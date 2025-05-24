#!/usr/bin/env node

import fs from 'fs';
import path from 'path';
import NodeCache from 'node-cache';
import axios from 'axios';
import yargs from 'yargs'; // Import yargs
// Use path.resolve for dynamic requires to make them more robust, especially in test environments.
const libPath = path.resolve(__dirname, './lib');
import { hideBin } from 'yargs/helpers'; // Import hideBin

// SDK imports will be done dynamically within handleClientCommand
// Do not import configService or startServer here yet if we need to set process.env first.

const changelogCache = new NodeCache({ stdTTL: 0, checkperiod: 0 });
const CACHE_KEY_CONTENT = 'changelogContent';
const CACHE_KEY_MTIME = 'changelogMtime';

function getPackageVersion(): string {
  try {
    const packageJsonPath = path.resolve(__dirname, '../package.json');
    const packageJsonContent = fs.readFileSync(packageJsonPath, 'utf8');
    const packageJson = JSON.parse(packageJsonContent) as { version?: string };
    return packageJson.version || 'unknown';
  } catch {
    return 'unknown';
  }
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
      if (verbose) { /* Future verbose-specific logic */ }
      return;
    }

    const changelogContent = fs.readFileSync(changelogPath, 'utf8');
    changelogCache.set(CACHE_KEY_CONTENT, changelogContent);
    changelogCache.set(CACHE_KEY_MTIME, currentMtime);
    
    console.log(changelogContent);
    if (verbose) { /* Future verbose-specific logic */ }
  } catch (error) {
    console.error('Error reading or caching CHANGELOG.md:', error);
  }
}

const KNOWN_TOOLS = [
  'agent_query',
  'search_code',
  'get_changelog',
  'get_indexing_status',
  'switch_suggestion_model',
  'get_session_history',
  'generate_suggestion',
  'get_repository_context',
];

interface PingResponseData {
  service?: string;
  status?: string;
  version?: string;
}

interface JsonRpcErrorResponse {
  jsonrpc: "2.0";
  id: string | number | null;
  error: {
    code: number;
    message: string;
    data?: unknown;
  };
}

function isJsonRpcErrorResponse(obj: unknown): obj is JsonRpcErrorResponse {
  return (
    typeof obj === 'object' &&
    obj !== null &&
    'jsonrpc' in obj &&
    obj.jsonrpc === '2.0' &&
    'error' in obj &&
    typeof (obj as { error: unknown }).error === 'object' &&
    (obj as { error: object }).error !== null &&
    'code' in (obj as { error: object }).error &&
    'message' in (obj as { error: object }).error
  );
}

// Add outputJson to argv type for handleClientCommand
interface ClientCommandArgs {
  toolName: string;
  params?: string;
  outputJson?: boolean; // New option
  // yargs also adds $0 and _
  [key: string]: unknown;
}

