import path from 'path';
import { describe, it, expect, vi, beforeEach, afterEach, type Mock, type MockInstance } from 'vitest';
import { StdioClientTransport as ActualStdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'; // Import for vi.mocked
import { Client as ActualMcpClient } from '@modelcontextprotocol/sdk/client/index.js'; // Import for vi.mocked
// yargs is not directly imported here as we are testing its invocation via index.ts's main
// Pre-calculate the path for the mock for dist/lib/server.js
const distLibServerPath = path.resolve(__dirname, '../../../dist/lib/server.js');

import fs from 'fs'; // For mocking fs in changelog test

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
    close: vi.fn(), // Ensure the transport instance has a close method
  })),
}));

// Store the original configService mock structure to reset it
const originalMockConfigServiceInstance = { HTTP_PORT: 0, AGENT_QUERY_TIMEOUT: 180000, /* other relevant defaults, use 0 for HTTP_PORT in tests */ };
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
    super(message); // Pass message to the base Error constructor
    this.name = "ServerStartupError"; // Set the name of the error
    this.exitCode = exitCode;
    this.originalError = options?.originalError;
    this.existingServerStatus = options?.existingServerStatus;
    this.requestedPort = options?.requestedPort;
    this.detectedServerPort = options?.detectedServerPort;
  }
};

// Mock the compiled path that dist/index.js will require
vi.mock(distLibServerPath, () => ({
  startServer: mockStartServer,
  startProxyServer: mockStartProxyServer, // Add mock for startProxyServer
  ServerStartupError: ServerStartupError, // Use the class defined in the test
}));
// --- End Mocks ---

