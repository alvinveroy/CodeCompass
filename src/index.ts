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
let libPath: string; // Declare libPath here
let libPathBase: string; // Base directory for 'lib'
let moduleFileExtensionForDynamicImports: string;

// Check for --cc-integration-test-sut-mode flag early
const ccIntegrationTestSutMode = process.argv.includes('--cc-integration-test-sut-mode');

if (ccIntegrationTestSutMode) {
  console.error(`[SUT_INDEX_TS_MODE_DEBUG] --cc-integration-test-sut-mode detected. Forcing src paths and test mocks.`);
  process.env.VITEST_WORKER_ID = 'integration_sut'; // Simulate test environment for path resolution
  process.env.NODE_ENV = 'test';
  process.env.CODECOMPASS_INTEGRATION_TEST_MOCK_LLM = 'true';
  process.env.CODECOMPASS_INTEGRATION_TEST_MOCK_QDRANT = 'true';
}

// Prominent logging for initial state
console.error(
  `[SUT_INDEX_TS_PATH_INIT_DEBUG] __dirname: ${__dirname}, CWD: ${process.cwd()}, isPackaged: ${isPackaged}, VITEST_WORKER_ID: ${process.env.VITEST_WORKER_ID}, CC_INT_TEST_MODE: ${ccIntegrationTestSutMode}`
);

if (process.env.VITEST_WORKER_ID) { // This will now also be true if --cc-integration-test-sut-mode was passed
  // Running in Vitest worker or forced integration test SUT mode, source files are in 'src' relative to project root (process.cwd())
  libPathBase = path.resolve(process.cwd(), 'src');
  moduleFileExtensionForDynamicImports = '.ts';
  console.error(`[SUT_INDEX_TS_LIBPATH_DEBUG] Condition: VITEST_WORKER_ID is set. libPathBase: ${libPathBase}, ext: ${moduleFileExtensionForDynamicImports}`);
} else if (isPackaged) {
  // Running as a packaged executable, 'lib' is relative to the executable's directory
  libPathBase = path.dirname(process.execPath);
  moduleFileExtensionForDynamicImports = '.js';
  console.error(`[SUT_INDEX_TS_LIBPATH_DEBUG] Condition: isPackaged. libPathBase: ${libPathBase}, ext: ${moduleFileExtensionForDynamicImports}`);
} else {
  // Default: running compiled .js from 'dist' (e.g., node dist/index.js)
  // In this case, __dirname is /path/to/project/dist
  libPathBase = __dirname;
  moduleFileExtensionForDynamicImports = '.js';
  console.error(`[SUT_INDEX_TS_LIBPATH_DEBUG] Condition: Fallback (likely node dist/index.js). libPathBase: ${libPathBase}, ext: ${moduleFileExtensionForDynamicImports}`);
}
libPath = path.join(libPathBase, 'lib'); // libPath will be project/src/lib or project/dist/lib or <executable_dir>/lib