async function handleClientCommand(argv: ClientCommandArgs) {
  const { toolName, params: toolParamsString, outputJson } = argv;
   
  const { configService } = require(path.join(libPath, 'config-service.js')) as typeof import('./lib/config-service');
   
  const { logger } = require(path.join(libPath, 'config-service.js')) as typeof import('./lib/config-service');

  logger.info(`CLI Client Mode: Attempting to execute tool '${toolName}'`);
  
  let parsedParams: Record<string, unknown> = {};
  if (toolParamsString) {
    try {
      parsedParams = JSON.parse(toolParamsString) as Record<string, unknown>;
      logger.info('With parameters:', parsedParams);
    } catch (e) {
      logger.error(`Error: Invalid JSON parameters for tool ${toolName}: ${toolParamsString}`);
      logger.error((e as Error).message);
      console.error(`Error: Invalid JSON parameters for tool '${toolName}'. Please provide a valid JSON string.`);
      console.error(`Details: ${(e as Error).message}`);
      // Let yargs handle exit by re-throwing or yargs.fail will catch it if this function is a handler
      throw new Error(`Invalid JSON parameters: ${(e as Error).message}`); 
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
      
       
      const { Client } = require('@modelcontextprotocol/sdk/client/index.js') as typeof import('@modelcontextprotocol/sdk/client/index.js');
       
      const { StreamableHTTPClientTransport } = require('@modelcontextprotocol/sdk/client/streamableHttp.js') as typeof import('@modelcontextprotocol/sdk/client/streamableHttp.js');

      const transport = new StreamableHTTPClientTransport(new URL(serverUrl));
      const client = new Client({ name: "codecompass-cli-client", version: getPackageVersion() });

      try {
        await client.connect(transport);
        logger.info("MCP Client connected to server.");
        logger.info(`Calling tool '${toolName}' with params:`, parsedParams);
        const result = await client.callTool({ name: toolName, arguments: parsedParams });
        logger.info("Tool execution successful.");
        logger.debug("Raw tool result:", result);

        if (outputJson) {
          console.log(JSON.stringify(result, null, 2));
        } else {
          if (result.content && Array.isArray(result.content)) {
            result.content.forEach(item => {
              // Assuming item is ToolResponseContentItem from SDK
              if (item && typeof item === 'object' && 'type' in item && item.type === 'text' && 'text' in item && typeof item.text === 'string') {
                console.log(item.text);
              } else {
                console.log(JSON.stringify(item, null, 2));
              }
            });
          } else if (result) { // result itself might be the content if not structured with `content` array
            console.log(JSON.stringify(result, null, 2));
          } else {
            logger.info("Tool executed, but no content was returned in the response.");
          }
        }
        
        await client.close();
      } catch (clientError: unknown) {
        logger.error("MCP Client error during tool execution:", clientError);
        if (outputJson && clientError) { // Also output JSON for errors if --json is used
            if (isJsonRpcErrorResponse(clientError)) {
                 console.error(JSON.stringify(clientError, null, 2));
            } else if (clientError instanceof Error) {
                console.error(JSON.stringify({ error: { message: clientError.message, name: clientError.name }}, null, 2));
            } else {
                console.error(JSON.stringify({ error: { message: "Unknown client error" }}, null, 2));
            }
        } else { // Default text error reporting
            if (isJsonRpcErrorResponse(clientError)) {
              console.error(`Error executing tool '${toolName}': ${clientError.error.message} (Code: ${clientError.error.code})`);
              if (clientError.error.data) {
                console.error(`Details: ${JSON.stringify(clientError.error.data, null, 2)}`);
              }
            } else if (clientError instanceof Error) {
              console.error(`Error during tool '${toolName}' execution: ${clientError.message}`);
            } else {
              console.error(`An unknown error occurred while executing tool '${toolName}'.`);
            }
        }
        throw clientError; 
      }
    } else {
      // ... (existing non-CodeCompass server handling)
      logger.warn(`Service on port ${configService.HTTP_PORT} is not a CodeCompass server or responded unexpectedly. Ping response:`, pingResponse.data);
      const errorMessage = `A service is running on port ${configService.HTTP_PORT}, but it's not a CodeCompass server or it's unresponsive.`;
      if (outputJson) {
          console.error(JSON.stringify({ error: { message: errorMessage, pingResponse: pingResponse.data }}, null, 2));
      } else {
          console.error(errorMessage);
          console.error(`Ping Response Status: ${pingResponse.status}, Data: ${JSON.stringify(pingResponse.data)}`);
      }
      throw new Error("Non-CodeCompass server detected or ping failed.");
    }
  } catch (error: unknown) {
    // ... (existing server connection error handling)
     
    const { logger: localLogger, configService: localConfigService } = require(path.join(libPath, 'config-service.js')) as typeof import('./lib/config-service');
    let errorMessage = `Failed to connect to CodeCompass server on port ${localConfigService.HTTP_PORT}.`;
    if (axios.isAxiosError(error)) {
      if (error.code === 'ECONNREFUSED' || error.code === 'ETIMEDOUT') {
        errorMessage = `CodeCompass server is not running on port ${localConfigService.HTTP_PORT}. The server is required for background repository synchronization and to process tool commands. Please start the server first (e.g., by running 'codecompass [repoPath]'). (Detail: ${error.code})`;
        localLogger.warn(errorMessage);
      } else {
        errorMessage = `Failed to connect to CodeCompass server (AxiosError) on port ${localConfigService.HTTP_PORT}: ${error.message}`;
        localLogger.error(errorMessage, { code: error.code, response: error.response?.data });
      }
    } else if (error instanceof Error) {
        errorMessage = `Failed to connect to CodeCompass server (Error) on port ${configService.HTTP_PORT}: ${error.message}`;
        localLogger.error(errorMessage, error);
    } else {
        errorMessage = `Failed to connect to CodeCompass server (UnknownError) on port ${configService.HTTP_PORT}.`;
        localLogger.error(errorMessage, error);
    }

    if (outputJson) {
        console.error(JSON.stringify({ error: { message: errorMessage }}, null, 2));
    } else {
        console.error(errorMessage.split('(Detail:')[0].trim()); // Show simpler message for non-json
    }
    throw error; // Re-throw for yargs
  }
}