// REMOVE the top-level vi.mock('../lib/server.js', ...)
// The mock for server.js will be handled by vi.doMock within runMainWithArgs

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
    const resolvedSUTLibPath = path.join(SUT_distPath, 'lib'); // Path to SUT's lib dir
    
    vi.doMock(path.join(resolvedSUTLibPath, 'config-service.js'), () => ({
      configService: currentMockConfigServiceInstance, 
      logger: currentMockLoggerInstance,             
    }));
    vi.doMock('@modelcontextprotocol/sdk/client/index.js', () => ({
      Client: vi.fn().mockImplementation(() => mockMcpClientInstance),
    }));
    vi.doMock('@modelcontextprotocol/sdk/client/streamableHttp.js', () => ({ // Keep for now if any test path uses it
      StreamableHTTPClientTransport: vi.fn(),
    }));
    vi.doMock('@modelcontextprotocol/sdk/client/stdio.js', () => ({ // Add mock for stdio transport
      StdioClientTransport: vi.fn().mockImplementation(() => ({ close: vi.fn() })),
    }));
    
    // The top-level vi.mock for dist/lib/server.js should now apply.
    // No need for vi.doMock for server.js here.
    await import(indexPath); 

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
      actualStderrDataCallbackForClientTests = null; // Reset for each test
      mockSpawnedProcessExitCallbackForClientTests = null;
      mockSpawnedProcessErrorCallbackForClientTests = null;
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

      expect(vi.mocked(ActualStdioClientTransport)).toHaveBeenCalledWith(
        expect.objectContaining({
          command: process.execPath,
          args: [
            expect.stringContaining('index.js'), // Path to dist/index.js
            'start',
            '.', // Default repoPath
            '--port', '0', // Client-spawned servers use dynamic utility port
          ],
          env: expect.objectContaining({
            HTTP_PORT: '0', // Client-spawned servers use dynamic utility port
          }),
        })
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

      expect(vi.mocked(ActualStdioClientTransport)).toHaveBeenCalledWith(
        expect.objectContaining({
          command: process.execPath,
          args: [
            expect.stringContaining('index.js'),
            'start',
            repoPath, // Custom repoPath
            '--port', '0',
          ],
          env: expect.objectContaining({
            HTTP_PORT: '0',
          }),
        })
      );
      expect(mockMcpClientInstance.callTool).toHaveBeenCalledWith({ name: 'agent_query', arguments: { query: 'test_repo' } });
      expect(mockMcpClientInstance.close).toHaveBeenCalled();
    });


    it('should handle client command failure (spawn error) and log via yargs .fail()', async () => {
      const spawnError = new Error("Failed to spawn");
      // To simulate spawn error, we need to make the StdioClientTransport constructor or its connect method throw.
      // A more direct way: mock StdioClientTransport's connect to reject.
      vi.mocked(ActualStdioClientTransport).mockImplementation(() => ({ connect: vi.fn().mockRejectedValue(spawnError) } as any));
      process.env.VITEST_TESTING_FAIL_HANDLER = "true";
      await runMainWithArgs(['agent_query', '{"query":"test_spawn_fail"}']);
      
      expect(currentMockLoggerInstance.error).toHaveBeenCalledWith('CLI Error (yargs.fail):', spawnError);
      expect(mockProcessExit).toHaveBeenCalledWith(1);
      delete process.env.VITEST_TESTING_FAIL_HANDLER;
    });

    it('should handle client command failure (server process premature exit) and log via yargs .fail()', async () => {
      // Simulate premature exit by having client.connect() reject with a specific error.
      // StdioClientTransport might internally handle this and surface it as a connection error.
      const prematureExitError = new Error("Server process exited prematurely");
      vi.mocked(ActualStdioClientTransport).mockImplementation(() => ({ connect: vi.fn().mockRejectedValue(prematureExitError) } as any));
      process.env.VITEST_TESTING_FAIL_HANDLER = "true";
      // No need to wait for simulateServerReady if server exits prematurely
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
      // StdioClientTransport might still be constructed, but connect or callTool should fail.
      expect(mockConsoleError).toHaveBeenCalledWith(expect.stringContaining("Invalid JSON parameters for tool 'agent_query'"));
      expect(currentMockLoggerInstance.error).toHaveBeenCalledWith('CLI Error (yargs.fail):', expect.objectContaining({ message: expect.stringContaining('Invalid JSON parameters') }));
      expect(mockProcessExit).toHaveBeenCalledWith(1);
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

    it('--port option should set HTTP_PORT environment variable for spawned server', { timeout: 30000 }, async () => {
      const customPort = 1234;
      await runMainWithArgs(['--port', String(customPort), 'agent_query', '{"query":"test_port_option"}']);

      expect(process.env.HTTP_PORT).toBe(String(customPort)); 
      expect(vi.mocked(ActualStdioClientTransport)).toHaveBeenCalledWith(
        expect.objectContaining({
          command: process.execPath,
          args: [
            expect.stringContaining('index.js'),
            'start',
            '.', // Default repoPath
            '--port', '0', // Client-spawned server still uses port '0' in args
          ],
          env: expect.objectContaining({
            // The parent process.env.HTTP_PORT is customPort,
            // but serverProcessParams.env explicitly sets HTTP_PORT: '0' for the child.
            HTTP_PORT: '0',
          }),
        })
      );
      expect(mockMcpClientInstance.callTool).toHaveBeenCalledWith({ name: 'agent_query', arguments: { query: 'test_port_option' } });
      expect(mockConsoleLog).toHaveBeenCalledWith('Tool call success');
    });

    it('--repo option should be used by startServerHandler', async () => {
      await runMainWithArgs(['start', '--repo', '/custom/repo/for/start']);
      expect(mockStartServer).toHaveBeenCalledWith('/custom/repo/for/start');
    });
    
    it('--repo option should be used by client stdio command for spawned server', { timeout: 30000 }, async () => {
      const repoPath = '/my/client/repo';
      await runMainWithArgs(['agent_query', '{"query":"test_repo_opt"}', '--repo', repoPath]);
      
      expect(vi.mocked(ActualStdioClientTransport)).toHaveBeenCalledWith(
        expect.objectContaining({
          command: process.execPath,
          args: [
            expect.stringContaining('index.js'),
            'start',
            repoPath, // Custom repoPath from --repo
            '--port', '0',
          ],
          env: expect.objectContaining({
            HTTP_PORT: '0',
          }),
        })
      );
    });


    it('--version option should display version and exit', async () => {
      await runMainWithArgs(['--version']);
      expect(mockConsoleLog).toHaveBeenCalledWith(expect.stringMatching(/\d+\.\d+\.\d+/)); 
      expect(mockProcessExit).toHaveBeenCalledWith(0);
    });

    it('--help option should display help and exit', async () => {
      await runMainWithArgs(['--help']);
      expect(mockConsoleLog).toHaveBeenCalledWith(expect.stringContaining("Commands:"));
      expect(mockConsoleLog).toHaveBeenCalledWith(expect.stringContaining("codecompass start [repoPath]"));
      expect(mockConsoleLog).toHaveBeenCalledWith(expect.stringContaining("Options:"));
      expect(mockConsoleLog).toHaveBeenCalledWith(expect.stringContaining("--help"));
      expect(mockConsoleLog).toHaveBeenCalledWith(expect.stringContaining("--port"));
      expect(mockProcessExit).toHaveBeenCalledWith(0);
    });
  });
  
  describe('Changelog Command', () => {
    it('should display changelog', async () => {
      vi.mocked(fs.statSync).mockReturnValue({ mtimeMs: Date.now() } as fs.Stats);
      vi.mocked(fs.readFileSync).mockReturnValue('## Test Changelog Content');
      
      await runMainWithArgs(['changelog']);
      expect(fs.readFileSync).toHaveBeenCalledWith(expect.stringContaining('CHANGELOG.md'), 'utf8');
      expect(mockConsoleLog).toHaveBeenCalledWith(expect.stringContaining('## Test Changelog Content'));
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
      expect(mockConsoleError).toHaveBeenCalledWith(expect.stringContaining("Unknown argument"));
      expect(currentMockLoggerInstance.error).toHaveBeenCalledWith('CLI Usage Error (yargs.fail):', expect.stringContaining("Unknown argument"));
      expect(mockProcessExit).toHaveBeenCalledWith(1);
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
      
      await runMainWithArgs(['agent_query', '{"query":"test_json_success"}', '--json']);
      
      expect(mockConsoleLog).toHaveBeenCalledWith(JSON.stringify(rawToolResult, null, 2));
    });

    it('should output JSON error when --json flag is used and tool call fails with JSON-RPC error (stdio)', { timeout: 30000 }, async () => {
      const rpcError = { jsonrpc: "2.0", id: "err-123", error: { code: -32001, message: "Tool specific error", data: { reason: "invalid input" } } } as const;
      mockMcpClientInstance.callTool.mockRejectedValue(rpcError);
      
      process.env.VITEST_TESTING_FAIL_HANDLER = "true";
      await runMainWithArgs(['agent_query', '{"query":"test_json_rpc_error"}', '--json']);

      expect(mockConsoleError).toHaveBeenCalledWith(JSON.stringify(rpcError, null, 2));
      expect(mockProcessExit).toHaveBeenCalledWith(1);
      delete process.env.VITEST_TESTING_FAIL_HANDLER;
    });

    it('should output JSON error when --json flag is used and tool call fails with generic Error (stdio)', { timeout: 30000 }, async () => {
      const genericError = new Error("A generic client error occurred");
      mockMcpClientInstance.callTool.mockRejectedValue(genericError);

      process.env.VITEST_TESTING_FAIL_HANDLER = "true";
      await runMainWithArgs(['agent_query', '{"query":"test_json_generic_error"}', '--json']);
      
      expect(mockConsoleError).toHaveBeenCalledWith(JSON.stringify({ error: { message: genericError.message, name: genericError.name } }, null, 2));
      expect(mockProcessExit).toHaveBeenCalledWith(1);
      delete process.env.VITEST_TESTING_FAIL_HANDLER;
    });
    
    // New tests for spawn failures or server premature exit are added above.
  });
});
