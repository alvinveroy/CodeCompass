import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
// import { initMcpSafeLogging } from "./mcp-logger"; // mcp-logger removed
import fs from "fs/promises";
 // Keep for sync operations if any remain
import path from "path"; // Keep for local path operations
import git from "isomorphic-git";
import { QdrantClient } from "@qdrant/js-client-rest";
import { configService, logger } from "./config-service";
// model-persistence functions (loadModelConfig, forceUpdateModelConfig) are no longer directly used here.
// Their functionalities are covered by configService methods or were part of removed tools.

// Initialize MCP-safe logging immediately
// initMcpSafeLogging(); // mcp-logger removed
import { DetailedQdrantSearchResult } from "./types"; // Changed QdrantSearchResult to DetailedQdrantSearchResult
import { z } from "zod"; // Simplified Zod import
import { checkOllama, checkOllamaModel } from "./ollama";
import { initializeQdrant } from "./qdrant"; // searchWithRefinement removed from here
import { searchWithRefinement } from "./query-refinement"; // Added import for searchWithRefinement
import { validateGitRepository, indexRepository, getRepositoryDiff } from "./repository";
// Removed metrics imports: getMetrics, resetMetrics, startMetricsLogging, trackToolChain, trackAgentRun
import { getLLMProvider, switchSuggestionModel, LLMProvider } from "./llm-provider"; // Added LLMProvider import
import { SuggestionPlanner } from "./suggestion-service"; // Added SuggestionPlanner import
import { AgentInitialQueryResponse } from "./types"; // AgentStepExecutionResponse, AgentStateSchema removed
import { VERSION } from "./version";
import { getOrCreateSession, addQuery, addSuggestion, updateContext, getRecentQueries, getRelevantResults } from "./state";
// import { runAgentLoop } from "./agent"; // This is now unused

// generateChainId function removed

// Normalize tool parameters to handle various input formats
export function normalizeToolParams(params: unknown): Record<string, unknown> {
  if (typeof params === 'object' && params !== null) {
    // If it's already a non-null object, return as is.
    // The MCP SDK should provide parameters matching the Zod schema.
    return params as Record<string, unknown>;
  }
  if (typeof params === 'string') {
    // Attempt to parse if it's a JSON string
    try {
      const parsed = JSON.parse(params);
      if (typeof parsed === 'object' && parsed !== null) {
        return parsed; // Successfully parsed JSON string to object
      }
    } catch {
      // Not a valid JSON string, treat as a simple query string
    }
    // Default for non-JSON strings or if JSON parsing results in non-object
    return { query: params };
  }
  
  // For other primitive values (numbers, booleans, undefined, null), convert to a query string
  // or handle as an error if they are not expected.
  // For simplicity, let's wrap them in a query object.
  if (params === null || params === undefined) {
    return { query: "" }; // Or throw error, or handle as per tool expectation
  }
  return { query: String(params) };
}

