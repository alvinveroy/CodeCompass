import { McpServer, ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js"; // Added ResourceTemplate
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
// Assuming these are correctly exported by the SDK, either from root or via defined subpaths.
// If the SDK's "exports" map points these subpaths to .js files, add .js here.
// If they are re-exported from the main SDK entry, use that.
import express from 'express';
import http from 'http';
import axios from 'axios'; // Add this import
import { ServerRequest, ServerNotification } from "@modelcontextprotocol/sdk/types.js";
import { RequestHandlerExtra } from "@modelcontextprotocol/sdk/shared/protocol.js";
import { Variables } from "@modelcontextprotocol/sdk/shared/uriTemplate.js";
import fs from "fs/promises";
import path from "path";
import git from "isomorphic-git";
import { QdrantClient } from "@qdrant/js-client-rest";
import { configService, logger } from "./config-service";

import {
  DetailedQdrantSearchResult,
  FileChunkPayload,         // New
  CommitInfoPayload,        // New
  DiffChunkPayload          // New
} from "./types"; 
import { IndexingStatusReport } from './repository'; // Correct import for IndexingStatusReport
import { z } from "zod";
import { checkOllama, checkOllamaModel } from "./ollama";
import { initializeQdrant } from "./qdrant";
import { searchWithRefinement } from "./query-refinement"; // Keep this
import { validateGitRepository, indexRepository, getRepositoryDiff, getGlobalIndexingStatus } from "./repository";
import { getLLMProvider, switchSuggestionModel, LLMProvider } from "./llm-provider";
import { processAgentQuery } from './agent-service';
import { VERSION } from "./version";
import { getOrCreateSession, addQuery, addSuggestion, updateContext, getRecentQueries, getRelevantResults } from "./state";

// Define this interface at the top level of the file, e.g., after imports
interface PingResponseData {
  service?: string;
  status?: string;
  version?: string;
}

// Helper type for server startup errors
class ServerStartupError extends Error {
  constructor(message: string, public exitCode = 1) { // Remove : number type annotation
    super(message);
    this.name = "ServerStartupError";
  }
}

export function normalizeToolParams(params: unknown): Record<string, unknown> {
  if (typeof params === 'object' && params !== null) {
    // Ensure it's a standard object, not a null-prototype one.
    // Spread syntax creates a new object with a standard prototype.
    return { ...params } as Record<string, unknown>;
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
  // Global error handlers to catch issues that might otherwise lead to silent crashes or malformed responses
  process.on('uncaughtException', (error: Error) => {
    logger.error('UNCAUGHT EXCEPTION:', { message: error.message, stack: error.stack });
    // Mandatory exit after uncaught exception
    // Ensure logs are flushed before exiting if logger is asynchronous.
    // For simplicity here, assuming logger.error is synchronous enough or process.exit will allow flushing.
    if (process.env.NODE_ENV !== 'test') { 
      process.exit(1); 
    }
  });

  process.on('unhandledRejection', (reason: unknown, promise: Promise<unknown>) => {
    logger.error('UNHANDLED PROMISE REJECTION:', { reason, promise });
    // Optionally, exit or take other measures. For robustness, exiting is often safer.
    // Ensure logs are flushed.
    if (process.env.NODE_ENV !== 'test') { 
      process.exit(1);
    }
  });
  
  logger.info("Starting CodeCompass MCP server...");

  // Create a promise that will be rejected if httpServer setup fails critically
  let httpServerSetupReject: (reason?: unknown) => void;
  const httpServerSetupPromise = new Promise<void>((_resolve, reject) => {
    httpServerSetupReject = reject;
  });

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
    // const llmProvider = await getLLMProvider(); // Already initialized a few lines above
    
    logger.info(`Initial indexing process started for ${repoPath} in the background.`);
    indexRepository(qdrantClient, repoPath, llmProvider)
      .then(() => {
        logger.info(`Initial indexing process completed successfully for ${repoPath}.`);
        // Status is managed by indexRepository itself
      })
      .catch((error: unknown) => {
        const errorMessage = error instanceof Error ? error.message : String(error);
        logger.error(`Initial indexing process failed for ${repoPath}: ${errorMessage}`);
        // Status is managed by indexRepository itself
      });

    // Prompts will be registered using server.prompt() later

    const serverCapabilities = {
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
        get_indexing_status: {}, // New tool for indexing status
      },
      prompts: {}, // Explicitly declare prompts capability
    };

    const server = new McpServer({
      name: "CodeCompass",
      version: VERSION,
      vendor: "CodeCompass",
      capabilities: serverCapabilities,
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
      new ResourceTemplate("repo://files/{filepath}", { list: undefined }), // Used ResourceTemplate directly
      {}, // metadata
      async (uri: URL, variables: Variables, _extra: RequestHandlerExtra<ServerRequest, ServerNotification>) => { // Used Variables directly
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
      "get_indexing_status",
      "Retrieves the current status of repository indexing. Provides information on whether indexing is idle, in-progress, completed, or failed, along with progress percentage and any error messages.",
      {}, // No parameters, represented by an empty ZodRawShape
      (_args: Record<string, never>, _extra: RequestHandlerExtra<ServerRequest, ServerNotification>) => {
        logger.info("Tool 'get_indexing_status' execution started.");
        const currentStatus = getGlobalIndexingStatus();
        return {
          content: [{
            type: "text",
            text: `# Indexing Status
- Status: ${currentStatus.status}
- Progress: ${currentStatus.overallProgress}%
- Message: ${currentStatus.message}
- Last Updated: ${currentStatus.lastUpdatedAt}
${currentStatus.currentFile ? `- Current File: ${currentStatus.currentFile}` : ''}
${currentStatus.currentCommit ? `- Current Commit: ${currentStatus.currentCommit}` : ''}
${currentStatus.totalFilesToIndex ? `- Total Files: ${currentStatus.totalFilesToIndex}` : ''}
${currentStatus.filesIndexed ? `- Files Indexed: ${currentStatus.filesIndexed}` : ''}
${currentStatus.totalCommitsToIndex ? `- Total Commits: ${currentStatus.totalCommitsToIndex}` : ''}
${currentStatus.commitsIndexed ? `- Commits Indexed: ${currentStatus.commitsIndexed}` : ''}
${currentStatus.errorDetails ? `- Error: ${currentStatus.errorDetails}` : ''}
            `,
          }],
        };
      }
    );
    
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

    // Setup Express HTTP server for status and notifications
    const expressApp = express();
     
    expressApp.use(express.json()); // Middleware to parse JSON bodies

     
    expressApp.get('/api/indexing-status', (_req: express.Request, res: express.Response): void => {
      const currentStatus = getGlobalIndexingStatus();
       
      res.json(currentStatus);
    });

    // Add the new /api/ping endpoint here
    expressApp.get('/api/ping', (_req: express.Request, res: express.Response): void => {
      res.json({ service: "CodeCompass", status: "ok", version: VERSION });
    });
     
    expressApp.post('/api/repository/notify-update', (_req: express.Request, res: express.Response): void => {
      logger.info('Received notification to update repository via /api/repository/notify-update.');
      
      const currentStatus = getGlobalIndexingStatus();
      if (['initializing', 'validating_repo', 'listing_files', 'cleaning_stale_entries', 'indexing_file_content', 'indexing_commits_diffs'].includes(currentStatus.status)) {
        logger.warn('Re-indexing request received, but indexing is already in progress.');
        res.status(409).json({ message: 'Indexing already in progress.' });
        return;
      }

      logger.info(`Triggering re-indexing for repository: ${repoPath}`);
      // Re-use qdrantClient, repoPath, llmProvider from the outer scope
      indexRepository(qdrantClient, repoPath, llmProvider)
        .then(() => {
          logger.info(`Repository re-indexing completed successfully for ${repoPath}.`);
          // Status managed by indexRepository
        })
        .catch((error: unknown) => {
          const errorMessage = error instanceof Error ? error.message : String(error);
          logger.error(`Repository re-indexing failed for ${repoPath}: ${errorMessage}`);
          // Status managed by indexRepository
        });
      
       
      res.status(202).json({ message: 'Re-indexing process initiated.' });
    });

    const httpPort = configService.HTTP_PORT; // Read from configService
     
    const httpServer = http.createServer(expressApp as (req: http.IncomingMessage, res: http.ServerResponse) => void);

    // eslint-disable-next-line @typescript-eslint/no-misused-promises
    httpServer.on('error', async (error: NodeJS.ErrnoException) => {
      if (error.code === 'EADDRINUSE') {
        logger.warn(`HTTP Port ${httpPort} is already in use. Attempting to ping...`);
        try {
          const pingResponse = await axios.get<PingResponseData>(`http://localhost:${httpPort}/api/ping`, { timeout: 500 });
          if (pingResponse.status === 200 && pingResponse.data && pingResponse.data.service === "CodeCompass") {
            logger.info(`Another CodeCompass instance (version ${pingResponse.data.version || 'unknown'}) is running on port ${httpPort}. Fetching its status...`);
            try {
              const statusResponse = await axios.get<IndexingStatusReport>(`http://localhost:${httpPort}/api/indexing-status`, { timeout: 1000 });
              if (statusResponse.status === 200 && statusResponse.data) {
                const existingStatus = statusResponse.data;
                // Use console.info for direct user feedback, logger.info for logs
                console.info(`\n--- Status of existing CodeCompass instance on port ${httpPort} ---`);
                console.info(`Version: ${pingResponse.data.version || 'unknown'}`);
                console.info(`Status: ${existingStatus.status}`);
                console.info(`Message: ${existingStatus.message}`);
                if (existingStatus.overallProgress !== undefined) {
                  console.info(`Progress: ${existingStatus.overallProgress}%`);
                }
                if (existingStatus.currentFile) {
                  console.info(`Current File: ${existingStatus.currentFile}`);
                }
                if (existingStatus.currentCommit) {
                  console.info(`Current Commit: ${existingStatus.currentCommit}`);
                }
                console.info(`Last Updated: ${existingStatus.lastUpdatedAt}`);
                console.info(`-----------------------------------------------------------\n`);
                logger.info("Current instance will exit as another CodeCompass server is already running.");
                httpServerSetupReject!(new ServerStartupError(`Port ${httpPort} in use by another CodeCompass instance.`, 0));
              } else {
                logger.error(`Failed to retrieve status from existing CodeCompass server on port ${httpPort}. It responded to ping but status endpoint failed. Status: ${statusResponse.status}`);
                httpServerSetupReject!(new ServerStartupError(`Port ${httpPort} in use, status fetch failed.`, 1));
              }
            } catch (statusError: unknown) {
              if (axios.isAxiosError(statusError)) {
                if (statusError.response) {
                  logger.error(`Error fetching status from existing CodeCompass server (port ${httpPort}): ${statusError.message}, Status: ${statusError.response.status}, Data: ${JSON.stringify(statusError.response.data)}`);
                } else if (statusError.request) {
                  logger.error(`Error fetching status from existing CodeCompass server (port ${httpPort}): No response received. ${statusError.message}`);
                } else {
                  logger.error(`Error fetching status from existing CodeCompass server (port ${httpPort}): ${statusError.message}`);
                }
              } else {
                logger.error(`Error fetching status from existing CodeCompass server (port ${httpPort}): ${String(statusError)}`);
              }
              httpServerSetupReject!(new ServerStartupError(`Port ${httpPort} in use, status fetch error.`, 1));
            }
          } else {
            // Ping successful but not a CodeCompass server
            logger.error(`Port ${httpPort} is in use, but it does not appear to be a CodeCompass server. Response: ${JSON.stringify(pingResponse.data)}`);
            logger.error(`Please free the port or configure a different one (e.g., via HTTP_PORT environment variable or in ~/.codecompass/model-config.json).`);
            httpServerSetupReject!(new ServerStartupError(`Port ${httpPort} in use by non-CodeCompass server.`, 1));
          }
        } catch (pingError: unknown) {
          // Ping failed (timeout, connection refused, or other error)
          logger.error(`Port ${httpPort} is in use by an unknown service or the existing CodeCompass server is unresponsive to pings.`);
          if (axios.isAxiosError(pingError)) {
            if (pingError.code === 'ECONNREFUSED') {
              logger.error(`Connection refused on port ${httpPort}.`);
            } else if (pingError.code === 'ETIMEDOUT' || pingError.code === 'ECONNABORTED') { // ECONNABORTED for timeout
              logger.error(`Ping attempt to port ${httpPort} timed out.`);
            } else {
              logger.error(`Ping error details: ${pingError.message}`);
            }
          } else {
             logger.error(`Ping error details: ${String(pingError)}`);
          }
          logger.error(`Please free the port or configure a different one (e.g., via HTTP_PORT environment variable or in ~/.codecompass/model-config.json).`);
          httpServerSetupReject!(new ServerStartupError(`Port ${httpPort} in use or ping failed.`, 1));
        }
      } else {
        logger.error(`Failed to start HTTP server on port ${httpPort}: ${error.message}`);
        httpServerSetupReject!(new ServerStartupError(`HTTP server error: ${error.message}`, 1));
      }
    });

    const listenPromise = new Promise<void>((resolve) => {
      httpServer.listen(httpPort, () => {
        logger.info(`CodeCompass HTTP server listening on port ${httpPort} for status and notifications.`);
        resolve(); // HTTP server is successfully listening
      });
    });

    // Race the listenPromise against the httpServerSetupPromise
    // If httpServerSetupPromise rejects (due to EADDRINUSE or other http error), this will throw
    await Promise.race([listenPromise, httpServerSetupPromise]);
    
    logger.info(`CodeCompass MCP server v${VERSION} running for repository: ${repoPath}`);
    const toolStubs = serverCapabilities.tools || {};
    logger.info(`CodeCompass server configured with tool stubs: ${Object.keys(toolStubs).join(', ')}`);
    
    console.error(`CodeCompass v${VERSION} MCP Server running on stdio`);
    
    await server.connect(transport);
    
    if (process.env.NODE_ENV === 'test') {
      logger.info("Test environment detected, server setup complete. Skipping SIGINT wait.");
      // No explicit resolve here, function completes normally if no errors
    } else {
      // Original block
      await new Promise<void>((resolve) => {
        process.on('SIGINT', () => {
          logger.info("SIGINT received, shutting down server.");
          resolve();
        });
      });
    }

  } catch (error: unknown) {
    const err = error instanceof ServerStartupError ? error : error as Error;
    logger.error("Failed to start CodeCompass", { message: err.message });
    if (process.env.NODE_ENV === 'test') { 
      throw err; // Re-throw in test env to be caught by test assertions
    }
    // Determine exit code from ServerStartupError if possible
    const exitCode = error instanceof ServerStartupError ? error.exitCode : 1;
    process.exit(exitCode);
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
      logger.info(`Tool 'agent_query' execution started with args:`, args);

      const query = args.query;
      const sessionId = args.sessionId;

      if (!query || typeof query !== 'string' || query.trim() === "") {
        const errorMsg = "Invalid or missing 'query' parameter for agent_query. Please provide a non-empty query string.";
        logger.error(errorMsg, { receivedQuery: query });
        return {
          content: [{
            type: "text",
            text: `# Agent Query Error\n\n${errorMsg}`,
          }],
        };
      }

      try {
        // Ensure config is fresh for this operation, especially if models/providers might have changed
        // configService.reloadConfigsFromFile(true); // processAgentQuery will use current configService state

        // processAgentQuery will internally get the LLMProvider and QdrantClient
        const agentResponseText = await processAgentQuery(query, sessionId);
        
        return {
          content: [{
            type: "text",
            text: agentResponseText,
          }],
        };
      } catch (error: unknown) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        logger.error("Critical error in agent_query tool handler", { 
          message: errorMessage,
          stack: error instanceof Error ? error.stack : undefined,
        });
        return {
          content: [{
            type: "text",
            text: `# Agent Query Failed\n\nAn unexpected error occurred: ${errorMessage}\nPlease check server logs for details.`,
          }],
        };
      }
    }
  );

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
    
    const fileChunkResults = results.filter(
        (result): result is DetailedQdrantSearchResult & { payload: FileChunkPayload } => 
            result.payload?.dataType === 'file_chunk'
    );

    if (fileChunkResults.length === 0 && results.length > 0) {
        logger.info(`Search for "${searchQuery}" found ${results.length} results, but none were file_chunks. Matched data might be from commits or diffs.`);
    } else if (results.length === 0) {
        logger.info(`Search for "${searchQuery}" found no results.`);
    }
    
    const summaries = await Promise.all(fileChunkResults.map(async result => {
      // Now, result.payload is known to be FileChunkPayload
      const snippet = result.payload.file_content_chunk.slice(0, configService.MAX_SNIPPET_LENGTH);
      let summaryText = "Summary unavailable"; // Renamed from 'summary' to avoid conflict with outer scope
      
      if (suggestionModelAvailable) {
        try {
          const summarizePrompt = `Summarize this code snippet in 50 words or less:\n\n${snippet}`;
          // Ensure llmProvider is available in this scope. It's initialized in startServer.
          // If not directly available, it needs to be passed or retrieved via getLLMProvider().
          // Assuming llmProvider is accessible here (e.g., passed to registerTools or retrieved).
          // For now, let's assume getLLMProvider() is the way if not passed down.
          const currentLlmProvider = await getLLMProvider(); // Get it if not passed down
          summaryText = await currentLlmProvider.generateText(summarizePrompt);
        } catch (error: unknown) {
          logger.warn(`Failed to generate summary for ${result.payload.filepath}: ${(error as Error).message}`);
          summaryText = "Summary generation failed";
        }
      }
      
      return {
        filepath: result.payload.filepath,
        snippet,
        summary: summaryText, // Use the renamed variable
        last_modified: result.payload.last_modified,
        relevance: result.score,
      };
    }));

    const formattedResponse = `# Search Results for: "${searchQuery}"
${refinedQuery !== searchQuery ? `\n> Query refined to: "${refinedQuery}"` : ''}
${summaries.length > 0 ? summaries.map(s => `
## ${s.filepath}
- Last Modified: ${s.last_modified}
- Relevance: ${s.relevance.toFixed(2)}

### Code Snippet
\`\`\`
${s.snippet}
\`\`\`

### Summary
${s.summary}
`).join('\n') : "\nNo relevant code snippets found in files for your query. The query might have matched commit messages or diffs, which are not detailed by this tool."}

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
    "get_changelog", // name
    "Retrieves the content of the `CHANGELOG.md` file from the root of the repository. This provides a history of changes and versions for the project. \nExample: Call this tool without parameters: `{}`. Title: Get Changelog", // description (Title incorporated here)
    {}, // paramsSchema (as ZodRawShape for no parameters)
    async (_args: Record<string, never>, _extra: RequestHandlerExtra<ServerRequest, ServerNotification>) => { // handler
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
            type: "text", 
            text: `# Error Reading Changelog\n\nFailed to read the changelog file. Current version is ${VERSION}.`,
          }],
        };
      }
    }
    // The 5th argument (annotations object) has been removed.
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
    // Ensure this handler is synchronous if no await is used.
    (args: { sessionId: string }, _extra: RequestHandlerExtra<ServerRequest, ServerNotification>) => { // Removed async
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
      const context = results
      .map(r => {
        if (r.payload?.dataType === 'file_chunk') {
          const payload = r.payload;
          return {
            type: 'file_chunk',
            filepath: payload.filepath,
            snippet: payload.file_content_chunk.slice(0, configService.MAX_SNIPPET_LENGTH),
            last_modified: payload.last_modified,
            relevance: r.score,
            note: ""
          };
        } else if (r.payload?.dataType === 'commit_info') {
          const payload = r.payload;
          return {
            type: 'commit_info',
            commit_oid: payload.commit_oid,
            message: payload.commit_message.slice(0, configService.MAX_SNIPPET_LENGTH),
            author: payload.commit_author_name,
            date: payload.commit_date,
            relevance: r.score,
            note: "Commit Information"
          };
        } else if (r.payload?.dataType === 'diff_chunk') {
          const payload = r.payload;
          return {
            type: 'diff_chunk',
            commit_oid: payload.commit_oid,
            filepath: payload.filepath,
            snippet: payload.diff_content_chunk.slice(0, configService.MAX_SNIPPET_LENGTH),
            change_type: payload.change_type,
            relevance: r.score,
            note: "Diff Information"
          };
        }
        logger.warn(`generate_suggestion: Encountered result with unknown payload type or missing dataType: ID ${r.id}`);
        return null;
      })
      .filter(item => item !== null) as Array<{type: string; relevance: number; note: string; [key: string]: unknown}>;
      
      if (context.length < 2 && relevantResults.length > 0) {
        const additionalContext = relevantResults
          .filter(rUnk => { // Check if this result is already in context by a more robust ID or combination
            const r = rUnk as DetailedQdrantSearchResult; // Assuming relevantResults are DetailedQdrantSearchResult
            if (r.payload?.dataType === 'file_chunk') {
              return !context.some(c => c.type === 'file_chunk' && c.filepath === (r.payload as FileChunkPayload).filepath);
            } else if (r.payload?.dataType === 'commit_info') {
              return !context.some(c => c.type === 'commit_info' && c.commit_oid === (r.payload as CommitInfoPayload).commit_oid);
            } else if (r.payload?.dataType === 'diff_chunk') {
              // Diff uniqueness might be more complex, e.g., commit_oid + filepath + chunk_index
              return !context.some(c => c.type === 'diff_chunk' && c.commit_oid === (r.payload as DiffChunkPayload).commit_oid && c.filepath === (r.payload as DiffChunkPayload).filepath);
            }
            return false; // Don't include if type is unknown or not handled
          })
          .slice(0, 2) // Limit additional context items
          .map(rUnk => {
            const r = rUnk as DetailedQdrantSearchResult; // Cast again for type safety
            if (r.payload?.dataType === 'file_chunk') {
              const payload = r.payload;
              return {
                type: 'file_chunk', // Removed 'as const'
                filepath: payload.filepath,
                snippet: payload.file_content_chunk.slice(0, configService.MAX_SNIPPET_LENGTH),
                last_modified: payload.last_modified,
                relevance: r.score,
                note: "From previous related query"
              };
            } else if (r.payload?.dataType === 'commit_info') {
              const payload = r.payload;
              return {
                type: 'commit_info', // Removed 'as const'
                commit_oid: payload.commit_oid,
                message: payload.commit_message.slice(0, configService.MAX_SNIPPET_LENGTH),
                author: payload.commit_author_name,
                date: payload.commit_date,
                relevance: r.score,
                note: "From previous related query (Commit Info)"
              };
            } else if (r.payload?.dataType === 'diff_chunk') {
              const payload = r.payload;
              return {
                type: 'diff_chunk', // Removed 'as const'
                commit_oid: payload.commit_oid,
                filepath: payload.filepath,
                snippet: payload.diff_content_chunk.slice(0, configService.MAX_SNIPPET_LENGTH),
                change_type: payload.change_type,
                relevance: r.score,
                note: "From previous related query (Diff Info)"
              };
            }
            return null; // Should be filtered out by preceding filter if type is not handled
          })
          .filter(item => item !== null); // Ensure no nulls from mapping
        
        context.push(...additionalContext as Array<{type: string; relevance: number; note: string; [key: string]: unknown}>); // Cast as it's a mix
      }

      const prompt = `
**Context**:
Repository: ${repoPath}
Files: ${files.join(", ")}
Recent Changes: ${_diff}
${recentQueries.length > 0 ? `Recent Queries: ${recentQueries.join(", ")}` : ''}

**Relevant Snippets**:
${context.map(c => {
      let itemDetails = '';
      if (c.type === 'file_chunk') {
            // Assert to expected primitive types or string
            const fc = c as unknown as { filepath: string; last_modified?: string | null; relevance: number; note?: string | null; snippet?: string | null };
            itemDetails = `File: ${fc.filepath} (Last modified: ${String(fc.last_modified ?? 'N/A')}, Relevance: ${fc.relevance.toFixed(2)}${fc.note ? `, Note: ${String(fc.note)}` : ''})\nSnippet:\n${String(fc.snippet ?? '')}`;
          } else if (c.type === 'commit_info') {
            const ci = c as unknown as { commit_oid: string; author?: string | null; date?: string | null; relevance: number; note?: string | null; message?: string | null };
            itemDetails = `Commit: ${ci.commit_oid} (Author: ${String(ci.author ?? 'N/A')}, Date: ${String(ci.date ?? 'N/A')}, Relevance: ${ci.relevance.toFixed(2)}${ci.note ? `, Note: ${String(ci.note)}` : ''})\nMessage Snippet:\n${String(ci.message ?? '')}`;
          } else if (c.type === 'diff_chunk') {
            const dc = c as unknown as { filepath: string; commit_oid: string; change_type?: string | null; relevance: number; note?: string | null; snippet?: string | null };
            itemDetails = `Diff: ${dc.filepath} in commit ${dc.commit_oid} (Type: ${String(dc.change_type ?? 'N/A')}, Relevance: ${dc.relevance.toFixed(2)}${dc.note ? `, Note: ${String(dc.note)}` : ''})\nDiff Snippet:\n${String(dc.snippet ?? '')}`;
          }
      return itemDetails;
    }).join("\n\n")}

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
${context.map(c => {
      if (c.type === 'file_chunk') {
            const fc = c as unknown as { filepath: string; last_modified?: string | null; relevance: number; note?: string | null; snippet?: string | null };
            return `
### File: ${fc.filepath}
- Last modified: ${String(fc.last_modified ?? 'N/A')}
- Relevance: ${fc.relevance.toFixed(2)}
${fc.note ? `- Note: ${String(fc.note)}` : ''}
\`\`\`
${String(fc.snippet ?? '')}
\`\`\``;
          } else if (c.type === 'commit_info') {
            const ci = c as unknown as { commit_oid: string; author?: string | null; date?: string | null; relevance: number; note?: string | null; message?: string | null };
            return `
### Commit: ${ci.commit_oid}
- Author: ${String(ci.author ?? 'N/A')}, Date: ${String(ci.date ?? 'N/A')}
- Relevance: ${ci.relevance.toFixed(2)}
${ci.note ? `- Note: ${String(ci.note)}` : ''}
Message Snippet:
\`\`\`
${String(ci.message ?? '')}
\`\`\``;
          } else if (c.type === 'diff_chunk') {
            const dc = c as unknown as { filepath: string; commit_oid: string; change_type?: string | null; relevance: number; note?: string | null; snippet?: string | null };
            return `
### Diff: ${dc.filepath} (Commit: ${String(dc.commit_oid)})
- Change Type: ${String(dc.change_type ?? 'N/A')}
- Relevance: ${dc.relevance.toFixed(2)}
${dc.note ? `- Note: ${String(dc.note)}` : ''}
Diff Snippet:
\`\`\`
${String(dc.snippet ?? '')}
\`\`\``;
          }
      return '';
    }).join('\n')}

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
      
      const context = results
      .map(r => {
        if (r.payload?.dataType === 'file_chunk') {
          const payload = r.payload;
          return {
            type: 'file_chunk',
            filepath: payload.filepath,
            snippet: payload.file_content_chunk.slice(0, configService.MAX_SNIPPET_LENGTH),
            last_modified: payload.last_modified,
            relevance: r.score,
          };
        } else if (r.payload?.dataType === 'commit_info') {
          const payload = r.payload;
          return {
            type: 'commit_info',
            commit_oid: payload.commit_oid,
            message: payload.commit_message.slice(0, configService.MAX_SNIPPET_LENGTH), // Snippet of commit message
            author: payload.commit_author_name,
            date: payload.commit_date,
            relevance: r.score,
          };
        } else if (r.payload?.dataType === 'diff_chunk') {
          const payload = r.payload;
          return {
            type: 'diff_chunk',
            commit_oid: payload.commit_oid,
            filepath: payload.filepath,
            snippet: payload.diff_content_chunk.slice(0, configService.MAX_SNIPPET_LENGTH), // Snippet of diff
            change_type: payload.change_type,
            relevance: r.score,
          };
        }
        logger.warn(`get_repository_context: Encountered result with unknown payload type or missing dataType: ID ${r.id}`);
        return null;
      })
      .filter(item => item !== null) as Array<{type: string; relevance: number; [key: string]: unknown}>; // Type for prompt construction
      
      const summaryPrompt = `
**Context**:
Repository: ${repoPath}
Files: ${files.join(", ")}
Recent Changes: ${_diff}
${recentQueries.length > 0 ? `Recent Queries: ${recentQueries.join(", ")}` : ''}

**Relevant Information Snippets**:
${context.map(c => {
  let itemDetails = '';
  if (c.type === 'file_chunk') {
            const fc = c as unknown as { filepath: string; last_modified?: string | null; relevance: number; note?: string | null; snippet?: string | null };
            itemDetails = `File: ${fc.filepath} (Last modified: ${String(fc.last_modified ?? 'N/A')}, Relevance: ${fc.relevance.toFixed(2)}${fc.note ? `, Note: ${String(fc.note)}` : ''})\nSnippet:\n${String(fc.snippet ?? '')}`;
          } else if (c.type === 'commit_info') {
            const ci = c as unknown as { commit_oid: string; author?: string | null; date?: string | null; relevance: number; note?: string | null; message?: string | null };
            itemDetails = `Commit: ${ci.commit_oid} (Author: ${String(ci.author ?? 'N/A')}, Date: ${String(ci.date ?? 'N/A')}, Relevance: ${ci.relevance.toFixed(2)}${ci.note ? `, Note: ${String(ci.note)}` : ''})\nMessage Snippet:\n${String(ci.message ?? '')}`;
          } else if (c.type === 'diff_chunk') {
            const dc = c as unknown as { filepath: string; commit_oid: string; change_type?: string | null; relevance: number; note?: string | null; snippet?: string | null };
            itemDetails = `Diff: ${dc.filepath} in commit ${dc.commit_oid} (Type: ${String(dc.change_type ?? 'N/A')}, Relevance: ${dc.relevance.toFixed(2)}${dc.note ? `, Note: ${String(dc.note)}` : ''})\nDiff Snippet:\n${String(dc.snippet ?? '')}`;
          }
  return itemDetails;
}).join("\n\n")}

**Instruction**:
Provide a concise summary of the context for "${queryStrCtx}" based on the repository files, commit history, diffs, and recent changes. Highlight key information relevant to the query, referencing specific files, commits, or snippets where applicable.
      `;
      
      const llmProvider = await getLLMProvider();
      
      const summary = await llmProvider.generateText(summaryPrompt);
      
      addQuery(session.id, queryStrCtx, results);
      
      const formattedResponse = `# Repository Context Summary for: "${queryStrCtx}"
${refinedQuery !== queryStrCtx ? `\n> Query refined to: "${refinedQuery}"` : ''}

## Summary
${summary}

## Relevant Information Used for Summary
${context.map(c => {
  if (c.type === 'file_chunk') {
            const fc = c as unknown as { filepath: string; last_modified?: string | null; relevance: number; note?: string | null; snippet?: string | null };
            return `
