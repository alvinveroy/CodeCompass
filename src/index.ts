#!/usr/bin/env node

// Add this block at the VERY TOP of the file, before any other imports
// to ensure it runs before anything else can modify process.env or console.
// This is for debugging spawned server environment in integration tests.
if (process.env.DEBUG_SPAWNED_SERVER_ENV === 'true') {
  const initialEnv = {
    NODE_ENV: process.env.NODE_ENV,
    HTTP_PORT: process.env.HTTP_PORT,
    // Add any other critical env vars you want to check
  };
  // Use a simple console.error for this debug log as logger might not be initialized.
  // Prefix with a clear marker.
  console.error(`[SPAWNED_SERVER_INIT_ENV_DEBUG] Initial process.env: ${JSON.stringify(initialEnv)}`);
}
// End of early debug block

import fs from 'fs';
import path from 'path';
import NodeCache from 'node-cache';
import yargs from 'yargs'; // Import yargs
import type { ChildProcess } from 'child_process'; 
import { StdioClientTransport, type StdioServerParameters } from '@modelcontextprotocol/sdk/client/stdio.js';
import { Client as MCPClientSdk } from '@modelcontextprotocol/sdk/client/index.js';

// Prominent logging for NODE_ENV, VITEST_WORKER_ID, and __dirname
console.error(`[SUT_INDEX_TS_ENV_CHECK_TOP] NODE_ENV: ${process.env.NODE_ENV}, VITEST_WORKER_ID: ${process.env.VITEST_WORKER_ID}, __dirname: ${__dirname}, isPackaged: ${!!(process as unknown as { pkg?: unknown }).pkg}`);

// Determine the correct path to the 'lib' directory based on execution context
const isPackaged = !!(process as unknown as { pkg?: unknown }).pkg;
let libPath: string;