// Start Server
export async function startServer(repoPath: string): Promise<void> {
  // MCP-safe logging is already initialized at the top of the file
  
  // Use file logging instead of stdout
  logger.info("Starting CodeCompass MCP server...");

  try {
    // ConfigService constructor loads from env and files.
    // For server start, ensure it reflects the latest state.
    configService.reloadConfigsFromFile(true); 

    // If SUGGESTION_MODEL was set in env, switchSuggestionModel might have been intended.
    // Now, configService handles this initial load. switchSuggestionModel is for dynamic changes.
    // We can log what's loaded:
    logger.info(`Initial suggestion model from config: ${configService.SUGGESTION_MODEL}`);
    
    // Validate repoPath
    if (!repoPath || repoPath === "${workspaceFolder}" || repoPath.trim() === "") {
      logger.warn("Invalid repository path provided, defaulting to current directory");
      repoPath = process.cwd(); // process.cwd() is fine
    }

    // loadModelConfig(true); // This is handled by configService.reloadConfigsFromFile(true)

    const llmProvider = await getLLMProvider(); // Uses configService
    const isLlmAvailable = await llmProvider.checkConnection();
    
    if (!isLlmAvailable) {
      logger.warn(`LLM provider (${configService.SUGGESTION_PROVIDER}) is not available. Some features may not work.`);
    }
    
    let suggestionModelAvailable = false;
    try {
      const currentSuggestionProvider = configService.SUGGESTION_PROVIDER.toLowerCase();
      if (currentSuggestionProvider === 'ollama') {
        await checkOllama(); // Uses configService
        await checkOllamaModel(configService.EMBEDDING_MODEL, true); // Uses configService
        await checkOllamaModel(configService.SUGGESTION_MODEL, false); // Uses configService
        suggestionModelAvailable = true;
      } else if (currentSuggestionProvider === 'deepseek') {
        suggestionModelAvailable = isLlmAvailable; // Assumes connection test implies model for DeepSeek
      } else {
        suggestionModelAvailable = isLlmAvailable; // Fallback for other/unknown
      }
    } catch (error: unknown) {
      logger.warn(`Warning: Model not available. Suggestion tools may be limited: ${(error as Error).message}`);
    }
    
    const qdrantClient = await initializeQdrant();
    await indexRepository(qdrantClient, repoPath);

    // Prompts will be registered using server.prompt() later

    const server = new McpServer({
      name: "CodeCompass",
      version: VERSION,
      vendor: "CodeCompass",
      capabilities: {
        resources: {
          "repo://structure": {},
          "repo://files/*": {},
          "repo://health": {},
          // "repo://metrics": {}, // Removed
          // "repo://provider": {}, // Removed
          "repo://version": {},
        },
        tools: {
          search_code: {},
          get_repository_context: {},
          ...(suggestionModelAvailable ? { generate_suggestion: {} } : {}),
          get_changelog: {},
          agent_query: {}, // Agent tool for direct plan and summary
          // execute_agent_step: {}, // Removed
          switch_suggestion_model: {},
          // "prompts/list": {}, // Removed from tools, will be a direct method
          // check_provider: {}, // Removed
          // reset_metrics: {}, // Removed
          // deepseek_diagnostic: {}, // Removed
          // force_deepseek_connection: {}, // Removed
          // provide_feedback and analyze_code_problem also removed by not being registered in registerTools
        },
        prompts: {}, // Explicitly declare prompts capability
        // prompts capability is now handled by individual server.prompt() registrations
      },
    });

    // Register resources
    if (typeof server.resource !== "function") {
      throw new Error("MCP server does not support 'resource' method");
    }
    
    // Add health check resource
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    server.resource("repo://health", "repo://health", z.object({}) as any, async () => {
      const status = {
        ollama: await checkOllama().then(() => "healthy").catch(() => "unhealthy"),
        qdrant: await qdrantClient.getCollections().then(() => "healthy").catch(() => "unhealthy"),
        repository: await validateGitRepository(repoPath) ? "healthy" : "unhealthy",
        version: VERSION,
        timestamp: new Date().toISOString()
      };
      return { contents: [{ uri: "repo://health", text: JSON.stringify(status, null, 2) }] };
    });
    
    // Add metrics resource - REMOVED
    
    // Add provider status resource - REMOVED
    
    // Add version resource
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    server.resource("repo://version", "repo://version", z.object({}) as any, async () => {
      return { contents: [{ uri: "repo://version", text: VERSION }] };
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    server.resource("repo://structure", "repo://structure", z.object({}) as any, async () => {
      const isGitRepo = await validateGitRepository(repoPath);
      const files = isGitRepo
        ? await git.listFiles({ fs, dir: repoPath, gitdir: path.join(repoPath, ".git"), ref: "HEAD" })
        : [];
      return { contents: [{ uri: "repo://structure", text: files.join("\n") }] };
    });

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    server.resource("repo://files/*", "repo://files/*", z.object({}) as any, async (uri: URL) => {
      const filepath = uri.pathname.replace(/^\/files\//, "");
      try {
        const content = await fs.readFile(path.join(repoPath, filepath), "utf8");
        return { contents: [{ uri: uri.toString(), text: content }] };
      } catch (error: unknown) {
        logger.error(`Error reading file ${filepath}`, { message: (error as Error).message });
        return { contents: [{ uri: uri.toString(), text: `Error: ${(error as Error).message}` }] };
      }
    });

    // Register tools
    await registerTools(server, qdrantClient, repoPath, suggestionModelAvailable);
    
    // Register prompts
    await registerPrompts(server);
    // The get_repository_context tool is registered within registerTools.
    // Its internal logic handles behavior when suggestionModelAvailable is false.
    // No need for a separate conditional registration here.
    
  
    // Register the switch suggestion model tool
    server.tool(
      "switch_suggestion_model",
      "Switches the primary model and provider used for generating suggestions. Embeddings continue to be handled by the configured Ollama embedding model. \nExample: To switch to 'deepseek-coder' (DeepSeek provider), use `{\"model\": \"deepseek-coder\", \"provider\": \"deepseek\"}`. To switch to 'llama3.1:8b' (Ollama provider), use `{\"model\": \"llama3.1:8b\", \"provider\": \"ollama\"}`. If provider is omitted, it may be inferred for known model patterns. For other providers like 'openai', 'gemini', 'claude', specify both model and provider: `{\"model\": \"gpt-4\", \"provider\": \"openai\"}`.",
      {
        model: z.string().describe("The suggestion model to switch to (e.g., 'llama3.1:8b', 'deepseek-coder', 'gpt-4')."),
        provider: z.string().optional().describe("The LLM provider for the model (e.g., 'ollama', 'deepseek', 'openai', 'gemini', 'claude'). If omitted, an attempt will be made to infer it.")
      },
      async (params: unknown) => {
        // chainId and trackToolChain removed
      
        logger.info("Received params for switch_suggestion_model", { params });
        const normalizedParams = normalizeToolParams(params);
        logger.debug("Normalized params for switch_suggestion_model", normalizedParams);
      
        // Parameters should conform to the Zod schema: { model: string }
        // normalizeToolParams ensures we have an object.
        let modelToSwitchTo: string;
        let providerToSwitchTo: string | undefined;

        if (normalizedParams && typeof normalizedParams.model === 'string') {
          modelToSwitchTo = normalizedParams.model;
        } else {
          logger.error("Invalid or missing 'model' parameter for switch_suggestion_model.", { normalizedParams });
          return {
            content: [{
              type: "text",
              text: "# Error Switching Suggestion Model\n\nInvalid or missing 'model' parameter. Please provide the model name as a string.",
            }],
          };
        }

        if (normalizedParams && typeof normalizedParams.provider === 'string') {
          providerToSwitchTo = normalizedParams.provider.toLowerCase();
        } else if (normalizedParams && normalizedParams.provider !== undefined) { // handles null or other non-string types for provider
          logger.error("Invalid 'provider' parameter for switch_suggestion_model. It must be a string if provided.", { normalizedParams });
          return {
            content: [{
              type: "text",
              text: "# Error Switching Suggestion Model\n\nInvalid 'provider' parameter. It must be a string if provided, or omitted.",
            }],
          };
        }
      
        logger.info(`Requested model switch: Model='${modelToSwitchTo}', Provider='${providerToSwitchTo || "infer"}'`);
        
        try {
          // The switchSuggestionModel function in llm-provider.ts now handles provider inference 
          // if providerToSwitchTo is undefined, and also any provider-specific checks (like API keys).
          const success = await switchSuggestionModel(modelToSwitchTo, providerToSwitchTo);
        
          if (!success) {
            // switchSuggestionModel in llm-provider.ts should log specific reasons for failure.
            return {
              content: [{
                type: "text",
                text: `# Failed to Switch Suggestion Model\n\nUnable to switch to model '${modelToSwitchTo}'${providerToSwitchTo ? ` with provider '${providerToSwitchTo}'` : ''}. Please check your configuration and server logs for details. Ensure the provider is supported and any necessary API keys or host configurations are correctly set.`,
              }],
            };
          }
        
          // Get the actual values from ConfigService to report what was set
          const actualModel = configService.SUGGESTION_MODEL;
          const actualProvider = configService.SUGGESTION_PROVIDER;
          const embeddingProvider = configService.EMBEDDING_PROVIDER;
        
          logger.info(`Successfully switched. ConfigService reports: Model='${actualModel}', Provider='${actualProvider}', Embedding Provider='${embeddingProvider}'`);
        
          // Construct a message confirming the switch
          let message = `# Suggestion Model Switched\n\nSuccessfully switched to model '${actualModel}' using provider '${actualProvider}' for suggestions.\nEmbeddings continue to use '${embeddingProvider}'.\n\n`;
          message += `To make this change permanent, update your environment variables (e.g., SUGGESTION_MODEL='${actualModel}', SUGGESTION_PROVIDER='${actualProvider}') or the relevant configuration files (e.g., ~/.codecompass/model-config.json).`;
          
          // Add provider-specific instructions or warnings if needed.
          // This can be enhanced based on feedback from llm-provider or specific checks here.
          if (actualProvider === 'deepseek' && !configService.DEEPSEEK_API_KEY) {
            message += `\n\nWarning: DeepSeek provider is selected, but DEEPSEEK_API_KEY is not found in current configuration. Ensure it is set for DeepSeek to function.`;
          } else if (actualProvider === 'openai' && !configService.OPENAI_API_KEY) {
            message += `\n\nWarning: OpenAI provider is selected, but OPENAI_API_KEY is not found. Ensure it is set.`;
          } else if (actualProvider === 'gemini' && !configService.GEMINI_API_KEY) {
            message += `\n\nWarning: Gemini provider is selected, but GEMINI_API_KEY is not found. Ensure it is set.`;
          } else if (actualProvider === 'claude' && !configService.CLAUDE_API_KEY) {
            message += `\n\nWarning: Claude provider is selected, but CLAUDE_API_KEY is not found. Ensure it is set.`;
          }

          return {
            content: [{
              type: "text",
              text: message,
            }],
          };
        } catch (error: unknown) {
          const err = error as Error;
          logger.error("Error switching suggestion model", { error: err.message });
          return {
            content: [{
              type: "text",
              text: `# Error Switching Suggestion Model\n\n${(error as Error).message}`,
            }],
          };
        }
      }
    );

    // Register deepseek_diagnostic tool - REMOVED
    // Register force_deepseek_connection tool - REMOVED
    
    // The 'prompts/list' method is automatically handled by the MCP SDK
    // based on the 'prompts' provided in the server capabilities.
    // No manual registration is needed.
    
    // Start metrics logging - REMOVED
    
    // Configure transport to use proper JSON formatting
    const transport = new StdioServerTransport();
    
    // Log startup info to file
    logger.info(`CodeCompass MCP server v${VERSION} running for repository: ${repoPath}`);
    const registeredTools = (server as { capabilities?: { tools?: Record<string, unknown> } }).capabilities?.tools || {};
    logger.info(`CodeCompass server started with tools: ${Object.keys(registeredTools).join(', ')}`);
    
    // Display version and status to stderr (similar to Context7)
    console.error(`CodeCompass v${VERSION} MCP Server running on stdio`);
    
    // Connect to transport after registering all capabilities
    await server.connect(transport);
    
    // Metrics interval clearing removed
    process.on('SIGINT', () => {
      logger.info("Server shutting down");
      process.exit(0);
    });
    
    await new Promise<void>((resolve) => {
      // This promise intentionally never resolves to keep the server running
      process.on('SIGINT', () => {
        resolve();
      });
    });

  } catch (error: unknown) {
    const err = error as Error;
    logger.error("Failed to start CodeCompass", { message: err.message });
    process.exit(1);
  }
}

async function registerPrompts(server: McpServer): Promise<void> {
  if (typeof server.prompt !== "function") {
    logger.warn("MCP server instance does not support 'prompt' method. Prompts may not be available.");
    return;
  }

  server.prompt(
    "repository-context",
    "Get context about your repository",
    { query: z.string().describe("The specific topic or question for which context is needed.") },
    ({ query }) => ({
      messages: [{
        role: "user",
        content: { type: "text", text: `Provide context about ${query} in this repository` }
      }]
    })
  );

  server.prompt(
    "code-suggestion",
    "Generate code suggestions",
    { query: z.string().describe("The specific topic or problem for which a code suggestion is needed.") },
    ({ query }) => ({
      messages: [{
        role: "user",
        content: { type: "text", text: `Generate a code suggestion for: ${query}` }
      }]
    })
  );

  server.prompt(
    "code-analysis",
    "Analyze code problems",
    { query: z.string().describe("The code problem or snippet to be analyzed.") },
    ({ query }) => ({
      messages: [{
        role: "user",
        content: { type: "text", text: `Analyze this code problem: ${query}` }
      }]
    })
  );

  logger.info("Registered prompts: repository-context, code-suggestion, code-analysis");
}

async function registerTools(
  server: McpServer, 
  qdrantClient: QdrantClient, 
  repoPath: string, 
  suggestionModelAvailable: boolean
): Promise<void> {
  if (typeof server.tool !== "function") {
    throw new Error("MCP server does not support 'tool' method");
  }
  
  // Add the agent_query tool
  server.tool(
    "agent_query",
    "Provides a detailed plan and a comprehensive summary for addressing complex questions or tasks related to the codebase. This tool generates these insights in a single pass. \nExample: `{\"query\": \"How is user authentication handled in this project?\"}`.",
    {
      query: z.string().describe("The question or task for the agent to process"),
      sessionId: z.string().optional().describe("Optional session ID to maintain context between requests")
      // maxSteps removed
    },
    async (params: unknown) => {
      // chainId, trackToolChain, trackAgentRun removed
      logger.info(`Tool 'agent_query' execution started.`);
      
      logger.info("Received params for agent_query", { params });
      const normalizedParams = normalizeToolParams(params);
      logger.debug("Normalized params for agent_query", normalizedParams);
      
      // Ensure query exists
      if (!normalizedParams.query && typeof normalizedParams === 'object') {
        normalizedParams.query = "repository information";
        logger.warn("No query provided for agent_query, using default");
      }
      
      const { query, sessionId: initialSessionId } = normalizedParams as { query: string; sessionId?: string }; // Renamed sessionId to avoid conflict
    
    try {
      // Ensure ConfigService reflects the latest state from files.
      configService.reloadConfigsFromFile(true);

      const llmProvider = await getLLMProvider(); // Uses configService
      logger.info(`Agent using provider: ${configService.SUGGESTION_PROVIDER}, model: ${configService.SUGGESTION_MODEL}`);

      // Perform a search for the agent's query to gather context
      const session = getOrCreateSession(initialSessionId, repoPath);
      const isGitRepo = await validateGitRepository(repoPath);
      const files = isGitRepo
        ? await git.listFiles({ fs, dir: repoPath, gitdir: path.join(repoPath, ".git"), ref: "HEAD" })
        : [];
      updateContext(session.id, repoPath, files); // Update context for the session

      const { results: searchResults, refinedQuery } = await searchWithRefinement(
        qdrantClient, 
        query as string,
        files
      );
      // Add this search to session history
      const topScore = searchResults.length > 0 ? searchResults[0].score : 0;
      addQuery(session.id, query as string, searchResults, topScore);

      const searchContextSnippets = searchResults.map(r => ({
        filepath: (r.payload as DetailedQdrantSearchResult['payload']).filepath,
        snippet: (r.payload as DetailedQdrantSearchResult['payload']).content.slice(0, configService.MAX_SNIPPET_LENGTH),
        relevance: r.score,
      }));

      const augmentedPrompt = `User Query: "${query}"
${refinedQuery !== query ? `Refined Query (used for vector search): "${refinedQuery}"` : ''}

Relevant code snippets based on the query:
${searchContextSnippets.length > 0 
  ? searchContextSnippets.map(c => `File: ${c.filepath} (Relevance: ${c.relevance.toFixed(2)})\n\`\`\`\n${c.snippet}\n\`\`\``).join("\n\n")
  : "No specific code snippets found directly matching the query."
}

Based on the user query and the provided relevant code snippets (if any), please generate a detailed plan and a comprehensive summary for addressing the user's query.
Ensure the plan outlines steps to answer the query or solve the task, and the summary provides a direct answer or solution.
`;
      
      const planner = new SuggestionPlanner(llmProvider);
      // initiateAgentQuery now returns a plan and summary directly.
      const agentResponse: AgentInitialQueryResponse = await planner.initiateAgentQuery(
        augmentedPrompt,
        session.id // Use the obtained session.id
      );

      if (agentResponse.status === "ERROR") {
        logger.error("Error in agent_query", { 
          sessionId: agentResponse.sessionId, 
          message: agentResponse.message 
        });
        return {
          content: [{
            type: "text",
            text: `# Agent Query Failed\n\nSession ID: ${agentResponse.sessionId}\nStatus: ${agentResponse.status}\nMessage: ${agentResponse.message}\n\nPlan:\n\`\`\`\n${agentResponse.generatedPlanText || "No plan generated."}\n\`\`\`\nSummary:\n\`\`\`\n${agentResponse.agentState.finalResponse || "No summary generated."}\n\`\`\``,
          }],
        };
      }
      
      const responseText = `# Agent Query Result

**Session ID:** ${agentResponse.sessionId}
**Status:** ${agentResponse.status}
**Message:** ${agentResponse.message}

## Generated Plan
\`\`\`
${agentResponse.generatedPlanText || "No plan generated."}
\`\`\`

## Generated Summary
\`\`\`
${agentResponse.agentState.finalResponse || "No summary generated."}
\`\`\`
`;
      
      return {
        content: [{
          type: "text",
          text: responseText,
        }],
      };
    } catch (error: unknown) {
      logger.error("Error in agent_query tool", { error: error instanceof Error ? error.message : String(error) });
      
      return {
        content: [{
          type: "text",
          text: `# Error in Agent Query Tool\n\nThere was an unexpected error processing your query: ${(error as Error).message}\n\nPlease check the server logs for more details.`,
        }],
      };
    }
  });

  // Tool to execute the next step of an agent's plan - REMOVED
  
  // Search Code Tool with iterative refinement
  server.tool(
    "search_code",
    "Performs a semantic search for code snippets within the repository that are relevant to the given query. Results include file paths, code snippets, and relevance scores. \nExample: `{\"query\": \"function to handle user login\"}`. For a broader search: `{\"query\": \"database connection setup\"}`.",
    {
      query: z.string().describe("The search query to find relevant code in the repository"),
      sessionId: z.string().optional().describe("Optional session ID to maintain context between requests")
    },
    async (params: unknown) => {
      // chainId and trackToolChain removed
      logger.info(`Tool 'search_code' execution started.`);
        
      logger.info("Received params for search_code", { params });
      const normalizedParams = normalizeToolParams(params);
      logger.debug("Normalized params for search_code", normalizedParams);
        
      // Ensure query exists
      if (!normalizedParams.query && typeof normalizedParams === 'object') {
        normalizedParams.query = "code search";
        logger.warn("No query provided for search_code, using default");
      }
        
      const { query, sessionId } = normalizedParams;
    
    // Get or create session
    const session = getOrCreateSession(sessionId as string | undefined, repoPath);
    
    // Log the extracted query to confirm it's working
    logger.info("Extracted query for search_code", { query, sessionId: session.id });
    
    const isGitRepo = await validateGitRepository(repoPath);
    const files = isGitRepo
      ? await git.listFiles({ fs, dir: repoPath, gitdir: path.join(repoPath, ".git"), ref: "HEAD" })
      : [];
    
    // Update context in session
    updateContext(session.id, repoPath, files);
    
    // Use iterative query refinement
    const { results, refinedQuery, relevanceScore } = await searchWithRefinement(
      qdrantClient, 
      query as string, 
      files
    );
    
    // Add query to session
    addQuery(session.id, query as string, results, relevanceScore);
    
    // Get the current LLM provider
    const llmProvider = await getLLMProvider();
    
    // Generate summaries for the results
    const summaries = await Promise.all(results.map(async result => {
      const snippet = (result.payload as DetailedQdrantSearchResult['payload']).content.slice(0, configService.MAX_SNIPPET_LENGTH);
      let summary = "Summary unavailable";
      
      if (suggestionModelAvailable) {
        try {
          // Create a summarization prompt
          const summarizePrompt = `Summarize this code snippet in 50 words or less:\n\n${snippet}`;
          summary = await llmProvider.generateText(summarizePrompt);
        } catch (error: unknown) {
          logger.warn(`Failed to generate summary: ${(error as Error).message}`);
          summary = "Summary generation failed";
        }
      }
      
      return {
        filepath: (result.payload as DetailedQdrantSearchResult['payload']).filepath,
        snippet,
        summary,
        last_modified: (result.payload as DetailedQdrantSearchResult['payload']).last_modified,
        relevance: result.score,
      };
    }));
    
    // Format the response as clean markdown
    const formattedResponse = `# Search Results for: "${query}"
${refinedQuery !== query ? `\n> Query refined to: "${refinedQuery}"` : ''}

${summaries.map(s => `
## ${s.filepath}
- Last Modified: ${s.last_modified}
- Relevance: ${s.relevance.toFixed(2)}

### Code Snippet
\`\`\`
${s.snippet}
\`\`\`

### Summary
${s.summary}
`).join('\n')}