async function startServerHandler(repoPath: string) {
     
    const { startServer, ServerStartupError: LocalServerStartupError, startProxyServer: localStartProxyServer } = require(path.join(libPath, 'server.js')) as typeof import('./lib/server');
     
    const { logger: localLogger } = require(path.join(libPath, 'config-service.js')) as typeof import('./lib/config-service');
  try {
    await startServer(repoPath);
  } catch (error: unknown) {
    // Ensure LocalServerStartupError is correctly typed to include the new fields
    const typedError = error as import('./lib/server').ServerStartupError;

    if (error instanceof LocalServerStartupError) { // Keep using LocalServerStartupError for type guard
      if (typedError.exitCode === 0) {
        // Existing CodeCompass server found
        const existingVersion = (typedError.existingServerStatus as PingResponseData)?.version;

        localLogger.info(
          `An existing CodeCompass server (v${existingVersion || 'unknown'}) was detected on port ${typedError.detectedServerPort}.`
        );
        localLogger.info(`This instance will attempt to start as an MCP proxy.`);

        if (typedError.requestedPort && typedError.detectedServerPort) {
          try {
            // localStartProxyServer is already required with a robust path
            await localStartProxyServer(typedError.requestedPort, typedError.detectedServerPort, existingVersion);
            // If startProxyServer resolves, the proxy is running. The process should stay alive.
            // No process.exit() here.
          } catch (proxyError: any) {
            localLogger.error(`Failed to start MCP proxy: ${proxyError.message}. Exiting.`);
            process.exit(1); // Exit directly if proxy fails
          }
        } else {
          localLogger.error('Proxy: Could not determine necessary port information from ServerStartupError. Exiting.');
          process.exit(1);
        }
      } else {
        // Other ServerStartupError (e.g., non-CodeCompass server on port, or other startup failure)
        localLogger.error(`CodeCompass server failed to start. Error: ${typedError.message}. Exiting with code ${typedError.exitCode}.`);
        // yargs.fail will handle process.exit if this function is a yargs command handler and throws
        throw typedError; // Re-throw for yargs to handle exit
      }
    } else {
      // Generic error not of ServerStartupError type
      localLogger.error('An unexpected error occurred during server startup:', error);
      throw error; // Re-throw for yargs
    }
  }
}