if (process.env.VITEST_WORKER_ID) { // Vitest sets VITEST_WORKER_ID, a reliable indicator of test environment
  libPath = path.join(__dirname, 'lib'); // Resolve to src/lib when testing with Vitest
  console.error(`[SUT_INDEX_TS_LIBPATH_DEBUG] Condition: VITEST_WORKER_ID is set. libPath set to: ${libPath}`);
} else if (process.env.NODE_ENV === 'test') { // Fallback for other test environments if VITEST_WORKER_ID is not set
  libPath = path.join(__dirname, 'lib');
  console.error(`[SUT_INDEX_TS_LIBPATH_DEBUG] Condition: NODE_ENV === 'test'. libPath set to: ${libPath}`);
} else if (isPackaged) { // Check for packaged application next
  libPath = path.join(__dirname, '..', 'dist', 'lib');
  console.error(`[SUT_INDEX_TS_LIBPATH_DEBUG] Condition: isPackaged. libPath set to: ${libPath}`);
} else if (process.env.NODE_ENV === 'development') { // Then check for development mode
  libPath = path.join(__dirname, '..', 'dist', 'lib'); // Development usually runs against dist for closer-to-prod behavior
  console.error(`[SUT_INDEX_TS_LIBPATH_DEBUG] Condition: NODE_ENV === 'development'. libPath set to: ${libPath}`);
} else {
  // Fallback for other environments (e.g., 'production' but not packaged, or NODE_ENV undefined)
  // This case might need refinement based on deployment strategy.
  // Defaulting to 'src/lib' if not packaged and not explicitly development.
  libPath = path.join(__dirname, 'lib');
  console.error(`[SUT_INDEX_TS_LIBPATH_DEBUG] Condition: Fallback (e.g., production from source). libPath set to: ${libPath}`);
}
console.error(`[SUT_INDEX_TS_LIBPATH_FINAL] Final libPath: ${libPath}`);

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

  let moduleFileExtensionForDynamicImportHcc: string;
  if (process.env.VITEST_WORKER_ID) {
    if (path.basename(__dirname) === 'dist') { // Integration test running dist/index.js
      moduleFileExtensionForDynamicImportHcc = '.js';
    } else { // Unit test running src/index.ts
      moduleFileExtensionForDynamicImportHcc = '.ts';
    }
  } else { // Production or development from dist, or packaged
    moduleFileExtensionForDynamicImportHcc = '.js';
  }

  // eslint-disable-next-line @typescript-eslint/no-require-imports -- Dynamic require for config after potential env changes by yargs
  const configServiceModuleFilenameForClient = `config-service${moduleFileExtensionForDynamicImportHcc}`;
  const configServiceModulePathForClient = path.join(libPath, configServiceModuleFilenameForClient);
  console.error(`[SUT_INDEX_TS_REQUIRE_DEBUG] About to import configService (in handleClientCommand) from: ${configServiceModulePathForClient} (__dirname: ${__dirname}, VITEST_WORKER_ID: ${process.env.VITEST_WORKER_ID}, ext: ${moduleFileExtensionForDynamicImportHcc})`);
  const configServiceModule = await import(configServiceModulePathForClient);
  const { configService, logger } = configServiceModule as typeof import('./lib/config-service');
  console.log('[SUT_INDEX_TS_DEBUG] Imported configService in handleClientCommand:', typeof configService, 'configService.DEEPSEEK_API_KEY (sample prop):', configService.DEEPSEEK_API_KEY ? 'exists' : 'MISSING/undefined');
  console.log(`[SUT_INDEX_TS_DEBUG] VITEST_WORKER_ID in SUT (handleClientCommand): ${process.env.VITEST_WORKER_ID}`);


  logger.info(`CLI Client Mode: Tool '${toolName}'`);
  
  const clientRepoPath = argv.repo as string || '.'; // Use global --repo option or default to '.'
  // logger.info(`Using repository path for client command: ${clientRepoPath}`); // Less verbose

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
  
    const isPkg = typeof (process as any).pkg !== 'undefined';
    const mainScriptPath = path.resolve(__dirname, 'index.js'); // Path to the compiled index.js

  // Parameters for StdioClientTransport to spawn the server
  const serverProcessParams: StdioServerParameters = {
    command: process.execPath, // Path to node executable
    args: [
      mainScriptPath,    // Path to this script (dist/index.js)
      'start',           // Command for the server to start
      clientRepoPath,    // Repository path for the server
      '--port', '0',     // Instruct server to find a dynamic utility port
    ],
    // Environment variables for the spawned server process
    env: {
      ...process.env, // Inherit parent env
      HTTP_PORT: '0', // Explicitly set for child, yargs in child will pick this up
      // Any other specific env vars the child server needs
      DEBUG_SPAWNED_SERVER_ENV: process.env.DEBUG_SPAWNED_SERVER_ENV || 'false', // Propagate debug flag
    },
  };

  console.log('[SUT_INDEX_TS_DEBUG] About to instantiate StdioClientTransport. Type of StdioClientTransport:', typeof StdioClientTransport); // Or the specific import used here
  const transport = new StdioClientTransport(serverProcessParams);
  const client = new MCPClientSdk({ name: "codecompass-cli-client", version: getPackageVersion() });

  let clientClosed = false;
  const cleanup = async () => {
    if (!clientClosed) {
      clientClosed = true;
      logger.info("Closing MCP client and transport.");
      await client.close().catch(err => logger.error("Error closing MCP client:", err));
      // StdioClientTransport's close method should handle terminating the child process.
    }
  };

  // Handle Ctrl+C and other termination signals gracefully
  process.on('SIGINT', async () => { await cleanup(); process.exit(0); });
  process.on('SIGTERM', async () => { await cleanup(); process.exit(0); });

  try {
    await client.connect(transport);
    logger.info("MCP Client connected to server via stdio transport.");
    logger.info(`Calling tool '${toolName}' with params:`, parsedParams);
    const result = await client.callTool({ name: toolName, arguments: parsedParams });
    logger.info("Tool execution successful via stdio.");
    logger.debug("Raw tool result:", result);

    if (outputJson) {
      console.log(JSON.stringify(result, null, 2));
    } else {
      // Prefer text content if available
      // Add type assertion for content parts
      const contentParts = result.content as Array<{ type?: string; text?: string }> | undefined;
      const textContent = contentParts?.find(c => c.type === 'text')?.text;
      if (textContent) {
        console.log(textContent);
      } else if (result) {
        console.log(JSON.stringify(result, null, 2));
      } else {
        logger.info("Tool executed, but no content was returned in the response.");
      }
    }
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
    await cleanup();
  }
}

