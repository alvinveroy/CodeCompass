import { McpServer, ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js"; // Added ResourceTemplate
// Assuming these are correctly exported by the SDK, either from root or via defined subpaths.
// If the SDK's "exports" map points these subpaths to .js files, add .js here.
// If they are re-exported from the main SDK entry, use that.
// import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js"; // Replaced by StdioServerTransport
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
// SessionManager import removed as it's not used or found at the specified path.
// Session handling is managed by StreamableHTTPServerTransport options.
// import { randomUUID } from "crypto"; // No longer needed for stdio transport
import express from 'express';
import http from 'http';
import axios from 'axios'; // Add this import
// import { ServerRequest, ServerNotification, isInitializeRequest } from "@modelcontextprotocol/sdk/types.js"; // No longer needed for stdio transport
import { type ServerRequest, type ServerNotification } from "@modelcontextprotocol/sdk/types.js";
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
import { getOrCreateSession, addQuery, addSuggestion, updateContext, getRecentQueries, getRelevantResults, getSessionHistory } from "./state";
import winston from "winston"; // Added for temporary logger

// RequestBodyWithId removed as it was only used by the /mcp HTTP endpoint

interface PingResponseData {
  service?: string;
  status?: string;
  version?: string;
}

// Helper type for server startup errors
// Ensure IndexingStatusReport is imported if you intend to pass the full status,
// otherwise PingResponseData might be sufficient for existingServerStatus.
// import { IndexingStatusReport } from './repository'; // Already imported
// PingResponseData is already defined in this file.

export class ServerStartupError extends Error {
  public readonly originalError?: Error;
  // Use PingResponseData or a union if more detailed status is needed from IndexingStatusReport
  public readonly existingServerStatus?: PingResponseData | IndexingStatusReport;
  public readonly requestedPort?: number;
  public readonly detectedServerPort?: number; // Port of the existing CodeCompass server

  constructor(
    message: string,
    public exitCode = 1,
    options?: {
      originalError?: Error;
      existingServerStatus?: PingResponseData | IndexingStatusReport;
      requestedPort?: number;
      detectedServerPort?: number;
    }
  ) {
    super(message);
    this.name = "ServerStartupError";
    this.originalError = options?.originalError;
    this.existingServerStatus = options?.existingServerStatus;
    this.requestedPort = options?.requestedPort;
    this.detectedServerPort = options?.detectedServerPort;
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

let processListenersAttached = false; // Flag to track if listeners are attached

// Add this function definition at the module level, before startServer

// eslint-disable-next-line @typescript-eslint/require-await
async function configureMcpServerInstance(
  mcpInstance: McpServer,
  qdrantClient: QdrantClient,
  repoPath: string,
  suggestionModelAvailable: boolean
  // Add other dependencies like VERSION if needed by resource/tool registration
) {
  // Register resources
  if (typeof mcpInstance.resource !== "function") {
    throw new Error("MCP server instance does not support 'resource' method");
  }
  
  mcpInstance.resource("Server Health Status", "repo://health", async () => {
    const healthUri = "repo://health";
    try {
      let ollamaStatus = "unhealthy";
      try {
        await checkOllama();
        ollamaStatus = "healthy";
      } catch (err) {
        logger.warn(`Ollama health check failed during repo://health: ${err instanceof Error ? err.message : String(err)}`);
      }

      let qdrantStatus = "unhealthy";
      try {
        await qdrantClient.getCollections();
        qdrantStatus = "healthy";
      } catch (err) {
        logger.warn(`Qdrant health check failed during repo://health: ${err instanceof Error ? err.message : String(err)}`);
      }
      
      const repositoryStatus = await validateGitRepository(repoPath) ? "healthy" : "unhealthy";

      const status = {
        ollama: ollamaStatus,
        qdrant: qdrantStatus,
        repository: repositoryStatus,
        version: VERSION, // Ensure VERSION is imported and accessible
        timestamp: new Date().toISOString()
      };
      return { contents: [{ uri: healthUri, text: JSON.stringify(status, null, 2) }] };
    } catch (error: unknown) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      logger.error(`Critical error in repo://health resource handler: ${errorMessage}`);
      const errorPayload = {
        error: "Failed to retrieve complete health status due to a critical error.",
        details: errorMessage,
        version: VERSION, // Ensure VERSION is imported and accessible
        timestamp: new Date().toISOString(),
        ollama: "unknown", 
        qdrant: "unknown",
        repository: "unknown"
      };
      return { contents: [{ uri: healthUri, text: JSON.stringify(errorPayload, null, 2) }] };
    }
  });
  
  mcpInstance.resource("Server Version", "repo://version", () => {
    return { contents: [{ uri: "repo://version", text: VERSION }] }; // Ensure VERSION is imported and accessible
  });

  mcpInstance.resource("Repository File Structure", "repo://structure", async () => {
    const uriStr = "repo://structure";
    const isGitRepo = await validateGitRepository(repoPath);
    if (!isGitRepo) {
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

  mcpInstance.resource(
    "Repository File Content",
    new ResourceTemplate("repo://files/{filepath}", { list: undefined }),
    {}, 
    async (uri: URL, variables: any, _extra: any) => {
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

    if (!relativeFilepath) {
      const errMsg = "File path cannot be empty.";
      logger.error(`Error accessing resource for URI ${uri.toString()}: ${errMsg}`);
      return { contents: [{ uri: uri.toString(), text: "", error: errMsg }] };
    }

    try {
      const resolvedRepoPath = path.resolve(repoPath);
      const requestedFullPath = path.resolve(repoPath, relativeFilepath);

      if (!requestedFullPath.startsWith(resolvedRepoPath + path.sep) && requestedFullPath !== resolvedRepoPath) {
        throw new Error(`Access denied: Path '${relativeFilepath}' attempts to traverse outside the repository directory.`);
      }
      
      let finalPathToRead = requestedFullPath;
      try {
          const stats = await fs.lstat(requestedFullPath);
          if (stats.isSymbolicLink()) {
              const symlinkTargetPath = await fs.realpath(requestedFullPath);
              if (!path.resolve(symlinkTargetPath).startsWith(resolvedRepoPath + path.sep) && path.resolve(symlinkTargetPath) !== resolvedRepoPath) {
                  throw new Error(`Access denied: Symbolic link '${relativeFilepath}' points outside the repository directory.`);
              }
              finalPathToRead = symlinkTargetPath;
          } else if (!stats.isFile()) {
              throw new Error(`Access denied: Path '${relativeFilepath}' is not a file.`);
          }
      } catch (statError: unknown) {
          if ((statError as NodeJS.ErrnoException).code === 'ENOENT') {
              throw new Error(`File not found: ${relativeFilepath}`);
          }
          throw statError;
      }

      const content = await fs.readFile(finalPathToRead, "utf8");
      return { contents: [{ uri: uri.toString(), text: content }] };
    } catch (error: unknown) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      logger.error(`Error accessing resource for URI ${uri.toString()} (relative path: ${relativeFilepath}): ${errorMessage}`);
      return { contents: [{ uri: uri.toString(), text: "", error: errorMessage }] };
    }
  });

  // Assuming registerTools and registerPrompts are defined elsewhere and correctly use mcpInstance
  registerTools(mcpInstance, qdrantClient, repoPath, suggestionModelAvailable); 
  registerPrompts(mcpInstance); 
  
  mcpInstance.tool(
    "get_indexing_status", // Renamed
    "Retrieves the current status of repository indexing. Provides information on whether indexing is idle, in-progress, completed, or failed, along with progress percentage and any error messages.",
    {}, 
    (_args: Record<string, never>, _extra: any) => {
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
  
  mcpInstance.tool(
    "switch_suggestion_model", // Renamed
    "Switches the primary model and provider used for generating suggestions. Embeddings continue to be handled by the configured Ollama embedding model. \nExample: To switch to 'deepseek-coder' (DeepSeek provider), use `{\"model\": \"deepseek-coder\", \"provider\": \"deepseek\"}`. To switch to 'llama3.1:8b' (Ollama provider), use `{\"model\": \"llama3.1:8b\", \"provider\": \"ollama\"}`. If provider is omitted, it may be inferred for known model patterns. For other providers like 'openai', 'gemini', 'claude', specify both model and provider: `{\"model\": \"gpt-4\", \"provider\": \"openai\"}`.",
    {
      model: z.string().describe("The suggestion model to switch to (e.g., 'llama3.1:8b', 'deepseek-coder', 'gpt-4')."),
      provider: z.string().optional().describe("The LLM provider for the model (e.g., 'ollama', 'deepseek', 'openai', 'gemini', 'claude'). If omitted, an attempt will be made to infer it.")
    },
    async (args: { model: string; provider?: string }, _extra: any) => {
      // ... (handler logic remains the same, just ensure logs refer to 'switch_suggestion_model')
      logger.info("Received args for switch_suggestion_model", { args });

      const modelToSwitchTo = args.model;
      const providerToSwitchTo = args.provider?.toLowerCase(); 

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
        const success = await switchSuggestionModel(modelToSwitchTo, providerToSwitchTo);
      
        if (!success) {
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
}


export async function startServer(repoPath: string): Promise<void> {
  // Add these logs for debugging the spawned server's environment
  // Temporarily create a new logger instance for this debug line if the main logger isn't ready
  const tempLogger = winston.createLogger({ transports: [new winston.transports.Console({ format: winston.format.simple() })]});
  
  // The reloadConfigsFromFile(true) should ensure it re-reads process.env if called early enough.
  // configService.reloadConfigsFromFile(true); // This is already called later
  
  // --- Original code continues ---
  if (!processListenersAttached) {
    process.on('uncaughtException', (error: Error) => {
      logger.error('UNCAUGHT EXCEPTION:', { message: error.message, stack: error.stack });
      if (process.env.NODE_ENV !== 'test') {
        process.exit(1);
      }
    });

    process.on('unhandledRejection', (reason: unknown, promise: Promise<unknown>) => {
      logger.error('UNHANDLED PROMISE REJECTION:', { reason, promise });
      if (process.env.NODE_ENV !== 'test') {
        process.exit(1);
      }
    });
    processListenersAttached = true;
  }
  
  logger.info("Starting CodeCompass MCP server...");

  // eslint-disable-next-line @typescript-eslint/no-empty-function -- Initializing with a no-op, will be reassigned.
  let httpServerSetupResolve: () => void = () => {}; // Add this
  let httpServerSetupReject: (reason?: unknown) => void = () => {}; 
  const httpServerSetupPromise = new Promise<void>((resolve, reject) => {
    httpServerSetupResolve = resolve; // Assign resolve
    httpServerSetupReject = reject;
  });

  try {
    configService.reloadConfigsFromFile(true); 
    logger.info(`[server.ts startServer] Before getting httpPort. configService instance used: ${configService.constructor.name}. process.env.HTTP_PORT: "${process.env.HTTP_PORT}"`);
    // logger.info(`[DEBUG server.ts] After reloadConfigsFromFile, configService.HTTP_PORT: ${configService.HTTP_PORT}`);
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
        await checkOllama(); // Assumes checkOllama is imported
        await checkOllamaModel(configService.EMBEDDING_MODEL, true); // Assumes checkOllamaModel is imported
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
    
    logger.info(`Initial indexing process started for ${repoPath} in the background.`);
    indexRepository(qdrantClient, repoPath, llmProvider)
      .then(() => {
        logger.info(`Initial indexing process completed successfully for ${repoPath}.`);
      })
      .catch((error: unknown) => {
        const errorMessage = error instanceof Error ? error.message : String(error);
        logger.error(`Initial indexing process failed for ${repoPath}: ${errorMessage}`);
      });

    const serverCapabilities = { /* ... capabilities definition as in your file ... */ 
      resources: {
        "repo://structure": { name: "Repository File Structure", description: "Lists all files in the current Git repository.", mimeType: "text/plain" },
        "repo://files/{filepath}": { name: "Repository File Content", description: "Retrieves the content of a specific file...", mimeType: "text/plain", template: true, parameters: { filepath: { type: "string", description: "..." }}},
        "repo://health": { name: "Server Health Status", description: "Provides the health status...", mimeType: "application/json" },
        "repo://version": { name: "Server Version", description: "Provides the current version...", mimeType: "text/plain" }
      },
      tools: {
        search_code: {}, get_repository_context: {}, // Renamed
        ...(suggestionModelAvailable ? { generate_suggestion: {} } : {}), // Renamed
        get_changelog: {}, agent_query: {}, switch_suggestion_model: {}, get_indexing_status: {}, // Renamed
        trigger_repository_update: {}, // Add this line
      },
      prompts: { "repository-context": {}, "code-suggestion": {}, "code-analysis": {} }, // Renamed
    };

    // This McpServer instance is primarily for defining capabilities.
    // Per-session instances will be created for actual MCP communication.
    // const _globalMcpServer = new McpServer({
    //   name: "CodeCompass", version: VERSION, vendor: "CodeCompass", capabilities: serverCapabilities,
    // });
    // Resource/tool/prompt registration for the global server instance is not strictly necessary
    // if all MCP communication goes through per-session instances that are configured individually.
    // However, if any global handlers were intended, they would be registered on _globalMcpServer.
    // For now, configureMcpServerInstance will be called on per-session servers.
    // With stdio, we will have one main McpServer instance.

    const mainStdioMcpServer = new McpServer({
      name: "CodeCompass", version: VERSION, vendor: "CodeCompass", capabilities: serverCapabilities,
    });
    await configureMcpServerInstance(mainStdioMcpServer, qdrantClient, repoPath, suggestionModelAvailable);

    // StdioServerTransport constructor expects stdin and stdout properties
    // Assuming StdioServerTransport defaults to process.stdin/stdout if no args are provided,
    // based on SDK examples.
    const transportForStdio = new StdioServerTransport();
    // Stdio MCP server connection moved to after HTTP server setup race condition.

    const finalDeclaredTools = Object.keys(serverCapabilities.tools);
    logger.info(`Declared tools in capabilities: ${finalDeclaredTools.join(', ')}`);
    const finalDeclaredPrompts = Object.keys(serverCapabilities.prompts);
    logger.info(`Declared prompts in capabilities: ${finalDeclaredPrompts.join(', ')}`);

    const expressApp = express();
    expressApp.use(express.json());
    
    expressApp.get('/api/indexing-status', (_req: express.Request, res: express.Response): void => {
      res.json(getGlobalIndexingStatus());
    });
    expressApp.get('/api/ping', (_req: express.Request, res: express.Response): void => {
      res.json({ service: "CodeCompass", status: "ok", version: VERSION });
    });
    expressApp.post('/api/repository/notify-update', (_req: express.Request, res: express.Response): void => {
      logger.info('Received /api/repository/notify-update.');
      const currentStatus = getGlobalIndexingStatus();
      if (['initializing', 'validating_repo', 'listing_files', 'cleaning_stale_entries', 'indexing_file_content', 'indexing_commits_diffs'].includes(currentStatus.status)) {
        res.status(409).json({ message: 'Indexing already in progress.' }); return;
      }
      indexRepository(qdrantClient, repoPath, llmProvider).catch(err => logger.error("Re-indexing error:", err));
      res.status(202).json({ message: 'Re-indexing initiated.' });
    });

    // activeSessionTransports and /mcp HTTP routes removed for stdio-first MCP.
    // MCP communication is now handled by mainStdioMcpServer via StdioServerTransport.

    // Read HTTP_PORT *after* reloadConfigsFromFile has definitely run
    let httpPort = configService.HTTP_PORT; 
    logger.info(`[server.ts startServer] Initial httpPort from configService.HTTP_PORT: ${httpPort}`);
    // logger.info(`[INTEGRATION_DEBUG] server.ts: configService.HTTP_PORT initially: ${httpPort}`);
    if (httpPort === 0) {
      logger.info(`[server.ts startServer] httpPort is 0, about to call findFreePort.`);
      logger.info(`HTTP_PORT is 0, attempting to find a free port dynamically.`);
      httpPort = await findFreePort(10000 + Math.floor(Math.random() * 10000)); // Start search from a high random port
      logger.info(`findFreePort selected: ${httpPort}. Setting global.CURRENT_HTTP_PORT.`);
      global.CURRENT_HTTP_PORT = httpPort; // Ensure this dynamically found port is globally visible if needed
    }
    // logger.info(`[INTEGRATION_DEBUG] server.ts: final httpPort for listen: ${httpPort}`);
    const httpServer = http.createServer(expressApp as (req: http.IncomingMessage, res: http.ServerResponse) => void);

    httpServer.on('error', async (error: NodeJS.ErrnoException) => { // eslint-disable-line @typescript-eslint/no-misused-promises -- Event handler, promise settlement not directly used by emitter
      if (error.code === 'EADDRINUSE') {
        // ADD THIS LOG:
        logger.error(`[Spawned Server EADDRINUSE DEBUG] Entered EADDRINUSE block. Current httpPort variable is: ${httpPort}. configService.HTTP_PORT is: ${configService.HTTP_PORT}`);
        logger.warn(`HTTP Port ${httpPort} is already in use. Attempting to ping...`);
        try {
          const pingResponse = await axios.get<PingResponseData>(`http://localhost:${httpPort}/api/ping`, { timeout: 500 });
          if (pingResponse.status === 200 && pingResponse.data?.service === "CodeCompass") {
            logger.info(`Another CodeCompass instance (v${pingResponse.data.version || 'unknown'}) is running on port ${httpPort}.`);
            // ... (rest of EADDRINUSE handling logic as in your file) ...
            // Full EADDRINUSE logic from user's provided file:
            try {
              const statusResponse = await axios.get<IndexingStatusReport>(`http://localhost:${httpPort}/api/indexing-status`, { timeout: 1000 });
              if (statusResponse.status === 200 && statusResponse.data) {
                const existingStatus = statusResponse.data;
                logger.info(`\n--- Status of existing CodeCompass instance on port ${httpPort} ---`);
                logger.info(`Version: ${pingResponse.data.version || 'unknown'}`);
                logger.info(`Status: ${existingStatus.status}`);
                logger.info(`Message: ${existingStatus.message}`);
                if (existingStatus.overallProgress !== undefined) {
                  logger.info(`Progress: ${existingStatus.overallProgress}%`);
                }
                if (existingStatus.currentFile) {
                  logger.info(`Current File: ${existingStatus.currentFile}`);
                }
                if (existingStatus.currentCommit) {
                  logger.info(`Current Commit: ${existingStatus.currentCommit}`);
                }
                logger.info(`Last Updated: ${existingStatus.lastUpdatedAt}`);
                logger.info(`-----------------------------------------------------------\n`);
                const exitMessage = `Current instance will exit as another CodeCompass server (v${pingResponse.data.version || 'unknown'}) is already running on port ${httpPort}.`;
                logger.info(exitMessage);
                console.error(exitMessage); // Also log to console for CLI visibility
                httpServerSetupReject(new ServerStartupError(
                  `Port ${httpPort} in use by another CodeCompass instance (v${pingResponse.data.version || 'unknown'}). This instance will exit.`,
                  0, // Exit code 0 for graceful exit
                  {
                    originalError: error, // The original EADDRINUSE error
                    existingServerStatus: pingResponse.data, // Store the ping data
                    requestedPort: httpPort,
                    detectedServerPort: httpPort,
                  }
                ));
              } else {
                logger.error(`Failed to retrieve status from existing CodeCompass server on port ${httpPort}. It responded to ping but status endpoint failed. Status: ${statusResponse.status}`);
                httpServerSetupReject(new ServerStartupError(
                  `Port ${httpPort} in use, status fetch failed.`,
                  1,
                  {
                    originalError: error,
                    existingServerStatus: pingResponse.data, // Still pass ping data
                    requestedPort: httpPort,
                    detectedServerPort: httpPort,
                  }
                ));
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
              httpServerSetupReject(new ServerStartupError(
                `Port ${httpPort} in use by existing CodeCompass server, but status fetch error occurred.`,
                1,
                {
                  originalError: error, // Original EADDRINUSE
                  existingServerStatus: pingResponse.data, // Ping data is still relevant
                  requestedPort: httpPort,
                  detectedServerPort: httpPort, // We know it's a CC server
                }
              ));
            }
          } else {
            logger.error(`Port ${httpPort} is in use by non-CodeCompass server. Response: ${JSON.stringify(pingResponse.data)}`);
            logger.error(`Please free the port or configure a different one (e.g., via HTTP_PORT environment variable or in ~/.codecompass/model-config.json).`);
            httpServerSetupReject(new ServerStartupError(
              `Port ${httpPort} is in use by non-CodeCompass server. Response: ${JSON.stringify(pingResponse.data)}`,
              1,
              {
                originalError: error, // The original EADDRINUSE error
                existingServerStatus: pingResponse.data,
                requestedPort: httpPort,
              }
            ));
          }
        } catch (pingError) {
          let pingErrorMessage = "Unknown ping error";
          if (axios.isAxiosError(pingError)) {
            pingErrorMessage = pingError.message;
            if (pingError.code === 'ECONNREFUSED') {
              logger.error(`Connection refused on port ${httpPort}.`);
            } else if (pingError.code === 'ETIMEDOUT' || pingError.code === 'ECONNABORTED') {
              logger.error(`Ping attempt to port ${httpPort} timed out.`);
            } else {
              logger.error(`Ping error details: ${pingError.message}`);
            }
          } else {
             pingErrorMessage = String(pingError);
             logger.error(`Ping error details: ${pingErrorMessage}`);
          }
          logger.error(`Port ${httpPort} is in use by an unknown service or the existing CodeCompass server is unresponsive to pings.`);
          logger.error(`Please free the port or configure a different one (e.g., via HTTP_PORT environment variable or in ~/.codecompass/model-config.json).`);
          httpServerSetupReject(new ServerStartupError(
            `Port ${httpPort} is in use by an unknown service or the existing CodeCompass server is unresponsive to pings. Ping error: ${pingErrorMessage}`,
            1,
            {
              originalError: error, // The original EADDRINUSE error
              existingServerStatus: { service: 'Unknown or non-responsive to pings' },
              requestedPort: httpPort,
            }
          ));
        }
      } else {
        logger.error(`Failed to start HTTP server on port ${httpPort}: ${error.message}`);
        httpServerSetupReject(new ServerStartupError(`HTTP server error: ${error.message}`, 1));
      }
    });

    const listenPromise = new Promise<void>((resolve) => {
      httpServer.listen(httpPort, () => {
        logger.info(`CodeCompass HTTP server listening on port ${httpPort} for status and notifications.`);
        httpServerSetupResolve(); // Resolve the setup promise on successful listen
        resolve();
      });
    });

    await Promise.race([listenPromise, httpServerSetupPromise]);
    
    // Connect stdio MCP server only if HTTP server setup didn't lead to an early exit/rejection.
    await mainStdioMcpServer.connect(transportForStdio);
    logger.info("CodeCompass MCP server connected to stdio transport. Ready for MCP communication over stdin/stdout.");
    
    logger.info(`CodeCompass MCP server v${VERSION} running for repository: ${repoPath} (MCP via stdio)`);
    // Updated console message to reflect stdio MCP and utility HTTP server
    // Only log this if the utility server is actually running (not disabled due to EADDRINUSE by another CC instance)
    // And if the server isn't exiting due to an existing instance.
    // The httpServerSetupPromise rejection with exitCode 0 handles the "exiting" scenario.
    if (!configService.IS_UTILITY_SERVER_DISABLED) { // This implies it's not exiting due to another CC instance
      console.error(`CodeCompass v${VERSION} ready. MCP active on stdio. Utility HTTP server running on port ${httpPort}.`);
    }
    // The case where IS_UTILITY_SERVER_DISABLED is true (proxy mode) is handled by the EADDRINUSE logic that resolves httpServerSetupPromise.
    // The case where it exits due to another CC instance (exitCode 0) will have its own console message from the EADDRINUSE handler.
    
    if (process.env.NODE_ENV === 'test') {
      logger.info("Test environment detected, server setup complete. Skipping SIGINT wait.");
      return; // Resolve the startServer promise in test mode
    } else {
      await new Promise<void>((resolve) => {
        process.on('SIGINT', () => {
          logger.info("SIGINT received, shutting down server.");
          resolve();
        });
      });
    }
  } catch (error: unknown) {
    const err = error instanceof ServerStartupError ? error : new Error(String(error)); // Ensure err is Error type
    logger.error("Failed to start CodeCompass", { message: err.message });
    if (process.env.NODE_ENV === 'test') { 
      throw err;
    }
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
    "repository-context", // Renamed
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
    "code-suggestion", // Renamed
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
    "code-analysis", // Renamed
    "Analyze code problems",
    { query: z.string().describe("The code problem or snippet to be analyzed.") },
    ({ query }) => ({
      messages: [{
        role: "user",
        content: { type: "text", text: `Analyze this code problem: ${query}` }
      }]
    })
  );
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
    "agent_query", // Renamed
    "Provides a detailed plan and a comprehensive summary for addressing complex questions or tasks related to the codebase. This tool generates these insights in a single pass. \nExample: `{\"query\": \"How is user authentication handled in this project?\"}`.",
    {
      query: z.string().describe("The question or task for the agent to process"),
      sessionId: z.string().optional().describe("Optional session ID to maintain context between requests")
      // maxSteps removed
    },
    async (args: { query: string; sessionId?: string }, _extra: any) => {
      // ... (handler logic remains the same, ensure logs refer to 'agent_query')
      logger.info(`Tool 'agent_query' execution started with args:`, args);

      const query = args.query;
      const sessionId = args.sessionId;
      logger.debug(`[SERVER_TOOL_HANDLER] agent_query entered. Args: ${JSON.stringify(args)}, Query: "${query}", SessionId: "${sessionId}"`);

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
        logger.debug(`[SERVER_TOOL_HANDLER] agent_query calling processAgentQuery. Query: "${query}", SessionId: "${sessionId}"`);
        const agentResponseText = await processAgentQuery(query, sessionId); // processAgentQuery only accepts two arguments
        logger.debug(`[SERVER_TOOL_HANDLER] agent_query processAgentQuery completed. Response: ${JSON.stringify(agentResponseText)}`);

        // Add this log:
        if (sessionId) {
          // repoPath is available from the registerTools function's scope
          const currentSession = getOrCreateSession(sessionId, repoPath); 
          if (currentSession) {
            console.log(`[SERVER_TS_DEBUG] After agent_query for session ${sessionId}, state.queries:`, JSON.stringify(currentSession.queries));
          }
        }
        // User requested logging:
        if (args.sessionId) { // Check if sessionId was provided in args
            const currentSessionState = getSessionHistory(args.sessionId); 
            const queryLog = currentSessionState.queries.map(q => q.query.substring(0, 30) + '...');
            logger.info(`[SERVER_TOOL_DEBUG] agent_query (session: ${args.sessionId}): After adding query (via processAgentQuery). Total queries now: ${currentSessionState.queries.length}. Recent queries: ${JSON.stringify(queryLog)}`);
            const updatedSessionForAgentQuery = getSessionHistory(args.sessionId); // Re-fetch to ensure we see what getSessionHistory would see
            logger.info(`[SERVER_TOOL_DEBUG] agent_query (session: ${args.sessionId}): After addQuery. Query count from re-fetched session: ${updatedSessionForAgentQuery.queries.length}.`);
            logger.info(`[SERVER_TOOL_DEBUG] agent_query (session: ${args.sessionId}): Queries object after addQuery: ${JSON.stringify(updatedSessionForAgentQuery.queries, null, 2)}`);
        } else {
            logger.warn('[SERVER_TOOL_DEBUG] agent_query: sessionId is undefined in args after processAgentQuery.');
        }
        
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
    "search_code", // Renamed
    "Performs a semantic search for code snippets within the repository that are relevant to the given query. Results include file paths, code snippets, and relevance scores. \nExample: `{\"query\": \"function to handle user login\"}`. For a broader search: `{\"query\": \"database connection setup\"}`.",
    {
      query: z.string().describe("The search query to find relevant code in the repository"),
      sessionId: z.string().optional().describe("Optional session ID to maintain context between requests")
    },
    async (args: { query: string; sessionId?: string }, _extra: any) => {
      // ... (handler logic remains the same, ensure logs refer to 'search_code')
      logger.info(`Tool 'search_code' execution started.`);
      logger.info("Received args for search_code", { args });

      const searchQuery = args.query || "code search"; 
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
    "get_changelog", // Renamed
    "Retrieves the content of the `CHANGELOG.md` file from the root of the repository. This provides a history of changes and versions for the project. \nExample: Call this tool without parameters: `{}`. Title: Get Changelog", 
    {}, 
    async (_args: Record<string, never>, _extra: any) => { 
      // ... (handler logic remains the same)
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
    "get_session_history", // Renamed
    "Retrieves the history of interactions (queries, suggestions, feedback) for a given session ID. This allows you to review past activities within a specific CodeCompass session. \nExample: `{\"sessionId\": \"your_session_id_here\"}`.",
    {
      sessionId: z.string().describe("The session ID to retrieve history for")
    },
    (args: { sessionId: string }, _extra: any) => { 
      // ... (handler logic remains the same, ensure logs refer to 'get_session_history')
      logger.info("Received args for get_session_history", { args });

      const sessionIdValue = args.sessionId;
      logger.debug(`[SERVER_TOOL_HANDLER] get_session_history entered. Requested sessionId: ${sessionIdValue}`);

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
      // repoPath is available in the scope of registerTools
      const session = getOrCreateSession(sessionIdValue, repoPath); // Pass repoPath

      if (!session) {
        // If session is null, it means it wasn't found and couldn't be created (or repoPath was missing for creation)
        const errorMsg = `Session with ID "${sessionIdValue}" not found. Ensure the session ID is correct or that the repository path was available if this is the first interaction for this session.`;
        logger.warn(`get_session_history: ${errorMsg}. Repo path used for lookup/creation attempt: ${repoPath}`);
        return {
          content: [{
            type: "text",
            text: `# Error Getting Session History\n\n${errorMsg}`,
          }],
        };
      }
      
      // Adding logger here for [SERVER_TOOLS_DEBUG]
      const queriesForLog = session.queries.map(q => ({
        query: q.query,
        ts: q.timestamp,
        results_count: q.results.length,
      }));
      logger.debug(
        `[SERVER_TOOLS_DEBUG] formatSessionHistory for session ${session.id}. Query count check.` // Temporarily removed the second argument.
      );
      
      // Add this log:
      console.log(`[SERVER_TS_DEBUG] In get_session_history for session ${session.id}, session.queries BEFORE formatting:`, JSON.stringify(session.queries));
      // User requested logging:
      const queryLog = session.queries.map(q => q.query.substring(0, 30) + '...');
      logger.info(`[SERVER_TOOL_DEBUG] get_session_history (session: ${session.id}): Retrieved session. Query count: ${session.queries.length}. Recent queries: ${JSON.stringify(queryLog)}`);
      logger.info(`[SERVER_TOOL_DEBUG] get_session_history (session: ${session.id}): Retrieved session. Query count from session object: ${session.queries.length}.`);
      logger.info(`[SERVER_TOOL_DEBUG] get_session_history (session: ${session.id}): Queries object: ${JSON.stringify(session.queries, null, 2)}`);
          
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

  // Add this new tool registration:
  server.tool(
    "trigger_repository_update",
    "Triggers a re-indexing of the repository. If this server instance's utility HTTP endpoint is disabled (due to another primary instance running), this request will be relayed to the primary instance. Otherwise, it triggers indexing locally.",
    {}, // No parameters for this tool
    async (_args: Record<string, never>, _extra: any) => {
      logger.info("Tool 'trigger_repository_update' execution started.");
      // The configService and logger should be available in this scope
      // or retrieved if necessary. qdrantClient and repoPath are parameters to registerTools.
      // llmProvider would need to be fetched if triggering locally.

      if (configService.IS_UTILITY_SERVER_DISABLED && configService.RELAY_TARGET_UTILITY_PORT) {
        const targetUrl = `http://localhost:${configService.RELAY_TARGET_UTILITY_PORT}/api/repository/notify-update`;
        logger.info(`Utility server is disabled, relaying repository update trigger to: ${targetUrl}`);
        try {
          // axios is already imported in server.ts
          const response = await axios.post(targetUrl, {}); // Empty body for POST
          logger.info(`Relayed repository update trigger successful, target server responded with status ${response.status}`);
          return {
            content: [{
              type: "text",
              text: `# Repository Update Triggered (Relayed to :${configService.RELAY_TARGET_UTILITY_PORT})\n\n${response.data.message || 'Update initiated on target server.'}`
            }]
          };
        } catch (error: unknown) {
          const errorMessage = error instanceof Error ? error.message : String(error);
          let errorDetails = errorMessage;
          if (axios.isAxiosError(error) && error.response) {
            errorDetails = `Status ${error.response.status}: ${JSON.stringify(error.response.data)}`;
          }
          logger.error(`Failed to relay repository update trigger: ${errorDetails}`);
          return {
            content: [{
              type: "text",
              text: `# Repository Update Trigger Failed (Relay Error)\n\nCould not relay to target server: ${errorDetails}`
            }]
          };
        }
      } else {
        logger.info("Utility server is active, triggering local repository update.");
        const currentStatus = getGlobalIndexingStatus(); // getGlobalIndexingStatus is imported
        if (['initializing', 'validating_repo', 'listing_files', 'cleaning_stale_entries', 'indexing_file_content', 'indexing_commits_diffs'].includes(currentStatus.status)) {
          const message = 'Indexing already in progress locally.';
          logger.warn(message);
          return {
            content: [{ type: "text", text: `# Repository Update Trigger Failed\n\n${message}` }]
          };
        }
        try {
          const llmProvider = await getLLMProvider(); // getLLMProvider is imported
          // indexRepository is imported. qdrantClient and repoPath are available from registerTools params.
          indexRepository(qdrantClient, repoPath, llmProvider)
            .then(() => logger.info("Local re-indexing process completed successfully via tool trigger."))
            .catch(err => logger.error("Local re-indexing error via tool trigger:", err));
          
          return {
            content: [{
              type: "text",
              text: "# Repository Update Triggered (Locally)\n\nRe-indexing initiated in the background."
            }]
          };
        } catch (error: unknown) {
          const errorMessage = error instanceof Error ? error.message : String(error);
          logger.error(`Error initiating local repository update: ${errorMessage}`);
          return {
            content: [{
              type: "text",
              text: `# Repository Update Trigger Failed (Local Error)\n\n${errorMessage}`
            }]
          };
        }
      }
    }
  );
    
  if (suggestionModelAvailable) {
    server.tool(
      "generate_suggestion", // Renamed
      "Generates code suggestions, implementation ideas, or examples based on a natural language query. It leverages repository context and relevant code snippets to provide targeted advice. \nExample: `{\"query\": \"Suggest an optimized way to fetch user data\"}`. For a specific task: `{\"query\": \"Write a Python function to parse a CSV file\"}`.",
      {
        query: z.string().describe("The query or prompt for generating code suggestions"),
        sessionId: z.string().optional().describe("Optional session ID to maintain context between requests")
      },
      async (args: { query: string; sessionId?: string }, _extra: any) => {
        // ... (handler logic remains the same, ensure logs refer to 'generate_suggestion')
        logger.info(`Tool 'generate_suggestion' execution started.`);
        logger.info("Received args for generate_suggestion", { args });

        const queryStr = args.query || "code suggestion"; 
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
      "get_repository_context", // Renamed
      "Provides a high-level summary of the repository's structure, common patterns, and conventions relevant to a specific query. It uses semantic search to find pertinent information and synthesizes it. \nExample: `{\"query\": \"What are the main components of the API service?\"}`. To understand coding standards: `{\"query\": \"coding conventions for frontend development\"}`.",
      {
        query: z.string().describe("The query to get repository context for"),
        sessionId: z.string().optional().describe("Optional session ID to maintain context between requests")
      },
      async (args: { query: string; sessionId?: string }, _extra: any) => {
        // ... (handler logic remains the same, ensure logs refer to 'get_repository_context')
        logger.info("Received args for get_repository_context", { args });

        const queryStrCtx = args.query || "repository context"; 
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

// Add this function definition, e.g., before startProxyServer
export async function findFreePort(startPort: number): Promise<number> { // Added export
  let port = startPort;
   
  while (true) {
    const server = http.createServer();
    try {
      await new Promise<void>((resolve, reject) => {
        server.once('error', (err: NodeJS.ErrnoException) => {
          server.removeAllListeners();
          if (err.code === 'EADDRINUSE') {
            resolve(); // Port is in use, resolve to allow trying the next port in the loop
          } else {
            reject(err); // Other error
          }
        });
        server.once('listening', () => {
          // Port is free, close server and then resolve with the port number
          server.close((closeErr?: Error) => { // server.close callback can have an error
            server.removeAllListeners();
            if (closeErr) {
              reject(closeErr);
            } else {
              // Signal success by rejecting with a special marker object containing the port.
              // This allows the catch block to identify a successful port discovery.
              // eslint-disable-next-line @typescript-eslint/no-throw-literal, @typescript-eslint/prefer-promise-reject-errors -- Custom rejection for control flow
              reject({ _isPortFoundMarker: true, port });
            }
          });
        });
        server.listen(port, 'localhost');
      });
      // If the promise resolved (due to EADDRINUSE from the 'error' handler), increment port and continue loop
      port++;
      if (port > 65535) {
        throw new Error('No free ports available.');
      }
    } catch (error: unknown) { // Changed from any to unknown
      // Check for our custom marker that indicates a port was successfully found and server closed.
      if (typeof error === 'object' && error !== null && '_isPortFoundMarker' in error && (error as {_isPortFoundMarker:boolean})._isPortFoundMarker === true && 'port' in error && typeof (error as {port:unknown}).port === 'number') {
        return (error as {port:number}).port; // Port found
      }
      // If it's a genuine EADDRINUSE (e.g., from a race condition not caught by 'error' listener,
      // or if the 'error' listener itself resolved to continue the loop), try next port.
      if (typeof error === 'object' && error !== null && 'code' in error && (error as {code:string}).code === 'EADDRINUSE') {
         port++;
         if (port > 65535) {
           throw new Error('No free ports available.');
         }
         // Continue to next iteration of the while loop
      } else {
        // Other unexpected error
        throw error; // Re-throw if it's not our marker or EADDRINUSE
      }
    } finally {
        // Ensure listeners are cleaned up in all cases for the current server instance
        server.removeAllListeners();
    }
  }
}
// Helper to convert stream to string for logging errors, place it before startProxyServer or inside if preferred
async function streamToString(stream: NodeJS.ReadableStream | unknown): Promise<string> {
  if (!stream || typeof (stream as NodeJS.ReadableStream).pipe !== 'function') { // Check if stream is null/undefined or not a stream
    return String(stream); // If not a stream, convert directly
  }
  return new Promise((resolve, reject) => {
    const chunks: Uint8Array[] = [];
    (stream as NodeJS.ReadableStream).on('data', (chunk: Uint8Array) => chunks.push(chunk));
    (stream as NodeJS.ReadableStream).on('error', reject);
    (stream as NodeJS.ReadableStream).on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
  });
}

export async function startProxyServer(
  requestedPort: number, // This is the port the main server instance initially tried
  targetServerPort: number, // This is the port the actual existing CodeCompass server is on
  existingServerVersion?: string
): Promise<http.Server | null> {
  logger.info(`[PROXY_DEBUG] startProxyServer: Attempting to start proxy. Requested main port: ${requestedPort}, Target existing server port: ${targetServerPort}`);
  let proxyListenPort: number;
  try {
    // Determine a suitable starting port for the proxy to avoid collision
    // If requestedPort (main server's attempted port) is the same as targetServerPort (where existing server is),
    // then the proxy needs to pick a clearly different port. Otherwise, it can try requestedPort + 50.
    const initialPortForProxySearch = requestedPort === targetServerPort ? requestedPort + 1 : requestedPort + 50;
    logger.info(`[PROXY_DEBUG] startProxyServer: Initial port for proxy search: ${initialPortForProxySearch}`);
    proxyListenPort = await findFreePort(initialPortForProxySearch);
    logger.info(`[PROXY_DEBUG] startProxyServer: Found free port ${proxyListenPort} for proxy.`);

  } catch (error) {
    const err = error instanceof Error ? error : new Error(String(error));
    logger.error(`[PROXY_DEBUG] startProxyServer: Failed to find free port for proxy: ${err.message}`, { error: err });
    return null;
  }

  // If findFreePort succeeded, proceed to create and listen on the proxy server
  return new Promise<http.Server | null>((resolveProxyListen, rejectProxyListen) => {
    const app = express();
    app.use('/mcp', express.raw({ type: '*/*', limit: '50mb' })); // For MCP JSON-RPC

    // Proxy MCP requests
    app.all('/mcp', async (req, res) => {
      const targetUrl = `http://localhost:${targetServerPort}/mcp`;
      logger.info(`[PROXY_DEBUG] MCP Request: ${req.method} ${req.url} to be proxied to ${targetUrl}`);
      
      const headersToForward: Record<string, string | string[] | undefined> = { ...req.headers };
      // Remove host header to avoid issues with some proxy setups or target servers
      delete headersToForward.host; 
      // Ensure connection header is appropriate for proxying
      headersToForward.connection = 'keep-alive';


      try {
        const mcpResponse = await axios({
          method: req.method as 'GET' | 'POST' | 'DELETE', // Cast method
          url: targetUrl,
          data: (req.method !== 'GET' && req.method !== 'HEAD' && req.body) ? req.body : undefined,
          headers: headersToForward,
          responseType: 'stream', // Important for streaming back the response
          timeout: configService.AGENT_QUERY_TIMEOUT + 10000, // Slightly longer timeout for proxy
        });

        logger.debug(`[PROXY_DEBUG] MCP Target server responded with status: ${mcpResponse.status}`);
        res.status(mcpResponse.status);
        // Forward relevant headers from target server's response
        Object.keys(mcpResponse.headers).forEach(key => {
          if (['content-type', 'content-length', 'mcp-session-id', 'cache-control', 'connection'].includes(key.toLowerCase())) {
            res.setHeader(key, mcpResponse.headers[key] as string | string[]);
          }
        });
        (mcpResponse.data as NodeJS.ReadableStream).pipe(res);

      } catch (error: unknown) {
        const axiosError = error as import('axios').AxiosError;
        const errorResponseData = axiosError.response?.data ? await streamToString(axiosError.response.data as NodeJS.ReadableStream) : undefined;
        logger.error('[PROXY_DEBUG] Error proxying MCP request to target server.', {
          message: axiosError.message,
          targetUrl,
          requestMethod: req.method,
          responseStatus: axiosError.response?.status,
          responseDataPreview: errorResponseData?.substring(0, 200), // Limit preview
        });

        if (axiosError.response && axiosError.response.headers) {
          res.status(axiosError.response.status);
          // Forward relevant headers from error response
          Object.keys(axiosError.response.headers).forEach(key => {
            const headerValue = axiosError.response!.headers[key];
            if (headerValue !== undefined) {
              if (['content-type', 'content-length'].includes(key.toLowerCase())) {
                res.setHeader(key, headerValue as string | string[]);
              }
            }
          });
          if (errorResponseData) {
            res.send(errorResponseData);
          } else if (axiosError.response.data && typeof (axiosError.response.data as NodeJS.ReadableStream).pipe === 'function') {
            (axiosError.response.data as NodeJS.ReadableStream).pipe(res);
          } else if (axiosError.response.data) {
            res.send(axiosError.response.data); // Send data as is if not streamable
          } else {
            res.end();
          }
        } else {
          // Network error or other issue before response from target
          res.status(502).json({ jsonrpc: "2.0", error: { code: -32001, message: 'Proxy error: Bad Gateway', data: axiosError.message }, id: null });
        }
      }
    });

    // Proxy /api/ping
    app.get('/api/ping', async (_req, res) => {
      const targetPingUrl = `http://localhost:${targetServerPort}/api/ping`;
      logger.info(`[PROXY_DEBUG] API Request: GET /api/ping to be proxied to ${targetPingUrl}`);
      try {
        const pingResponse = await axios.get(targetPingUrl, { timeout: 2000 });
        logger.debug(`[PROXY_DEBUG] Ping target server responded with status: ${pingResponse.status}`);
        res.status(pingResponse.status).json(pingResponse.data);
      } catch (error: unknown) {
        const axiosError = error as import('axios').AxiosError;
        logger.error('[PROXY_DEBUG] Error proxying /api/ping.', { message: axiosError.message, responseStatus: axiosError.response?.status });
        res.status(axiosError.response?.status || 502).json({ error: 'Proxy error for /api/ping', details: axiosError.message });
      }
    });

    // Proxy /api/indexing-status
    app.get('/api/indexing-status', async (_req, res) => {
      const targetStatusUrl = `http://localhost:${targetServerPort}/api/indexing-status`;
      logger.info(`[PROXY_DEBUG] API Request: GET /api/indexing-status to be proxied to ${targetStatusUrl}`);
      try {
        const statusResponse = await axios.get(targetStatusUrl, { timeout: 5000 });
        logger.debug(`[PROXY_DEBUG] Indexing status target server responded with status: ${statusResponse.status}`);
        res.status(statusResponse.status).json(statusResponse.data);
      } catch (error: unknown) {
        const axiosError = error as import('axios').AxiosError;
        logger.error('[PROXY_DEBUG] Error proxying /api/indexing-status.', { message: axiosError.message, responseStatus: axiosError.response?.status });
        res.status(axiosError.response?.status || 502).json({ error: 'Proxy error for /api/indexing-status', details: axiosError.message });
      }
    });

    const proxyHttpServer = http.createServer(app); // Renamed to proxyHttpServer
    proxyHttpServer.listen(proxyListenPort, 'localhost', () => {
      logger.info(`[PROXY_DEBUG] Original CodeCompass server (v${existingServerVersion || 'N/A'}) is running on port ${targetServerPort}.`);
      logger.info(`[PROXY_DEBUG] This instance (CodeCompass Proxy) is listening on port ${proxyListenPort}.`);
      logger.info(`[PROXY_DEBUG] MCP requests to http://localhost:${proxyListenPort}/mcp will be forwarded to http://localhost:${targetServerPort}/mcp`);
      logger.info(`[PROXY_DEBUG] API endpoints /api/ping and /api/indexing-status are also proxied.`);
      console.error(`CodeCompass Proxy running on port ${proxyListenPort}, forwarding to main server on ${targetServerPort}.`);
      resolveProxyListen(proxyHttpServer);
    });
    proxyHttpServer.on('error', (err: NodeJS.ErrnoException) => {
      logger.error(`[PROXY_DEBUG] Proxy server failed to start on port ${proxyListenPort}: ${err.message}`, { error: err });
      rejectProxyListen(err); // Reject if listen fails
    });
  });
}
