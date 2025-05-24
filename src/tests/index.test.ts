import path from 'path';
import { describe, it, expect, vi, beforeEach, afterEach, type Mock, type MockInstance } from 'vitest';
// yargs is not directly imported here as we are testing its invocation via index.ts's main
import fs from 'fs'; // For mocking fs in changelog test

// --- Mocks for modules dynamically required by index.ts handlers ---
// axios mock removed as it's no longer directly used by handleClientCommand's primary path

// Mock fs for changelog command - ensure it's correctly structured
vi.mock('fs', () => {
  const mockFsFunctionsInFactory = {
    statSync: vi.fn(),
    readFileSync: vi.fn(),
    // Add any other fs functions if index.ts uses them, e.g. existsSync
    // For changelog, only statSync and readFileSync are directly used by displayChangelog
  };
  return {
    default: mockFsFunctionsInFactory,
    ...mockFsFunctionsInFactory, // Also make them available at the root for easier test access if needed
  };
});

vi.mock('child_process', async () => {
  const actualCp = await vi.importActual('child_process') as typeof import('child_process');
  return {
    ...actualCp,
    spawn: mockSpawnFn,
  };
});

const mockMcpClientInstance = {
  connect: vi.fn(),
  callTool: vi.fn(),
  close: vi.fn(),
};
vi.mock('@modelcontextprotocol/sdk/client/index.js', () => ({
  Client: vi.fn().mockImplementation(() => mockMcpClientInstance),
}));

vi.mock('@modelcontextprotocol/sdk/client/streamableHttp.js', () => ({
  StreamableHTTPClientTransport: vi.fn(), // This might become StdioClientTransport
}));

vi.mock('@modelcontextprotocol/sdk/client/stdio.js', () => ({ // Mock for StdioClientTransport
  StdioClientTransport: vi.fn().mockImplementation(() => ({
    // Mock methods if needed, e.g., close: vi.fn()
  })),
}));

// Store the original configService mock structure to reset it
const originalMockConfigServiceInstance = { HTTP_PORT: 3001, AGENT_QUERY_TIMEOUT: 180000, /* other relevant defaults */ };
// These will be freshly created in beforeEach for use with vi.doMock
let currentMockConfigServiceInstance: typeof originalMockConfigServiceInstance;
let currentMockLoggerInstance: {
  info: Mock; warn: Mock; error: Mock; debug: Mock;
};


const mockStartServer = vi.fn();
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
vi.mock('../lib/server.js', () => ({
  startServer: mockStartServer,
  startProxyServer: mockStartProxyServer, // Add mock for startProxyServer
  ServerStartupError: ServerStartupError, // Use the class defined in the test
}));
// --- End Mocks ---

import type { ChildProcess } from 'child_process'; // Ensure this is imported if not already

const mockSpawnFn = vi.fn();