async function startServerHandler(repoPathOrArgv: string | { repoPath?: string; repo?: string; [key: string]: unknown; _: (string | number)[] ; $0: string; }) {
  let effectiveRepoPath: string;
  if (typeof repoPathOrArgv === 'string') { // Called directly with repoPath
    effectiveRepoPath = repoPathOrArgv;
  } else { // Called from yargs with argv object
    effectiveRepoPath = repoPathOrArgv.repoPath || repoPathOrArgv.repo || '.';
  }
    
  const isPkg = typeof (process as any).pkg !== 'undefined';

  let moduleFileExtensionForDynamicImportSsh: string;
  if (process.env.VITEST_WORKER_ID) {
    if (path.basename(__dirname) === 'dist') { // Integration test running dist/index.js
      moduleFileExtensionForDynamicImportSsh = '.js';
    } else { // Unit test running src/index.ts
      moduleFileExtensionForDynamicImportSsh = '.ts';
    }
  } else { // Production or development from dist, or packaged
    moduleFileExtensionForDynamicImportSsh = '.js';
  }

    // eslint-disable-next-line @typescript-eslint/no-require-imports -- Dynamic require for config after potential env changes by yargs
    const serverModuleFilename = `server${moduleFileExtensionForDynamicImportSsh}`;
    const serverModulePath = path.join(libPath, serverModuleFilename);
    console.error(`[SUT_INDEX_TS_REQUIRE_DEBUG] About to import serverModule from: ${serverModulePath} (__dirname: ${__dirname}, VITEST_WORKER_ID: ${process.env.VITEST_WORKER_ID}, ext: ${moduleFileExtensionForDynamicImportSsh})`);
    const serverModule = await import(serverModulePath);
    const { startServer, ServerStartupError: LocalServerStartupError } = serverModule;
    
    // Define the type for ServerStartupError for TypeScript
    type ServerStartupErrorType = {
      message: string;
      exitCode: number;
    };
    console.log('[SUT_INDEX_TS_DEBUG] Imported startServer (handler) in startServerHandler:', typeof startServer, 'Is mock:', !!(startServer as any)?.mock?.calls);
    console.log(`[SUT_INDEX_TS_DEBUG] VITEST_WORKER_ID in SUT (startServerHandler): ${process.env.VITEST_WORKER_ID}`);
    // eslint-disable-next-line @typescript-eslint/no-require-imports -- Dynamic require for config after potential env changes by yargs
    const configServiceModuleFilename = `config-service${moduleFileExtensionForDynamicImportSsh}`; // Use the same extension logic
    const configServiceModulePath = path.join(libPath, configServiceModuleFilename);
    console.error(`[SUT_INDEX_TS_REQUIRE_DEBUG] About to import configServiceModule (in startServerHandler) from: ${configServiceModulePath} (__dirname: ${__dirname}, VITEST_WORKER_ID: ${process.env.VITEST_WORKER_ID}, ext: ${moduleFileExtensionForDynamicImportSsh})`);
    const configServiceModule = await import(configServiceModulePath);
    const { logger: localLogger, configService: localConfigService } = configServiceModule;
    console.log('[SUT_INDEX_TS_DEBUG] Imported configService in startServerHandler:', typeof localConfigService, 'configService.DEEPSEEK_API_KEY (sample prop):', localConfigService.DEEPSEEK_API_KEY ? 'exists' : 'MISSING/undefined');
  try {
    await startServer(effectiveRepoPath);
    // If startServer resolves, it means stdio MCP is up. Utility HTTP server might be disabled
    // due to a conflict (Option C), but the instance is operational.
    // No specific action needed here; server will continue to run.
  } catch (error: unknown) {
    // This block will only be hit if startServer throws an error.
    // For Option C, ServerStartupError should only be thrown for fatal issues (exitCode=1).
    if (error instanceof LocalServerStartupError) {
      const typedError = error as { message: string; exitCode: number };
      localLogger.error(`CodeCompass server failed to start. Error: ${typedError.message}. Exiting with code ${typedError.exitCode}.`);
    } else {
      localLogger.error('An unexpected error occurred during server startup:', error);
    }
    // Re-throw for yargs.fail() to handle process exit.
    throw error;
  }
}

