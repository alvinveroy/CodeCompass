import { McpServer, ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { ServerRequest, ServerNotification } from "@modelcontextprotocol/sdk/types";
import { Variables } from "@modelcontextprotocol/sdk/shared/uriTemplate"; // Attempt specific import for Variables
import { RequestHandlerExtra } from "@modelcontextprotocol/sdk/shared/protocol"; // Attempt specific import for RequestHandlerExtra
import fs from "fs/promises";
import path from "path";
import git from "isomorphic-git";
import { QdrantClient } from "@qdrant/js-client-rest";
import { configService, logger } from "./config-service";

import { DetailedQdrantSearchResult } from "./types";
import { z } from "zod";
import { checkOllama, checkOllamaModel } from "./ollama";
import { initializeQdrant } from "./qdrant";
import { searchWithRefinement } from "./query-refinement";
import { validateGitRepository, indexRepository, getRepositoryDiff } from "./repository";
import { getLLMProvider, switchSuggestionModel, LLMProvider } from "./llm-provider";
import { SuggestionPlanner } from "./suggestion-service";
import { AgentInitialQueryResponse } from "./types";
import { VERSION } from "./version";
import { getOrCreateSession, addQuery, addSuggestion, updateContext, getRecentQueries, getRelevantResults } from "./state";

export function normalizeToolParams(params: unknown): Record<string, unknown> {
  if (typeof params === 'object' && params !== null) {
    // If it's already a non-null object, return as is.
    return params as Record<string, unknown>;
  }
  if (typeof params === 'string') {
    try {
      const parsed = JSON.parse(params) as unknown;
      if (typeof parsed === 'object' && parsed !== null) {
        return parsed as Record<string, unknown>;
      }
      return { query: params };
    } catch {
      return { query: params };
    }
  }
  
  if (params === null || params === undefined) {
    return { query: "" };
  }
  // At this point, params can be boolean, number, bigint, or symbol.
  // For these types, String() or .toString() is the correct and safe way to convert.
  if (typeof params === 'number' || typeof params === 'boolean' || typeof params === 'bigint') {
    return { query: String(params) };
  }
  if (typeof params === 'symbol') {
    return { query: params.toString() }; // Symbols require .toString()
  }
  // Fallback for any other unexpected type, though TS should prevent this with `unknown`
  logger.warn(`normalizeToolParams: Encountered unexpected param type at end of function: ${typeof params}. Defaulting query string.`);
  return { query: `[Unexpected type: ${typeof params}]` };
}

export async function startServer(repoPath: string): Promise<void> {
  
  logger.info("Starting CodeCompass MCP server...");

  try {
    // ConfigService constructor loads from env and files.
    // For server start, ensure it reflects the latest state.
    configService.reloadConfigsFromFile(true); 

    logger.info(`Initial suggestion model from config: ${configService.SUGGESTION_MODEL}`);
    
    if (!repoPath || repoPath === "${workspaceFolder}" || repoPath.trim() === "") {
      logger.warn("Invalid repository path provided, defaulting to current directory");
      repoPath = process.cwd();
    }

    const llmProvider = await getLLMProvider();
    const isLlmAvailable = await llmProvider.checkConnection();
    
    if (!isLlmAvailable) {
      logger.warn(`LLM provider (${configService.SUGGESTION_PROVIDER}) is not available. Some features may not work.`);
    }
    
    let suggestionModelAvailable = false;
    try {
      const currentSuggestionProvider = configService.SUGGESTION_PROVIDER.toLowerCase();
      if (currentSuggestionProvider === 'ollama') {
        await checkOllama();
        await checkOllamaModel(configService.EMBEDDING_MODEL, true);
        await checkOllamaModel(configService.SUGGESTION_MODEL, false);
        suggestionModelAvailable = true;
      } else if (currentSuggestionProvider === 'deepseek') {
        suggestionModelAvailable = isLlmAvailable;
      } else {
        suggestionModelAvailable = isLlmAvailable;
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
          "repo://structure": {
            name: "Repository File Structure",
            description: "Lists all files in the current Git repository.",
            mimeType: "text/plain"
          },
          "repo://files/{filepath}": {
            name: "Repository File Content",
            description: "Retrieves the content of a specific file from the repository. Replace {filepath} with a full file path relative to the repository root, e.g., 'repo://files/src/main.js'.",
            mimeType: "text/plain", // Default, actual content type might vary
            template: true,
            parameters: {
              filepath: {
                type: "string",
                description: "The path to the file relative to the repository root."
              }
            }
          },
          "repo://health": {
            name: "Server Health Status",
            description: "Provides the health status of the CodeCompass server and its core components (LLM provider, vector database, and repository access).",
            mimeType: "application/json"
          },
          "repo://version": {
            name: "Server Version",
            description: "Provides the current version of the CodeCompass server.",
            mimeType: "text/plain"
          }
        },
        tools: {
          search_code: {},
          get_repository_context: {},
          ...(suggestionModelAvailable ? { generate_suggestion: {} } : {}),
          get_changelog: {},
          agent_query: {},
          switch_suggestion_model: {},
        },
        prompts: {}, // Explicitly declare prompts capability
      },
    });

    // Register resources
    if (typeof server.resource !== "function") {
      throw new Error("MCP server does not support 'resource' method");
    }
    
    server.resource("Server Health Status", "repo://health", async () => {
      const healthUri = "repo://health";
      try {
        // More robust error capturing for individual checks
        let ollamaStatus = "unhealthy";
        try {
          await checkOllama();
          ollamaStatus = "healthy";
        } catch (err) {
          logger.warn(`Ollama health check failed during repo://health: ${err instanceof Error ? err.message : String(err)}`);
          // ollamaStatus remains "unhealthy"
        }

        let qdrantStatus = "unhealthy";
        try {
          await qdrantClient.getCollections(); // This just checks if the call succeeds
          qdrantStatus = "healthy";
        } catch (err) {
          logger.warn(`Qdrant health check failed during repo://health: ${err instanceof Error ? err.message : String(err)}`);
          // qdrantStatus remains "unhealthy"
        }
        
        // validateGitRepository already logs its own warnings and should return true/false
        const repositoryStatus = await validateGitRepository(repoPath) ? "healthy" : "unhealthy";

        const status = {
          ollama: ollamaStatus,
          qdrant: qdrantStatus,
          repository: repositoryStatus,
          version: VERSION,
          timestamp: new Date().toISOString()
        };
        return { contents: [{ uri: healthUri, text: JSON.stringify(status, null, 2) }] };
      } catch (error: unknown) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        logger.error(`Critical error in repo://health resource handler: ${errorMessage}`);
        const errorPayload = {
          error: "Failed to retrieve complete health status due to a critical error.",
          details: errorMessage,
          version: VERSION,
          timestamp: new Date().toISOString(),
          ollama: "unknown", 
          qdrant: "unknown",
          repository: "unknown"
        };
        return { contents: [{ uri: healthUri, text: JSON.stringify(errorPayload, null, 2) }] };
      }
    });
    
    server.resource("Server Version", "repo://version", () => {
      return { contents: [{ uri: "repo://version", text: VERSION }] };
    });
    server.resource("Repository File Structure", "repo://structure", async () => {
      const uriStr = "repo://structure";
      const isGitRepo = await validateGitRepository(repoPath);
      if (!isGitRepo) {
        // Consistent with original behavior: empty list if not a valid/recognized git repo.
        // validateGitRepository already logs a warning.
        return { contents: [{ uri: uriStr, text: "" }] }; 
      }
      try {
        const files = await git.listFiles({ fs, dir: repoPath, gitdir: path.join(repoPath, ".git"), ref: "HEAD" });
        return { contents: [{ uri: uriStr, text: files.join("\n") }] };
      } catch (error: unknown) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        logger.error(`Error listing repository files for ${repoPath}: ${errorMessage}`);
        return { contents: [{ uri: uriStr, text: "", error: `Failed to list repository files: ${errorMessage}` }] };
      }
    });

    server.resource(
      "Repository File Content",
      new ResourceTemplate("repo://files/{filepath}", { list: undefined }),
      {}, // metadata
      async (uri: URL, variables: Variables, _extra: RequestHandlerExtra<ServerRequest, ServerNotification>) => {
      const rawFilepathValue = variables.filepath;
      let relativeFilepath = '';
      if (typeof rawFilepathValue === 'string') {
        relativeFilepath = rawFilepathValue.trim();
      } else if (Array.isArray(rawFilepathValue) && rawFilepathValue.length > 0 && typeof rawFilepathValue[0] === 'string') {
        logger.warn(`Filepath parameter '${JSON.stringify(rawFilepathValue)}' resolved to an array. Using the first element: '${rawFilepathValue[0]}'`);
        relativeFilepath = rawFilepathValue[0].trim();
      } else if (rawFilepathValue !== undefined) {
        logger.warn(`Filepath parameter '${Array.isArray(rawFilepathValue) ? JSON.stringify(rawFilepathValue) : rawFilepathValue}' resolved to an unexpected type: ${typeof rawFilepathValue}. Treating as empty.`);
      }
      // If rawFilepathValue is undefined, or an empty array, or an array not containing a string at index 0, relativeFilepath remains ''.

      if (!relativeFilepath) {
        const errMsg = "File path cannot be empty.";
        logger.error(`Error accessing resource for URI ${uri.toString()}: ${errMsg}`);
        return { contents: [{ uri: uri.toString(), text: "", error: errMsg }] };
      }

      try {
        const resolvedRepoPath = path.resolve(repoPath); // Normalized
        const requestedFullPath = path.resolve(repoPath, relativeFilepath); // Normalized

        // Initial security check: Ensure the resolved path is within the repoPath
        if (!requestedFullPath.startsWith(resolvedRepoPath + path.sep) && requestedFullPath !== resolvedRepoPath) {
          throw new Error(`Access denied: Path '${relativeFilepath}' attempts to traverse outside the repository directory.`);
        }
        
        let finalPathToRead = requestedFullPath;
        try {
            const stats = await fs.lstat(requestedFullPath);
            if (stats.isSymbolicLink()) {
                const symlinkTargetPath = await fs.realpath(requestedFullPath);
                // Ensure the resolved symlink target is also within the repository
                if (!path.resolve(symlinkTargetPath).startsWith(resolvedRepoPath + path.sep) && path.resolve(symlinkTargetPath) !== resolvedRepoPath) {
                    throw new Error(`Access denied: Symbolic link '${relativeFilepath}' points outside the repository directory.`);
                }
                finalPathToRead = symlinkTargetPath; // Update path to read from the symlink's target
            } else if (!stats.isFile()) {
                throw new Error(`Access denied: Path '${relativeFilepath}' is not a file.`);
            }
        } catch (statError: unknown) {
            if ((statError as NodeJS.ErrnoException).code === 'ENOENT') {
                throw new Error(`File not found: ${relativeFilepath}`);
            }
            throw statError; // Re-throw other stat/realpath errors
        }

        const content = await fs.readFile(finalPathToRead, "utf8");
        return { contents: [{ uri: uri.toString(), text: content }] };
      } catch (error: unknown) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        logger.error(`Error accessing resource for URI ${uri.toString()} (relative path: ${relativeFilepath}): ${errorMessage}`);
        return { contents: [{ uri: uri.toString(), text: "", error: errorMessage }] };
      }
    });

    registerTools(server, qdrantClient, repoPath, suggestionModelAvailable); 
    
    registerPrompts(server); 
    
    server.tool(
      "switch_suggestion_model",
      "Switches the primary model and provider used for generating suggestions. Embeddings continue to be handled by the configured Ollama embedding model. \nExample: To switch to 'deepseek-coder' (DeepSeek provider), use `{\"model\": \"deepseek-coder\", \"provider\": \"deepseek\"}`. To switch to 'llama3.1:8b' (Ollama provider), use `{\"model\": \"llama3.1:8b\", \"provider\": \"ollama\"}`. If provider is omitted, it may be inferred for known model patterns. For other providers like 'openai', 'gemini', 'claude', specify both model and provider: `{\"model\": \"gpt-4\", \"provider\": \"openai\"}`.",
      {
        model: z.string().describe("The suggestion model to switch to (e.g., 'llama3.1:8b', 'deepseek-coder', 'gpt-4')."),
        provider: z.string().optional().describe("The LLM provider for the model (e.g., 'ollama', 'deepseek', 'openai', 'gemini', 'claude'). If omitted, an attempt will be made to infer it.")
      },
      async (args: { model: string; provider?: string }, _extra: RequestHandlerExtra<ServerRequest, ServerNotification>) => {
        logger.info("Received args for switch_suggestion_model", { args });

        const modelToSwitchTo = args.model;
        const providerToSwitchTo = args.provider?.toLowerCase(); // provider is optional

        if (!modelToSwitchTo || typeof modelToSwitchTo !== 'string' || modelToSwitchTo.trim() === "") {
          const errorMsg = "Invalid or missing 'model' parameter. Please provide a non-empty model name string.";
          logger.error(errorMsg, { receivedModel: modelToSwitchTo });
          return {
            content: [{
              type: "text",
              text: `# Error Switching Suggestion Model\n\n${errorMsg}`,
            }],
          };
        }

        if (args.provider !== undefined && (typeof args.provider !== 'string' || args.provider.trim() === "")) {
            const errorMsg = "Invalid 'provider' parameter. If provided, it must be a non-empty string.";
            logger.error(errorMsg, { receivedProvider: args.provider });
            return {
                content: [{
                    type: "text",
                    text: `# Error Switching Suggestion Model\n\n${errorMsg}`,
                }],
            };
        }
      
        logger.info(`Requested model switch: Model='${modelToSwitchTo}', Provider='${providerToSwitchTo || "(infer)"}'`);
        
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
        
          const actualModel = configService.SUGGESTION_MODEL;
          const actualProvider = configService.SUGGESTION_PROVIDER;
          const embeddingProvider = configService.EMBEDDING_PROVIDER;
        
          logger.info(`Successfully switched. ConfigService reports: Model='${actualModel}', Provider='${actualProvider}', Embedding Provider='${embeddingProvider}'`);
        
          let message = `# Suggestion Model Switched\n\nSuccessfully switched to model '${actualModel}' using provider '${actualProvider}' for suggestions.\nEmbeddings continue to use '${embeddingProvider}'.\n\n`;
          message += `To make this change permanent, update your environment variables (e.g., SUGGESTION_MODEL='${actualModel}', SUGGESTION_PROVIDER='${actualProvider}') or the relevant configuration files (e.g., ~/.codecompass/model-config.json).`;
          
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
          logger.error("Error switching suggestion model", { message: error instanceof Error ? error.message : String(error) });
          return {
            content: [{
              type: "text",
              text: `# Error Switching Suggestion Model\n\n${error instanceof Error ? error.message : String(error)}`,
            }],
          };
        }
      }
    );

    const transport = new StdioServerTransport();
    
    logger.info(`CodeCompass MCP server v${VERSION} running for repository: ${repoPath}`);
    const registeredTools = (server as { capabilities?: { tools?: Record<string, unknown> } }).capabilities?.tools || {};
    logger.info(`CodeCompass server started with tools: ${Object.keys(registeredTools).join(', ')}`);
    
    console.error(`CodeCompass v${VERSION} MCP Server running on stdio`);
    
    await server.connect(transport);
    
    // }); // This was misplaced, removed. The try block continues.
    
    await new Promise<void>((resolve) => {
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

function registerPrompts(server: McpServer): void {
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

function registerTools( // Removed async
  server: McpServer, 
  qdrantClient: QdrantClient, 
  repoPath: string, 
  suggestionModelAvailable: boolean
): void {
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
    async (args: { query: string; sessionId?: string }, _extra: RequestHandlerExtra<ServerRequest, ServerNotification>) => {
      logger.info(`Tool 'agent_query' execution started.`);
      // args are already parsed by Zod via McpServer based on the schema above.
      // No need for normalizeToolParams here if using args directly.
      logger.info("Received args for agent_query", { args });

      const query = args.query || "repository information"; // Default if query is empty string after parsing
      const initialSessionId = args.sessionId;

      if (args.query === undefined || args.query === null || args.query.trim() === "") {
        logger.warn("No query provided or query is empty for agent_query, using default 'repository information'");
      }
    
    try {
      configService.reloadConfigsFromFile(true);

      const llmProvider = await getLLMProvider();
      logger.info(`Agent using provider: ${configService.SUGGESTION_PROVIDER}, model: ${configService.SUGGESTION_MODEL}`);
      const session = getOrCreateSession(initialSessionId, repoPath);
      const isGitRepo = await validateGitRepository(repoPath);
      const files = isGitRepo
        ? await git.listFiles({ fs, dir: repoPath, gitdir: path.join(repoPath, ".git"), ref: "HEAD" })
        : [];
      updateContext(session.id, repoPath, files); // Update context for the session

      const { results: searchResults, refinedQuery } = await searchWithRefinement(
        qdrantClient, 
        query, // query is already string
        files
      );
      const topScore = searchResults.length > 0 ? searchResults[0].score : 0;
      addQuery(session.id, query, searchResults, topScore);

      const searchContextSnippets = searchResults.map(r => ({
        filepath: r.payload.filepath,
        snippet: r.payload.content.slice(0, configService.MAX_SNIPPET_LENGTH),
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
      const agentResponse: AgentInitialQueryResponse = await planner.initiateAgentQuery(
        augmentedPrompt,
        session.id
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
          text: `# Error in Agent Query Tool\n\nThere was an unexpected error processing your query: ${error instanceof Error ? error.message : String(error)}\n\nPlease check the server logs for more details.`,
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
    async (args: { query: string; sessionId?: string }, _extra: RequestHandlerExtra<ServerRequest, ServerNotification>) => {
      logger.info(`Tool 'search_code' execution started.`);
      logger.info("Received args for search_code", { args });

      const searchQuery = args.query || "code search"; // Default if query is empty string
      const searchSessionId = args.sessionId;
      
      if (args.query === undefined || args.query === null || args.query.trim() === "") {
        logger.warn("No query provided or query is empty for search_code, using default 'code search'");
      }

    try {
      const session = getOrCreateSession(searchSessionId, repoPath);
    
      logger.info("Using query for search_code", { query: searchQuery, sessionId: session.id });
    
    const isGitRepo = await validateGitRepository(repoPath);
    const files = isGitRepo
      ? await git.listFiles({ fs, dir: repoPath, gitdir: path.join(repoPath, ".git"), ref: "HEAD" })
      : [];
    
    updateContext(session.id, repoPath, files);
    
    const { results, refinedQuery, relevanceScore } = await searchWithRefinement(
      qdrantClient, 
      searchQuery, 
      files
    );
    
    addQuery(session.id, searchQuery, results, relevanceScore); 
    
    const llmProvider = await getLLMProvider();
    
    const summaries = await Promise.all(results.map(async result => {
      const snippet = result.payload.content.slice(0, configService.MAX_SNIPPET_LENGTH);
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
        filepath: result.payload.filepath,
        snippet,
        summary,
        last_modified: result.payload.last_modified,
        relevance: result.score,
      };
    }));
    
    // Format the response as clean markdown
    const formattedResponse = `# Search Results for: "${searchQuery}"
${refinedQuery !== searchQuery ? `\n> Query refined to: "${refinedQuery}"` : ''}

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
    } catch (error: unknown) {
      logger.error("Error in search_code tool", { error: error instanceof Error ? error.message : String(error) });
      return {
        content: [{
          type: "text",
          text: `# Error in Search Code Tool\n\nThere was an unexpected error processing your query: ${error instanceof Error ? error.message : String(error)}\n\nPlease check the server logs for more details.`,
        }],
      };
    }
  });

  // Add get_changelog tool
  server.tool(
    "get_changelog",
    "Retrieves the content of the `CHANGELOG.md` file from the root of the repository. This provides a history of changes and versions for the project. \nExample: Call this tool without parameters: `{}`.",
    {},
    {
      annotations: { title: "Get Changelog" }
    },
    async (_args: Record<string, never>, _extra: RequestHandlerExtra<ServerRequest, ServerNotification>) => {
      try {
        const changelogPath = path.join(repoPath, 'CHANGELOG.md');
        const changelog = await fs.readFile(changelogPath, 'utf8'); 
        
        return {
          content: [{
            type: "text" as const,
            text: `# CodeCompass Changelog (v${VERSION})\n\n${changelog}`,
          }],
        };
      } catch (error: unknown) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        logger.error("Failed to read changelog", { message: errorMessage });
        return {
          content: [{
            type: "text" as const,
            text: `# Error Reading Changelog\n\nFailed to read the changelog file. Current version is ${VERSION}.`,
          }],
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
    (args: { sessionId: string }, _extra: RequestHandlerExtra<ServerRequest, ServerNotification>) => {
      logger.info("Received args for get_session_history", { args });

      const sessionIdValue = args.sessionId;

      if (typeof sessionIdValue !== 'string' || !sessionIdValue) {
        const errorMsg = "Session ID is required and must be a non-empty string.";
        logger.error(errorMsg, { receivedSessionId: String(sessionIdValue) });
        // Return an error structure consistent with other tools
        return {
          content: [{
            type: "text",
            text: `# Error Getting Session History\n\n${errorMsg}`,
          }],
        };
      }

    try {
      const session = getOrCreateSession(sessionIdValue);
      
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
          text: `# Error\n\n${error instanceof Error ? error.message : String(error)}`,
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
      async (args: { query: string; sessionId?: string }, _extra: RequestHandlerExtra<ServerRequest, ServerNotification>) => {
        logger.info(`Tool 'generate_suggestion' execution started.`);
        logger.info("Received args for generate_suggestion", { args });

        const queryStr = args.query || "code suggestion"; // Default if query is empty string
        const sessionIdFromParams = args.sessionId;

        if (args.query === undefined || args.query === null || args.query.trim() === "") {
          logger.warn("No query provided or query is empty for generate_suggestion, using default 'code suggestion'");
        }
        
      try {
        const session = getOrCreateSession(sessionIdFromParams, repoPath);
      
      logger.info("Using query for generate_suggestion", { query: queryStr, sessionId: session.id });
      
      const isGitRepo = await validateGitRepository(repoPath);
      const files = isGitRepo
        ? await git.listFiles({ fs, dir: repoPath, gitdir: path.join(repoPath, ".git"), ref: "HEAD" })
        : [];
      const _diff = await getRepositoryDiff(repoPath);
      
      updateContext(session.id, repoPath, files, _diff);
      
      const recentQueries = getRecentQueries(session.id);
      const relevantResults = getRelevantResults(session.id);
      
      const { results, refinedQuery } = await searchWithRefinement(
        qdrantClient, 
        queryStr, 
        files
      );
      
      // Map search results to context
      const context = results.map(r => ({
        filepath: r.payload.filepath,
        snippet: r.payload.content.slice(0, configService.MAX_SNIPPET_LENGTH),
        last_modified: r.payload.last_modified,
        relevance: r.score,
        note: ""
      }));
      
      if (context.length < 2 && relevantResults.length > 0) {
        const additionalContext = relevantResults
          .filter(r => !context.some(c => c.filepath === (r as DetailedQdrantSearchResult).payload?.filepath))
          .slice(0, 2)
          .map(rUnk => {
            const r = rUnk as DetailedQdrantSearchResult;
            return {
              filepath: r.payload?.filepath || "unknown",
              snippet: r.payload?.content?.slice(0, configService.MAX_SNIPPET_LENGTH) || "",
              last_modified: r.payload?.last_modified || "unknown",
              relevance: r.score || 0.5,
              note: "From previous related query"
            };
          });
        
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
Based on the provided context and snippets, generate a detailed code suggestion for "${queryStr}". Include:
- A suggested code implementation or improvement.
- An explanation of how it addresses the query.
- References to the provided snippets or context where applicable.
Ensure the suggestion is concise, practical, and leverages the repository's existing code structure. If the query is ambiguous, provide a general solution with assumptions clearly stated.
      `;
      
      const llmProvider: LLMProvider = await getLLMProvider();
      
      const suggestion = await llmProvider.generateText(prompt);
      
      addSuggestion(session.id, queryStr, suggestion);
      
      const formattedResponse = `# Code Suggestion for: "${queryStr}"
${refinedQuery !== queryStr ? `\n> Query refined to: "${refinedQuery}"` : ''}

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
      
      return {
          content: [{
            type: "text",
            text: formattedResponse,
          }],
        };
      } catch (error: unknown) {
        logger.error("Error in generate_suggestion tool", { error: error instanceof Error ? error.message : String(error) });
        return {
          content: [{
            type: "text",
            text: `# Error in Generate Suggestion Tool\n\nThere was an unexpected error processing your query: ${error instanceof Error ? error.message : String(error)}\n\nPlease check the server logs for more details.`,
          }],
        };
      }
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
      async (args: { query: string; sessionId?: string }, _extra: RequestHandlerExtra<ServerRequest, ServerNotification>) => {
        logger.info("Received args for get_repository_context", { args });

        const queryStrCtx = args.query || "repository context"; // Default if query is empty string
        const sessionIdFromParamsCtx = args.sessionId;

        if (args.query === undefined || args.query === null || args.query.trim() === "") {
          logger.warn("No query provided or query is empty for get_repository_context, using default 'repository context'");
        }
      
      const session = getOrCreateSession(sessionIdFromParamsCtx, repoPath);
      
      logger.info("Using query for repository context", { query: queryStrCtx, sessionId: session.id });
      
      const isGitRepo = await validateGitRepository(repoPath);
      const files = isGitRepo
        ? await git.listFiles({ fs, dir: repoPath, gitdir: path.join(repoPath, ".git"), ref: "HEAD" })
        : [];
      const _diff = await getRepositoryDiff(repoPath);
      
      updateContext(session.id, repoPath, files, _diff);
      
      const { results, refinedQuery } = await searchWithRefinement(
        qdrantClient, 
        queryStrCtx, 
        files
      );
      
      const recentQueries = getRecentQueries(session.id);
      
      const context = results.map(r => ({
        filepath: r.payload.filepath,
        snippet: r.payload.content.slice(0, configService.MAX_SNIPPET_LENGTH),
        last_modified: r.payload.last_modified,
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
Provide a concise summary of the context for "${queryStrCtx}" based on the repository files and recent changes. Highlight key information relevant to the query, referencing specific files or snippets where applicable.
      `;
      
      const llmProvider = await getLLMProvider();
      
      const summary = await llmProvider.generateText(summaryPrompt);
      
      addQuery(session.id, queryStrCtx, results);
      
      const formattedResponse = `# Repository Context Summary for: "${queryStrCtx}"
${refinedQuery !== queryStrCtx ? `\n> Query refined to: "${refinedQuery}"` : ''}

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
    
  }
}