### File: ${fc.filepath}
- Last modified: ${String(fc.last_modified ?? 'N/A')}
- Relevance: ${fc.relevance.toFixed(2)}
${fc.note ? `- Note: ${String(fc.note)}` : ''}
\`\`\`
${String(fc.snippet ?? '')}
\`\`\``;
          } else if (c.type === 'commit_info') {
            const ci = c as unknown as { commit_oid: string; author?: string | null; date?: string | null; relevance: number; note?: string | null; message?: string | null };
            return `
### Commit: ${ci.commit_oid}
- Author: ${String(ci.author ?? 'N/A')}, Date: ${String(ci.date ?? 'N/A')}
- Relevance: ${ci.relevance.toFixed(2)}
${ci.note ? `- Note: ${String(ci.note)}` : ''}
Message Snippet:
\`\`\`
${String(ci.message ?? '')}
\`\`\``;
          } else if (c.type === 'diff_chunk') {
            const dc = c as unknown as { filepath: string; commit_oid: string; change_type?: string | null; relevance: number; note?: string | null; snippet?: string | null };
            return `
### Diff: ${dc.filepath} (Commit: ${String(dc.commit_oid)})
- Change Type: ${String(dc.change_type ?? 'N/A')}
- Relevance: ${dc.relevance.toFixed(2)}
${dc.note ? `- Note: ${String(dc.note)}` : ''}
Diff Snippet:
\`\`\`
${String(dc.snippet ?? '')}
\`\`\``;
          }
  return '';
}).join('\n')}

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
