#!/usr/bin/env node

import fs from 'fs';
import path from 'path';
import NodeCache from 'node-cache';
import axios from 'axios'; // Import axios
// SDK imports will be done dynamically within executeClientCommand
// Do not import configService or startServer here yet if we need to set process.env first.

// Initialize cache: stdTTL is 0 (infinite) as we manage staleness via file mtime
// checkOnPreviousTTL: false, as we don't use individual item TTLs here.
const changelogCache = new NodeCache({ stdTTL: 0, checkperiod: 0 });
const CACHE_KEY_CONTENT = 'changelogContent';
const CACHE_KEY_MTIME = 'changelogMtime';

// Helper function to read package.json version
function getPackageVersion(): string {
  try {
    // Assuming the script runs from dist/index.js, package.json is ../package.json
    const packageJsonPath = path.resolve(__dirname, '../package.json');
    const packageJsonContent = fs.readFileSync(packageJsonPath, 'utf8');
    const packageJson = JSON.parse(packageJsonContent) as { version?: string };
    return packageJson.version || 'unknown';
  } catch {
    // Silently return 'unknown' on error, e.g. if package.json is not found during certain build phases
    return 'unknown';
  }
}

function displayHelp() {
  const version = getPackageVersion();
  console.log(`
CodeCompass CLI (version ${version})

Usage: codecompass [options] [command|repoPath] [tool_parameters_json]

Description:
  AI-powered MCP server for codebase navigation and LLM prompt optimization.
  If no command is provided, or if the first argument is a path, the server starts.
  If the first command is a recognized tool name, CodeCompass attempts to act as a client.

Options:
  --port <number>     Specify the HTTP port for the server. Overrides HTTP_PORT env var.

Server Commands:
  [repoPath]          Start the server with the specified or default repoPath.
                      Example: codecompass /path/to/your/repo
                               codecompass .
                               codecompass --port 3005 /path/to/repo

Client Commands (if a server is running on the configured port):
  agent_query <json_params>
                      Execute the 'agent_query' tool.
                      Example: codecompass agent_query '{"query": "How is auth handled?"}'
  bb7_search_code <json_params>
                      Execute the 'bb7_search_code' tool.
                      Example: codecompass bb7_search_code '{"query": "user login function"}'
  bb7_get_changelog   Execute the 'bb7_get_changelog' tool (no parameters).
  bb7_get_indexing_status
                      Execute the 'bb7_get_indexing_status' tool (no parameters).
  bb7_switch_suggestion_model <json_params>
                      Execute the 'bb7_switch_suggestion_model' tool.
                      Example: codecompass bb7_switch_suggestion_model '{"model": "deepseek-coder", "provider": "deepseek"}'
  bb7_get_session_history <json_params>
                      Execute the 'bb7_get_session_history' tool.
                      Example: codecompass bb7_get_session_history '{"sessionId": "some-id"}'
  bb7_generate_suggestion <json_params>
                      Execute the 'bb7_generate_suggestion' tool.
                      Example: codecompass bb7_generate_suggestion '{"query": "optimize this loop"}'
  bb7_get_repository_context <json_params>
                      Execute the 'bb7_get_repository_context' tool.
                      Example: codecompass bb7_get_repository_context '{"query": "main API components"}'


Other Commands:
  --help, -h          Show this help message and exit.
  --version, -v       Show version information and exit.
  --changelog         Show the project changelog and exit.
                      Supports an optional --verbose flag.

For more information, visit: https://github.com/alvinveroy/codecompass
`);
}

function displayChangelog(verbose: boolean) {
  const changelogPath = path.resolve(__dirname, '../CHANGELOG.md');
  try {
    const stats = fs.statSync(changelogPath);
    const currentMtime = stats.mtimeMs;

    const cachedMtime = changelogCache.get<number>(CACHE_KEY_MTIME);
    const cachedContent = changelogCache.get<string>(CACHE_KEY_CONTENT);

    if (cachedContent && cachedMtime && cachedMtime === currentMtime) {
      console.log(cachedContent);
      if (verbose) {
        // Future verbose-specific logic
      }
      return;
    }

    const changelogContent = fs.readFileSync(changelogPath, 'utf8');
    changelogCache.set(CACHE_KEY_CONTENT, changelogContent);
    changelogCache.set(CACHE_KEY_MTIME, currentMtime);
    
    console.log(changelogContent);
    if (verbose) {
      // Future verbose-specific logic
    }
  } catch (error) {
    console.error('Error reading or caching CHANGELOG.md:', error);
  }
}

