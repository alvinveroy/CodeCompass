import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { initMcpSafeLogging, restoreConsole } from "./mcp-logger";
import fs from "fs/promises";
import path from "path";
import git from "isomorphic-git";
import { QdrantClient } from "@qdrant/js-client-rest";
import { logger, COLLECTION_NAME, MAX_SNIPPET_LENGTH, LLM_PROVIDER } from "./config";
import * as deepseek from "./deepseek";

// Initialize MCP-safe logging immediately
initMcpSafeLogging();
import { QdrantSearchResult } from "./types";
import { z } from "zod";
import { checkOllama, checkOllamaModel } from "./ollama";
import { initializeQdrant, searchWithRefinement } from "./qdrant";
import { validateGitRepository, indexRepository, getRepositoryDiff } from "./repository";
import { getMetrics, resetMetrics, startMetricsLogging, trackToolChain, trackAgentRun, trackAgentCompletion, trackAgentToolUsage } from "./metrics";
import { getLLMProvider, switchLLMProvider, switchSuggestionModel } from "./llm-provider";
import { VERSION } from "./version";
import { getOrCreateSession, addQuery, addSuggestion, addFeedback, updateContext, getRecentQueries, getRelevantResults, addAgentSteps } from "./state";
import { runAgentLoop, parseToolCalls } from "./agent";

// Normalize tool parameters to handle various input formats
export function normalizeToolParams(params: unknown): Record<string, any> {
  try {
    // Handle stringified JSON input
    if (typeof params === "string") {
      try {
        const parsed = JSON.parse(params);
        return parsed;
      } catch {
        // If it's not valid JSON, treat it as a query string
        return { query: params };
      }
    } 
    
    // Handle object input
    if (typeof params === 'object' && params !== null) {
      if ('query' in params || 'prompt' in params || 'sessionId' in params) {
        return params as Record<string, any>;
      } else {
        // If no query property exists but we have an object, use the entire object as the query
        return { query: JSON.stringify(params) };
      }
    }
    
    // Handle primitive values
    return { query: String(params) };
  } catch (error: any) {
    logger.error("Failed to normalize parameters", { message: error.message });
    throw new Error("Invalid input format: parameters must be a valid JSON object or string");
  }
}

// Function to register the get_repository_context tool separately
async function registerGetRepositoryContextTool(
  server: McpServer,
  qdrantClient: QdrantClient,
  repoPath: string
): Promise<void> {
  if (typeof server.tool !== "function") {
    throw new Error("MCP server does not support 'tool' method");
  }
  
  // Get Repository Context Tool with simplified implementation for when suggestion model is unavailable
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
      
      logger.info("Received params for get_repository_context (simplified)", { params });
      const normalizedParams = normalizeToolParams(params);
      logger.debug("Normalized params for get_repository_context (simplified)", normalizedParams);
        
      // Handle the case where params might be a JSON string with a query property
      let parsedParams = normalizedParams;
      if (typeof normalizedParams === 'string') {
        try {
          const parsed = JSON.parse(normalizedParams);
          if (parsed && typeof parsed === 'object') {
            parsedParams = parsed;
          }
        } catch (e) {
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
    const session = getOrCreateSession(sessionId, repoPath);
    
    // Log the extracted query to confirm it's working
    logger.info("Extracted query for repository context", { query, sessionId: session.id });
    
    const isGitRepo = await validateGitRepository(repoPath);
    const files = isGitRepo
      ? await git.listFiles({ fs, dir: repoPath, gitdir: path.join(repoPath, ".git"), ref: "HEAD" })
      : [];
    const diff = await getRepositoryDiff(repoPath);
    
    // Update context in session
    updateContext(session.id, repoPath, files, diff);
    
    // Use iterative query refinement
    const { results, refinedQuery } = await searchWithRefinement(
      qdrantClient, 
      query, 
      files
    );
    
    // Get recent queries from session to provide context
    const recentQueries = getRecentQueries(session.id);
    
    const context = results.map(r => ({
      filepath: (r.payload as QdrantSearchResult['payload']).filepath,
      snippet: (r.payload as QdrantSearchResult['payload']).content.slice(0, MAX_SNIPPET_LENGTH),
      last_modified: (r.payload as QdrantSearchResult['payload']).last_modified,
      relevance: r.score,
    }));
    
    // Add query to session
    addQuery(session.id, query, results);
    
    // Format the response as clean markdown without using the suggestion model
    const formattedResponse = `# Repository Context Summary for: "${query}"
${refinedQuery !== query ? `\n> Query refined to: "${refinedQuery}"` : ''}

## Summary
Repository context information for "${query}" is available in the files below.
Note: Detailed summary unavailable (suggestion model not loaded).

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
${diff}
\`\`\`

Session ID: ${session.id} (Use this ID in future requests to maintain context)`;
    
    return {
      content: [{
        type: "text",
        text: formattedResponse,
      }],
    };
  });
  
  logger.info("get_repository_context tool registered separately");
}

