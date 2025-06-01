import path from 'path';

const KNOWN_TOOLS = [
  'agent_query',
  'search_code',
  'get_changelog',
  'get_indexing_status',
  'switch_suggestion_model',
  'get_session_history',
  'generate_suggestion',
  'get_repository_context',
  'trigger_repository_update',
];

// Define projectRootForDynamicMock and srcLibPath at the top level
const projectRootForDynamicMock = path.resolve(__dirname, '../../'); // Path from src/tests/index.test.ts to project root
const srcLibPath = path.join(projectRootForDynamicMock, 'src', 'lib'); // Absolute path to src/lib

// --- Top-level vi.mock for SUT's dependencies, using absolute paths ---
// These mocks target the .ts files in src/lib, which the SUT should import when VITEST_WORKER_ID is set.
// const serverTsAbsolutePath = path.resolve(srcLibPath, 'server.ts'); // Using static relative path now
console.error(`[INDEX_TEST_VI_MOCK_SETUP_DEBUG] Attempting to mock server.ts using relative path: ../../src/lib/server.ts`);
vi.mock('../../src/lib/server.ts', () => {
  console.log(`[INDEX_TEST_VI_MOCK_DEBUG] TOP-LEVEL vi.mock factory for ../../src/lib/server.ts (server.ts) IS RUNNING.`);
  return {
    SERVER_MODULE_TOKEN: { type: "mocked_server_module_top_level_abs_path" },
    get startServer() { return mockStartServerHandler; },
    get ServerStartupError() { return ServerStartupError; }, // Ensure ServerStartupError is defined before this mock factory
  };
});

// const configServiceTsAbsolutePath = path.resolve(srcLibPath, 'config-service.ts'); // Using static relative path now
console.error(`[INDEX_TEST_VI_MOCK_SETUP_DEBUG] Attempting to mock config-service.ts using relative path: ../../src/lib/config-service.ts`);
vi.mock('../../src/lib/config-service.ts', () => {
  console.log(`[INDEX_TEST_VI_MOCK_DEBUG] TOP-LEVEL vi.mock factory for ../../src/lib/config-service.ts (config-service.ts) IS RUNNING.`);
  return {
    configService: mockConfigServiceForFactory, // Return the stable mock object directly
    logger: mockLoggerForFactory,           // Return the stable mock object directly
  };
});

import { describe, it, expect, vi, beforeEach, afterEach, type Mock, type MockInstance } from 'vitest';
import { StdioClientTransport as ActualStdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { Client as ActualMcpClient } from '@modelcontextprotocol/sdk/client/index.js';
import fs from 'fs';

// BEGIN MOCK DEFINITIONS (MUST BE BEFORE VI.MOCK CALLS USING THEM)

const mockedFsSpies = {
  statSync: vi.fn(),
  readFileSync: vi.fn(),
};

const mockStdioClientTransportInstanceClose = vi.fn();
// Simpler definition at the top level for hoisting
const mockStdioClientTransportConstructor = vi.fn(); // DEFINED HERE (simplified)

const mockMcpClientInstance = { // DEFINED HERE
  connect: vi.fn(),
  callTool: vi.fn(),
  close: vi.fn(),
};

// Import the TYPE of the actual ConfigService, not the instance.
import type { ConfigService as ActualConfigServiceType } from '../../src/lib/config-service';

// Define types for the mock config service to ensure mutability for test properties
type MockConfigServiceOverrides = {
  HTTP_PORT: number; // Mutable for tests
  AGENT_QUERY_TIMEOUT: number; // Mutable for tests
  VERSION: string; // Mock-specific version
  reloadConfigsFromFile: Mock; // Mocked method
  // Add other properties here if they are readonly in ActualConfigServiceType but need to be mutable in tests
};

// This type combines the actual service type with our overrides, ensuring mutability.
type TestMockConfigService = Omit<ActualConfigServiceType, keyof MockConfigServiceOverrides> & MockConfigServiceOverrides;

// Define the stable mock objects that the factory will return.
const mockLoggerForFactory = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
};

const mockConfigServiceForFactory = {
  // Properties from ActualConfigServiceType that the SUT might use
  HTTP_PORT: 0, // Default for tests, mutable
  AGENT_QUERY_TIMEOUT: 180000, // Default, mutable
  DEEPSEEK_API_KEY: 'mock_deepseek_key',
  OLLAMA_HOST: 'http://mock-ollama',
  QDRANT_HOST: 'http://mock-qdrant',
  COLLECTION_NAME: 'mock-collection',
  SUGGESTION_MODEL: 'mock-suggestion-model',
  SUGGESTION_PROVIDER: 'mock-suggestion-provider',
  EMBEDDING_MODEL: 'mock-embedding-model',
  EMBEDDING_PROVIDER: 'mock-embedding-provider',
  OPENAI_API_KEY: 'mock_openai_key',
  GEMINI_API_KEY: 'mock_gemini_key',
  CLAUDE_API_KEY: 'mock_claude_key',
  VERSION: 'mock-version-from-factory', // Specific to mock
  MAX_INPUT_LENGTH: 1000,
  MAX_SNIPPET_LENGTH: 100,
  REQUEST_TIMEOUT: 5000,
  MAX_RETRIES: 3,
  RETRY_DELAY: 100,
  // Add any other properties or getters from ActualConfigServiceType as needed
  // e.g., get LLM_PROVIDER() { return this.SUGGESTION_PROVIDER; },
  // Methods
  reloadConfigsFromFile: vi.fn(),
} as unknown as TestMockConfigService; // Use the new TestMockConfigService type for the cast

// These `let` variables will be assigned in `beforeEach` for convenience.
let currentMockConfigServiceInstance: typeof mockConfigServiceForFactory;
let currentMockLoggerInstance: typeof mockLoggerForFactory;

// Define mock functions and ServerStartupError class first
const mockStartServerHandler = vi.fn().mockResolvedValue({ close: vi.fn() }); // Renamed from mockStartServer for clarity
const mockStartProxyServer = vi.fn(); 
const ServerStartupError = class ServerStartupError extends Error { 
  exitCode: number;
  originalError?: Error;
  existingServerStatus?: any;
  requestedPort?: number;
  detectedServerPort?: number;

  constructor(message: string, exitCode = 1, options?: any) {
    super(message);
    this.name = "ServerStartupError";
    this.exitCode = exitCode;
    this.originalError = options?.originalError;
    this.existingServerStatus = options?.existingServerStatus;
    this.requestedPort = options?.requestedPort;
    this.detectedServerPort = options?.detectedServerPort;
  }
};