// Main CLI execution logic using yargs
export async function main() { // Add export
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
        // eslint-disable-next-line no-console
        console.log('[INDEX_TS_DEBUG] Default/Start command handler INVOKED');
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
    .fail(async (msg, err, yargsInstance) => { // Changed _yargsInstance to yargsInstance
    // Dynamically import logger for failure messages if possible
    // eslint-disable-next-line @typescript-eslint/no-require-imports -- Dynamic require for config after potential env changes by yargs
    let failLogger: { error: (...args: any[]) => void } = console; // Default to console
    try {
      let moduleFileExtensionForDynamicImportFail: string;
      if (process.env.VITEST_WORKER_ID) {
        if (path.basename(__dirname) === 'dist') { // Integration test running dist/index.js
          moduleFileExtensionForDynamicImportFail = '.js';
        } else { // Unit test running src/index.ts
          moduleFileExtensionForDynamicImportFail = '.ts';
        }
      } else { // Production or development from dist, or packaged
        moduleFileExtensionForDynamicImportFail = '.js';
      }

      const loggerModuleFilenameForFail = `config-service${moduleFileExtensionForDynamicImportFail}`;
      const loggerModulePathForFail = path.join(libPath, loggerModuleFilenameForFail);
      console.error(`[SUT_INDEX_TS_REQUIRE_DEBUG] About to import loggerModule (in .fail()) from: ${loggerModulePathForFail} (__dirname: ${__dirname}, VITEST_WORKER_ID: ${process.env.VITEST_WORKER_ID}, ext: ${moduleFileExtensionForDynamicImportFail})`);
      const loggerModule = await import(loggerModulePathForFail);
      failLogger = loggerModule.logger;
    } catch (e) {
      console.error("[SUT_INDEX_TS_DEBUG] Failed to load logger in .fail(), using console.error", e);
    }
    
    failLogger.error('YARGS_FAIL_HANDLER_INVOKED --- Details:', {
      hasMsg: !!msg, msgContent: msg, msgType: typeof msg,
      hasErr: !!err, errName: err?.name, errMessage: err?.message
    });
      // The try-catch block for failLogger is now handled by the above initialization.
      // The original logic for logging the error or message:
      if (process.env.VITEST_TESTING_FAIL_HANDLER) { // Check if in test fail handler mode
        if (err) {
            failLogger.error('CLI Error (yargs.fail):', err); // Log the error object directly for tests
        } else if (msg) {
            failLogger.error('CLI Usage Error (yargs.fail):', msg);
        }
      } else {
        // Default behavior for actual CLI execution
        yargsInstance.showHelp(); // Show help to the user
        if (err) {
            failLogger.error(`\nError: ${err.message || msg}`);
        } else if (msg) {
            failLogger.error(`\nError: ${msg}`);
        }
      }

      if (!err && msg && !process.env.VITEST_TESTING_FAIL_HANDLER) { // Avoid double console.error if VITEST_TESTING_FAIL_HANDLER already logged
        console.error(msg);
      }
      // Yargs will exit with 1 by default if err is present or msg is from yargs validation.
      // No need to call process.exit(1) explicitly here if yargs handles it.
    });

  try {
    console.log('[INDEX_TS_DEBUG] Before cli.parseAsync()');
    await cli.parseAsync();
    console.log('[INDEX_TS_DEBUG] After cli.parseAsync() - success path');
  } catch (error) {
    console.log('[INDEX_TS_DEBUG] After cli.parseAsync() - catch block');
    // This catch block is for errors thrown from command handlers
    // that yargs' .fail() might not have caught or for truly unexpected issues.
    try {
        let moduleFileExtensionForDynamicImportCrit: string;
        if (process.env.VITEST_WORKER_ID) {
          if (path.basename(__dirname) === 'dist') { // Integration test running dist/index.js
            moduleFileExtensionForDynamicImportCrit = '.js';
          } else { // Unit test running src/index.ts
            moduleFileExtensionForDynamicImportCrit = '.ts';
          }
        } else { // Production or development from dist, or packaged
          moduleFileExtensionForDynamicImportCrit = '.js';
        }

        const critLoggerModuleFilename = `config-service${moduleFileExtensionForDynamicImportCrit}`;
        const critLoggerModulePath = path.join(libPath, critLoggerModuleFilename);
        console.error(`[SUT_INDEX_TS_REQUIRE_DEBUG] About to import critLoggerModule (in main catch) from: ${critLoggerModulePath} (__dirname: ${__dirname}, VITEST_WORKER_ID: ${process.env.VITEST_WORKER_ID}, ext: ${moduleFileExtensionForDynamicImportCrit})`);
        // eslint-disable-next-line @typescript-eslint/no-require-imports -- Dynamic require for config after potential env changes by yargs
        const { logger: critLogger } = await import(critLoggerModulePath) as typeof import('./lib/config-service');
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