// Generate a chain ID for tracking tool chains
function generateChainId(): string {
  return `chain_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;
}

// Start Server
export async function startServer(repoPath: string): Promise<void> {
  // MCP-safe logging is already initialized at the top of the file
  
  // Use file logging instead of stdout
  logger.info("Starting CodeCompass MCP server...");

  try {
    // Set default suggestion model if specified in environment
    if (process.env.SUGGESTION_MODEL) {
      logger.info(`Using suggestion model from environment: ${process.env.SUGGESTION_MODEL}`);
      await switchSuggestionModel(process.env.SUGGESTION_MODEL);
    }
    
    // Validate repoPath
    if (!repoPath || repoPath === "${workspaceFolder}" || repoPath.trim() === "") {
      logger.warn("Invalid repository path provided, defaulting to current directory");
      repoPath = process.cwd();
    }

    // Get and check LLM provider
    const llmProvider = await getLLMProvider();
    const isLlmAvailable = await llmProvider.checkConnection();
    
    if (!isLlmAvailable) {
      logger.warn(`LLM provider (${LLM_PROVIDER}) is not available. Some features may not work.`);
    }
    
    // Check if suggestion model is available (only needed for Ollama)
    let suggestionModelAvailable = false;
    try {
      if (LLM_PROVIDER.toLowerCase() === 'ollama') {
        await checkOllama();
        await checkOllamaModel(process.env.EMBEDDING_MODEL || "nomic-embed-text:v1.5", true);
        await checkOllamaModel(process.env.SUGGESTION_MODEL || "llama3.1:8b", false);
        suggestionModelAvailable = true;
      } else {
        // For DeepSeek, we assume the model is available if the connection test passed
        suggestionModelAvailable = isLlmAvailable;
      }
    } catch (error: any) {
      logger.warn(`Warning: Model not available. Suggestion tools may be limited: ${error.message}`);
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
          switch_suggestion_model: {}, // Add the switch_suggestion_model tool to capabilities
          check_provider: {}, // Add the check_provider tool to capabilities
          reset_metrics: {}, // Add reset_metrics tool to capabilities
          debug_provider: {}, // Add debug_provider tool to capabilities
          reset_provider: {}, // Add reset_provider tool to capabilities
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
      } catch (error: any) {
        logger.error(`Error reading file ${filepath}`, { message: error.message });
        return { contents: [{ uri: uri.toString(), text: `Error: ${error.message}` }] };
      }
    });

    // Register tools
    await registerTools(server, qdrantClient, repoPath, suggestionModelAvailable);
  
    // Ensure get_repository_context is always registered
    if (!suggestionModelAvailable) {
      logger.info("Registering get_repository_context tool separately");
      registerGetRepositoryContextTool(server, qdrantClient, repoPath);
    }
    
    // Register debug_provider tool
    server.tool(
      "debug_provider",
      "Debug the current provider configuration and test its functionality",
      {},
      async () => {
        try {
          const { debugProvider } = await import("./provider-debug");
          const debugResult = await debugProvider();
          
          return {
            content: [{
              type: "text",
              text: `# Provider Debug Results\n\n` +
                `## Current State\n` +
                `- Suggestion Model: ${debugResult.globals.CURRENT_SUGGESTION_MODEL || "Not set"}\n` +
                `- Suggestion Provider: ${debugResult.globals.CURRENT_SUGGESTION_PROVIDER || "Not set"}\n` +
                `- Embedding Provider: ${debugResult.globals.CURRENT_EMBEDDING_PROVIDER || "Not set"}\n\n` +
                `## Environment Variables\n` +
                `- SUGGESTION_MODEL: ${debugResult.environment.SUGGESTION_MODEL || "Not set"}\n` +
                `- SUGGESTION_PROVIDER: ${debugResult.environment.SUGGESTION_PROVIDER || "Not set"}\n` +
                `- EMBEDDING_PROVIDER: ${debugResult.environment.EMBEDDING_PROVIDER || "Not set"}\n` +
                `- DEEPSEEK_API_KEY: ${debugResult.environment.DEEPSEEK_API_KEY}\n` +
                `- DEEPSEEK_API_URL: ${debugResult.environment.DEEPSEEK_API_URL || "Not set"}\n` +
                `- OLLAMA_HOST: ${debugResult.environment.OLLAMA_HOST || "Not set"}\n\n` +
                `## Provider Tests\n` +
                `- Provider Type: ${debugResult.provider.type}\n` +
                `- Provider Model: ${debugResult.provider.model}\n` +
                `- Connection Test: ${debugResult.provider.connectionTest ? "✅ Successful" : "❌ Failed"}\n` +
                `- Generation Test: ${debugResult.provider.generationTest ? "✅ Successful" : "❌ Failed"}\n` +
                `${debugResult.provider.generationError ? `- Generation Error: ${debugResult.provider.generationError}\n` : ""}` +
                `\n` +
                `Timestamp: ${debugResult.timestamp}`
            }],
          };
        } catch (error: any) {
          logger.error("Error in debug_provider tool", { error: error.message });
          return {
            content: [{
              type: "text",
              text: `# Error in Provider Debug\n\n${error.message}`,
            }],
          };
        }
      }
    );
    
    // Register reset_provider tool
    server.tool(
      "reset_provider",
      "Reset all provider settings and cache",
      {},
      async () => {
        try {
          const { resetProvider } = await import("./provider-debug");
          await resetProvider();
          
          return {
            content: [{
              type: "text",
              text: `# Provider Reset Complete\n\nAll provider settings and cache have been reset.\n\nUse the switch_suggestion_model tool to set a new provider.`
            }],
          };
        } catch (error: any) {
          logger.error("Error in reset_provider tool", { error: error.message });
          return {
            content: [{
              type: "text",
              text: `# Error in Provider Reset\n\n${error.message}`,
            }],
          };
        }
      }
    );
  
    // Register direct_model_switch tool
    server.tool(
      "direct_model_switch",
      "Emergency tool to directly switch models bypassing the normal mechanism",
      {
        model: z.string().describe("The model to switch to (e.g., deepseek-coder, llama3.1:8b)")
      },
      async (params: unknown) => {
        logger.info("Received params for direct_model_switch", { params });
        const normalizedParams = normalizeToolParams(params);
      
        try {
          // Extract model from params
          let model = "deepseek-coder"; // Default model
        
          if (typeof normalizedParams === 'object' && normalizedParams !== null) {
            if (normalizedParams.model) {
              model = normalizedParams.model;
            }
          } else if (typeof normalizedParams === 'string') {
            model = normalizedParams;
          }
        
          // Run the direct switch function
          const switchResult = await import("./server-tools/direct-model-switch").then(
            module => module.directModelSwitch(model)
          );
          
          // Force update the provider based on model name
          if (switchResult.success) {
            const isDeepSeekModel = model.toLowerCase().includes('deepseek');
            global.CURRENT_SUGGESTION_PROVIDER = isDeepSeekModel ? 'deepseek' : 'ollama';
            process.env.SUGGESTION_PROVIDER = isDeepSeekModel ? 'deepseek' : 'ollama';
            
            // Force set environment variables to ensure they're properly set
            process.env.SUGGESTION_MODEL = model.toLowerCase();
            
            // Clear any cached provider instances and modules
            Object.keys(require.cache).forEach(key => {
              if (key.includes('llm-provider') || key.includes('deepseek') || key.includes('ollama')) {
                delete require.cache[key];
              }
            });
            
            // Ensure the LLM provider is updated immediately
            const llmProvider = await getLLMProvider();
            
            logger.info(`Forced provider to ${global.CURRENT_SUGGESTION_PROVIDER} based on model name`);
            logger.info(`Current LLM provider: ${await llmProvider.checkConnection() ? "connected" : "disconnected"}`);
            
            // Verify the provider was actually set correctly
            logger.info(`Verification - Current suggestion provider: ${global.CURRENT_SUGGESTION_PROVIDER}`);
            logger.info(`Verification - Current suggestion model: ${global.CURRENT_SUGGESTION_MODEL}`);
            
            // Force a test generation to ensure the provider is working
            try {
              const testResult = await llmProvider.generateText("Test message");
              logger.info(`Test generation successful with provider ${global.CURRENT_SUGGESTION_PROVIDER}`);
            } catch (error) {
              logger.error(`Test generation failed with provider ${global.CURRENT_SUGGESTION_PROVIDER}`, { error });
            }
          }
        
          if (!switchResult.success) {
            return {
              content: [{
                type: "text",
                text: `# Direct Model Switch Failed\n\nFailed to directly switch to ${model}.\n\nBefore: ${JSON.stringify(switchResult.before)}\nAfter: ${JSON.stringify(switchResult.after)}\nError: ${switchResult.error || "Unknown error"}`
              }],
            };
          }
        
          return {
            content: [{
              type: "text",
              text: `# Direct Model Switch Successful\n\nSuccessfully switched to ${model} using direct method.\n\nBefore: ${JSON.stringify(switchResult.before)}\nAfter: ${JSON.stringify(switchResult.after)}\n\nTimestamp: ${switchResult.timestamp}`
            }],
          };
        } catch (error: any) {
          logger.error("Error in direct_model_switch tool", { error: error.message });
          return {
            content: [{
              type: "text",
              text: `# Error in Direct Model Switch\n\n${error.message}`
            }],
          };
        }
      }
    );

    // Register model_switch_diagnostic tool
    server.tool(
      "model_switch_diagnostic",
      "Comprehensive diagnostic tool for model switching issues",
      {},
      async () => {
        logger.info("Running model switch diagnostic tool");
      
        try {
          // Run the diagnostic
          const diagnosticResult = await import("./server-tools/model-switch-diagnostic").then(
            module => module.modelSwitchDiagnostic()
          );
        
          return {
            content: [{
              type: "text",
              text: `# Model Switch Diagnostic Results\n\n` +
                `## Current State\n` +
                `### Environment Variables\n` +
                `- SUGGESTION_MODEL: ${diagnosticResult.currentState.environment.SUGGESTION_MODEL || "Not set"}\n` +
                `- SUGGESTION_PROVIDER: ${diagnosticResult.currentState.environment.SUGGESTION_PROVIDER || "Not set"}\n` +
                `- EMBEDDING_PROVIDER: ${diagnosticResult.currentState.environment.EMBEDDING_PROVIDER || "Not set"}\n` +
                `- DEEPSEEK_API_KEY: ${diagnosticResult.currentState.environment.DEEPSEEK_API_KEY}\n` +
                `- DEEPSEEK_API_URL: ${diagnosticResult.currentState.environment.DEEPSEEK_API_URL || "Not set"}\n` +
                `- OLLAMA_HOST: ${diagnosticResult.currentState.environment.OLLAMA_HOST || "Not set"}\n` +
                `- NODE_ENV: ${diagnosticResult.currentState.environment.NODE_ENV || "Not set"}\n` +
                `- VITEST: ${diagnosticResult.currentState.environment.VITEST || "Not set"}\n\n` +
                `### Global Variables\n` +
                `- CURRENT_SUGGESTION_MODEL: ${diagnosticResult.currentState.globals.CURRENT_SUGGESTION_MODEL || "Not set"}\n` +
                `- CURRENT_SUGGESTION_PROVIDER: ${diagnosticResult.currentState.globals.CURRENT_SUGGESTION_PROVIDER || "Not set"}\n` +
                `- CURRENT_EMBEDDING_PROVIDER: ${diagnosticResult.currentState.globals.CURRENT_EMBEDDING_PROVIDER || "Not set"}\n\n` +
                `## Test Results\n` +
                `### DeepSeek Test\n` +
                `- Expected: model=${diagnosticResult.tests.deepseek.expected.model}, provider=${diagnosticResult.tests.deepseek.expected.provider}\n` +
                `- Actual: model=${diagnosticResult.tests.deepseek.actual.model}, provider=${diagnosticResult.tests.deepseek.actual.provider}\n` +
                `- Success: ${diagnosticResult.tests.deepseek.success ? "✅" : "❌"}\n\n` +
                `### Ollama Test\n` +
                `- Expected: model=${diagnosticResult.tests.ollama.expected.model}, provider=${diagnosticResult.tests.ollama.expected.provider}\n` +
                `- Actual: model=${diagnosticResult.tests.ollama.actual.model}, provider=${diagnosticResult.tests.ollama.actual.provider}\n` +
                `- Success: ${diagnosticResult.tests.ollama.success ? "✅" : "❌"}\n\n` +
                `Timestamp: ${diagnosticResult.timestamp}`
            }],
          };
        } catch (error: any) {
          logger.error("Error in model_switch_diagnostic tool", { error: error.message });
          return {
            content: [{
              type: "text",
              text: `# Error in Model Switch Diagnostic\n\n${error.message}`,
            }],
          };
        }
      }
    );

    // Register debug_model_switch tool
    server.tool(
      "debug_model_switch",
      "Debug tool to help diagnose model switching issues",
      {
        model: z.string().optional().describe("The model to test switching to")
      },
      async (params: unknown) => {
        const normalizedParams = normalizeToolParams(params);
        logger.info("Received params for debug_model_switch", normalizedParams);
      
        try {
          // Extract model from params
          let model = "deepseek-coder"; // Default model for debugging
        
          if (typeof normalizedParams === 'object' && normalizedParams !== null) {
            if (normalizedParams.model) {
              model = normalizedParams.model;
            }
          } else if (typeof normalizedParams === 'string') {
            model = normalizedParams;
          }
        
          // Run the debug function
          const debugResult = await import("./server-tools/debug-model-switch").then(
            module => module.debugModelSwitch(model)
          );
        
          return {
            content: [{
              type: "text",
              text: `# Model Switch Debug Results\n\n` +
                `Requested model: ${debugResult.requestedModel}\n` +
                `Normalized model: ${debugResult.normalizedModel}\n` +
                `Provider: ${debugResult.provider}\n\n` +
                `## Before Direct Setting\n` +
                `### Environment Variables\n` +
                `- SUGGESTION_MODEL: ${debugResult.before.environment.SUGGESTION_MODEL || "Not set"}\n` +
                `- SUGGESTION_PROVIDER: ${debugResult.before.environment.SUGGESTION_PROVIDER || "Not set"}\n` +
                `- EMBEDDING_PROVIDER: ${debugResult.before.environment.EMBEDDING_PROVIDER || "Not set"}\n` +
                `- DEEPSEEK_API_KEY: ${debugResult.before.environment.DEEPSEEK_API_KEY}\n\n` +
                `### Global Variables\n` +
                `- CURRENT_SUGGESTION_MODEL: ${debugResult.before.globals.CURRENT_SUGGESTION_MODEL || "Not set"}\n` +
                `- CURRENT_SUGGESTION_PROVIDER: ${debugResult.before.globals.CURRENT_SUGGESTION_PROVIDER || "Not set"}\n` +
                `- CURRENT_EMBEDDING_PROVIDER: ${debugResult.before.globals.CURRENT_EMBEDDING_PROVIDER || "Not set"}\n\n` +
                `## After Direct Setting\n` +
                `### Environment Variables\n` +
                `- SUGGESTION_MODEL: ${debugResult.after.environment.SUGGESTION_MODEL || "Not set"}\n` +
                `- SUGGESTION_PROVIDER: ${debugResult.after.environment.SUGGESTION_PROVIDER || "Not set"}\n` +
                `- EMBEDDING_PROVIDER: ${debugResult.after.environment.EMBEDDING_PROVIDER || "Not set"}\n` +
                `- DEEPSEEK_API_KEY: ${debugResult.after.environment.DEEPSEEK_API_KEY}\n\n` +
                `### Global Variables\n` +
                `- CURRENT_SUGGESTION_MODEL: ${debugResult.after.globals.CURRENT_SUGGESTION_MODEL || "Not set"}\n` +
                `- CURRENT_SUGGESTION_PROVIDER: ${debugResult.after.globals.CURRENT_SUGGESTION_PROVIDER || "Not set"}\n` +
                `- CURRENT_EMBEDDING_PROVIDER: ${debugResult.after.globals.CURRENT_EMBEDDING_PROVIDER || "Not set"}\n\n` +
                `Timestamp: ${debugResult.timestamp}`
            }],
          };
        } catch (error: any) {
          logger.error("Error in debug_model_switch tool", { error: error.message });
          return {
            content: [{
              type: "text",
              text: `# Error in Debug Model Switch\n\n${error.message}`,
            }],
          };
        }
      }
    );
  
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
      
        // Extract model from params, handling different input formats
        let model = "llama3.1:8b"; // Default model
      
        if (typeof normalizedParams === 'string') {
          try {
            // Try to parse as JSON if it's a string
            const parsed = JSON.parse(normalizedParams);
            if (parsed && typeof parsed === 'object' && parsed.model) {
              model = parsed.model;
            } else if (parsed && typeof parsed === 'object' && parsed.provider) {
              // For backward compatibility
              model = parsed.provider === "deepseek" ? "deepseek-coder" : "llama3.1:8b";
            }
          } catch (e) {
            // If not valid JSON, use as is
            model = normalizedParams;
          }
        } else if (typeof normalizedParams === 'object' && normalizedParams !== null) {
          // Handle object input
          if (normalizedParams.model) {
            model = normalizedParams.model;
          } else if (normalizedParams.provider) {
            // For backward compatibility
            model = normalizedParams.provider === "deepseek" ? "deepseek-coder" : "llama3.1:8b";
          }
        }
      
        logger.info(`Requested model: ${model}`);
        
        // Ensure we're using the exact model name provided
        const normalizedModel = model.toLowerCase();
        
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
                  text: `# Failed to Switch Suggestion Model\n\nUnable to switch to ${model}. DeepSeek API key is not configured.\n\nPlease set the DEEPSEEK_API_KEY environment variable and try again.`,
                }],
              };
            }
            
            // Check API endpoint
            if (!process.env.DEEPSEEK_API_URL) {
              logger.warn("DeepSeek API URL not set, using default endpoint");
            }
          }
        
          // Switch the suggestion model
          const success = await switchSuggestionModel(normalizedModel);
        
          if (!success) {
            return {
              content: [{
                type: "text",
                text: `# Failed to Switch Suggestion Model\n\nUnable to switch to ${model}. Please check your configuration and logs for details.`,
              }],
            };
          }
        
          // Get the actual values from the global variables to ensure we're reporting what was actually set
          const actualModel = global.CURRENT_SUGGESTION_MODEL;
          const actualProvider = global.CURRENT_SUGGESTION_PROVIDER;
          const embeddingProvider = global.CURRENT_EMBEDDING_PROVIDER || process.env.EMBEDDING_PROVIDER || "ollama";
        
          // Log the current models and providers to debug
          logger.info(`Current suggestion model: ${actualModel}, provider: ${actualProvider}, embedding: ${embeddingProvider}`);
          
          // Verify that the model was actually changed
          if (actualModel !== requestedModel) {
            logger.error(`Model switch failed: requested ${requestedModel} but got ${actualModel}`);
            
            // Force set the model directly as a last resort
            global.CURRENT_SUGGESTION_MODEL = requestedModel;
            global.CURRENT_SUGGESTION_PROVIDER = requestedModel.includes('deepseek') ? 'deepseek' : 'ollama';
            
            logger.info(`Forced model to ${requestedModel} and provider to ${global.CURRENT_SUGGESTION_PROVIDER}`);
            
            // Check if the force-set worked
            if (global.CURRENT_SUGGESTION_MODEL !== requestedModel) {
              return {
                content: [{
                  type: "text",
                  text: `# Error Switching Suggestion Model\n\nFailed to switch to ${requestedModel}. The model is still set to ${global.CURRENT_SUGGESTION_MODEL}.\n\nPlease check the logs for more details.`,
                }],
              };
            }
          }
        
          // Use the requested model in the response to ensure consistency
          return {
            content: [{
              type: "text",
              text: `# Suggestion Model Switched\n\nSuccessfully switched to ${requestedModel} for suggestions.\n\nUsing ${requestedModel} (${requestedModel.includes('deepseek') ? 'deepseek' : 'ollama'} provider) for suggestions and ${embeddingProvider} for embeddings.\n\nTo make this change permanent, set the SUGGESTION_MODEL environment variable to '${requestedModel}'`,
            }],
          };
        } catch (error: any) {
          logger.error("Error switching suggestion model", { error: error.message });
          return {
            content: [{
              type: "text",
              text: `# Error Switching Suggestion Model\n\n${error.message}`,
            }],
          };
        }
      }
    );

    
    // Start metrics logging
    const metricsInterval = startMetricsLogging(300000); // Log metrics every 5 minutes
    
    // Configure transport to use proper JSON formatting
    const transport = new StdioServerTransport();
    
    // Log startup info to file
    logger.info(`CodeCompass MCP server v${VERSION} running for repository: ${repoPath}`);
    logger.info(`CodeCompass server started with tools: ${Object.keys(suggestionModelAvailable ? 
      { search_code: {}, get_repository_context: {}, generate_suggestion: {}, get_changelog: {}, reset_metrics: {}, get_session_history: {}, provide_feedback: {}, analyze_code_problem: {}, agent_query: {}, switch_suggestion_model: {}, check_provider: {} } : 
      { search_code: {}, get_repository_context: {}, get_changelog: {}, reset_metrics: {}, get_session_history: {}, agent_query: {}, switch_suggestion_model: {}, check_provider: {} }
    ).join(', ')}`);
    
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
    
    await new Promise(() => {});
  } catch (error: any) {
    logger.error("Failed to start CodeCompass", { message: error.message });
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
      
      logger.info("Received params for agent_query", { params });
      const normalizedParams = normalizeToolParams(params);
      logger.debug("Normalized params for agent_query", normalizedParams);
      
      // Ensure query exists
      if (!normalizedParams.query && typeof normalizedParams === 'object') {
        normalizedParams.query = "repository information";
        logger.warn("No query provided for agent_query, using default");
      }
      
      const { query, sessionId, maxSteps = 5 } = normalizedParams;
    
    try {
      // Force clear any cached providers
      Object.keys(require.cache).forEach(key => {
        if (key.includes('llm-provider') || key.includes('deepseek') || key.includes('ollama')) {
          delete require.cache[key];
        }
      });
      
      // Import the clearProviderCache function and use it
      const { clearProviderCache } = await import('./llm-provider');
      clearProviderCache();
      
      // Ensure we have the latest LLM provider
      const llmProvider = await getLLMProvider();
      
      // Log detailed provider information
      logger.info(`Agent using provider: ${global.CURRENT_SUGGESTION_PROVIDER}, model: ${global.CURRENT_SUGGESTION_MODEL}`);
      logger.info(`Provider details - suggestionProvider: ${process.env.SUGGESTION_PROVIDER}, suggestionModel: ${process.env.SUGGESTION_MODEL}`);
      
      // Verify the provider is working with a test generation
      try {
        const testResult = await llmProvider.generateText("Test message");
        logger.info(`Agent verified provider ${global.CURRENT_SUGGESTION_PROVIDER} is working`);
      } catch (error) {
        logger.error(`Agent failed to verify provider ${global.CURRENT_SUGGESTION_PROVIDER}`, { error });
      }
      
      // Create a timeout promise
      const timeoutPromise = new Promise<string>((_, reject) => {
        setTimeout(() => {
          reject(new Error("Agent query timed out after 60 seconds"));
        }, 60000); // 60 second timeout
      });
      
      // Run the agent loop with timeout
      const response = await Promise.race([
        runAgentLoop(
          query,
          sessionId,
          qdrantClient,
          repoPath,
          suggestionModelAvailable,
          maxSteps
        ),
        timeoutPromise
      ]);
      
      return {
        content: [{
          type: "text",
          text: response,
        }],
      };
    } catch (error: any) {
      logger.error("Error in agent_query", { error: error.message });
      
      return {
        content: [{
          type: "text",
          text: `# Error in Agent Processing\n\nThere was an error processing your query: ${error.message}\n\nPlease try a more specific query or use one of the other tools directly.`,
        }],
      };
    }
  });
  
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
    const session = getOrCreateSession(sessionId, repoPath);
    
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
      query, 
      files
    );
    
    // Add query to session
    addQuery(session.id, query, results, relevanceScore);
    
    // Get the current LLM provider
    const llmProvider = await getLLMProvider();
    
    // Generate summaries for the results
    const summaries = await Promise.all(results.map(async result => {
      const snippet = (result.payload as QdrantSearchResult['payload']).content.slice(0, MAX_SNIPPET_LENGTH);
      let summary = "Summary unavailable";
      
      if (suggestionModelAvailable) {
        try {
          // Create a summarization prompt
          const summarizePrompt = `Summarize this code snippet in 50 words or less:\n\n${snippet}`;
          summary = await llmProvider.generateText(summarizePrompt);
        } catch (error: any) {
          logger.warn(`Failed to generate summary: ${error.message}`);
          summary = "Summary generation failed";
        }
      }
      
      return {
        filepath: (result.payload as QdrantSearchResult['payload']).filepath,
        snippet,
        summary,
        last_modified: (result.payload as QdrantSearchResult['payload']).last_modified,
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
    "Check the current LLM provider status and test the connection.",
    {
      verbose: z.boolean().optional().describe("Whether to include detailed information")
    },
    async () => {
      const { testCurrentProvider, getCurrentProviderInfo } = await import("./test-provider");
      
      const providerInfo = await getCurrentProviderInfo();
      const connectionTest = await testCurrentProvider();
      
      return {
        content: [{
          type: "text",
          text: `# LLM Provider Status

## Current Suggestion Model: ${providerInfo.suggestionModel || "llama3.1:8b"}
## Current Suggestion Provider: ${providerInfo.suggestionProvider}
## Current Embedding Provider: ${providerInfo.embeddingProvider}

- Connection Test: ${connectionTest ? "✅ Successful" : "❌ Failed"}
- Provider Details:
${Object.entries(providerInfo)
  .filter(([key]) => key !== 'provider')
  .map(([key, value]) => `  - ${key}: ${value}`)
  .join('\n')}

To switch suggestion models, use the \`switch_suggestion_model\` tool with the model parameter:
- For Ollama models: \`{"model": "llama3.1:8b"}\`
- For DeepSeek models: \`{"model": "deepseek-coder"}\` (requires DEEPSEEK_API_KEY)

Note: For DeepSeek models, ensure you have set the DEEPSEEK_API_KEY environment variable.
You can also set DEEPSEEK_API_URL to use a custom endpoint (defaults to https://api.deepseek.com/v1).
`,
        }],
      };
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
      const session = getOrCreateSession(sessionId);
      
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
    } catch (error: any) {
      return {
        content: [{
          type: "text",
          text: `# Error\n\n${error.message}`,
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
      const session = getOrCreateSession(sessionId, repoPath);
      
      // Log the extracted query to confirm it's working
      logger.info("Extracted query for generate_suggestion", { query, sessionId: session.id });
      
      // First, use search_code internally to get relevant context
      trackToolChain(chainId, "search_code");
      
      const isGitRepo = await validateGitRepository(repoPath);
      const files = isGitRepo
        ? await git.listFiles({ fs, dir: repoPath, gitdir: path.join(repoPath, ".git"), ref: "HEAD" })
        : [];
      const diff = await getRepositoryDiff(repoPath);
      
      // Update context in session
      updateContext(session.id, repoPath, files, diff);
      
      // Get recent queries from session to provide context
      const recentQueries = getRecentQueries(session.id);
      const relevantResults = getRelevantResults(session.id);
      
      // Use iterative query refinement for better search results
      const { results, refinedQuery } = await searchWithRefinement(
        qdrantClient, 
        query, 
        files
      );
      
      // Map search results to context
      const context = results.map(r => ({
        filepath: (r.payload as QdrantSearchResult['payload']).filepath,
        snippet: (r.payload as QdrantSearchResult['payload']).content.slice(0, MAX_SNIPPET_LENGTH),
        last_modified: (r.payload as QdrantSearchResult['payload']).last_modified,
        relevance: r.score,
        note: ""
      }));
      
      // Include previous relevant results if current results are limited
      if (context.length < 2 && relevantResults.length > 0) {
        const additionalContext = relevantResults
          .filter(r => !context.some(c => c.filepath === r.payload?.filepath))
          .slice(0, 2)
          .map(r => ({
            filepath: r.payload?.filepath || "unknown",
            snippet: r.payload?.content?.slice(0, MAX_SNIPPET_LENGTH) || "",
            last_modified: r.payload?.last_modified || "unknown",
            relevance: r.score || 0.5,
            note: "From previous related query"
          }));
        
        context.push(...additionalContext);
      }

      const prompt = `
**Context**:
Repository: ${repoPath}
Files: ${files.join(", ")}
Recent Changes: ${diff}
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
      const llmProvider = await getLLMProvider();
      
      // Generate suggestion with the current provider
      const suggestion = await llmProvider.generateText(prompt);
      
      // Add suggestion to session
      addSuggestion(session.id, query, suggestion);
      
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
${diff}
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
          const { sessionId, feedbackId, score, comments, originalQuery, suggestion } = normalizedParams;
      
        // Get session
        const session = getOrCreateSession(sessionId);
        
        // Add feedback to session
        addFeedback(session.id, score, comments);
        
        // Get the current LLM provider
        const llmProvider = await getLLMProvider();
        
        // Process feedback to improve the suggestion
        const improvedSuggestion = await llmProvider.processFeedback(
          originalQuery,
          suggestion,
          comments,
          score
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
      } catch (error: any) {
        logger.error("Error processing feedback", { error: error.message });
        return {
          content: [{
            type: "text",
            text: `# Error Processing Feedback\n\n${error.message}\n\nPlease ensure you provide all required parameters: sessionId, feedbackId, score, comments, originalQuery, and suggestion.`,
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
          } catch (e) {
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
      const session = getOrCreateSession(sessionId, repoPath);
      
      // Log the extracted query to confirm it's working
      logger.info("Extracted query for repository context", { query, sessionId: session.id });
      
      const isGitRepo = await validateGitRepository(repoPath);
      const files = isGitRepo
        ? await git.listFiles({ fs, dir: repoPath, gitdir: path.join(repoPath, ".git"), ref: "HEAD" })
        : [];
      const diff = await getRepositoryDiff(repoPath);
      
      // Update context in session
      updateContext(session.id, repoPath, files, diff);
      
      // Use iterative query refinement
      const { results, refinedQuery } = await searchWithRefinement(
        qdrantClient, 
        query, 
        files
      );
      
      // Get recent queries from session to provide context
      const recentQueries = getRecentQueries(session.id);
      
      const context = results.map(r => ({
        filepath: (r.payload as QdrantSearchResult['payload']).filepath,
        snippet: (r.payload as QdrantSearchResult['payload']).content.slice(0, MAX_SNIPPET_LENGTH),
        last_modified: (r.payload as QdrantSearchResult['payload']).last_modified,
        relevance: r.score,
      }));
      
      const summaryPrompt = `
**Context**:
Repository: ${repoPath}
Files: ${files.join(", ")}
Recent Changes: ${diff}
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
      addQuery(session.id, query, results);
      
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
${diff}
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
      const session = getOrCreateSession(sessionId, repoPath);
      
      // Step 1: Get repository context
      trackToolChain(chainId, "get_repository_context");
      logger.info("Step 1: Getting repository context");
      
      const isGitRepo = await validateGitRepository(repoPath);
      const files = isGitRepo
        ? await git.listFiles({ fs, dir: repoPath, gitdir: path.join(repoPath, ".git"), ref: "HEAD" })
        : [];
      const diff = await getRepositoryDiff(repoPath);
      
      // Use iterative query refinement to find relevant code
      const { results: contextResults } = await searchWithRefinement(
        qdrantClient, 
        query, 
        files
      );
      
      const context = contextResults.map(r => ({
        filepath: (r.payload as QdrantSearchResult['payload']).filepath,
        snippet: (r.payload as QdrantSearchResult['payload']).content.slice(0, MAX_SNIPPET_LENGTH),
        last_modified: (r.payload as QdrantSearchResult['payload']).last_modified,
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
      addQuery(session.id, query, contextResults);
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