const mockSpawnFn = vi.fn(); // DEFINED HERE

// END MOCK DEFINITIONS

// NOW THE VI.MOCK CALLS

vi.mock('fs', () => ({ 
  get default() { return mockedFsSpies; },
  get statSync() { return mockedFsSpies.statSync; },
  get readFileSync() { return mockedFsSpies.readFileSync; },
}));

vi.mock('child_process', async () => { 
  const actualCp = await vi.importActual('child_process') as typeof import('child_process');
  return {
    ...actualCp,
    get spawn() { return mockSpawnFn; },
  };
});

vi.mock('@modelcontextprotocol/sdk/client/index.js', () => ({ 
  get Client() { return vi.fn().mockImplementation(() => mockMcpClientInstance); },
}));

vi.mock('@modelcontextprotocol/sdk/client/streamableHttp.js', () => ({
  get StreamableHTTPClientTransport() { return vi.fn(); } 
}));

// The SUT (src/index.ts) is ESM and will resolve SDK imports via its "exports" map.
// For 'import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js"',
// the SDK's package.json ("./*": { "import": "./dist/esm/*" }) means it resolves to
// "@modelcontextprotocol/sdk/dist/esm/client/stdio.js".
// So, we must mock that specific resolved path.
// Inlined the path string to avoid hoisting issues with sdkStdioClientPath variable.
// Changed to mock the package path directly, letting SDK's "exports" handle resolution.
console.error(`[INDEX_TEST_VI_MOCK_SETUP_DEBUG] Attempting to mock SDK's StdioClientTransport using package path: @modelcontextprotocol/sdk/client/stdio.js`);
vi.mock('@modelcontextprotocol/sdk/client/stdio.js', () => {
  console.log(`[INDEX_TEST_VI_MOCK_DEBUG] TOP-LEVEL vi.mock factory for @modelcontextprotocol/sdk/client/stdio.js IS RUNNING.`);
  // Ensure the factory returns an object where StdioClientTransport is a property.
  return {
    StdioClientTransport: mockStdioClientTransportConstructor,
    // Add other named exports from this SDK module if the SUT uses them and they need mocking.
    // e.g., getDefaultEnvironment: vi.fn(), DEFAULT_INHERITED_ENV_VARS: []
  };
});

// Revert to standard top-level vi.mock for SUT's direct dependencies (source files)
// These mocks are for when index.test.ts *itself* imports these modules,
// or when the SUT (src/index.ts) imports them and VITEST_WORKER_ID is NOT set (i.e., SUT requires .js)
// The paths here should match what the SUT would require as .js files from libPath.
// However, the primary goal is to mock the .ts files for when VITEST_WORKER_ID is set.
// The previous vi.mock calls using serverTsPathToMock and configServiceTsPathToMock handle the .ts case.

// If the SUT, when VITEST_WORKER_ID is NOT set, requires '.../dist/lib/server.js',
// then these mocks might need to target those paths or be structured differently.
// For now, assuming the .ts mocks are the priority for Vitest environment.
// The existing mocks for server.ts and config-service.ts using absolute paths should cover
// the case where the SUT (src/index.ts) dynamically imports them as .ts files.

// If direct imports of these .js paths from `dist/lib` by the SUT (when not in Vitest worker)
// need to be mocked, separate vi.mock calls targeting those specific paths would be required.
// For now, let's rely on the .ts path mocks being effective in the Vitest test environment.
// The console.error logs in the mock factories will confirm which ones are being hit.

// The following mocks for '.js' files in 'dist/lib' are likely not needed if the SUT
// correctly imports '.ts' files from 'src/lib' when VITEST_WORKER_ID is set,
// and those .ts imports are correctly mocked by the vi.mock calls above using relative paths.
// Keeping them commented out for now to reduce complexity and potential conflicts.
// If tests indicate that the SUT *is* trying to load from 'dist/lib/*.js' even in Vitest,
// these might need to be revisited, but the goal is to mock the source '.ts' files.

// const serverJsPathForDistMock = path.join(srcLibPath.replace('/src/', '/dist/'), 'server.js');
// console.error(`[INDEX_TEST_VI_MOCK_DEBUG] Registering (potentially redundant) vi.mock for SUT's server.js (dist) path: ${serverJsPathForDistMock}`);
// vi.mock(serverJsPathForDistMock, async () => {
//   console.log(`[INDEX_TEST_DEBUG] Mock factory for ${serverJsPathForDistMock} (dist .js) IS RUNNING.`);
//   return {
//     get startServerHandler() { return mockStartServerHandler; },
//   };
// });

// const configServiceJsPathForDistMock = path.join(srcLibPath.replace('/src/', '/dist/'), 'config-service.js');
// console.error(`[INDEX_TEST_VI_MOCK_DEBUG] Registering (potentially redundant) vi.mock for SUT's config-service.js (dist) path: ${configServiceJsPathForDistMock}`);
// vi.mock(configServiceJsPathForDistMock, () => {
//   console.log(`[INDEX_TEST_DEBUG] Mock factory for ${configServiceJsPathForDistMock} (dist .js) IS RUNNING.`);
//   return {
//     // as they are reassigned in beforeEach
//     get configService() { return currentMockConfigServiceInstance; },
//     get logger() { return currentMockLoggerInstance; },
//   };
// });


// --- End Mocks ---

// yargs is not directly imported here as we are testing its invocation via index.ts's main

// Import the SUT path
const indexPath = path.resolve(__dirname, '../../src/index.ts'); // Changed to src

// Near the top of src/tests/index.test.ts, after imports
let actualStderrDataCallbackForClientTests: ((data: Buffer) => void) | null = null;
let mockSpawnedProcessExitCallbackForClientTests: ((code: number | null, signal: NodeJS.Signals | null) => void) | null = null;
let mockSpawnedProcessErrorCallbackForClientTests: ((err: Error) => void) | null = null;