Session ID: ${session.id} (Use this ID in future requests to maintain context)`;
    
    return {
      content: [{
        type: "text",
        text: formattedResponse,
      }],
    };
  });

  // Add get_changelog tool
  server.tool(
    "get_changelog",
    "Retrieves the content of the `CHANGELOG.md` file from the root of the repository. This provides a history of changes and versions for the project. \nExample: Call this tool without parameters: `{}`.",
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    z.object({}) as any, // Use z.object({}) with type assertion for runtime compatibility
    async () => {
      try {
        const changelogPath = path.join(repoPath, 'CHANGELOG.md');
        const changelog = await fs.readFile(changelogPath, 'utf8');
        
        return {
          content: [{
            type: "text",
            text: `# CodeCompass Changelog (v${VERSION})\n\n${changelog}`,
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
          } as any], // Cast content item to any for TS compatibility
        };
      } catch (error) {
        logger.error("Failed to read changelog", { error });
        return {
          content: [{
            type: "text",
            text: `# Error Reading Changelog\n\nFailed to read the changelog file. Current version is ${VERSION}.`,
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
          } as any], // Cast content item to any for TS compatibility
        };
      }
    }
  );
  
  // Add reset_metrics tool - REMOVED
  // Add check_provider tool - REMOVED
  
  // Add get_session_history tool
  server.tool(
    "get_session_history",
    "Retrieves the history of interactions (queries, suggestions, feedback) for a given session ID. This allows you to review past activities within a specific CodeCompass session. \nExample: `{\"sessionId\": \"your_session_id_here\"}`.",
    {
      sessionId: z.string().describe("The session ID to retrieve history for")
    },
    async (params: unknown) => {
      logger.info("Received params for get_session_history", { params });
      const normalizedParams = normalizeToolParams(params);
      logger.debug("Normalized params for get_session_history", normalizedParams);
        
      const { sessionId } = normalizedParams;
        
      if (!sessionId) {
        throw new Error("Session ID is required");
      }
    
    try {
      const session = getOrCreateSession(sessionId as string);
      
      return {
        content: [{
          type: "text",
          text: `# Session History (${session.id})

## Session Info
- Created: ${new Date(session.createdAt).toISOString()}
- Last Updated: ${new Date(session.lastUpdated).toISOString()}
- Repository: ${session.context.repoPath}

## Queries (${session.queries.length})
${session.queries.map((q, i) => `
### Query ${i+1}: "${q.query}"
- Timestamp: ${new Date(q.timestamp).toISOString()}
- Results: ${q.results.length}
- Relevance Score: ${q.relevanceScore.toFixed(2)}
`).join('')}

## Suggestions (${session.suggestions.length})
${session.suggestions.map((s, i) => `
### Suggestion ${i+1}
- Timestamp: ${new Date(s.timestamp).toISOString()}
- Prompt: "${s.prompt.substring(0, 100)}..."
${s.feedback ? `- Feedback Score: ${s.feedback.score}/10
- Feedback Comments: ${s.feedback.comments}` : '- No feedback provided'}
`).join('')}`,
        }],
      };
    } catch (error: unknown) {
      return {
        content: [{
          type: "text",
          text: `# Error\n\n${(error as Error).message}`,
        }],
      };
    }
  });
    
  if (suggestionModelAvailable) {
    // Generate Suggestion Tool with multi-step reasoning
    server.tool(
      "generate_suggestion",
      "Generates code suggestions, implementation ideas, or examples based on a natural language query. It leverages repository context and relevant code snippets to provide targeted advice. \nExample: `{\"query\": \"Suggest an optimized way to fetch user data\"}`. For a specific task: `{\"query\": \"Write a Python function to parse a CSV file\"}`.",
      {
        query: z.string().describe("The query or prompt for generating code suggestions"),
        sessionId: z.string().optional().describe("Optional session ID to maintain context between requests")
      },
      async (params: unknown) => {
        // chainId and trackToolChain removed
        logger.info(`Tool 'generate_suggestion' execution started.`);
        
        logger.info("Received params for generate_suggestion", { params });
        const normalizedParams = normalizeToolParams(params);
        logger.debug("Normalized params for generate_suggestion", normalizedParams);
        
        // Ensure query exists
        if (!normalizedParams.query && typeof normalizedParams === 'object') {
          normalizedParams.query = "code suggestion";
          logger.warn("No query provided for generate_suggestion, using default");
        }
        
        const { query, sessionId } = normalizedParams;
      
      // Get or create session
      const session = getOrCreateSession(sessionId as string | undefined, repoPath);
      
      // Log the extracted query to confirm it's working
      logger.info("Extracted query for generate_suggestion", { query, sessionId: session.id });
      
      // First, use search_code internally to get relevant context
      // trackToolChain(chainId, "search_code"); // Removed as chainId is not defined and metrics are removed
      
      const isGitRepo = await validateGitRepository(repoPath);
      const files = isGitRepo
        ? await git.listFiles({ fs, dir: repoPath, gitdir: path.join(repoPath, ".git"), ref: "HEAD" })
        : [];
      const _diff = await getRepositoryDiff(repoPath);
      
      // Update context in session
      updateContext(session.id, repoPath, files, _diff);
      
      // Get recent queries from session to provide context
      const recentQueries = getRecentQueries(session.id);
      const relevantResults = getRelevantResults(session.id);
      
      // Use iterative query refinement for better search results
      const { results, refinedQuery } = await searchWithRefinement(
        qdrantClient, 
        query as string, 
        files
      );
      
      // Map search results to context
      const context = results.map(r => ({
        filepath: (r.payload as DetailedQdrantSearchResult['payload']).filepath,
        snippet: (r.payload as DetailedQdrantSearchResult['payload']).content.slice(0, configService.MAX_SNIPPET_LENGTH),
        last_modified: (r.payload as DetailedQdrantSearchResult['payload']).last_modified,
        relevance: r.score,
        note: ""
      }));
      
      // Include previous relevant results if current results are limited
      if (context.length < 2 && relevantResults.length > 0) {
        const additionalContext = relevantResults
          .filter(r => !context.some(c => c.filepath === (r as unknown as DetailedQdrantSearchResult).payload?.filepath))
          .slice(0, 2)
          .map(r => ({
            filepath: (r as unknown as DetailedQdrantSearchResult).payload?.filepath || "unknown",
            snippet: (r as unknown as DetailedQdrantSearchResult).payload?.content?.slice(0, configService.MAX_SNIPPET_LENGTH) || "",
            last_modified: (r as unknown as DetailedQdrantSearchResult).payload?.last_modified || "unknown",
            relevance: (r as unknown as DetailedQdrantSearchResult).score || 0.5,
            note: "From previous related query"
          }));
        
        context.push(...additionalContext);
      }

      const prompt = `
**Context**:
Repository: ${repoPath}
Files: ${files.join(", ")}
Recent Changes: ${_diff}
${recentQueries.length > 0 ? `Recent Queries: ${recentQueries.join(", ")}` : ''}

**Relevant Snippets**:
${context.map(c => `File: ${c.filepath} (Last modified: ${c.last_modified}, Relevance: ${c.relevance.toFixed(2)}${c.note ? `, Note: ${c.note}` : ''})\n${c.snippet}`).join("\n\n")}

**Instruction**:
Based on the provided context and snippets, generate a detailed code suggestion for "${query}". Include:
- A suggested code implementation or improvement.
- An explanation of how it addresses the query.
- References to the provided snippets or context where applicable.
Ensure the suggestion is concise, practical, and leverages the repository's existing code structure. If the query is ambiguous, provide a general solution with assumptions clearly stated.
      `;
      
      // Get the current LLM provider
      const llmProvider: LLMProvider = await getLLMProvider();
      
      // Generate suggestion directly using the LLM provider
      const suggestion = await llmProvider.generateText(prompt);
      
      // Add suggestion to session
      addSuggestion(session.id, query as string, suggestion);
      
      // Format the response as clean markdown
      const formattedResponse = `# Code Suggestion for: "${query}"
${refinedQuery !== query ? `\n> Query refined to: "${refinedQuery}"` : ''}

## Suggestion
${suggestion}

## Context Used
${context.map(c => `
### ${c.filepath}
- Last modified: ${c.last_modified}
- Relevance: ${c.relevance.toFixed(2)}
${c.note ? `- Note: ${c.note}` : ''}

\`\`\`
${c.snippet}
\`\`\`
`).join('\n')}

## Recent Changes
\`\`\`
${_diff}
\`\`\`

Session ID: ${session.id} (Use this ID in future requests to maintain context)`;
// Feedback ID removed
      
      return {
        content: [{
          type: "text",
          text: formattedResponse,
        }],
      };
    });
    
    // Add a new feedback tool - REMOVED (provide_feedback)

    // Get Repository Context Tool with state management
    server.tool(
      "get_repository_context",
      "Provides a high-level summary of the repository's structure, common patterns, and conventions relevant to a specific query. It uses semantic search to find pertinent information and synthesizes it. \nExample: `{\"query\": \"What are the main components of the API service?\"}`. To understand coding standards: `{\"query\": \"coding conventions for frontend development\"}`.",
      {
        query: z.string().describe("The query to get repository context for"),
        sessionId: z.string().optional().describe("Optional session ID to maintain context between requests")
      },
      async (params: unknown) => {
        // chainId and trackToolChain removed
        
        logger.info("Received params for get_repository_context", { params });
        const normalizedParams = normalizeToolParams(params);
        logger.debug("Normalized params for get_repository_context", normalizedParams);
        
        // Handle the case where params might be a JSON string with a query property
        let parsedParams = normalizedParams;
        if (typeof normalizedParams === 'string') {
          try {
            const parsed = JSON.parse(normalizedParams);
            if (parsed && typeof parsed === 'object') {
              parsedParams = parsed;
            }
          } catch {
            // If it's not valid JSON, keep using it as a string query
            parsedParams = { query: normalizedParams };
          }
        }
        
        // Ensure query exists
        if (!parsedParams.query && typeof parsedParams === 'object') {
          // If query is missing but we have a JSON object, use the entire object as context
          parsedParams.query = "repository context";
          logger.warn("No query provided for get_repository_context, using default");
        }
        
        const query = parsedParams.query;
        const sessionId = 'sessionId' in parsedParams ? parsedParams.sessionId : undefined;
      
      // Get or create session
      const session = getOrCreateSession(sessionId as string | undefined, repoPath);
      
      // Log the extracted query to confirm it's working
      logger.info("Extracted query for repository context", { query, sessionId: session.id });
      
      const isGitRepo = await validateGitRepository(repoPath);
      const files = isGitRepo
        ? await git.listFiles({ fs, dir: repoPath, gitdir: path.join(repoPath, ".git"), ref: "HEAD" })
        : [];
      const _diff = await getRepositoryDiff(repoPath);
      
      // Update context in session
      updateContext(session.id, repoPath, files, _diff);
      
      // Use iterative query refinement
      const { results, refinedQuery } = await searchWithRefinement(
        qdrantClient, 
        query as string, 
        files
      );
      
      // Get recent queries from session to provide context
      const recentQueries = getRecentQueries(session.id);
      
      const context = results.map(r => ({
        filepath: (r.payload as DetailedQdrantSearchResult['payload']).filepath,
        snippet: (r.payload as DetailedQdrantSearchResult['payload']).content.slice(0, configService.MAX_SNIPPET_LENGTH),
        last_modified: (r.payload as DetailedQdrantSearchResult['payload']).last_modified,
        relevance: r.score,
      }));
      
      const summaryPrompt = `
**Context**:
Repository: ${repoPath}
Files: ${files.join(", ")}
Recent Changes: ${_diff}
${recentQueries.length > 0 ? `Recent Queries: ${recentQueries.join(", ")}` : ''}

**Relevant Snippets**:
${context.map(c => `File: ${c.filepath} (Last modified: ${c.last_modified}, Relevance: ${c.relevance.toFixed(2)})\n${c.snippet}`).join("\n\n")}

**Instruction**:
Provide a concise summary of the context for "${query}" based on the repository files and recent changes. Highlight key information relevant to the query, referencing specific files or snippets where applicable.
      `;
      
      // Get the current LLM provider
      const llmProvider = await getLLMProvider();
      
      // Generate summary with multi-step reasoning
      const summary = await llmProvider.generateText(summaryPrompt);
      
      // Add query to session
      addQuery(session.id, query as string, results);
      
      // Format the response as clean markdown
      const formattedResponse = `# Repository Context Summary for: "${query}"
${refinedQuery !== query ? `\n> Query refined to: "${refinedQuery}"` : ''}

## Summary
${summary}

## Relevant Files
${context.map(c => `
### ${c.filepath}
- Last modified: ${c.last_modified}
- Relevance: ${c.relevance.toFixed(2)}

\`\`\`
${c.snippet}
\`\`\`
`).join('\n')}

## Recent Changes
\`\`\`
${_diff}
\`\`\`

Session ID: ${session.id} (Use this ID in future requests to maintain context)`;
      
      return {
        content: [{
          type: "text",
          text: formattedResponse,
        }],
      };
    });
    
    // Add a new tool for multi-step reasoning - REMOVED (analyze_code_problem)
  }
}
