#!/usr/bin/env node

import fs from 'fs';
import path from 'path';
import NodeCache from 'node-cache';
import axios from 'axios';
import yargs from 'yargs'; // Import yargs
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
      
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const { Client } = require('@modelcontextprotocol/sdk/client/index.js') as typeof import('@modelcontextprotocol/sdk/client/index.js');
      // eslint-disable-next-line @typescript-eslint/no-var-requires
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
              if (item && item.type === 'text' && typeof item.text === 'string') {
                console.log(item.text);
              } else {
                console.log(JSON.stringify(item, null, 2));
              }
            });
          } else if (result) {
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
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { logger: localLogger } = require('./lib/config-service') as typeof import('./lib/config-service');
    let errorMessage = `Failed to connect to CodeCompass server on port ${configService.HTTP_PORT}.`;
    if (axios.isAxiosError(error)) {
      if (error.code === 'ECONNREFUSED' || error.code === 'ETIMEDOUT') {
        errorMessage = `CodeCompass server is not running on port ${configService.HTTP_PORT}. Please start the server first. (Detail: ${error.code})`;
        localLogger.warn(errorMessage);
      } else {
        errorMessage = `Failed to connect to CodeCompass server (AxiosError) on port ${configService.HTTP_PORT}: ${error.message}`;
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
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { startServer, ServerStartupError: LocalServerStartupError } = require('./lib/server') as typeof import('./lib/server');
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { logger: localLogger } = require('./lib/config-service') as typeof import('./lib/config-service');
  try {
    await startServer(repoPath);
  } catch (error: unknown) {
    if (error instanceof LocalServerStartupError) {
      if (error.exitCode !== 0) {
        localLogger.error(`CodeCompass server failed to start. Error: ${error.message}`);
        // console.error is now handled by yargs .fail() or if error is re-thrown
      }
      // If exitCode is 0, it means an existing instance was found.
      // The server.ts logic already logs this. We can let yargs exit gracefully by resolving.
      if (error.exitCode !== 0) throw error; // Re-throw only for actual errors
    } else {
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
        await startServerHandler(argv.repoPath as string);
      }
    );

  // Dynamically add commands for each known tool
  KNOWN_TOOLS.forEach(toolName => {
    let commandDescription = `Execute the '${toolName}' tool.`;
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
            params: argv.params as string | undefined, 
            outputJson: argv.json as boolean // Pass the new flag
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
    .fail((msg, err, yargsInstance) => {
      // Dynamically import logger for failure messages if possible
      try {
          // eslint-disable-next-line @typescript-eslint/no-var-requires
          const { logger } = require('./lib/config-service') as typeof import('./lib/config-service');
          if (err) {
              logger.error('CLI Error:', { message: err.message, stack: err.stack });
          } else if (msg) {
              logger.error('CLI Usage Error:', msg);
          }
      } catch (_ignored) { /* fallback to console.error */ }

      if (err) {
        // console.error(err); // yargs might print its own error message
        // To avoid double printing, we might only print if yargs doesn't
        // Or, customize yargs error display. For now, let yargs handle it.
      } else {
        // yargsInstance.showHelp(); // Show help on usage error
        console.error(msg); // Print the specific message from yargs
      }
      // yargs automatically exits with 1 on failure by default
      // process.exit(1); // This might be redundant if yargs handles it
    });

  try {
    await cli.parseAsync(); // Use parseAsync for promise-based handlers
    // If parseAsync resolves, it means command handlers (if any ran) resolved.
    // yargs handles process.exit for its own errors or if handlers throw.
  } catch (error) {
    // This catch is for unhandled promise rejections from command handlers
    // that weren't caught by yargs' .fail() or if parseAsync itself throws.
    try {
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const { logger } = require('./lib/config-service') as typeof import('./lib/config-service');
        logger.error('Critical error in CLI execution:', error);
    } catch (_ignored) { /* fallback to console.error */ }
    console.error('Critical error in CLI execution:', error);
    process.exit(1);
  }
}

// Execute the main function
main(); // No .catch here, main's internal try/catch for parseAsync handles it.