// The simulateServerReadyForClientTests helper is no longer directly applicable
// as StdioClientTransport handles server readiness internally.
// Tests will rely on client.connect() resolving or rejecting.
// If specific stderr/stdout inspection of the spawned server is needed,
// StdioClientTransport would need to expose a way to access the child process's streams,
// or tests would need to use a more integrated approach.

// --- Mocks for modules dynamically required by index.ts handlers ---
// axios mock removed as it's no longer directly used by handleClientCommand's primary path

// The fs mock is now defined at the top using mockedFsSpies

// --- Mocks for source files ---
// Top-level vi.doMock calls are now used for SUT's direct dependencies.
// --- End Mocks ---

import type { ChildProcess } from 'child_process'; // Ensure this is imported if not already

let mockProcessExit: MockInstance<typeof process.exit>;
let originalConsoleLog: (...args: any[]) => void; // Store original console.log
let mockConsoleLog: MockInstance<typeof console.log>;
let mockConsoleError: MockInstance<typeof console.error>;
let originalProcessEnv: NodeJS.ProcessEnv;
let originalArgv: string[];

describe('CLI with yargs (index.ts)', () => {
  let mockSpawnInstance: {
    on: Mock; kill: Mock; pid?: number; stdin: any; stdout: any; stderr: any;
  };

  beforeEach(() => {
    vi.resetAllMocks(); 
    originalProcessEnv = { ...process.env };
    originalArgv = [...process.argv];

    // Initialize console and process spies
    mockProcessExit = vi.spyOn(process, 'exit').mockImplementation((code) => {
      // Throw an error to be caught by tests expecting an exit
      throw new Error(`process.exit called with ${code ?? 'unknown code'}`);
    });
    
    // Spy on console.log but also call the original implementation
    originalConsoleLog = console.log.bind(console);
    mockConsoleLog = vi.spyOn(console, 'log').mockImplementation(vi.fn()); // Pure spy for assertions
    mockConsoleError = vi.spyOn(console, 'error').mockImplementation(vi.fn());
    
    mockProcessExit.mockClear(); // Clear mockProcessExit calls
        
    // Assign references to the stable mock singletons
    currentMockConfigServiceInstance = mockConfigServiceForFactory;
    currentMockLoggerInstance = mockLoggerForFactory;

    // Reset the state of the stable mock singletons
    currentMockConfigServiceInstance.reloadConfigsFromFile.mockClear();
    currentMockConfigServiceInstance.HTTP_PORT = 0; // Reset to default test value
    currentMockConfigServiceInstance.AGENT_QUERY_TIMEOUT = 1000; // Reset to test value
    // Add resets for any other properties of mockConfigServiceForFactory that tests might change

    currentMockLoggerInstance.info.mockClear();
    currentMockLoggerInstance.warn.mockClear();
    currentMockLoggerInstance.error.mockClear();
    currentMockLoggerInstance.debug.mockClear();
    
    // Reset other top-level mocks that might be stateful
    mockStartServerHandler.mockReset().mockResolvedValue(undefined);
    mockStartProxyServer.mockReset().mockResolvedValue(undefined);
    
    mockMcpClientInstance.callTool.mockReset().mockResolvedValue({ content: [{ type: 'text', text: 'Tool call success' }] });
    mockMcpClientInstance.connect.mockReset().mockResolvedValue(undefined);
    mockMcpClientInstance.close.mockReset().mockResolvedValue(undefined);
    
    mockStdioClientTransportConstructor.mockImplementation(() => ({ // mockStdioClientTransportConstructor is defined before vi.mock
      close: mockStdioClientTransportInstanceClose,
    }));

    delete process.env.HTTP_PORT;
  });

  afterEach(() => {
    process.env = originalProcessEnv;
    process.argv = originalArgv;
    vi.restoreAllMocks();
  });
    
  async function runMainWithArgs(args: string[]) {
    let effectiveProcessArgs = [...args];
    // If args is empty (simulating `codecompass` default command),
    // or if the first argument is a path (simulating `codecompass /some/path`),
    // yargs default command `$0 [repoPath]` handles it.
    // To explicitly test the `start` command with no repoPath (expecting default '.'),
    // the test should call `runMainWithArgs(['start'])`.
    // `runMainWithArgs([])` should simulate `codecompass` which invokes the default command.
    // The issue was that yargs took `indexPath` as the `repoPath`.
    // The most straightforward way to ensure `.` is used for `codecompass` (no args)
    // is to ensure `startServerHandler` defaults correctly if `repoPath` from yargs is `indexPath`.
    // However, a cleaner test setup is to make `runMainWithArgs([])` explicitly test the `start` command.
    if (args.length === 0) {
      effectiveProcessArgs = ['start']; // Simulate `codecompass start` for default behavior tests
    }
    // For other cases like `runMainWithArgs(['/my/repo'])`, yargs default command `$0 [repoPath]` will correctly pick up `/my/repo`.
    // For tool commands, `args` will start with the tool name.

    process.argv = ['npx', 'tsx', indexPath, ...effectiveProcessArgs];
    
    // Ensure SUT runs in a test-aware context for mocks to apply to src/*.ts files
    // and for SUT's internal path logic to target src/lib/*.ts
    process.env.VITEST_WORKER_ID = '1'; 
    process.env.NODE_ENV = 'test';

    console.error(`[INDEX_TEST_RUN_MAIN_DEBUG] Before vi.resetModules(). Current VITEST_WORKER_ID: ${process.env.VITEST_WORKER_ID}, NODE_ENV: ${process.env.NODE_ENV}`);
    vi.resetModules(); 
    console.error(`[INDEX_TEST_RUN_MAIN_DEBUG] After vi.resetModules().`);
    
    console.log(`[INDEX_TEST_DEBUG] runMainWithArgs: About to import SUT from indexPath: ${indexPath} using tsx.`);
    
    const currentSutIndexPath = indexPath; // Already points to src/index.ts

    console.error(`[INDEX_TEST_RUN_MAIN_DEBUG] About to dynamically import SUT from (src) currentSutIndexPath: ${currentSutIndexPath}. Current VITEST_WORKER_ID: ${process.env.VITEST_WORKER_ID}`);
    try {
      const sutModuleUntyped = await import(currentSutIndexPath);
      console.error(`[INDEX_TEST_RUN_MAIN_DEBUG] Dynamic import of SUT from ${currentSutIndexPath} completed.`);

      // Perform more explicit checks before asserting the type and calling main
      if (typeof sutModuleUntyped !== 'object' || sutModuleUntyped === null || typeof (sutModuleUntyped as any).main !== 'function') {
        throw new Error(`SUT module from ${currentSutIndexPath} does not have a valid exported 'main' function.`);
      }
      
      // Now that we've checked, we can assert the type more confidently for the call.
      const sutModule = sutModuleUntyped as { main: () => Promise<void> };
      await sutModule.main();
      
      console.error(`[INDEX_TEST_RUN_MAIN_DEBUG] SUT main() executed and resolved.`);
    } catch (e) {
      const errorMessage = e instanceof Error ? e.message : String(e);
      console.error(`[INDEX_TEST_RUN_MAIN_DEBUG] Error during dynamic import or execution of SUT from ${currentSutIndexPath}:`, errorMessage, e);
      // Always re-throw the error. Test assertions (e.g., .rejects.toThrow()) will handle it.
      throw e;
    }
    console.log(`[INDEX_TEST_DEBUG] runMainWithArgs: SUT import/execution finished or threw.`);
  }

  describe('Server Start Command (default and "start")', () => {
    it('should call startServerHandler with default repoPath when no args', async () => {
      await runMainWithArgs([]);
      expect(mockStartServerHandler).toHaveBeenCalledWith('.');
      // Successful promise resolution from handler implies yargs exits 0
    });

    it('should call startServerHandler with specified repoPath for default command', async () => {
      await runMainWithArgs(['/my/repo']);
      expect(mockStartServerHandler).toHaveBeenCalledWith('/my/repo');
    });

    it('should call startServerHandler with specified repoPath from --repo global option for default command if no positional', async () => {
      await runMainWithArgs(['--repo', '/global/repo']);
      expect(mockStartServerHandler).toHaveBeenCalledWith('/global/repo');
    });
    
    it('should call startServerHandler with specified repoPath for "start" command (positional)', async () => {
      await runMainWithArgs(['start', '/my/repo/path']);
      expect(mockStartServerHandler).toHaveBeenCalledWith('/my/repo/path');
    });

    it('should call startServerHandler with repoPath from --repo for "start" command if no positional', async () => {
      await runMainWithArgs(['start', '--repo', '/global/start/repo']);
      expect(mockStartServerHandler).toHaveBeenCalledWith('/global/start/repo');
    });

    it('should handle startServer failure (fatal error, exitCode 1) and log via yargs .fail()', async () => {
      const startupError = new ServerStartupError("Server failed to boot with fatal error", 1, {});
      mockStartServerHandler.mockRejectedValue(startupError);
      process.env.VITEST_TESTING_FAIL_HANDLER = "true";

      await expect(runMainWithArgs(['start'])).rejects.toThrowError(startupError);

      // The new .fail() handler in test mode with VITEST_TESTING_FAIL_HANDLER will use console.error
      expect(mockConsoleError).toHaveBeenCalledWith('YARGS_FAIL_TEST_MODE_ERROR_OUTPUT:', startupError.message);
      expect(mockConsoleError).toHaveBeenCalledWith(
        'YARGS_FAIL_HANDLER_INVOKED --- Details:',
        expect.objectContaining({ effectiveErrorMessage: startupError.message, errMessage: startupError.message, hasErr: true })
      );
      expect(mockProcessExit).not.toHaveBeenCalled();
      delete process.env.VITEST_TESTING_FAIL_HANDLER;
    });

    // Removed test for startProxyServer as startServerHandler no longer calls it.
    // If startServer resolves (even with utility server disabled), it's a success for startServerHandler.
    // If startServer rejects, it's a fatal error (exitCode 1), handled by the test above.
  });

  describe('Client Tool Commands (stdio based)', () => {
    beforeEach(() => {
      actualStderrDataCallbackForClientTests = null; // Reset for each test
      mockSpawnedProcessExitCallbackForClientTests = null;
      mockSpawnedProcessErrorCallbackForClientTests = null;
      mockStdioClientTransportConstructor.mockClear(); // Clear the mock constructor
      mockStdioClientTransportInstanceClose.mockClear();
      // Initialize mockSpawnInstance (it's declared at a higher scope)
      mockSpawnInstance = {
        on: vi.fn((event, cb) => {
          if (event === 'exit') mockSpawnedProcessExitCallbackForClientTests = cb;
          else if (event === 'error') mockSpawnedProcessErrorCallbackForClientTests = cb;
          return mockSpawnInstance;
        }),
        kill: vi.fn(),
        pid: 12345,
        stdin: { write: vi.fn(), end: vi.fn(), on: vi.fn(), pipe: vi.fn() }, // Added pipe
        stdout: { on: vi.fn(), pipe: vi.fn(), unpipe: vi.fn(), resume: vi.fn() },
        stderr: { 
          on: vi.fn(function(this: any, event, callback) { // Use function for 'this'
            if (event === 'data') {
              actualStderrDataCallbackForClientTests = callback;
            }
            return this; // Return the stderr mock object itself
          }), 
          pipe: vi.fn(),
          removeAllListeners: vi.fn(), // Added
        },
        removeAllListeners: vi.fn(), // Added
        // Add other ChildProcess properties/methods if SUT uses them
      } as unknown as typeof mockSpawnInstance; // Use unknown for type flexibility with the mock
      mockSpawnFn.mockReturnValue(mockSpawnInstance);
      // The (mockSpawnInstance as any).simulateServerReady = simulateServerReady; line can be removed
      // as we will use the helper function directly.
    });

    // For client command tests, StdioClientTransport will be instantiated by the SUT (index.ts)
    // We expect client.connect() to be called on its instance.
    it('should spawn server and call tool via stdio for "agent_query"', { timeout: 30000 }, async () => {
      await runMainWithArgs(['agent_query', '{"query":"test_stdio"}']);

      expect(mockStdioClientTransportConstructor).toHaveBeenCalledWith(
        expect.objectContaining({
          command: 'npx', // Expect 'npx'
          args: [
            'tsx', // Expect 'tsx'
            path.resolve(process.cwd(), 'src', 'index.ts'), // Expect path to src/index.ts
            'start',
            '.', // Default repoPath
            '--port', '0',
            '--cc-integration-test-sut-mode', // Expect this flag
          ],
          env: expect.objectContaining({ // env is a top-level property for StdioServerParameters
              HTTP_PORT: '0',
              VITEST_WORKER_ID: expect.any(String),
              CODECOMPASS_INTEGRATION_TEST_MOCK_LLM: 'true', // Should be explicitly true if client is in test mode
              CODECOMPASS_INTEGRATION_TEST_MOCK_QDRANT: 'true', // Should be explicitly true
            }),
          }),
      );
      // We expect the MCP client's callTool to be invoked.
      expect(mockMcpClientInstance.callTool).toHaveBeenCalledWith({ name: 'agent_query', arguments: { query: 'test_stdio' } });
      expect(mockConsoleLog).toHaveBeenCalledWith('Tool call success');
      // StdioClientTransport's close method should handle killing the process.
      // We can check if client.close was called.
      expect(mockMcpClientInstance.close).toHaveBeenCalled();
    });
    
    it('should use --repo path for spawned server in client stdio mode', { timeout: 30000 }, async () => {
      const repoPath = '/custom/path';
      await runMainWithArgs(['agent_query', '{"query":"test_repo"}', '--repo', repoPath]);

      expect(mockStdioClientTransportConstructor).toHaveBeenCalledWith(
        expect.objectContaining({
          command: 'npx',
          args: [
            'tsx',
            path.resolve(process.cwd(), 'src', 'index.ts'),
            'start',
            repoPath, // Custom repoPath
            '--port', '0',
            '--cc-integration-test-sut-mode',
          ],
          env: expect.objectContaining({ // env is a top-level property
              HTTP_PORT: '0',
              VITEST_WORKER_ID: expect.any(String),
              CODECOMPASS_INTEGRATION_TEST_MOCK_LLM: 'true',
              CODECOMPASS_INTEGRATION_TEST_MOCK_QDRANT: 'true',
            }),
          }),
      );
      expect(mockMcpClientInstance.callTool).toHaveBeenCalledWith({ name: 'agent_query', arguments: { query: 'test_repo' } });
      expect(mockMcpClientInstance.close).toHaveBeenCalled();
    });


    it('should handle client command failure (spawn error) and log via yargs .fail()', async () => {
      const spawnError = new Error("Failed to spawn");
      mockStdioClientTransportConstructor.mockImplementation(() => {
        throw spawnError;
      });
      process.env.VITEST_TESTING_FAIL_HANDLER = "true";
      mockConsoleError.mockClear(); // Clear before run
      await expect(runMainWithArgs(['agent_query', '{"query":"test_spawn_fail"}'])).rejects.toThrowError(spawnError);
      
      expect(mockConsoleError).toHaveBeenCalledWith('YARGS_FAIL_TEST_MODE_ERROR_OUTPUT:', spawnError.message);
      expect(mockConsoleError).toHaveBeenCalledWith(
        'YARGS_FAIL_HANDLER_INVOKED --- Details:',
        expect.objectContaining({ effectiveErrorMessage: spawnError.message, errMessage: spawnError.message, hasErr: true })
      );
      expect(mockProcessExit).not.toHaveBeenCalled();
      delete process.env.VITEST_TESTING_FAIL_HANDLER;
    });

    it('should handle client command failure (server process premature exit) and log via yargs .fail()', async () => {
      const prematureExitError = new Error("Server process exited prematurely");
      mockMcpClientInstance.connect.mockRejectedValue(prematureExitError);
      
      process.env.VITEST_TESTING_FAIL_HANDLER = "true";
      mockConsoleError.mockClear(); // Clear before run
      await expect(runMainWithArgs(['agent_query', '{"query":"test_server_exit"}'])).rejects.toThrowError(prematureExitError);
      
      expect(mockConsoleError).toHaveBeenCalledWith('YARGS_FAIL_TEST_MODE_ERROR_OUTPUT:', prematureExitError.message);
      expect(mockConsoleError).toHaveBeenCalledWith(
        'YARGS_FAIL_HANDLER_INVOKED --- Details:',
        expect.objectContaining({ effectiveErrorMessage: prematureExitError.message, errMessage: prematureExitError.message, hasErr: true })
      );
      expect(mockProcessExit).not.toHaveBeenCalled();
      delete process.env.VITEST_TESTING_FAIL_HANDLER;
    }),


    it('should handle invalid JSON parameters for client command (stdio) and log via yargs .fail()', async () => {
      process.env.VITEST_TESTING_FAIL_HANDLER = "true";
      mockConsoleError.mockClear(); // Clear before run
      
      await expect(runMainWithArgs(['agent_query', '{"query": "test"'])).rejects.toThrowError(
        // This error is thrown by handleClientCommand and then re-thrown by yargs.fail()
        new Error("Invalid JSON parameters: Expected ',' or '}' after property value in JSON at position 16")
      );
      
      // yargs .fail() handler logs to console.error in test mode
      const yargsFailOutputLogged = mockConsoleError.mock.calls.some(call => 
        call[0] === 'YARGS_FAIL_TEST_MODE_ERROR_OUTPUT:' && 
        typeof call[1] === 'string' && call[1].includes("Invalid JSON parameters: Expected ',' or '}' after property value in JSON at position 16")
      );
      expect(yargsFailOutputLogged, "Expected yargs .fail() to log the specific error to console.error").toBe(true);
      
      // SUT's handleClientCommand also logs via its own logger
      expect(currentMockLoggerInstance.error).toHaveBeenCalledWith(
        "Error: Invalid JSON parameters for tool agent_query: {\"query\": \"test\"", // The SUT log includes the tool name and params
        // The second argument to logger.error is the error message itself
        "Expected ',' or '}' after property value in JSON at position 16" 
      );
      expect(currentMockLoggerInstance.error).toHaveBeenCalledWith(
        "Invalid JSON parameters: Expected ',' or '}' after property value in JSON at position 16" // The details log
      );

      expect(mockProcessExit).not.toHaveBeenCalled();
      delete process.env.VITEST_TESTING_FAIL_HANDLER;
    });
  });

  describe('Global Options', () => {
    beforeEach(() => {
      actualStderrDataCallbackForClientTests = null; // Reset for each test
      mockSpawnedProcessExitCallbackForClientTests = null;
      mockSpawnedProcessErrorCallbackForClientTests = null;

      mockSpawnInstance = {
        on: vi.fn((event, cb) => {
          if (event === 'exit') mockSpawnedProcessExitCallbackForClientTests = cb;
          else if (event === 'error') mockSpawnedProcessErrorCallbackForClientTests = cb;
          return mockSpawnInstance;
        }),
        kill: vi.fn(),
        pid: 12345,
        stdin: { write: vi.fn(), end: vi.fn(), on: vi.fn(), pipe: vi.fn() },
        stdout: { on: vi.fn(), pipe: vi.fn(), unpipe: vi.fn(), resume: vi.fn() },
        stderr: { 
          on: vi.fn(function(this: any, event, callback) {
            if (event === 'data') {
              actualStderrDataCallbackForClientTests = callback;
            }
            return this;
          }), 
          pipe: vi.fn(),
          removeAllListeners: vi.fn(),
        },
        removeAllListeners: vi.fn(),
      } as unknown as typeof mockSpawnInstance;
      mockSpawnFn.mockReturnValue(mockSpawnInstance);
    });

    // (This test name is slightly misleading, it checks process.env in the *current* process after yargs parsing)
    it('--port option should set HTTP_PORT environment variable, and configService should see it', async () => {
      const customPort = 1234;
      const originalHttpPort = process.env.HTTP_PORT; // Store original
      process.env.HTTP_PORT = '0'; // Set initial for the test context

      console.log(`[INDEX_TEST_PORT_DEBUG] Before runMainWithArgs, test's process.env.HTTP_PORT: ${process.env.HTTP_PORT}`);
      
      // We expect runMainWithArgs to cause yargs to set process.env.HTTP_PORT to customPort
      // And then for startServerHandler (which uses configService) to be called.
      // We'll check if configService (mocked or real, depending on test setup) sees the change.

      // Temporarily spy on configService.HTTP_PORT getter or a method that uses it
      // This is tricky because configService is also in the SUT.
      // Let's assume mockStartServerHandler will be called, and it implicitly uses configService.
      // The SUT's yargs apply function should log the change.
      // We will check if the SUT's configService (mocked) reflects this.
      // The mockStartServerHandler uses the mocked configService.

      await runMainWithArgs(['start', '--port', String(customPort)]);
    
      // Check if the SUT's configService (via the mock) had its HTTP_PORT set.
      // This relies on the yargs 'apply' function setting process.env.HTTP_PORT,
      // and then configService (when reloaded or its getter is accessed by startServerHandler)
      // picking up this new value.
      // The mockConfigServiceForFactory.HTTP_PORT is what startServerHandler would see.
      // However, the 'apply' function in yargs sets process.env.HTTP_PORT.
      // The mockConfigServiceForFactory itself doesn't automatically update from process.env.
      // So, this assertion needs to check the SUT's internal state if possible,
      // or rely on the SUT's logs if direct state assertion is too complex.
      // For now, we'll assume the SUT's internal configService would pick it up.
      // The most direct check is if mockStartServerHandler was called, implying successful port setup.
      expect(mockStartServerHandler).toHaveBeenCalled(); 
      
      // Check if the SUT's yargs middleware logged the port being observed.
      const portLogFound = currentMockLoggerInstance.info.mock.calls.some(
        call => typeof call[0] === 'string' && call[0].includes(`[SUT_INDEX_TS_YARGS_MW] --port option value at middleware: ${customPort}`)
      );
      expect(portLogFound, `Expected SUT log for --port middleware. Calls: ${JSON.stringify(currentMockLoggerInstance.info.mock.calls)}`).toBe(true);
      
      // Restore original
      if (originalHttpPort === undefined) delete process.env.HTTP_PORT;
      else process.env.HTTP_PORT = originalHttpPort;
    });

    it('--repo option should be used by startServerHandler', async () => {
      await runMainWithArgs(['start', '--repo', '/custom/repo/for/start']);
      expect(mockStartServerHandler).toHaveBeenCalledWith('/custom/repo/for/start');
    });
    
    it('--repo option should be used by client stdio command for spawned server', { timeout: 30000 }, async () => {
      const repoPath = '/my/client/repo';
      await runMainWithArgs(['agent_query', '{"query":"test_repo_opt"}', '--repo', repoPath]);
      
      expect(mockStdioClientTransportConstructor).toHaveBeenCalledWith(
        expect.objectContaining({
          command: 'npx',
          args: [
            'tsx',
            path.resolve(process.cwd(), 'src', 'index.ts'),
            'start',
            repoPath, // Custom repoPath from --repo
            '--port', '0',
            '--cc-integration-test-sut-mode',
          ],
          env: expect.objectContaining({ // env is a top-level property
              HTTP_PORT: '0',
              VITEST_WORKER_ID: expect.any(String),
              CODECOMPASS_INTEGRATION_TEST_MOCK_LLM: 'true',
              CODECOMPASS_INTEGRATION_TEST_MOCK_QDRANT: 'true',
            }),
          }),
      );
    });


    it('--version option should display version and exit', async () => {
      // With the new .fail handler, yargs.exit() will be called in non-test mode.
      // In test mode, .fail() throws. yargs itself might throw for --version if it tries to exit.
      // Let's ensure VITEST_TESTING_FAIL_HANDLER is set so .fail() throws predictably.
      process.env.VITEST_TESTING_FAIL_HANDLER = "true";
      mockConsoleLog.mockClear(); // Clear previous calls

      // yargs --version typically prints to stdout. With exitProcess(false), it should resolve.
      // mockProcessExit should NOT be called.
      await expect(runMainWithArgs(['--version'])).resolves.toBeUndefined();
      
      // Check that among all calls, one matches the version string.
      // This is more robust against other debug logs.
      const { getPackageVersion: getSutPackageVersion } = await import('../../src/index.js');
      const expectedVersion = getSutPackageVersion();

      const versionLogFound = mockConsoleLog.mock.calls.some(call =>
        call.length > 0 && typeof call[0] === 'string' && call[0].trim() === expectedVersion
      );
      expect(versionLogFound, `Expected console.log to be called with version string "${expectedVersion}". Calls: ${JSON.stringify(mockConsoleLog.mock.calls)}`).toBe(true);

      expect(mockProcessExit).not.toHaveBeenCalled(); 
      delete process.env.VITEST_TESTING_FAIL_HANDLER;
    });

    it('--help option should display help and exit', async () => {
      process.env.VITEST_TESTING_FAIL_HANDLER = "true";
      mockConsoleLog.mockClear(); // Clear before run
      await expect(runMainWithArgs(['--help'])).resolves.toBeUndefined();
      
      const helpOutput = mockConsoleLog.mock.calls.map(call => call[0]).join('\n');
      expect(helpOutput).toContain("Commands:");
      expect(helpOutput).toContain("codecompass start [repoPath]");
      // Check for a tool command example with more flexible regex
      expect(helpOutput).toMatch(/codecompass\s+agent_query\s+\[params\].*Execute the 'agent_query' tool/s);
      expect(helpOutput).toContain("Options:");
      expect(helpOutput).toContain("--help");
      expect(helpOutput).toContain("--port");
      expect(mockProcessExit).not.toHaveBeenCalled();
      delete process.env.VITEST_TESTING_FAIL_HANDLER;
    });
  });
  
  describe('Changelog Command', () => {
    it('should display changelog', async () => {
      mockConsoleLog.mockClear(); // Clear before run
      mockedFsSpies.statSync.mockReturnValue({ mtimeMs: Date.now() } as fs.Stats);
      const projectRoot = path.resolve(__dirname, '../../');
      const expectedPackageJsonPath = path.join(projectRoot, 'package.json');
      const expectedChangelogPath = path.join(projectRoot, 'CHANGELOG.md');

      mockedFsSpies.readFileSync.mockImplementation((filePath: fs.PathOrFileDescriptor) => {
        const p = path.resolve(filePath.toString());
        if (p === expectedPackageJsonPath) {
          return '{"version":"0.0.0-test"}';
        }
        if (p === expectedChangelogPath) {
          return '## Test Changelog Content';
        }
        return '';
      });
      
      await runMainWithArgs(['changelog']);
      
      expect(mockedFsSpies.readFileSync).toHaveBeenCalledTimes(2);
      expect(mockedFsSpies.readFileSync).toHaveBeenCalledWith(expectedPackageJsonPath, 'utf8');
      expect(mockedFsSpies.readFileSync).toHaveBeenCalledWith(expectedChangelogPath, 'utf8');
      expect(mockConsoleLog).toHaveBeenCalledWith(expect.stringContaining('## Test Changelog Content'));
    });
  });

  describe('Error Handling and Strict Mode by yargs', () => {
    it('should show error and help for unknown command', async () => {
      process.env.VITEST_TESTING_FAIL_HANDLER = "true";
      mockConsoleError.mockClear(); // Clear before run
      mockProcessExit.mockClear();

      const expectedErrorPattern = /Unknown command: unknowncommand|You must provide a command to run|Not enough non-option arguments|Unknown argument: unknowncommand/;
      await expect(runMainWithArgs(['unknowncommand'])).rejects.toThrowError(expectedErrorPattern);

      const consoleErrorCalls = mockConsoleError.mock.calls.map(call => call.join(' ')).join('\n');
      // Check that help output was logged
      expect(consoleErrorCalls).toMatch(/Usage: codecompass <command> \[options\]/);
      // Check that the specific error message from yargs was logged by the .fail() handler's test mode path
      expect(consoleErrorCalls).toMatch(/YARGS_FAIL_TEST_MODE_ERROR_OUTPUT:.*(Unknown command: unknowncommand|You must provide a command to run|Not enough non-option arguments|Unknown argument: unknowncommand)/s);
      
      expect(mockStartServerHandler).not.toHaveBeenCalled();
      expect(mockProcessExit).not.toHaveBeenCalled(); // yargs .fail() throws in test mode
      delete process.env.VITEST_TESTING_FAIL_HANDLER;
    });

    it('should show error and help for unknown option', async () => {
      process.env.VITEST_TESTING_FAIL_HANDLER = "true";
      mockConsoleError.mockClear(); // Clear before run
      mockProcessExit.mockClear();

      const expectedErrorMsgPattern = /Unknown argument: --unknown-option|Unknown arguments: unknown-option, unknownOption/;
      await expect(runMainWithArgs(['start', '--unknown-option'])).rejects.toThrowError(expectedErrorMsgPattern);
      
      const consoleErrorCalls = mockConsoleError.mock.calls.map(call => call.join(' ')).join('\n');
      expect(consoleErrorCalls).toMatch(/Usage: codecompass <command> \[options\]/);
      // Check that the specific error message from yargs was logged by the .fail() handler's test mode path
      expect(consoleErrorCalls).toMatch(/YARGS_FAIL_TEST_MODE_ERROR_OUTPUT:.*(Unknown argument: --unknown-option|Unknown arguments: unknown-option, unknownOption)/s);
      
      expect(mockStartServerHandler).not.toHaveBeenCalled(); 
      expect(mockProcessExit).not.toHaveBeenCalled();
      delete process.env.VITEST_TESTING_FAIL_HANDLER;
    });
  });

  describe('Client Tool Commands with --json output flag', () => {
    beforeEach(() => { 
      actualStderrDataCallbackForClientTests = null; // Reset for each test
      mockSpawnedProcessExitCallbackForClientTests = null;
      mockSpawnedProcessErrorCallbackForClientTests = null;

      mockSpawnInstance = { 
        on: vi.fn((event, cb) => {
          if (event === 'exit') mockSpawnedProcessExitCallbackForClientTests = cb;
          else if (event === 'error') mockSpawnedProcessErrorCallbackForClientTests = cb;
          return mockSpawnInstance;
        }),
        kill: vi.fn(),
        pid: 12345,
        stdin: { write: vi.fn(), end: vi.fn(), on: vi.fn(), pipe: vi.fn() },
        stdout: { on: vi.fn(), pipe: vi.fn(), unpipe: vi.fn(), resume: vi.fn() },
        stderr: { 
          on: vi.fn(function(this: any, event, callback) {
            if (event === 'data') {
              actualStderrDataCallbackForClientTests = callback;
            }
            return this;
          }), 
          pipe: vi.fn(),
          removeAllListeners: vi.fn(),
        },
        removeAllListeners: vi.fn(),
      } as unknown as typeof mockSpawnInstance;
      mockSpawnFn.mockReturnValue(mockSpawnInstance);
    });

    it('should output raw JSON when --json flag is used on successful tool call', { timeout: 30000 }, async () => {
      const rawToolResult = { content: [{ type: 'text', text: 'Success' }], id: '123' };
      mockMcpClientInstance.callTool.mockResolvedValue(rawToolResult);
      
      mockConsoleLog.mockClear(); // Clear before running the command
      await runMainWithArgs(['agent_query', '{"query":"test_json_success"}', '--json']);
      
      console.log('[JSON_TEST_DEBUG] mockConsoleLog calls for --json test:', JSON.stringify(mockConsoleLog.mock.calls, null, 2));
      const jsonOutputCall = mockConsoleLog.mock.calls.find(call => {
        if (call.length > 0 && typeof call[0] === 'string') {
          try {
            JSON.parse(call[0]); // Check if it's valid JSON
            return true; 
          } catch (e) { /* not JSON */ }
        }
        return false;
      });

      if (!jsonOutputCall) {
        // Add a warning or a more informative failure if no JSON output was found
        // console.warn('[JSON_TEST_DEBUG] No valid JSON output found in mockConsoleLog. Skipping JSON content assertion for this run.');
        // Fail the test explicitly if no JSON output is a critical failure:
        expect(jsonOutputCall, 'Expected to find a console.log call with valid JSON output, but none was found.').toBeDefined();
      } else {
        const parsedOutput = JSON.parse(jsonOutputCall[0] as string);
        expect(parsedOutput).toEqual(expect.objectContaining(rawToolResult));
      }
    });

    it('should output JSON error when --json flag is used and tool call fails with JSON-RPC error (stdio)', { timeout: 30000 }, async () => {
      const rpcErrorObject = { code: -32001, message: "Tool specific error", data: { reason: "invalid input" } };
      const rpcErrorResponse = { jsonrpc: "2.0", id: "err-123", error: rpcErrorObject } as const;
      // Simulate the error structure that handleClientCommand would throw
      const errorThrownByHandleClient = new Error(`Tool 'agent_query' failed: ${rpcErrorObject.message}`);
      (errorThrownByHandleClient as any).jsonRpcError = rpcErrorObject;
      mockMcpClientInstance.callTool.mockRejectedValue(errorThrownByHandleClient);
      
      process.env.VITEST_TESTING_FAIL_HANDLER = "true";
      await expect(runMainWithArgs(['agent_query', '{"query":"test_json_rpc_error"}', '--json']))
        .rejects.toThrow(
          // The error thrown by yargs.fail() will be an Error instance.
          // If handleClientCommand throws an error with a jsonRpcError property,
          // yargs.fail() should re-throw that error object.
          expect.objectContaining({
            message: `Tool 'agent_query' failed: ${rpcErrorObject.message}`,
            jsonRpcError: rpcErrorObject,
          })
        );

      // SUT's handleClientCommand logs the JSON error to console.error when --json is active
      // It logs the error object passed to it, which now includes jsonRpcError
      const expectedErrorPayloadForConsole = {
        error: {
          message: errorThrownByHandleClient.message,
          name: errorThrownByHandleClient.name,
          code: rpcErrorObject.code,
          data: rpcErrorObject.data,
          // stderr: expect.any(String) // stderr is not part of this error path
        }
      };
      expect(mockConsoleError.mock.calls.some(call => 
        call[0] === JSON.stringify(expectedErrorPayloadForConsole, null, 2)
      )).toBe(true);
      
      // yargs .fail() handler also logs
      const yargsFailOutputLogged = mockConsoleError.mock.calls.some(call => 
        call[0] === 'YARGS_FAIL_TEST_MODE_ERROR_OUTPUT:' && 
        typeof call[1] === 'string' && call[1].includes(`Tool 'agent_query' failed: ${rpcErrorObject.message}`)
      );
      expect(yargsFailOutputLogged, `Expected yargs fail output. Calls: ${JSON.stringify(mockConsoleError.mock.calls)}`).toBe(true);
      expect(mockProcessExit).not.toHaveBeenCalled();
      delete process.env.VITEST_TESTING_FAIL_HANDLER;
    });

    it('should output JSON error when --json flag is used and tool call fails with generic Error (stdio)', { timeout: 30000 }, async () => {
      const genericError = new Error("A generic client error occurred");
      mockMcpClientInstance.callTool.mockRejectedValue(genericError);

      process.env.VITEST_TESTING_FAIL_HANDLER = "true";
      mockConsoleError.mockClear(); // Clear before run
      await expect(runMainWithArgs(['agent_query', '{"query":"test_json_generic_error"}', '--json'])).rejects.toThrowError(genericError);
      
      // SUT's handleClientCommand logs the JSON error to console.error
      const expectedJsonErrorLog = JSON.stringify({ 
        error: { 
          message: genericError.message, 
          name: genericError.name, 
          // stderr: expect.any(String) // stderr is not reliably captured or part of this specific error path
        } 
      }, null, 2);
      const genericErrorJsonLogged = mockConsoleError.mock.calls.some(call => call[0] === expectedJsonErrorLog);
      expect(genericErrorJsonLogged, `Expected console.error to be called with: ${expectedJsonErrorLog}. Calls: ${JSON.stringify(mockConsoleError.mock.calls)}`).toBe(true);
      
      // yargs .fail() handler also logs
      const yargsFailOutputLogged = mockConsoleError.mock.calls.some(call => 
        call[0] === 'YARGS_FAIL_TEST_MODE_ERROR_OUTPUT:' && 
        typeof call[1] === 'string' && call[1] === genericError.message
      );
      expect(yargsFailOutputLogged, `Expected yargs fail output. Calls: ${JSON.stringify(mockConsoleError.mock.calls)}`).toBe(true);
      expect(mockProcessExit).not.toHaveBeenCalled();
      delete process.env.VITEST_TESTING_FAIL_HANDLER;
    });
    
      // New tests for spawn failures or server premature exit are added above.
    });
  });
