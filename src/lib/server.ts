import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { initMcpSafeLogging } from "./mcp-logger";
import fs from "fs/promises";
import * as fsSync from "fs"; // Keep for sync operations if any remain
import path from "path"; // Keep for local path operations
import git from "isomorphic-git";
import { QdrantClient } from "@qdrant/js-client-rest";
import { configService, logger } from "./config-service";
import * as deepseek from "./deepseek";
// model-persistence functions (loadModelConfig, forceUpdateModelConfig) are no longer directly used here.
// Their functionalities are covered by configService methods or were part of removed tools.

// Initialize MCP-safe logging immediately
initMcpSafeLogging();
import { DetailedQdrantSearchResult } from "./types"; // Changed QdrantSearchResult to DetailedQdrantSearchResult
import { z } from "zod";
import { checkOllama, checkOllamaModel } from "./ollama";
import { initializeQdrant } from "./qdrant"; // searchWithRefinement removed from here
import { searchWithRefinement } from "./query-refinement"; // Added import for searchWithRefinement
import { validateGitRepository, indexRepository, getRepositoryDiff } from "./repository";
import { getMetrics, resetMetrics, startMetricsLogging, trackToolChain, trackAgentRun } from "./metrics";
import { getLLMProvider, switchSuggestionModel, LLMProvider } from "./llm-provider"; // Added LLMProvider import
import { SuggestionPlanner } from "./suggestion-service"; // Added SuggestionPlanner import
import { AgentInitialQueryResponse, AgentState, AgentStepExecutionResponse, AgentStateSchema } from "./types"; // Added imports
import { VERSION } from "./version";
import { getOrCreateSession, addQuery, addSuggestion, addFeedback, updateContext, getRecentQueries, getRelevantResults } from "./state";
// import { runAgentLoop } from "./agent"; // This is now unused

