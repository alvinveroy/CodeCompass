#!/usr/bin/env node

import fs from 'fs';
import path from 'path';
import NodeCache from 'node-cache';
// axios import removed as it's no longer used by handleClientCommand
import yargs from 'yargs'; // Import yargs
import { spawn, type ChildProcess } from 'child_process'; // Added spawn
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
  'trigger_repository_update', // Added
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
  // eslint-disable-next-line @typescript-eslint/no-require-imports -- Dynamic require for config after potential env changes by yargs
  const { configService } = require(path.join(libPath, 'config-service.js')) as typeof import('./lib/config-service');
  // eslint-disable-next-line @typescript-eslint/no-require-imports -- Dynamic require for config after potential env changes by yargs
  const { logger } = require(path.join(libPath, 'config-service.js')) as typeof import('./lib/config-service');

  logger.info(`CLI Client Mode: Attempting to execute tool '${toolName}' via stdio`);
  
  const clientRepoPath = argv.repo as string || '.'; // Use global --repo option or default to '.'
  logger.info(`Using repository path for client command: ${clientRepoPath}`);

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

  let child: ChildProcess | null = null;

  try {
    const scriptPath = process.argv[1]; // Path to the current script (e.g., dist/index.js)
    const args = ['start', clientRepoPath];
    // Pass the --port to the child if it was specified for the parent
    if (process.env.HTTP_PORT) {
      args.push('--port', process.env.HTTP_PORT);
    }
    logger.info(`Spawning server process: ${process.execPath} ${scriptPath} ${args.join(' ')}`);

    child = spawn(process.execPath, [scriptPath, ...args], {
      stdio: ['pipe', 'pipe', 'pipe'], // pipe stdin, stdout, stderr
    });

    let serverReady = false;
    let earlyExitError: Error | null = null;

    child.stderr?.on('data', (data: Buffer) => {
      const message = data.toString();
      // Heuristic to detect server readiness from stderr logs
      // Example: "CodeCompass vX.Y.Z ready. MCP active on stdio."
      if (message.includes("MCP active on stdio")) {
        serverReady = true;
        logger.info("Spawned server reported ready on stdio.");
      }
      // Log server's stderr, prefixed
      process.stderr.write(`[server stderr] ${message}`);
    });

    child.on('error', (err) => {
      logger.error('Failed to start server process:', err);
      earlyExitError = err;
    });

    child.on('exit', (code, signal) => {
      if (!serverReady && !earlyExitError) { // Exited before explicitly ready and no spawn error
        const exitMsg = `Server process exited prematurely with code ${code}, signal ${signal}. Check server logs.`;
        logger.error(exitMsg);
        earlyExitError = new Error(exitMsg);
      } else if (code !== 0 && code !== null && !earlyExitError) { // Exited with error after being ready
         const exitMsg = `Server process exited with error code ${code}, signal ${signal}.`;
         logger.error(exitMsg);
         // This might happen if client.close() causes server to exit with error, or other issues.
         // We might not want to overwrite a specific tool execution error with this.
         // For now, log it. The primary error will be from callTool if it occurred.
      }
    });
    
    // Wait a short period for the server to initialize or detect early exit
    // This is a heuristic. A more robust method would be for the server to send a specific "ready" signal on stdout.
    // For now, we rely on stderr log parsing and a timeout.
    await new Promise<void>((resolve, reject) => {
      const readyTimeout = setTimeout(() => {
        if (!serverReady && !earlyExitError) {
          reject(new Error("Timeout waiting for spawned server to become ready."));
        } else if (earlyExitError) {
          reject(earlyExitError);
        } else {
          resolve();
        }
      }, 20000); // 20-second timeout for server readiness (increased from 10s)

      const checkReady = () => {
        if (serverReady || earlyExitError) {
          clearTimeout(readyTimeout);
          if (earlyExitError) reject(earlyExitError); else resolve();
        } else {
          setTimeout(checkReady, 100);
        }
      };
      checkReady();
    });
    
    if (earlyExitError) throw earlyExitError; // If an error occurred during spawn/early exit

    const { Client: MCPClient } = require('@modelcontextprotocol/sdk/client/index.js') as typeof import('@modelcontextprotocol/sdk/client/index.js');
    const { StdioClientTransport } = require('@modelcontextprotocol/sdk/client/stdio.js') as typeof import('@modelcontextprotocol/sdk/client/stdio.js');

    // Pass the child process using the 'process' key as per StdioClientTransportOptions
    const transport = new StdioClientTransport({ process: child } as any);
    const client = new MCPClient({ name: "codecompass-cli-client", version: getPackageVersion() });

    await client.connect(transport);
    logger.info("MCP Client connected to spawned server via stdio.");
    logger.info(`Calling tool '${toolName}' with params:`, parsedParams);
    const result = await client.callTool({ name: toolName, arguments: parsedParams });
    logger.info("Tool execution successful via stdio.");
    logger.debug("Raw tool result:", result);

    if (outputJson) {
      console.log(JSON.stringify(result, null, 2));
    } else {
      if (result.content && Array.isArray(result.content)) {
        result.content.forEach(item => {
          if (item && typeof item === 'object' && 'type' in item && item.type === 'text' && 'text' in item && typeof item.text === 'string') {
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

  } catch (error: unknown) {
    logger.error(`Error during client command '${toolName}' (stdio):`, error);
    const reportError = (errToReport: unknown) => {
      if (outputJson) {
        if (isJsonRpcErrorResponse(errToReport)) {
          console.error(JSON.stringify(errToReport, null, 2));
        } else if (errToReport instanceof Error) {
          console.error(JSON.stringify({ error: { message: errToReport.message, name: errToReport.name } }, null, 2));
        } else {
          console.error(JSON.stringify({ error: { message: "Unknown client error" } }, null, 2));
        }
      } else {
        if (isJsonRpcErrorResponse(errToReport)) {
          console.error(`Error executing tool '${toolName}': ${errToReport.error.message} (Code: ${errToReport.error.code})`);
          if (errToReport.error.data) console.error(`Details: ${JSON.stringify(errToReport.error.data, null, 2)}`);
        } else if (errToReport instanceof Error) {
          console.error(`Error during tool '${toolName}' execution: ${errToReport.message}`);
        } else {
          console.error(`An unknown error occurred while executing tool '${toolName}'.`);
        }
      }
    };
    reportError(error);
    throw error; // Re-throw for yargs
  } finally {
    if (child) {
      logger.info(`Terminating spawned server process (PID: ${child.pid}).`);
      child.kill('SIGTERM'); // Send SIGTERM first
      // Set a timeout to force kill if it doesn't exit gracefully
      const killTimeout = setTimeout(() => {
        if (child && !child.killed) {
          logger.warn(`Spawned server process (PID: ${child.pid}) did not exit gracefully, sending SIGKILL.`);
          child.kill('SIGKILL');
        }
      }, 2000); // 2 seconds to exit gracefully
      child.on('exit', () => clearTimeout(killTimeout));
    }
  }
}

async function startServerHandler(repoPathOrArgv: string | { repoPath?: string; repo?: string; [key: string]: unknown; _: (string | number)[] ; $0: string; }) {
  let effectiveRepoPath: string;
  if (typeof repoPathOrArgv === 'string') { // Called directly with repoPath
    effectiveRepoPath = repoPathOrArgv;
  } else { // Called from yargs with argv object
    effectiveRepoPath = repoPathOrArgv.repoPath || repoPathOrArgv.repo || '.';
  }
    // eslint-disable-next-line @typescript-eslint/no-require-imports -- Dynamic require for config after potential env changes by yargs
    const { startServer, ServerStartupError: LocalServerStartupError } = require(path.join(libPath, 'server.js')) as typeof import('./lib/server');
    // eslint-disable-next-line @typescript-eslint/no-require-imports -- Dynamic require for config after potential env changes by yargs
    const { logger: localLogger } = require(path.join(libPath, 'config-service.js')) as typeof import('./lib/config-service');
  try {
    await startServer(effectiveRepoPath);
    // If startServer resolves, it means stdio MCP is up. Utility HTTP server might be disabled
    // due to a conflict (Option C), but the instance is operational.
    // No specific action needed here; server will continue to run.
  } catch (error: unknown) {
    // This block will only be hit if startServer throws an error.
    // For Option C, ServerStartupError should only be thrown for fatal issues (exitCode=1).
    if (error instanceof LocalServerStartupError) {
      localLogger.error(`CodeCompass server failed to start. Error: ${error.message}. Exiting with code ${error.exitCode}.`);
    } else {
      localLogger.error('An unexpected error occurred during server startup:', error);
    }
    // Re-throw for yargs.fail() to handle process exit.
    throw error;
  }
}

// Main CLI execution logic using yargs
async function main() {
  const cli = yargs(hideBin(process.argv))
    .option('port', {
      alias: 'p',
      type: 'number',
      description: 'Specify the HTTP port for the server or spawned client server. Overrides HTTP_PORT env var.',
      global: true,
      apply: (value: number | undefined) => {
        if (value !== undefined) {
          if (isNaN(value) || value <= 0 || value > 65535) {
            // yargs will typically handle this with its own validation if type: 'number' is effective
            // but an explicit check here is safer before setting env var.
            // Throwing an error here will be caught by yargs .fail()
            throw new Error(`Error: Invalid port number "${value}". Port must be between 1 and 65535.`);
          }
          process.env.HTTP_PORT = String(value);
        }
      }
    })
    .option('repo', { // New global option for repository path
      alias: 'r',
      type: 'string',
      description: 'Specify the repository path for server or client tool context.',
      global: true,
      // No 'apply' needed, handlers will use this value from argv.
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
    .scriptName("codecompass") // Set script name for help output
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
        // Pass the full argv object so startServerHandler can access .repo if .repoPath is not set
        await startServerHandler(argv as { repoPath?: string; repo?: string; [key: string]: unknown; _: (string | number)[] ; $0: string; });
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
        // Construct the ClientCommandArgs object correctly, including the toolName
        const commandArgs: ClientCommandArgs = {
          params: argv.params as string | undefined,
          outputJson: argv.json as boolean | undefined,
          repo: argv.repo as string | undefined,
          toolName: toolName, // This 'toolName' is from the forEach loop's scope
          $0: argv.$0 as string,
          _: argv._ as (string | number)[],
        };
        await handleClientCommand(commandArgs as ClientCommandArgs & { repo?: string });
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
          // eslint-disable-next-line @typescript-eslint/no-require-imports -- Dynamic require for config after potential env changes by yargs
          const { logger: failLogger } = require(path.join(libPath, 'config-service.js')) as typeof import('./lib/config-service');
          if (err) {
              failLogger.error('CLI Error (yargs.fail):', { message: err.message, stack: err.stack });
          } else if (msg) {
              failLogger.error('CLI Usage Error (yargs.fail):', msg);
          }
      } catch (_e) { // Use _e if error object 'e' is not used
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
        // eslint-disable-next-line @typescript-eslint/no-require-imports -- Dynamic require for config after potential env changes by yargs
        const { logger: critLogger } = require(path.join(libPath, 'config-service.js')) as typeof import('./lib/config-service');
        critLogger.error('Critical unhandled error in CLI execution:', error);
    } catch (_e) { // Use _e if error object 'e' is not used
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