console.error(`[SUT_INDEX_TS_LIBPATH_FINAL] Final libPath: ${libPath}, Final ext: ${moduleFileExtensionForDynamicImports}, __dirname: ${__dirname}, CWD: ${process.cwd()}, isPackaged: ${isPackaged}, VITEST_WORKER_ID: ${process.env.VITEST_WORKER_ID}`);

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

  // Use the globally determined moduleFileExtensionForDynamicImports
  // eslint-disable-next-line @typescript-eslint/no-require-imports -- Dynamic require for config after potential env changes by yargs
  const configServiceModuleFilenameForClient = `config-service${moduleFileExtensionForDynamicImports}`;
  const configServiceModulePathForClient = path.join(libPath, configServiceModuleFilenameForClient);
  console.error(`[SUT_INDEX_TS_REQUIRE_DEBUG] About to import configService (in handleClientCommand) from: ${configServiceModulePathForClient} (__dirname: ${__dirname}, VITEST_WORKER_ID: ${process.env.VITEST_WORKER_ID}, ext: ${moduleFileExtensionForDynamicImports})`);
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
  
  // const isPkg = typeof (process as any).pkg !== 'undefined'; // isPackaged is already defined globally
  // Determine the SUT script path for StdioClientTransport's args
  // When tests run (VITEST_WORKER_ID is set), the client should spawn the compiled SUT from 'dist'.
  // When running normally from 'dist', it should also spawn 'dist/index.js'.
  // When packaged, it spawns the packaged 'index.js'.
  let sutScriptPathForClientSpawn: string;
  if (isPackaged) {
    // When packaged, process.execPath is the executable itself.
    // The 'start' command and other args are passed directly to it.
    // Assuming the main script inside the package is 'index.js' relative to executable.
    // However, if the pkg setup involves Node, this might need adjustment.
    // For now, assuming process.execPath is the primary command.
    // If node is bundled, args might need to include the script path within the package.
    // This logic aligns with typical Node.js script execution.
    sutScriptPathForClientSpawn = path.resolve(path.dirname(process.execPath), 'index.js'); // Path to the bundled index.js
    // This might be incorrect if __dirname inside pkg is different or if the packaged structure is different.
    // A more robust way for pkg might be needed if this fails.
    sutScriptPathForClientSpawn = path.resolve(path.dirname(process.execPath), 'index.js'); // Path to the bundled index.js
  } else {
    // Default: running from source (via Vitest) or from compiled 'dist'.
    // Always spawn the 'dist/index.js' version for the server.
    // process.cwd() is the project root.
    sutScriptPathForClientSpawn = path.resolve(process.cwd(), 'dist', 'index.js');
  }
  console.error(`[SUT_INDEX_TS_CLIENT_SPAWN_DEBUG] sutScriptPathForClientSpawn: ${sutScriptPathForClientSpawn}`);

  // Parameters for StdioClientTransport to spawn the server
  const serverProcessParams: StdioServerParameters = {
    command: process.execPath, // Path to node executable
    args: [
      sutScriptPathForClientSpawn, // Path to SUT script (src/index.ts for tests, dist/index.js otherwise)
      'start',           // Command for the server to start
      clientRepoPath,    // Repository path for the server
      '--port', '0',     // Instruct server to find a dynamic utility port
    ],
    // Environment variables for the server process.
    // StdioClientTransport's StdioServerParameters expects 'env' as a top-level property.
    // 'options' was incorrect and caused TS2353.
    // stdio handling is typically managed by the SDK or its default spawn options.
    env: {
      // Selectively pass environment variables.
      PATH: process.env.PATH ?? '',
      NODE_ENV: process.env.NODE_ENV ?? '',
      // HTTP_PORT for the spawned server:
      // 1. Use --port from the client command's argv if it were to exist (it doesn't currently, but for future proofing).
      // 2. Fallback to the client's process.env.HTTP_PORT.
      // 3. Default to '0' for dynamic port assignment in the spawned server.
      HTTP_PORT: argv.port?.toString() ?? process.env.HTTP_PORT ?? '0',
      // Propagate test-related environment variables if they are set in the client's environment.
      ...(process.env.VITEST_WORKER_ID && { VITEST_WORKER_ID: process.env.VITEST_WORKER_ID }),
      ...(process.env.CODECOMPASS_INTEGRATION_TEST_MOCK_LLM && { CODECOMPASS_INTEGRATION_TEST_MOCK_LLM: process.env.CODECOMPASS_INTEGRATION_TEST_MOCK_LLM }),
      ...(process.env.CODECOMPASS_INTEGRATION_TEST_MOCK_QDRANT && { CODECOMPASS_INTEGRATION_TEST_MOCK_QDRANT: process.env.CODECOMPASS_INTEGRATION_TEST_MOCK_QDRANT }),
      ...(process.env.DEBUG_SPAWNED_SERVER_ENV && { DEBUG_SPAWNED_SERVER_ENV: process.env.DEBUG_SPAWNED_SERVER_ENV }),
    },
    // SpawnOptions like 'stdio' can be added here if StdioServerParameters supports them directly,
    // or they might be part of an 'options' property if the SDK's API for StdioServerParameters changes.
    // For now, assuming 'stdio: "pipe"' is a default or handled internally by StdioClientTransport.
  };

  console.log('[SUT_INDEX_TS_DEBUG] About to instantiate StdioClientTransport. Type of StdioClientTransport:', typeof StdioClientTransport, 'serverProcessParams.env:', JSON.stringify(serverProcessParams.env));
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
    // Prioritize --repo option if positional repoPath is not provided or is the default '.'
    if (repoPathOrArgv.repo) { // If --repo is explicitly provided
      effectiveRepoPath = repoPathOrArgv.repo;
    } else if (repoPathOrArgv.repoPath && repoPathOrArgv.repoPath !== '.') { // If positional is provided and not default
      effectiveRepoPath = repoPathOrArgv.repoPath;
    } else { // Fallback to default '.'
      effectiveRepoPath = '.';
    }
  }
  console.log(`[SUT_INDEX_TS_DEBUG] startServerHandler: Effective repoPath determined as: ${effectiveRepoPath}`);
    
  // Use the globally determined moduleFileExtensionForDynamicImports
  // eslint-disable-next-line @typescript-eslint/no-require-imports -- Dynamic require for config after potential env changes by yargs
    const serverModuleFilename = `server${moduleFileExtensionForDynamicImports}`;
    const serverModulePath = path.join(libPath, serverModuleFilename);
    console.error(`[SUT_INDEX_TS_REQUIRE_DEBUG] About to import serverModule from: ${serverModulePath} (__dirname: ${__dirname}, VITEST_WORKER_ID: ${process.env.VITEST_WORKER_ID}, ext: ${moduleFileExtensionForDynamicImports})`);
    const serverModule = await import(serverModulePath);
    console.error('[SUT_INDEX_TS_SERVER_MODULE_TOKEN_CHECK]', (serverModule as any).SERVER_MODULE_TOKEN); // Log the token
    const { startServer, ServerStartupError: LocalServerStartupError } = serverModule;
    
    // Define the type for ServerStartupError for TypeScript
    type ServerStartupErrorType = {
      message: string;
      exitCode: number;
    };
    console.log('[SUT_INDEX_TS_DEBUG] Imported startServer (handler) in startServerHandler:', typeof startServer, 'Is mock:', !!(startServer as any)?.mock?.calls);
    console.log(`[SUT_INDEX_TS_DEBUG] VITEST_WORKER_ID in SUT (startServerHandler): ${process.env.VITEST_WORKER_ID}`);
    // eslint-disable-next-line @typescript-eslint/no-require-imports -- Dynamic require for config after potential env changes by yargs
    const configServiceModuleFilename = `config-service${moduleFileExtensionForDynamicImports}`; // Use the same extension logic
    const configServiceModulePath = path.join(libPath, configServiceModuleFilename);
    console.error(`[SUT_INDEX_TS_REQUIRE_DEBUG] About to import configServiceModule (in startServerHandler) from: ${configServiceModulePath} (__dirname: ${__dirname}, VITEST_WORKER_ID: ${process.env.VITEST_WORKER_ID}, ext: ${moduleFileExtensionForDynamicImports})`);
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

  // Early check for --cc-integration-test-sut-mode to bypass full yargs parsing if needed.
  // This flag indicates that src/index.ts is being spawned as a server for integration tests.
  if (process.argv.includes('--cc-integration-test-sut-mode')) {
    console.error('[SUT_INDEX_TS_MODE_DEBUG] --cc-integration-test-sut-mode detected. Bypassing full CLI parsing for server startup.');

    // Simplified argument parsing for this mode.
    // We expect 'start' command, optionally a repoPath, and optionally --port.
    const args = hideBin(process.argv);
    let repoPath = '.'; // Default repo path
    let portArg = '0';   // Default to dynamic port

    // Find 'start' command
    const startIndex = args.findIndex(arg => arg === 'start');
    if (startIndex === -1 && !args.includes('--cc-integration-test-sut-mode')) { // 'start' might be implicit if only repoPath is given after the flag
        // This case should ideally not happen if client always passes 'start'
        console.error('[SUT_INDEX_TS_MODE_DEBUG] "start" command not found in SUT mode args, defaulting repoPath.');
    }

    // Look for positional repoPath after 'start' or after the mode flag
    let potentialRepoPathIndex = -1;
    if (startIndex !== -1 && args.length > startIndex + 1 && !args[startIndex + 1].startsWith('--')) {
        potentialRepoPathIndex = startIndex + 1;
    } else {
        // If 'start' is not explicit, check after the mode flag itself
        const modeFlagIndex = args.indexOf('--cc-integration-test-sut-mode');
        if (modeFlagIndex !== -1 && args.length > modeFlagIndex + 1 && !args[modeFlagIndex + 1].startsWith('--')) {
            potentialRepoPathIndex = modeFlagIndex + 1;
        }
    }
    if (potentialRepoPathIndex !== -1) {
        repoPath = args[potentialRepoPathIndex];
    }
    
    // Check for --repo option as an override
    const repoOptionIndex = args.indexOf('--repo');
    if (repoOptionIndex > -1 && args.length > repoOptionIndex + 1) {
      repoPath = args[repoOptionIndex + 1];
    }

    // Check for --port option
    const portOptionIndex = args.indexOf('--port');
    if (portOptionIndex > -1 && args.length > portOptionIndex + 1) {
      portArg = args[portOptionIndex + 1];
    }

    // Set process.env.HTTP_PORT based on extracted portArg
    if (!isNaN(parseInt(portArg, 10)) && parseInt(portArg, 10) >= 0 && parseInt(portArg, 10) <= 65535) {
      process.env.HTTP_PORT = portArg;
    } else {
      console.error(`[SUT_INDEX_TS_MODE_DEBUG] Invalid port '${portArg}' provided in SUT mode. Using default '0'.`);
      process.env.HTTP_PORT = '0';
    }
    console.error(`[SUT_INDEX_TS_MODE_DEBUG] SUT mode determined: repoPath='${repoPath}', HTTP_PORT='${process.env.HTTP_PORT}'`);

    // Dynamically import and run startServerHandler
    // libPath and moduleFileExtensionForDynamicImports are already set globally at the top of the file.
    const serverModuleFilename = `server${moduleFileExtensionForDynamicImports}`;
    const serverModulePath = path.join(libPath, serverModuleFilename);
    const configServiceModuleFilename = `config-service${moduleFileExtensionForDynamicImports}`;
    const configServiceModulePath = path.join(libPath, configServiceModuleFilename);

    try {
      const serverModule = await import(serverModulePath);
      const { startServerHandler: directStartServerHandler } = serverModule; // Renamed to avoid conflict
      // Pass an object that mimics yargs argv structure expected by startServerHandler
      await directStartServerHandler({ repo: repoPath, port: parseInt(process.env.HTTP_PORT, 10), _:['start', repoPath], $0:'codecompass' });
    } catch (error: unknown) {
      // Minimal error handling for SUT mode
      try {
        const { logger: critLogger } = await import(configServiceModulePath) as typeof import('./lib/config-service');
        critLogger.error('Critical unhandled error in SUT integration mode startup:', error);
      } catch (logErr) {
        console.error('Fallback SUT mode error (logger unavailable):', error, 'Logger load error:', logErr);
      }
      // In test environment, re-throw to allow test to fail and capture the error.
      // Otherwise, exit.
      if (process.env.NODE_ENV !== 'test' && process.env.VITEST_WORKER_ID === undefined) {
          process.exit(1);
      } else {
          throw error; 
      }
    }
    return; // Exit main early, skipping full CLI parsing
  }

  // Original yargs CLI setup follows for non-SUT-mode execution
  const cli = yargs(hideBin(process.argv))
    .option('port', {
      alias: 'p',
      type: 'number',
      description: 'Specify the HTTP port for the server or spawned client server. Overrides HTTP_PORT env var.',
      global: true,
      apply: (value: number | undefined) => {
        if (value !== undefined) {
          if (isNaN(value) || value <= 0 || value > 65535) {
            throw new Error(`Error: Invalid port number "${value}". Port must be between 1 and 65535.`);
          }
          process.env.HTTP_PORT = String(value);
        }
      }
    })
    .option('cc-integration-test-sut-mode', { // Add the new hidden flag
      type: 'boolean',
      hidden: true, // Hide from help output
      default: false,
      global: true, // Make it global so it's parsed early
      // No 'apply' needed, its presence is checked at the top of the file
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
      // Use the globally determined moduleFileExtensionForDynamicImports
      const loggerModuleFilenameForFail = `config-service${moduleFileExtensionForDynamicImports}`;
      const loggerModulePathForFail = path.join(libPath, loggerModuleFilenameForFail);
      console.error(`[SUT_INDEX_TS_REQUIRE_DEBUG] About to import loggerModule (in .fail()) from: ${loggerModulePathForFail} (__dirname: ${__dirname}, VITEST_WORKER_ID: ${process.env.VITEST_WORKER_ID}, ext: ${moduleFileExtensionForDynamicImports})`);
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
        // Use the globally determined moduleFileExtensionForDynamicImports
        const critLoggerModuleFilename = `config-service${moduleFileExtensionForDynamicImports}`;
        const critLoggerModulePath = path.join(libPath, critLoggerModuleFilename);
        console.error(`[SUT_INDEX_TS_REQUIRE_DEBUG] About to import critLoggerModule (in main catch) from: ${critLoggerModulePath} (__dirname: ${__dirname}, VITEST_WORKER_ID: ${process.env.VITEST_WORKER_ID}, ext: ${moduleFileExtensionForDynamicImports})`);
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

// Execute the main function only if this script is run directly
if (require.main === module) {
  void main(); // Mark as void to satisfy no-floating-promises
}
// Else, if imported, main is just exported and can be called by the importer.