// List of known tools that can be called from the CLI
// This helps distinguish tool calls from repoPath arguments.
const KNOWN_TOOLS = [
  'agent_query',
  'bb7_search_code',
  'bb7_get_changelog',
  'bb7_get_indexing_status',
  'bb7_switch_suggestion_model',
  'bb7_get_session_history',
  'bb7_generate_suggestion',
  'bb7_get_repository_context',
  // Add other tools intended for CLI client execution here
];

interface PingResponseData {
  service?: string;
  status?: string;
  version?: string;
}

async function executeClientCommand(toolName: string, toolParamsString?: string) {
  // Dynamically import configService and logger here to ensure process.env.HTTP_PORT is set
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { configService } = require('./lib/config-service') as typeof import('./lib/config-service');
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { logger } = require('./lib/config-service') as typeof import('./lib/config-service');

  logger.info(`CLI Client Mode: Attempting to execute tool '${toolName}'`);
  
  let parsedParams: Record<string, unknown> = {};
  if (toolParamsString) {
    try {
      parsedParams = JSON.parse(toolParamsString) as Record<string, unknown>;
      logger.info('With parameters:', parsedParams);
    } catch (e) {
      logger.error(`Error: Invalid JSON parameters for tool ${toolName}: ${toolParamsString}`);
      logger.error((e as Error).message);
      console.error(`Error: Invalid JSON parameters for tool ${toolName}. Please provide a valid JSON string.`);
      process.exit(1);
    }
  } else {
    logger.info('With no parameters.');
  }

  const serverUrl = `http://localhost:${configService.HTTP_PORT}`;
  
  try {
    logger.debug(`Pinging server at ${serverUrl}/api/ping`);
    const pingResponse = await axios.get<PingResponseData>(`${serverUrl}/api/ping`, { timeout: 2000 });

    if (pingResponse.status === 200 && pingResponse.data?.service === "CodeCompass") {
      logger.info(`CodeCompass server v${pingResponse.data.version || 'unknown'} is running on port ${configService.HTTP_PORT}. Proceeding with tool execution.`);
      
      // Dynamically import MCP SDK Client components
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const { Client } = require('@modelcontextprotocol/sdk/client/index.js') as typeof import('@modelcontextprotocol/sdk/client/index.js');
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const { StreamableHTTPClientTransport } = require('@modelcontextprotocol/sdk/client/streamableHttp.js') as typeof import('@modelcontextprotocol/sdk/client/streamableHttp.js');

      const transport = new StreamableHTTPClientTransport(new URL(serverUrl));
      const client = new Client({ name: "codecompass-cli-client", version: getPackageVersion() });

      try {
        await client.connect(transport);
        logger.info("MCP Client connected to server.");

        // Add sessionId to parameters if not already present, for tools that might use it.
        // This is a simple approach; more sophisticated session management might be needed later.
        if (!parsedParams.sessionId) {
            // For simplicity, we can generate a new one or leave it out.
            // Some tools might implicitly create/use sessions on the server.
            // For now, let's not add one automatically unless a tool specifically requires it
            // and the user hasn't provided one.
            // parsedParams.sessionId = `cli-session-${Date.now()}`;
        }


        logger.info(`Calling tool '${toolName}' with params:`, parsedParams);
        const result = await client.callTool({ name: toolName, arguments: parsedParams });
        logger.info("Tool execution successful. Result:", result);

        // Output the result in a user-friendly way
        // Assuming result.content is an array of { type: "text", text: "..." }
        if (result.content && Array.isArray(result.content)) {
          result.content.forEach(item => {
            if (item.type === 'text' && typeof item.text === 'string') {
              console.log(item.text);
            } else {
              // Fallback for other content types or structures
              console.log(JSON.stringify(item, null, 2));
            }
          });
        } else {
          console.log(JSON.stringify(result, null, 2));
        }
        
        await client.close();
        process.exit(0);

      } catch (clientError) {
        logger.error("MCP Client error:", clientError);
        const errorMessage = clientError instanceof Error ? clientError.message : String(clientError);
        // Check if it's a JSON-RPC error from the server
        if (typeof clientError === 'object' && clientError !== null && 'error' in clientError) {
            const rpcError = (clientError as { error: { message?: string, data?: unknown } }).error;
            console.error(`Error executing tool '${toolName}': ${rpcError.message || 'Unknown server error'}`);
            if (rpcError.data) {
                console.error(`Details: ${JSON.stringify(rpcError.data)}`);
            }
        } else {
            console.error(`Error executing tool '${toolName}': ${errorMessage}`);
        }
        process.exit(1);
      }

    } else {
      logger.warn(`Service on port ${configService.HTTP_PORT} is not a CodeCompass server or responded unexpectedly. Ping response:`, pingResponse.data);
      console.error(`A service is running on port ${configService.HTTP_PORT}, but it's not a CodeCompass server or it's unresponsive.`);
      process.exit(1);
    }
  } catch (error) {
    if (axios.isAxiosError(error) && (error.code === 'ECONNREFUSED' || error.code === 'ETIMEDOUT')) {
      logger.warn(`CodeCompass server is not running on port ${configService.HTTP_PORT}. Connection refused or timed out.`);
      console.error(`CodeCompass server is not running on port ${configService.HTTP_PORT}. Please start the server first.`);
    } else {
      logger.error(`Failed to connect to CodeCompass server on port ${configService.HTTP_PORT}:`, error);
      console.error(`Failed to connect to CodeCompass server on port ${configService.HTTP_PORT}.`);
    }
    process.exit(1);
  }
}