let mockProcessExit: MockInstance<typeof process.exit>;
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
    mockProcessExit = vi.spyOn(process, 'exit').mockImplementation(vi.fn() as unknown as typeof process.exit);
    mockConsoleLog = vi.spyOn(console, 'log').mockImplementation(vi.fn());
    mockConsoleError = vi.spyOn(console, 'error').mockImplementation(vi.fn());
        
    // Reset the mutable mockConfigServiceInstance to its original state by creating fresh copies
    currentMockConfigServiceInstance = { ...originalMockConfigServiceInstance };
    currentMockLoggerInstance = {
      info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(),
    };
    // Reset other top-level mocks that might be stateful
    mockStartServer.mockReset().mockResolvedValue(undefined);
    mockStartProxyServer.mockReset().mockResolvedValue(undefined);
    // mockAxiosGet reset removed as it's no longer the primary path for client commands
    mockMcpClientInstance.callTool.mockReset().mockResolvedValue({ content: [{ type: 'text', text: 'Tool call success' }] });
    mockMcpClientInstance.connect.mockReset().mockResolvedValue(undefined);
    mockMcpClientInstance.close.mockReset().mockResolvedValue(undefined);
    
    delete process.env.HTTP_PORT;
  });

  afterEach(() => {
    process.env = originalProcessEnv;
    process.argv = originalArgv;
    vi.restoreAllMocks();
  });
    
  async function runMainWithArgs(args: string[]) {
    const indexPath = require.resolve('../../dist/index.js'); // Define indexPath first
    process.argv = ['node', indexPath, ...args]; // Use absolute indexPath here
    vi.resetModules(); 
      
    // Dynamically resolve paths as src/index.ts would
    // const indexPath = require.resolve('../../dist/index.js'); // This line is now effectively moved up
    const SUT_distPath = path.dirname(indexPath); 
    const resolvedSUTLibPath = path.join(SUT_distPath, 'lib'); 
    
    vi.doMock(path.join(resolvedSUTLibPath, 'config-service.js'), () => ({
      configService: currentMockConfigServiceInstance, 
      logger: currentMockLoggerInstance,             
    }));
    vi.doMock(path.join(resolvedSUTLibPath, 'server.js'), () => ({
      startServer: mockStartServer,
      startProxyServer: mockStartProxyServer,
      ServerStartupError: ServerStartupError,
    }));
    vi.doMock('@modelcontextprotocol/sdk/client/index.js', () => ({
      Client: vi.fn().mockImplementation(() => mockMcpClientInstance),
    }));
    vi.doMock('@modelcontextprotocol/sdk/client/streamableHttp.js', () => ({ // Keep for now if any test path uses it
      StreamableHTTPClientTransport: vi.fn(),
    }));
    vi.doMock('@modelcontextprotocol/sdk/client/stdio.js', () => ({ // Add mock for stdio transport
      StdioClientTransport: vi.fn().mockImplementation(() => ({ /* mock transport methods if needed */ })),
    }));
    
    await import(indexPath); 

    // The following block (const declarations, vi.doMock calls, and the second await import) was duplicated and is removed.
    // // Dynamically resolve paths as src/index.ts would
    // // require.resolve needs a path that exists relative to this test file to find index.js
    // // Assuming index.js is in dist/ and tests are in dist/tests/
    // // If src/index.ts is run directly (e.g. via ts-node for tests), then '../index.js' might point to src/index.js
    // // Let's assume the compiled output structure where index.js is at a level accessible via '../index.js' from 'dist/tests/index.js'
    // // And 'lib' is a sibling to 'index.js'
    // // const indexPath = require.resolve('../index.js'); // Get absolute path to index.js
    // // const SUT_distPath = path.dirname(indexPath); // Get directory of index.js (e.g., /path/to/project/dist)
    // // const resolvedSUTLibPath = path.join(SUT_distPath, 'lib'); // Path to SUT's lib dir

    // // vi.doMock(path.join(resolvedSUTLibPath, 'config-service.js'), () => ({
    // //   configService: currentMockConfigServiceInstance, // Use the current, fresh mock
    // //   logger: currentMockLoggerInstance,             // Use the current, fresh mock
    // // }));
    // // vi.doMock(path.join(resolvedSUTLibPath, 'server.js'), () => ({
    // //   startServer: mockStartServer,
    // //   startProxyServer: mockStartProxyServer,
    // //   ServerStartupError: ServerStartupError,
    // // }));
    // // // Mock SDK client components that are dynamically required in handleClientCommand
    // // vi.doMock('@modelcontextprotocol/sdk/client/index.js', () => ({
    // //   Client: vi.fn().mockImplementation(() => mockMcpClientInstance),
    // // }));
    // // vi.doMock('@modelcontextprotocol/sdk/client/streamableHttp.js', () => ({
    // //   StreamableHTTPClientTransport: vi.fn(),
    // // }));

    // // // Importing src/index.js executes main() at its end.
    // // // No need to destructure or call main explicitly if it's not exported.
    // // await import('../index.js'); 
    // Yargs fail handler might call process.exit. We catch errors from parseAsync
    // to allow assertions on console.error or logger.error before process.exit is checked.
    try {
      // await main(); // main() is not exported and is self-executing on import. This call is incorrect.
    } catch (e) {
      // Suppress errors thrown by handlers if yargs .fail() is expected to catch them
      // This allows tests to assert on console/logger output from .fail()
      // console.warn("Error caught during runMainWithArgs:", e);
    }
  }

  describe('Server Start Command (default and "start")', () => {
    it('should call startServerHandler with default repoPath when no args', async () => {
      await runMainWithArgs([]);
      expect(mockStartServer).toHaveBeenCalledWith('.');
      // Successful promise resolution from handler implies yargs exits 0
    });

    it('should call startServerHandler with specified repoPath for default command', async () => {
      await runMainWithArgs(['/my/repo']);
      expect(mockStartServer).toHaveBeenCalledWith('/my/repo');
    });

    it('should call startServerHandler with specified repoPath from --repo global option for default command if no positional', async () => {
      await runMainWithArgs(['--repo', '/global/repo']);
      expect(mockStartServer).toHaveBeenCalledWith('/global/repo');
    });
    
    it('should call startServerHandler with specified repoPath for "start" command (positional)', async () => {
      await runMainWithArgs(['start', '/my/repo/path']);
      expect(mockStartServer).toHaveBeenCalledWith('/my/repo/path');
    });

    it('should call startServerHandler with repoPath from --repo for "start" command if no positional', async () => {
      await runMainWithArgs(['start', '--repo', '/global/start/repo']);
      expect(mockStartServer).toHaveBeenCalledWith('/global/start/repo');
    });

    it('should handle startServer failure (fatal error, exitCode 1) and log via yargs .fail()', async () => {
      const startupError = new ServerStartupError("Server failed to boot with fatal error", 1);
      mockStartServer.mockRejectedValue(startupError);
      process.env.VITEST_TESTING_FAIL_HANDLER = "true"; 
      await runMainWithArgs(['start']);
      expect(currentMockLoggerInstance.error).toHaveBeenCalledWith('CLI Error (yargs.fail):', expect.objectContaining({ message: "Server failed to boot with fatal error" }));
      expect(mockProcessExit).toHaveBeenCalledWith(1);
      delete process.env.VITEST_TESTING_FAIL_HANDLER;
    });

    // Removed test for startProxyServer as startServerHandler no longer calls it.
    // If startServer resolves (even with utility server disabled), it's a success for startServerHandler.
    // If startServer rejects, it's a fatal error (exitCode 1), handled by the test above.
  });

  describe('Client Tool Commands (stdio based)', () => {
    beforeEach(() => {
      // Initialize mockSpawnInstance (it's declared at a higher scope)
      mockSpawnInstance = {
        on: vi.fn((event, cb) => {
          if (event === 'error' || event === 'exit') { /* store cb if needed */ }
          return mockSpawnInstance;
        }),
        kill: vi.fn(),
        pid: 12345,
        stdin: { write: vi.fn(), end: vi.fn(), on: vi.fn() },
        stdout: { on: vi.fn(), pipe: vi.fn(), unpipe: vi.fn(), resume: vi.fn() },
        stderr: { on: vi.fn(), pipe: vi.fn() },
      };
      mockSpawnFn.mockReturnValue(mockSpawnInstance); // Configure the mock function

      // Simulate server ready message on stderr
      vi.mocked(mockSpawnInstance.stderr.on).mockImplementation((event, callback) => {
        if (event === 'data') {
          // Store callback if needed for manual triggering in tests
          // The original comment about simulating server ready message can remain.
        }
        return mockSpawnInstance.stderr;
      });
    });

    it('should spawn server and call tool via stdio for "agent_query"', { timeout: 30000 }, async () => {
      // Simulate server ready message
      mockSpawnInstance.on.mockImplementation((event, cb) => {
        if (event === 'exit') { /* store cb */ }
        if (event === 'error') { /* store cb */ }
        // Simulate server becoming ready shortly after spawn
        // This is a common pattern: the 'data' event on stderr might signal readiness
        if (mockSpawnInstance.stderr && mockSpawnInstance.stderr.on) {
            mockSpawnInstance.stderr.on('data', (dataCb) => {
                // Simulate the server sending its "ready" message
                const readyMessage = Buffer.from("CodeCompass v0.0.0 ready. MCP active on stdio.");
                // This callback is for data *from* stderr, not for registering a listener.
                // The test needs to ensure the 'data' listener in SUT gets called.
                // This mock setup is getting complex. Let's simplify.
                // The SUT's stderr 'data' handler will set serverReady.
                // We just need to make sure that handler is called.
                // The test can manually trigger the 'data' event on the mock stderr.
            });
        }
        return mockSpawnInstance;
      });
      // Manually trigger server ready state for the test's promise to resolve
      // This is a bit of a hack; ideally, the SUT's internal promise resolves based on actual events.
      // For now, let the 10s timeout in SUT handle it, or make the mock smarter.
      // A better way: make the mock `on('data', ...)` call the SUT's callback.
      // The SUT's `child.stderr?.on('data', (data: Buffer) => { ... serverReady = true ... });`
      // So, when `mockSpawnInstance.stderr.on('data', SUT_callback)` is called, we store SUT_callback.
      // Then in the test, we call `SUT_callback(Buffer.from("...MCP active on stdio..."))`.
      let stderrDataCallback: ((data: Buffer) => void) | undefined;
      vi.mocked(mockSpawnInstance.stderr.on).mockImplementation((event, callback) => {
        if (event === 'data') stderrDataCallback = callback;
        return mockSpawnInstance.stderr;
      });


      await runMainWithArgs(['agent_query', '{"query":"test_stdio"}']);
      
      // Poll for stderrDataCallback to be set by the SUT
      let attempts = 0;
      while (!stderrDataCallback && attempts < 100) { // Poll for up to 10 seconds (100 * 100ms)
          await new Promise(resolve => setTimeout(resolve, 100));
          attempts++;
      }

      // Simulate the server sending its ready message on stderr
      if (stderrDataCallback) {
        stderrDataCallback(Buffer.from("CodeCompass v0.0.0 ready. MCP active on stdio."));
      } else {
        throw new Error("stderr 'data' listener not attached by SUT (timed out polling)");
      }
      
      // Wait for async operations within handleClientCommand to complete
      await new Promise(resolve => setTimeout(resolve, 3000)); // Increased from 500ms


      // const { spawn } = require('child_process'); // Not needed
      expect(mockSpawnFn).toHaveBeenCalledWith(
        process.execPath, // node
        [process.argv[1], 'start', '.', '--port', String(currentMockConfigServiceInstance.HTTP_PORT)], // script, start, repoPath, --port
        expect.anything()
      );
      expect(mockMcpClientInstance.callTool).toHaveBeenCalledWith({ name: 'agent_query', arguments: { query: 'test_stdio' } });
      expect(mockConsoleLog).toHaveBeenCalledWith('Tool call success');
      expect(mockSpawnInstance.kill).toHaveBeenCalled();
    });
    
    it('should use --repo path for spawned server in client stdio mode', { timeout: 30000 }, async () => {
      let stderrDataCallback: ((data: Buffer) => void) | undefined;
      vi.mocked(mockSpawnInstance.stderr.on).mockImplementation((event, callback) => {
        if (event === 'data') stderrDataCallback = callback;
        return mockSpawnInstance.stderr;
      });

      await runMainWithArgs(['agent_query', '{"query":"test_repo"}', '--repo', '/custom/path']);
      
      let attempts = 0;
      while (!stderrDataCallback && attempts < 100) {
          await new Promise(resolve => setTimeout(resolve, 100));
          attempts++;
      }
      
      if (stderrDataCallback) stderrDataCallback(Buffer.from("MCP active on stdio"));
      else throw new Error("stderr 'data' listener not attached (timed out polling)");
      
      await new Promise(resolve => setTimeout(resolve, 3000)); // Increased


      // const { spawn } = require('child_process'); // Not needed
      expect(mockSpawnFn).toHaveBeenCalledWith(
        process.execPath,
        [process.argv[1], 'start', '/custom/path', '--port', String(currentMockConfigServiceInstance.HTTP_PORT)],
        expect.anything()
      );
      expect(mockMcpClientInstance.callTool).toHaveBeenCalledWith({ name: 'agent_query', arguments: { query: 'test_repo' } });
    });


    it('should handle client command failure (spawn error) and log via yargs .fail()', async () => {
      const spawnError = new Error("Failed to spawn");
      // const { spawn } = require('child_process'); // Not needed
      vi.mocked(mockSpawnFn).mockImplementation(() => { throw spawnError; }); // Use mockSpawnFn

      process.env.VITEST_TESTING_FAIL_HANDLER = "true";
      await runMainWithArgs(['agent_query', '{"query":"test_spawn_fail"}']);
      
      expect(currentMockLoggerInstance.error).toHaveBeenCalledWith('CLI Error (yargs.fail):', spawnError);
      expect(mockProcessExit).toHaveBeenCalledWith(1);
      delete process.env.VITEST_TESTING_FAIL_HANDLER;
    });

    it('should handle client command failure (server process premature exit) and log via yargs .fail()', async () => {
      mockSpawnInstance.on.mockImplementation((event, cb) => {
        if (event === 'exit') {
          // Simulate premature exit with error code
          (cb as (code: number | null, signal: string | null) => void)(1, null);
        }
        return mockSpawnInstance;
      });
      
      process.env.VITEST_TESTING_FAIL_HANDLER = "true";
      await runMainWithArgs(['agent_query', '{"query":"test_server_exit"}']);
      
      expect(currentMockLoggerInstance.error).toHaveBeenCalledWith('CLI Error (yargs.fail):', 
        expect.objectContaining({ message: expect.stringContaining("Server process exited prematurely") })
      );
      expect(mockProcessExit).toHaveBeenCalledWith(1);
      delete process.env.VITEST_TESTING_FAIL_HANDLER;
    });


    it('should handle invalid JSON parameters for client command (stdio) and log via yargs .fail()', async () => {
      process.env.VITEST_TESTING_FAIL_HANDLER = "true";
      await runMainWithArgs(['agent_query', '{"query": "test"']); // Invalid JSON
      // Spawn won't happen if JSON is invalid before that
      // const { spawn } = require('child_process'); // Not needed
      expect(mockSpawnFn).not.toHaveBeenCalled(); 
      expect(mockConsoleError).toHaveBeenCalledWith(expect.stringContaining("Invalid JSON parameters for tool 'agent_query'"));
      expect(currentMockLoggerInstance.error).toHaveBeenCalledWith('CLI Error (yargs.fail):', expect.objectContaining({ message: expect.stringContaining('Invalid JSON parameters') }));
      expect(mockProcessExit).toHaveBeenCalledWith(1);
      delete process.env.VITEST_TESTING_FAIL_HANDLER;
    });
  });

  describe('Global Options', () => {
    beforeEach(() => {
      // Initialize mockSpawnInstance if tests in this suite need it
      mockSpawnInstance = {
        on: vi.fn((event, cb) => {
          if (event === 'error' || event === 'exit') { /* store cb if needed */ }
          return mockSpawnInstance;
        }),
        kill: vi.fn(),
        pid: 12345,
        stdin: { write: vi.fn(), end: vi.fn(), on: vi.fn() },
        stdout: { on: vi.fn(), pipe: vi.fn(), unpipe: vi.fn(), resume: vi.fn() },
        stderr: { on: vi.fn(), pipe: vi.fn() },
      };
      mockSpawnFn.mockReturnValue(mockSpawnInstance);
    });

    it('--port option should set HTTP_PORT environment variable for spawned server', { timeout: 30000 }, async () => {
      const customPort = 1234;
      let stderrDataCallback: ((data: Buffer) => void) | undefined;
      vi.mocked(mockSpawnInstance.stderr.on).mockImplementation((event, callback) => {
        if (event === 'data') stderrDataCallback = callback;
        return mockSpawnInstance.stderr;
      });
      
      await runMainWithArgs(['--port', String(customPort), 'agent_query', '{"query":"test_port_option"}']);
      
      let attempts = 0;
      while (!stderrDataCallback && attempts < 100) {
          await new Promise(resolve => setTimeout(resolve, 100));
          attempts++;
      }

      if (stderrDataCallback) stderrDataCallback(Buffer.from("MCP active on stdio"));
      else throw new Error("stderr 'data' listener not attached for port test (timed out polling)");
      
      await new Promise(resolve => setTimeout(resolve, 3000)); // Increased

      expect(process.env.HTTP_PORT).toBe(String(customPort)); // Parent process.env is set by yargs
      // const { spawn } = require('child_process'); // Not needed
      expect(mockSpawnFn).toHaveBeenCalledWith(
        process.execPath,
        [process.argv[1], 'start', '.', '--port', String(customPort)], // Child gets --port
        expect.anything()
      );
      expect(mockConsoleLog).toHaveBeenCalledWith('Tool call success');
    });

    it('--repo option should be used by startServerHandler', async () => {
      await runMainWithArgs(['start', '--repo', '/custom/repo/for/start']);
      expect(mockStartServer).toHaveBeenCalledWith('/custom/repo/for/start');
    });
    
    it('--repo option should be used by client stdio command for spawned server', { timeout: 30000 }, async () => {
      let stderrDataCallback: ((data: Buffer) => void) | undefined;
      vi.mocked(mockSpawnInstance.stderr.on).mockImplementation((event, callback) => {
        if (event === 'data') stderrDataCallback = callback;
        return mockSpawnInstance.stderr;
      });

      await runMainWithArgs(['agent_query', '{"query":"test_repo_opt"}', '--repo', '/my/client/repo']);

      let attempts = 0;
      while (!stderrDataCallback && attempts < 100) {
          await new Promise(resolve => setTimeout(resolve, 100));
          attempts++;
      }

      if (stderrDataCallback) stderrDataCallback(Buffer.from("MCP active on stdio"));
      else throw new Error("stderr 'data' listener not attached for repo option test (timed out polling)");
      
      await new Promise(resolve => setTimeout(resolve, 3000)); // Increased
      
      // const { spawn } = require('child_process'); // Not needed
      expect(mockSpawnFn).toHaveBeenCalledWith(
        process.execPath,
        [process.argv[1], 'start', '/my/client/repo', '--port', String(currentMockConfigServiceInstance.HTTP_PORT)],
        expect.anything()
      );
    });


    it('--version option should display version and exit', async () => {
      // Yargs handles --version and exits 0. No .fail() involvement.
      await runMainWithArgs(['--version']);
      expect(mockConsoleLog).toHaveBeenCalledWith(expect.stringMatching(/\d+\.\d+\.\d+/)); // Version string like x.y.z
      expect(mockProcessExit).toHaveBeenCalledWith(0);
    });

    it('--help option should display help and exit', async () => {
      // Yargs handles --help and exits 0. No .fail() involvement.
      await runMainWithArgs(['--help']);
      // The scriptName is set to "codecompass", so help output should reflect that.
      // Yargs typically shows "Usage: <scriptName> [command]"
      expect(mockConsoleLog).toHaveBeenCalledWith(expect.stringContaining("Usage: codecompass [repoPath]"));
      expect(mockProcessExit).toHaveBeenCalledWith(0);
    });
  });
  
  describe('Changelog Command', () => {
    it('should display changelog', async () => {
      // Ensure fs.statSync and fs.readFileSync are properly mocked via the vi.mock('fs',...) at the top
      vi.mocked(fs.statSync).mockReturnValue({ mtimeMs: Date.now() } as fs.Stats);
      vi.mocked(fs.readFileSync).mockReturnValue('## Test Changelog Content');
      
      await runMainWithArgs(['changelog']);
      expect(fs.readFileSync).toHaveBeenCalledWith(expect.stringContaining('CHANGELOG.md'), 'utf8');
      expect(mockConsoleLog).toHaveBeenCalledWith(expect.stringContaining('## Test Changelog Content'));
      // For synchronous yargs command handlers that don't throw, yargs exits 0.
      // No explicit process.exit(0) in handler, so yargs default behavior.
      // If yargs doesn't exit, then no call to mockProcessExit.
      // Let's assume yargs handles exit code 0 for success.
    });
  });

  describe('Error Handling and Strict Mode by yargs', () => {
    it('should show error and help for unknown command', async () => {
      process.env.VITEST_TESTING_FAIL_HANDLER = "true";
      await runMainWithArgs(['unknowncommand']);
      expect(mockConsoleError).toHaveBeenCalledWith(expect.stringContaining("Unknown argument: unknowncommand"));
      expect(currentMockLoggerInstance.error).toHaveBeenCalledWith('CLI Usage Error (yargs.fail):', expect.stringContaining("Unknown argument: unknowncommand"));
      expect(mockProcessExit).toHaveBeenCalledWith(1);
      delete process.env.VITEST_TESTING_FAIL_HANDLER;
    });

    it('should show error and help for unknown option', async () => {
      process.env.VITEST_TESTING_FAIL_HANDLER = "true";
      await runMainWithArgs(['--unknown-option']);
      // Yargs might output "Unknown arguments: unknown-option, unknownOption" if it camelCases.
      // Let's make the check more flexible.
      expect(mockConsoleError).toHaveBeenCalledWith(expect.stringContaining("Unknown argument"));
      expect(currentMockLoggerInstance.error).toHaveBeenCalledWith('CLI Usage Error (yargs.fail):', expect.stringContaining("Unknown argument"));
      expect(mockProcessExit).toHaveBeenCalledWith(1);
      delete process.env.VITEST_TESTING_FAIL_HANDLER;
    });
  });

  describe('Client Tool Commands with --json output flag', () => {
    it('should output raw JSON when --json flag is used on successful tool call', { timeout: 30000 }, async () => {
      const rawToolResult = { content: [{ type: 'text', text: 'Success' }], id: '123' };
      mockMcpClientInstance.callTool.mockResolvedValue(rawToolResult);

      let stderrDataCallback: ((data: Buffer) => void) | undefined;
      vi.mocked(mockSpawnInstance.stderr.on).mockImplementation((event, callback) => {
        if (event === 'data') stderrDataCallback = callback;
        return mockSpawnInstance.stderr;
      });
      
      await runMainWithArgs(['agent_query', '{"query":"test_json_success"}', '--json']);

      let attempts = 0;
      while (!stderrDataCallback && attempts < 100) {
          await new Promise(resolve => setTimeout(resolve, 100));
          attempts++;
      }

      if (stderrDataCallback) stderrDataCallback(Buffer.from("MCP active on stdio"));
      else throw new Error("stderr 'data' listener not attached for json success test (timed out polling)");
      
      await new Promise(resolve => setTimeout(resolve, 3000)); // Increased
      
      expect(mockConsoleLog).toHaveBeenCalledWith(JSON.stringify(rawToolResult, null, 2));
    });

    it('should output JSON error when --json flag is used and tool call fails with JSON-RPC error (stdio)', { timeout: 30000 }, async () => {
      const rpcError = { jsonrpc: "2.0", id: "err-123", error: { code: -32001, message: "Tool specific error", data: { reason: "invalid input" } } } as const;
      mockMcpClientInstance.callTool.mockRejectedValue(rpcError);
      
      let stderrDataCallback: ((data: Buffer) => void) | undefined;
      vi.mocked(mockSpawnInstance.stderr.on).mockImplementation((event, callback) => {
        if (event === 'data') stderrDataCallback = callback;
        return mockSpawnInstance.stderr;
      });

      process.env.VITEST_TESTING_FAIL_HANDLER = "true";
      await runMainWithArgs(['agent_query', '{"query":"test_json_rpc_error"}', '--json']);

      let attempts = 0;
      while (!stderrDataCallback && attempts < 100) {
          await new Promise(resolve => setTimeout(resolve, 100));
          attempts++;
      }

      if (stderrDataCallback) stderrDataCallback(Buffer.from("MCP active on stdio"));
      else throw new Error("stderr 'data' listener not attached for json rpc error test (timed out polling)");
      
      await new Promise(resolve => setTimeout(resolve, 3000)); // Increased

      expect(mockConsoleError).toHaveBeenCalledWith(JSON.stringify(rpcError, null, 2));
      expect(mockProcessExit).toHaveBeenCalledWith(1);
      delete process.env.VITEST_TESTING_FAIL_HANDLER;
    });

    it('should output JSON error when --json flag is used and tool call fails with generic Error (stdio)', { timeout: 30000 }, async () => {
      const genericError = new Error("A generic client error occurred");
      mockMcpClientInstance.callTool.mockRejectedValue(genericError);

      let stderrDataCallback: ((data: Buffer) => void) | undefined;
      vi.mocked(mockSpawnInstance.stderr.on).mockImplementation((event, callback) => {
        if (event === 'data') stderrDataCallback = callback;
        return mockSpawnInstance.stderr;
      });

      process.env.VITEST_TESTING_FAIL_HANDLER = "true";
      await runMainWithArgs(['agent_query', '{"query":"test_json_generic_error"}', '--json']);

      let attempts = 0;
      while (!stderrDataCallback && attempts < 100) {
          await new Promise(resolve => setTimeout(resolve, 100));
          attempts++;
      }

      if (stderrDataCallback) stderrDataCallback(Buffer.from("MCP active on stdio"));
      else throw new Error("stderr 'data' listener not attached for json generic error test (timed out polling)");
      
      await new Promise(resolve => setTimeout(resolve, 3000)); // Increased
      
      expect(mockConsoleError).toHaveBeenCalledWith(JSON.stringify({ error: { message: genericError.message, name: genericError.name } }, null, 2));
      expect(mockProcessExit).toHaveBeenCalledWith(1);
      delete process.env.VITEST_TESTING_FAIL_HANDLER;
    });
    
    // Tests for server ping failures are removed as client stdio mode doesn't ping.
    // New tests for spawn failures or server premature exit are added above.
  });
});