// Main CLI execution logic using yargs
async function main() {
  const cli = yargs(hideBin(process.argv))
    .option('port', {
      alias: 'p',
      type: 'number',
      description: 'Specify the HTTP port for the server. Overrides HTTP_PORT env var.',
      global: true,
      // Apply the port setting to process.env immediately if provided
      // This middleware runs before command handlers
      apply: (value: number | undefined) => { // Changed from middleware to apply for direct effect
        if (value !== undefined) {
          if (isNaN(value) || value <= 0 || value > 65535) {
            // yargs will typically handle this with its own validation if type: 'number' is effective
            // but an explicit check here is safer before setting env var.
            // Throwing an error here will be caught by yargs .fail()
            throw new Error(`Error: Invalid port number "${value}". Port must be between 1 and 65535.`);
          }
          process.env.HTTP_PORT = String(value);
          // Dynamically require logger here if we want to log this early
          // For now, this side-effect is silent until configService is fully loaded by a command.
        }
      }
    })
    .command(
      'changelog',
      'Show the project changelog',
      (yargsInstance) => {
        return yargsInstance.option('verbose', {
          type: 'boolean',
          default: false,
          description: 'Show verbose changelog output (future use)',
        });
      },
      (argv) => { // This handler is synchronous
        displayChangelog(argv.verbose);
        // yargs expects a promise from async handlers, or nothing from sync.
        // If displayChangelog were async, we'd await it.
      }
    )
    .command(
      // Default command for starting the server
      ['start [repoPath]', '$0 [repoPath]'],
      'Start the CodeCompass server (default command)',
      (yargsInstance) => {
        return yargsInstance.positional('repoPath', {
          type: 'string',
          default: '.',
          describe: 'Path to the git repository to serve',
        });
      },
      async (argv) => {
        // process.env.HTTP_PORT would have been set by the global 'port' option's 'apply'
        await startServerHandler(argv.repoPath);
      }
    );

  // Dynamically add commands for each known tool
  KNOWN_TOOLS.forEach(toolName => {
    const commandDescription = `Execute the '${toolName}' tool.`;
    let exampleParams = `'{"some_param": "value"}'`;
    // Customize example params based on tool
    if (toolName === 'get_changelog' || toolName === 'get_indexing_status') {
      exampleParams = '(no parameters needed)';
    } else if (toolName === 'agent_query') {
      exampleParams = `'{"query": "How is auth handled?", "sessionId": "my-session"}'`;
    } else if (toolName === 'get_session_history') {
      exampleParams = `'{"sessionId": "your-session-id"}' (sessionId is required)`;
    } // Add more else if for other tools with specific examples

    cli.command(
      `${toolName} [params]`,
      commandDescription,
      (yargsInstance) => {
        return yargsInstance.positional('params', {
          type: 'string',
          describe: `JSON string of parameters for ${toolName}. Example: ${exampleParams}`,
          // Default to '{}' for tools that can accept no params but still need a JSON object
          default: (toolName === 'get_changelog' || toolName === 'get_indexing_status') ? '{}' : undefined,
          })
          .option('json', { // Add --json flag for tool commands
            alias: 'j',
            type: 'boolean',
            description: 'Output the raw JSON response from the tool.',
            default: false,
          });
      },
      async (argv) => {
        // Pass the full argv to handleClientCommand so it can access --json
        await handleClientCommand({
            toolName, 
            params: argv.params, 
            outputJson: argv.json // Pass the new flag
        });
      }
    );
  });

  cli
    .version(getPackageVersion()) // Setup --version
    .alias('v', 'version')
    .help() // Setup --help
    .alias('h', 'help')
    .wrap(Math.min(120, yargs(hideBin(process.argv)).terminalWidth())) // Use yargs().terminalWidth()
    .epilogue('For more information, visit: https://github.com/alvinveroy/codecompass')
    .demandCommand(0, 1, 'Too many commands. Specify one command or a repository path to start the server.')
    .strict() // Error on unknown options/commands
    .fail((msg, err, _yargsInstance) => {
      // Dynamically import logger for failure messages if possible
      try {
           
          const { logger: failLogger } = require(path.join(libPath, 'config-service.js')) as typeof import('./lib/config-service');
          if (err) {
              failLogger.error('CLI Error (yargs.fail):', { message: err.message, stack: err.stack });
          } else if (msg) {
              failLogger.error('CLI Usage Error (yargs.fail):', msg);
          }
      } catch (e) {
          console.error("Fallback yargs.fail (logger unavailable): ", msg || err);
      }

      if (!err && msg) {
        console.error(msg);
      }
      // Yargs will exit with 1 by default if err is present or msg is from yargs validation.
      // No need to call process.exit(1) explicitly here if yargs handles it.
    });

  try {
    await cli.parseAsync();
  } catch (error) {
    // This catch block is for errors thrown from command handlers
    // that yargs' .fail() might not have caught or for truly unexpected issues.
    try {
         
        const { logger: critLogger } = require(path.join(libPath, 'config-service.js')) as typeof import('./lib/config-service');
        critLogger.error('Critical unhandled error in CLI execution:', error);
    } catch (e) {
        console.error('Fallback critical error logger (logger unavailable): Critical error in CLI execution:', error);
    }
    // If an error reaches here, it's likely something yargs didn't handle, so exit.
    if (process.env.NODE_ENV !== 'test') {
        process.exit(1);
    } else {
        // In test environment, re-throw to allow test to fail and capture the error
        throw error;
    }
  }
}

// Execute the main function
void main(); // Mark as void to satisfy no-floating-promises