async function main() {
  const args = process.argv.slice(2);
  let repoPath = ".";
  let portOverride: string | undefined;

  const remainingArgsForCommandProcessing: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--port') {
      if (i + 1 < args.length) {
        portOverride = args[i + 1];
        i++; 
      } else {
        console.error('Error: --port option requires a value.');
        displayHelp();
        process.exit(1);
      }
    } else {
      remainingArgsForCommandProcessing.push(arg);
    }
  }

  if (portOverride) {
    const portNum = parseInt(portOverride, 10);
    if (isNaN(portNum) || portNum <= 0 || portNum > 65535) {
      console.error(`Error: Invalid port number "${portOverride}". Port must be between 1 and 65535.`);
      process.exit(1);
    }
    process.env.HTTP_PORT = portOverride; 
    // console.log(`Attempting to use port: ${portOverride} (from --port flag)`); // Logged by configService now
  }


  const primaryArg = remainingArgsForCommandProcessing[0];
  const secondaryArg = remainingArgsForCommandProcessing[1]; 

  if (primaryArg === '--help' || primaryArg === '-h') {
    displayHelp();
    process.exit(0);
  } else if (primaryArg === '--version' || primaryArg === '-v') {
    console.log(getPackageVersion());
    process.exit(0);
  } else if (primaryArg === '--changelog') {
    const verbose = secondaryArg === '--verbose';
    displayChangelog(verbose);
    process.exit(0);
  } else if (KNOWN_TOOLS.includes(primaryArg)) {
    // This is a client command execution
    const toolName = primaryArg;
    const toolParamsString = secondaryArg; // This is the JSON string of parameters
    // Any further args (remainingArgsForCommandProcessing[2] onwards) are currently ignored for client commands.
    await executeClientCommand(toolName, toolParamsString);
  } else {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { startServer, ServerStartupError } = require('./lib/server') as typeof import('./lib/server');

    if (primaryArg && !primaryArg.startsWith('--')) {
      repoPath = primaryArg;
    } else if (primaryArg && primaryArg.startsWith('--')) {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const { logger: localLogger } = require('./lib/config-service') as typeof import('./lib/config-service');
      localLogger.warn(`Warning: Unrecognized flag "${primaryArg}" after --port processing. Starting server with default repository path "${repoPath}".`);
      localLogger.warn(`Run 'codecompass --help' for available commands.`);
    }

    try {
      await startServer(repoPath);
    } catch (error: unknown) {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const { logger: localLogger } = require('./lib/config-service') as typeof import('./lib/config-service');
      if (error instanceof ServerStartupError) {
        if (error.exitCode !== 0) {
          // ServerStartupError with exitCode 0 means existing instance found, already logged by server.ts
          localLogger.error(`CodeCompass server failed to start. Error: ${error.message}`);
          console.error(`CodeCompass server failed to start. Error: ${error.message}`);
        }
        process.exit(error.exitCode);
      } else {
        localLogger.error('An unexpected error occurred during server startup:', error);
        console.error('An unexpected error occurred during server startup:', error);
        process.exit(1);
      }
    }
  }
}

main().catch(error => {
  // This catch is a fallback. We try to import logger, but if configService itself fails,
  // console.error is the only option.
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { logger } = require('./lib/config-service') as typeof import('./lib/config-service');
    logger.error('Critical error in CLI execution:', error);
  } catch (_ignored) {
    // Ignored
  }
  console.error('Critical error in CLI execution:', error);
  process.exit(1);
});