// Generate a chain ID for tracking tool chains
function generateChainId(): string {
  return `chain_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;
}

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

    const server = new McpServer({
      name: "CodeCompass",
      version: VERSION,
      vendor: "CodeCompass",
      capabilities: {
        resources: {
          "repo://structure": {},
          "repo://files/*": {},
          "repo://health": {},
          "repo://metrics": {},
          "repo://provider": {},
          "repo://version": {},
        },
        tools: {
          search_code: {},
          get_repository_context: {},
          ...(suggestionModelAvailable ? { generate_suggestion: {} } : {}),
          get_changelog: {},
          agent_query: {}, // New agent tool that works regardless of suggestion model
          execute_agent_step: {}, // Tool to execute a single step of an agent's plan
          switch_suggestion_model: {}, // Add the switch_suggestion_model tool to capabilities
          check_provider: {}, // Add the check_provider tool to capabilities
          reset_metrics: {}, // Add reset_metrics tool to capabilities
          // debug_provider is removed
          // reset_provider is removed
          deepseek_diagnostic: {}, // Add deepseek_diagnostic tool
          force_deepseek_connection: {}, // Add force_deepseek_connection tool
        },
      },
    });

    // Register resources
    if (typeof server.resource !== "function") {
      throw new Error("MCP server does not support 'resource' method");
    }
    
    // Add health check resource
    server.resource("repo://health", "repo://health", {}, async () => {
      const status = {
        ollama: await checkOllama().then(() => "healthy").catch(() => "unhealthy"),
        qdrant: await qdrantClient.getCollections().then(() => "healthy").catch(() => "unhealthy"),
        repository: await validateGitRepository(repoPath) ? "healthy" : "unhealthy",
        version: VERSION,
        timestamp: new Date().toISOString()
      };
      return { contents: [{ uri: "repo://health", text: JSON.stringify(status, null, 2) }] };
    });
    
    // Add metrics resource
    server.resource("repo://metrics", "repo://metrics", {}, async () => {
      const metrics = getMetrics();
      return { contents: [{ uri: "repo://metrics", text: JSON.stringify(metrics, null, 2) }] };
    });
    
    // Add provider status resource
    server.resource("repo://provider", "repo://provider", {}, async () => {
      const { getCurrentProviderInfo } = await import("./test-provider");
      const providerInfo = await getCurrentProviderInfo();
      return { contents: [{ uri: "repo://provider", text: JSON.stringify(providerInfo, null, 2) }] };
    });
    
    // Add version resource
    server.resource("repo://version", "repo://version", {}, async () => {
      return { contents: [{ uri: "repo://version", text: VERSION }] };
    });
    server.resource("repo://structure", "repo://structure", {}, async () => {
      const isGitRepo = await validateGitRepository(repoPath);
      const files = isGitRepo
        ? await git.listFiles({ fs, dir: repoPath, gitdir: path.join(repoPath, ".git"), ref: "HEAD" })
        : [];
      return { contents: [{ uri: "repo://structure", text: files.join("\n") }] };
    });

    server.resource("repo://files/*", "repo://files/*", {}, async (uri: URL) => {
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
    // The get_repository_context tool is registered within registerTools.
    // Its internal logic handles behavior when suggestionModelAvailable is false.
    // No need for a separate conditional registration here.
    
  
    // Register the switch suggestion model tool
    server.tool(
      "switch_suggestion_model",
      "Switch between different suggestion models (e.g., llama3.1:8b, deepseek-coder) while keeping embeddings on ollama.",
      {
        model: z.string().describe("The suggestion model to switch to (e.g., llama3.1:8b, deepseek-coder)")
      },
      async (params: unknown) => {
        const chainId = generateChainId();
        trackToolChain(chainId, "switch_suggestion_model");
      
        logger.info("Received params for switch_suggestion_model", { params });
        const normalizedParams = normalizeToolParams(params);
        logger.debug("Normalized params for switch_suggestion_model", normalizedParams);
      
        // Parameters should conform to the Zod schema: { model: string }
        // normalizeToolParams ensures we have an object.
        let modelToSwitchTo: string;

        if (normalizedParams && typeof normalizedParams.model === 'string') {
          modelToSwitchTo = normalizedParams.model;
        } else {
          // Fallback or error if 'model' parameter is missing or not a string
          // This case should ideally be caught by Zod validation if params come directly from client
          // If normalizeToolParams converted a non-object/non-JSON-string to { query: ... },
          // then .model would be undefined.
          logger.error("Invalid or missing 'model' parameter for switch_suggestion_model.", { normalizedParams });
          return {
            content: [{
              type: "text",
              text: "# Error Switching Suggestion Model\n\nInvalid or missing 'model' parameter. Please provide the model name as a string.",
            }],
          };
        }
      
        logger.info(`Requested model: ${modelToSwitchTo}`);
        
        // Ensure we're using the exact model name provided
        const normalizedModel = modelToSwitchTo.toLowerCase();
        
        // Store the requested model for verification later
        const requestedModel = normalizedModel;
        
        try {
          // Determine if this is a DeepSeek model
          const isDeepSeekModel = normalizedModel.includes('deepseek');
          
          // For DeepSeek models, ensure we have the API key and endpoint configured
          if (isDeepSeekModel) {
            // Check API key
            if (!await deepseek.checkDeepSeekApiKey()) {
              return {
                content: [{
                  type: "text",
                  text: `# Failed to Switch Suggestion Model\n\nUnable to switch to ${modelToSwitchTo}. DeepSeek API key is not configured.\n\nPlease set the DEEPSEEK_API_KEY environment variable and try again.`,
                }],
              };
            }
            
            // Check API endpoint via ConfigService
            if (!configService.DEEPSEEK_API_URL) { // Or check against a known default if that's the logic
              logger.warn("DeepSeek API URL not set (checked via ConfigService), using default endpoint from ConfigService.");
            }
          }
        
          // Switch the suggestion model
          const success = await switchSuggestionModel(normalizedModel);
        
          if (!success) {
            return {
              content: [{
                type: "text",
                text: `# Failed to Switch Suggestion Model\n\nUnable to switch to ${modelToSwitchTo}. Please check your configuration and logs for details.`,
              }],
            };
          }
        
          // Get the actual values from ConfigService to ensure we're reporting what was actually set
          const actualModel = configService.SUGGESTION_MODEL;
          const actualProvider = configService.SUGGESTION_PROVIDER;
          const embeddingProvider = configService.EMBEDDING_PROVIDER;
        
          // Log the current models and providers to debug
          logger.info(`Current suggestion model from ConfigService: ${actualModel}, provider: ${actualProvider}, embedding: ${embeddingProvider}`);
          
          // Verify that the model was actually changed
          if (actualModel !== requestedModel) {
            logger.error(`Model switch failed: requested ${requestedModel} but ConfigService reports ${actualModel}. Attempting to force set via ConfigService.`);
            
            // Force set the model via ConfigService
            configService.setSuggestionModel(requestedModel);
            configService.setSuggestionProvider(requestedModel.includes('deepseek') ? 'deepseek' : 'ollama');
            
            logger.info(`Forced model to ${configService.SUGGESTION_MODEL} and provider to ${configService.SUGGESTION_PROVIDER} via ConfigService.`);
            
            // Check if the force-set worked by reading back from ConfigService
            if (configService.SUGGESTION_MODEL !== requestedModel) {
              return {
                content: [{
                  type: "text",
                  text: `# Error Switching Suggestion Model\n\nFailed to switch to ${requestedModel}. The model is still set to ${configService.SUGGESTION_MODEL}.\n\nPlease check the logs for more details.`,
                }],
              };
            }
          }
        
          // Use the requested model in the response to ensure consistency
          return {
            content: [{
              type: "text",
              text: `# Suggestion Model Switched\n\nSuccessfully switched to ${configService.SUGGESTION_MODEL} for suggestions.\n\nUsing ${configService.SUGGESTION_MODEL} (${configService.SUGGESTION_PROVIDER} provider) for suggestions and ${configService.EMBEDDING_PROVIDER} for embeddings.\n\nTo make this change permanent, set the SUGGESTION_MODEL environment variable to '${configService.SUGGESTION_MODEL}' or update ~/.codecompass/model-config.json.`,
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

    // Register deepseek_diagnostic tool
    server.tool(
      "deepseek_diagnostic",
      "Run a diagnostic check for DeepSeek API configuration and connectivity.",
      {}, // No parameters needed
      async () => {
        logger.info("Running deepseek_diagnostic tool");
        try {
          const diagnosticResult = await import("./server-tools/deepseek-diagnostic").then(
            module => module.deepseekDiagnostic()
          );
          // Format the result as markdown text
          const { configuration, apiKeyStatus, connectionStatus, timestamp, troubleshootingSteps } = diagnosticResult as any;
          const text = `# DeepSeek Diagnostic Report\n\n` +
                       `**Timestamp:** ${timestamp}\n\n` +
                       `## Configuration from ConfigService:\n` +
                       `- DEEPSEEK_API_KEY: ${configuration.DEEPSEEK_API_KEY}\n` +
                       `- DEEPSEEK_API_URL: ${configuration.DEEPSEEK_API_URL}\n` +
                       `- DEEPSEEK_MODEL: ${configuration.DEEPSEEK_MODEL}\n` +
                       `- SUGGESTION_PROVIDER: ${configuration.SUGGESTION_PROVIDER}\n` +
                       `- SUGGESTION_MODEL: ${configuration.SUGGESTION_MODEL}\n\n` +
                       `**API Key Status:** ${apiKeyStatus}\n` +
                       `**Connection Status:** ${connectionStatus}\n\n` +
                       `## Troubleshooting Steps:\n` +
                       `${(troubleshootingSteps as string[]).map(step => `- ${step}`).join('\n')}\n`;
          return { content: [{ type: "text", text }] };
        } catch (error: unknown) {
          const err = error as Error;
          logger.error("Error in deepseek_diagnostic tool", { error: err.message });
          return { content: [{ type: "text", text: `# Error in DeepSeek Diagnostic\n\n${err.message}` }] };
        }
      }
    );

    // Register force_deepseek_connection tool
    server.tool(
      "force_deepseek_connection",
      "Force a direct test connection to DeepSeek API with specified or default parameters. Bypasses some local config checks for direct testing.",
      { // Define expected parameters, all optional as they can fallback to configService/env
        apiKey: z.string().optional().describe("DeepSeek API Key to test with."),
        apiUrl: z.string().optional().describe("DeepSeek API URL to test against."),
        model: z.string().optional().describe("DeepSeek model to use for the test.")
      },
      async (params: unknown) => {
        logger.info("Running force_deepseek_connection tool");
        const normalizedParams = normalizeToolParams(params); // Ensure params are an object
        try {
          const connectionResult = await import("./server-tools/force-deepseek-connection").then(
            module => module.forceDeepseekConnection(normalizedParams)
          );
          // Format the result as markdown text
          const { success, error, errorCode, responseStatus, responseData, troubleshooting, ...otherDetails } = connectionResult as any;
          let text = `# Force DeepSeek Connection Test Report\n\n` +
                     `**Success:** ${success ? "✅ Yes" : "❌ No"}\n\n`;
          if (error) {
            text += `**Error:** ${error}\n`;
            if (errorCode) text += `**Error Code:** ${errorCode}\n`;
            if (responseStatus) text += `**Response Status:** ${responseStatus}\n`;
            if (responseData) text += `**Response Data:** \`\`\`json\n${JSON.stringify(responseData, null, 2)}\n\`\`\`\n`;
          }
          text += `**Details:**\n` +
                  `${Object.entries(otherDetails).map(([key, value]) => `- ${key}: ${JSON.stringify(value)}`).join('\n')}\n\n`;
          if (troubleshooting && (troubleshooting as string[]).length > 0) {
            text += `## Troubleshooting Steps:\n` +
                    `${(troubleshooting as string[]).map(step => `- ${step}`).join('\n')}\n`;
          }
          return { content: [{ type: "text", text }] };
        } catch (error: unknown) {
          const err = error as Error;
          logger.error("Error in force_deepseek_connection tool", { error: err.message });
          return { content: [{ type: "text", text: `# Error in Force DeepSeek Connection\n\n${err.message}` }] };
        }
      }
    );
    
    // Register custom RPC methods
    // Note: Using type assertion to handle potential missing method in the type definition
    const serverWithMethods = server as unknown as { registerMethod?: (name: string, handler: () => Promise<unknown>) => void };
    
    if (typeof serverWithMethods.registerMethod !== "function") {
      logger.warn("MCP server does not support 'registerMethod', some functionality may be limited");
    } else {
      // Register prompts/list method
      serverWithMethods.registerMethod("prompts/list", async () => {
        logger.info("Handling prompts/list request");
        return {
          prompts: [
            {
              id: "repository-context",
              name: "Repository Context",
              description: "Get context about your repository",
              template: "Provide context about {{query}} in this repository"
            },
            {
              id: "code-suggestion",
              name: "Code Suggestion",
              description: "Generate code suggestions",
              template: "Suggest code for {{query}}"
            },
            {
              id: "code-analysis",
              name: "Code Analysis",
              description: "Analyze code problems",
              template: "Analyze this code problem: {{query}}"
            }
          ]
        };
      });
    }
    
    // Start metrics logging
    const metricsInterval = startMetricsLogging(300000); // Log metrics every 5 minutes
    
    // Configure transport to use proper JSON formatting
    const transport = new StdioServerTransport();
    
    // Log startup info to file
    logger.info(`CodeCompass MCP server v${VERSION} running for repository: ${repoPath}`);
    const registeredTools = (server as any).capabilities?.tools || {};
    logger.info(`CodeCompass server started with tools: ${Object.keys(registeredTools).join(', ')}`);
    
    // Display version and status to stderr (similar to Context7)
    console.error(`CodeCompass v${VERSION} MCP Server running on stdio`);
    
    // Connect to transport after registering all capabilities
    await server.connect(transport);
    
    // Ensure metrics interval is cleared on shutdown
    process.on('SIGINT', () => {
      clearInterval(metricsInterval);
      logger.info("Server shutting down, metrics logging stopped");
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
    "Run an AI agent that can perform multiple steps to answer complex questions about your codebase. The agent can use other tools internally to gather information and provide a comprehensive response.",
    {
      query: z.string().describe("The question or task for the agent to process"),
      sessionId: z.string().optional().describe("Optional session ID to maintain context between requests"),
      maxSteps: z.number().default(5).describe("Maximum number of reasoning steps the agent should take (default: 5)")
    },
    async (params: unknown) => {
      const chainId = generateChainId();
      trackToolChain(chainId, "agent_query");
      trackAgentRun();
      logger.info(`Tool 'agent_query' execution started. Chain ID: ${chainId}`);
      
      logger.info("Received params for agent_query", { params });
      const normalizedParams = normalizeToolParams(params);
      logger.debug("Normalized params for agent_query", normalizedParams);
      
      // Ensure query exists
      if (!normalizedParams.query && typeof normalizedParams === 'object') {
        normalizedParams.query = "repository information";
        logger.warn("No query provided for agent_query, using default");
      }
      
      const { query, sessionId } = normalizedParams; // maxSteps is not used in initiateAgentQuery directly
    
    try {
      // Ensure ConfigService reflects the latest state from files.
      configService.reloadConfigsFromFile(true);

      const llmProvider = await getLLMProvider(); // Uses configService
      logger.info(`Agent using provider: ${configService.SUGGESTION_PROVIDER}, model: ${configService.SUGGESTION_MODEL}`);
      
      const planner = new SuggestionPlanner(llmProvider);
      const initialResponse: AgentInitialQueryResponse = await planner.initiateAgentQuery(
        query as string,
        sessionId as string | undefined
      );

      if (initialResponse.status === "ERROR") {
        logger.error("Error in agent_query during plan initiation", { 
          sessionId: initialResponse.sessionId, 
          message: initialResponse.message 
        });
        return {
          content: [{
            type: "text",
            text: `# Agent Query Failed\n\nSession ID: ${initialResponse.sessionId}\nStatus: ${initialResponse.status}\nMessage: ${initialResponse.message}\n\nAgent State:\n\`\`\`json\n${JSON.stringify(initialResponse.agentState, null, 2)}\n\`\`\``,
          }],
        };
      }
      
      const responseText = `# Agent Query Initiated Successfully

**Session ID:** ${initialResponse.sessionId}
**Status:** ${initialResponse.status}
**Message:** ${initialResponse.message}

## Generated Plan
\`\`\`
${initialResponse.generatedPlanText || "No plan text generated."}
\`\`\`

**Next Steps:** To execute this plan, use the session ID (\`${initialResponse.sessionId}\`) with a subsequent command designed for step-by-step execution (e.g., a future 'execute_agent_step' tool or an enhanced 'agent_query' tool).

**Current Agent State:**
\`\`\`json
${JSON.stringify(initialResponse.agentState, null, 2)}
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

  // Tool to execute the next step of an agent's plan
  server.tool(
    "execute_agent_step",
    "Executes the next step of an agent's plan based on the current agent state. Returns the outcome of the step and the updated agent state.",
    {
      sessionId: z.string().describe("The session ID for the ongoing agent query."),
      // The agentState should be passed by the client.
      // This makes the tool stateless regarding agent execution history beyond what's in AgentState.
      agentState: AgentStateSchema.describe("The current state of the agent, including the plan and executed steps.")
    },
    async (params: unknown) => {
      const chainId = generateChainId();
      trackToolChain(chainId, "execute_agent_step");
      logger.info(`Tool 'execute_agent_step' execution started. Chain ID: ${chainId}`);

      logger.info("Received params for execute_agent_step", { params });
      const normalizedParams = normalizeToolParams(params);
      logger.debug("Normalized params for execute_agent_step", normalizedParams);

      const { sessionId, agentState } = normalizedParams as { sessionId: string, agentState: AgentState };

      if (!agentState || typeof agentState !== 'object' || agentState.sessionId !== sessionId) {
        logger.error("Invalid agentState provided for execute_agent_step", { sessionId, agentState });
        return {
          content: [{
            type: "text",
            text: `# Error in Agent Step Execution\n\nInvalid or missing agentState provided. Ensure the agentState object is correctly passed and matches the sessionId.`,
          }],
        };
      }
      
      try {
        // Ensure ConfigService reflects the latest state from files.
        configService.reloadConfigsFromFile(true);
        const llmProvider = await getLLMProvider();
        const planner = new SuggestionPlanner(llmProvider);

        const stepResponse: AgentStepExecutionResponse = await planner.executeNextAgentStep(
          agentState as AgentState // Cast as AgentState, validated by Zod schema at tool level
        );

        if (stepResponse.status === "ERROR") {
          logger.error("Error in agent_step_execution during step execution", { 
            sessionId: stepResponse.sessionId, 
            message: stepResponse.message 
          });
        }
        
        // Format the response
        let responseText = `# Agent Step Execution Result
**Session ID:** ${stepResponse.sessionId}
**Status:** ${stepResponse.status}
**Message:** ${stepResponse.message}
`;

        if (stepResponse.executedStep) {
          responseText += `
## Executed Step
**Reasoning:** ${stepResponse.executedStep.reasoning}
**Output:** 
\`\`\`
${stepResponse.executedStep.output}
\`\`\`
`;
        }
        
        responseText += `
**Updated Agent State:**
\`\`\`json
${JSON.stringify(stepResponse.agentState, null, 2)}
\`\`\`
`;
        if (stepResponse.status === "COMPLETED" && stepResponse.agentState.finalResponse) {
          responseText += `
## Final Response
\`\`\`
${stepResponse.agentState.finalResponse}
\`\`\`
`;
        } else if (stepResponse.status === "STEP_EXECUTED") {
           responseText += `
**Next Steps:** To continue, call 'execute_agent_step' again with this updated Agent State.`;
        }


        return {
          content: [{
            type: "text",
            text: responseText,
          }],
        };

      } catch (error: unknown) {
        logger.error("Error in execute_agent_step tool", { error: error instanceof Error ? error.message : String(error), sessionId });
        return {
          content: [{
            type: "text",
            text: `# Error in Agent Step Execution Tool\n\nThere was an unexpected error processing the agent step: ${(error as Error).message}\n\nPlease check the server logs for more details.`,
          }],
        };
      }
    }
  );
  
  // Search Code Tool with iterative refinement
  server.tool(
    "search_code",
    "Search for code in your repository based on a query. This function uses semantic search to find relevant code snippets that match your query.",
    {
      query: z.string().describe("The search query to find relevant code in the repository"),
      sessionId: z.string().optional().describe("Optional session ID to maintain context between requests")
    },
    async (params: unknown) => {
      const chainId = generateChainId();
      trackToolChain(chainId, "search_code");
      logger.info(`Tool 'search_code' execution started. Chain ID: ${chainId}`);
        
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
    "Retrieve the changelog for the repository. This function returns the contents of the CHANGELOG.md file if it exists.",
    {},
    async () => {
      try {
        const changelogPath = path.join(repoPath, 'CHANGELOG.md');
        const changelog = await fs.readFile(changelogPath, 'utf8');
        
        return {
          content: [{
            type: "text",
            text: `# CodeCompass Changelog (v${VERSION})\n\n${changelog}`,
          }],
        };
      } catch (error) {
        logger.error("Failed to read changelog", { error });
        return {
          content: [{
            type: "text",
            text: `# Error Reading Changelog\n\nFailed to read the changelog file. Current version is ${VERSION}.`,
          }],
        };
      }
    }
  );
  
  // Add reset_metrics tool
  server.tool(
    "reset_metrics",
    "Reset all the tracking metrics for the current session. This is useful for benchmarking or starting fresh measurements.",
    {},
    async () => {
      resetMetrics();
      return {
        content: [{
          type: "text",
          text: "# Metrics Reset\n\nAll metrics have been reset successfully.",
        }],
      };
    }
  );
  
  // Add check_provider tool
  server.tool(
    "check_provider",
    "Check the current LLM provider status, configuration, and test the connection.",
    {}, // No parameters needed, checkProviderDetailed is always verbose.
    async () => {
      logger.info("Running check_provider tool");
      try {
        const { checkProviderDetailed } = await import("./server-tools/check-provider");
        const result = await checkProviderDetailed() as any; // Cast to any to access properties

        const text = `# LLM Provider Status Report\n\n` +
                     `**Timestamp:** ${result.timestamp}\n\n` +
                     `## Effective Configuration (from ConfigService):\n` +
                     `- Suggestion Model: ${result.environment.SUGGESTION_MODEL}\n` +
                     `- Suggestion Provider: ${result.environment.SUGGESTION_PROVIDER}\n` +
                     `- Embedding Provider: ${result.environment.EMBEDDING_PROVIDER}\n` +
                     `- DeepSeek API Key: ${result.environment.DEEPSEEK_API_KEY}\n` +
                     `- DeepSeek API URL: ${result.environment.DEEPSEEK_API_URL}\n` +
                     `- DeepSeek Model (for tests): ${result.model}\n` +
                     `- Ollama Host: ${result.environment.OLLAMA_HOST}\n\n` +
                     `## Global Variables (set by ConfigService):\n` +
                     `- CURRENT_SUGGESTION_MODEL: ${result.globals.CURRENT_SUGGESTION_MODEL}\n` +
                     `- CURRENT_SUGGESTION_PROVIDER: ${result.globals.CURRENT_SUGGESTION_PROVIDER}\n` +
                     `- CURRENT_EMBEDDING_PROVIDER: ${result.globals.CURRENT_EMBEDDING_PROVIDER}\n\n` +
                     `## Connectivity & Status:\n` +
                     `- API Key Configured (for DeepSeek): ${result.apiKeyConfigured ? "✅ Yes" : "❌ No"}\n` +
                     `- API Endpoint Configured (for DeepSeek): ${result.apiEndpointConfigured ? "✅ Yes" : "❌ No"}\n` +
                     `- Connection Status: ${result.connectionStatus}\n\n` +
                     `## Notes:\n${result.noteText}\n\n` +
                     `To switch suggestion models, use the \`switch_suggestion_model\` tool.\n` +
                     `For more detailed DeepSeek diagnostics, use the \`deepseek_diagnostic\` tool.`;
        
        return { content: [{ type: "text", text }] };
      } catch (error: unknown) {
        const err = error as Error;
        logger.error("Error in check_provider tool", { error: err.message });
        return { content: [{ type: "text", text: `# Error in Provider Check\n\n${err.message}` }] };
      }
    }
  );
  
  // Add get_session_history tool
  server.tool(
    "get_session_history",
    "Retrieve the history of queries and suggestions from a specific session. This helps track your interaction with CodeCompass.",
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
      "Generate code suggestions based on a query or prompt. This function uses AI to provide implementation ideas and code examples.",
      {
        query: z.string().describe("The query or prompt for generating code suggestions"),
        sessionId: z.string().optional().describe("Optional session ID to maintain context between requests")
      },
      async (params: unknown) => {
        const chainId = generateChainId();
        trackToolChain(chainId, "generate_suggestion");
        logger.info(`Tool 'generate_suggestion' execution started. Chain ID: ${chainId}`);
        
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
      trackToolChain(chainId, "search_code");
      
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

Session ID: ${session.id} (Use this ID in future requests to maintain context)
Feedback ID: ${chainId} (Use this ID to provide feedback on this suggestion)`;
      
      return {
        content: [{
          type: "text",
          text: formattedResponse,
        }],
      };
    });
    
    // Add a new feedback tool
    server.tool(
      "provide_feedback",
      "Provide feedback on a suggestion to improve future recommendations.",
      {
        sessionId: z.string().describe("The session ID that received the suggestion"),
        feedbackId: z.string().optional().describe("The ID of the suggestion to provide feedback for"),
        score: z.number().min(1).max(10).describe("Rating score from 1-10"),
        comments: z.string().describe("Detailed feedback comments"),
        originalQuery: z.string().describe("The original query that generated the suggestion"),
        suggestion: z.string().describe("The suggestion that was provided")
      },
      async (params: unknown) => {
        logger.info("Received params for provide_feedback", { params });
        const normalizedParams = normalizeToolParams(params);
        logger.debug("Normalized params for provide_feedback", normalizedParams);
        
        try {
          const { sessionId, score, comments, originalQuery, suggestion } = normalizedParams;
      
        // Get session
        const session = getOrCreateSession(sessionId as string);
        
        // Add feedback to session
        addFeedback(session.id, score as number, comments as string);
        
        // Get the current LLM provider
        const llmProvider = await getLLMProvider();
        
        // Process feedback to improve the suggestion
        const improvedSuggestion = await llmProvider.processFeedback(
          originalQuery as string,
          suggestion as string,
          comments as string,
          score as number
        );
      
        // Format the response
        const formattedResponse = `# Improved Suggestion Based on Your Feedback

Thank you for your feedback (score: ${score}/10).

## Original Query
${originalQuery}

## Your Feedback
${comments}

## Improved Suggestion
${improvedSuggestion}

Session ID: ${session.id}`;
        
        return {
          content: [{
            type: "text",
            text: formattedResponse,
          }],
        };
      } catch (error: unknown) {
        logger.error("Error processing feedback", { error: (error as Error).message });
        return {
          content: [{
            type: "text",
            text: `# Error Processing Feedback\n\n${(error as Error).message}\n\nPlease ensure you provide all required parameters: sessionId, feedbackId, score, comments, originalQuery, and suggestion.`,
          }],
        };
      }
    });

    // Get Repository Context Tool with state management
    server.tool(
      "get_repository_context",
      "Get high-level context about your repository related to a specific query. This provides an overview of relevant project structure, patterns, and conventions.",
      {
        query: z.string().describe("The query to get repository context for"),
        sessionId: z.string().optional().describe("Optional session ID to maintain context between requests")
      },
      async (params: unknown) => {
        const chainId = generateChainId();
        trackToolChain(chainId, "get_repository_context");
        
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
    
    // Add a new tool for multi-step reasoning
    server.tool(
      "analyze_code_problem",
      "Analyze a code problem through multiple steps: problem analysis, root cause identification, and implementation planning.",
      {
        query: z.string().describe("Description of the code problem to analyze"),
        sessionId: z.string().optional().describe("Optional session ID to maintain context between requests")
      },
      async (params: unknown) => {
        const chainId = generateChainId();
        trackToolChain(chainId, "analyze_code_problem");
        logger.info(`Tool 'analyze_code_problem' execution started. Chain ID: ${chainId}`);
        
        logger.info("Received params for analyze_code_problem", { params });
        const normalizedParams = normalizeToolParams(params);
        logger.debug("Normalized params for analyze_code_problem", normalizedParams);
        
        // Ensure query exists
        if (!normalizedParams.query && typeof normalizedParams === 'object') {
          normalizedParams.query = "code problem";
          logger.warn("No query provided for analyze_code_problem, using default");
        }
        
        const { query = "code problem", sessionId } = normalizedParams;
      
      // Get or create session
      const session = getOrCreateSession(sessionId as string | undefined, repoPath);
      
      // Step 1: Get repository context
      trackToolChain(chainId, "get_repository_context");
      logger.info("Step 1: Getting repository context");
      
      const isGitRepo = await validateGitRepository(repoPath);
      const files = isGitRepo
        ? await git.listFiles({ fs, dir: repoPath, gitdir: path.join(repoPath, ".git"), ref: "HEAD" })
        : [];
      const _diff = await getRepositoryDiff(repoPath);
      
      // Use iterative query refinement to find relevant code
      const { results: contextResults } = await searchWithRefinement(
        qdrantClient, 
        query as string, 
        files
      );
      
      const context = contextResults.map(r => ({
        filepath: (r.payload as DetailedQdrantSearchResult['payload']).filepath,
        snippet: (r.payload as DetailedQdrantSearchResult['payload']).content.slice(0, configService.MAX_SNIPPET_LENGTH),
        last_modified: (r.payload as DetailedQdrantSearchResult['payload']).last_modified,
        relevance: r.score,
      }));
      
      // Step 2: Analyze the problem
      trackToolChain(chainId, "analyze_problem");
      logger.info("Step 2: Analyzing the problem");
      
      const analysisPrompt = `
**Code Problem Analysis**

Problem: ${query}

**Relevant Code**:
${context.map(c => `File: ${c.filepath}\n\`\`\`\n${c.snippet}\n\`\`\``).join("\n\n")}

**Instructions**:
1. Analyze the problem described above.
2. Identify potential causes based on the code snippets.
3. List possible solutions.
4. Recommend the best approach.

Structure your analysis with these sections:
- Problem Understanding
- Root Cause Analysis
- Potential Solutions
- Recommended Approach
      `;
      
      // Get the current LLM provider
      const llmProvider = await getLLMProvider();
      
      const analysis = await llmProvider.generateText(analysisPrompt);
      
      // Step 3: Generate implementation plan
      trackToolChain(chainId, "generate_implementation_plan");
      logger.info("Step 3: Generating implementation plan");
      
      const planPrompt = `
Based on your analysis of the problem:

${analysis}

Generate a step-by-step implementation plan to solve this problem. Include:
1. Files that need to be modified
2. Specific changes to make
3. Any new code that needs to be written
4. Testing approach to verify the solution works
      `;
      
      const implementationPlan = await llmProvider.generateText(planPrompt);
      
      // Add to session
      addQuery(session.id, query as string, contextResults);
      addSuggestion(session.id, analysisPrompt, analysis);
      addSuggestion(session.id, planPrompt, implementationPlan);
      
      // Format the response
      const formattedResponse = `# Code Problem Analysis: "${query}"

## Problem Analysis
${analysis}

## Implementation Plan
${implementationPlan}

## Relevant Code
${context.map(c => `
### ${c.filepath}
- Last modified: ${c.last_modified}
- Relevance: ${c.relevance.toFixed(2)}

\`\`\`
${c.snippet}
\`\`\`
`).join('\n')}

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
