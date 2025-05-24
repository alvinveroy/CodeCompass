import { describe, it, expect, vi, beforeEach, afterEach, type Mock, type MockInstance } from 'vitest';
// yargs is not directly imported here as we are testing its invocation via index.ts's main
import fs from 'fs'; // For mocking fs in changelog test

// --- Mocks for modules dynamically required by index.ts handlers ---
const mockAxiosGet = vi.fn();
vi.mock('axios', () => ({
  default: {
    get: mockAxiosGet,
    isAxiosError: vi.fn((e): e is import('axios').AxiosError => e && typeof e === 'object' && 'isAxiosError' in e && e.isAxiosError === true),
  }
}));

// Mock fs for changelog command - ensure it's correctly structured
vi.mock('fs', () => ({
  // default: { // If displayChangelog uses import fs from 'fs' and esModuleInterop is tricky
    statSync: vi.fn(),
    readFileSync: vi.fn(),
  // },
  // Provide them at the root if displayChangelog uses import { statSync } from 'fs'
  // For `import fs from 'fs'`, Vitest usually handles making these available on `fs.default` or `fs` directly.
  // Let's assume direct availability for now.
}));

const mockMcpClientInstance = {
  connect: vi.fn(),
  callTool: vi.fn(),
  close: vi.fn(),
};
vi.mock('@modelcontextprotocol/sdk/client/index.js', () => ({
  Client: vi.fn().mockImplementation(() => mockMcpClientInstance),
}));

vi.mock('@modelcontextprotocol/sdk/client/streamableHttp.js', () => ({
  StreamableHTTPClientTransport: vi.fn(),
}));

// Store the original configService mock structure to reset it
const originalMockConfigServiceInstance = { HTTP_PORT: 3001, AGENT_QUERY_TIMEOUT: 180000 };
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

let mockProcessExit: MockInstance<typeof process.exit>;
let mockConsoleLog: MockInstance<typeof console.log>;
let mockConsoleError: MockInstance<typeof console.error>;
let originalProcessEnv: NodeJS.ProcessEnv;
let originalArgv: string[];

describe('CLI with yargs (index.ts)', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    originalProcessEnv = { ...process.env };
    originalArgv = [...process.argv];
    
    // Reset the mutable mockConfigServiceInstance to its original state by creating fresh copies
    currentMockConfigServiceInstance = { ...originalMockConfigServiceInstance };
    currentMockLoggerInstance = {
      info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(),
    };
    // Reset other top-level mocks that might be stateful
    mockStartServer.mockReset().mockResolvedValue(undefined);
    mockStartProxyServer.mockReset().mockResolvedValue(undefined);
    mockAxiosGet.mockReset().mockImplementation(async (url: string) => {
      // Use currentMockConfigServiceInstance for port, as it's fresh for each test
      if (url === `http://localhost:${currentMockConfigServiceInstance.HTTP_PORT}/api/ping`) {
        return { status: 200, data: { service: "CodeCompass", version: "test-server" } };
      }
      return { status: 404, data: {} };
    });
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
    process.argv = ['node', 'index.js', ...args];
    vi.resetModules(); 
    
    // Dynamically resolve paths as src/index.ts would
    const indexPath = require.resolve('../index.js'); 
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
    vi.doMock('@modelcontextprotocol/sdk/client/streamableHttp.js', () => ({
      StreamableHTTPClientTransport: vi.fn(),
    }));
    
    await import('../index.js'); 

    // Dynamically resolve paths as src/index.ts would
    // require.resolve needs a path that exists relative to this test file to find index.js
    // Assuming index.js is in dist/ and tests are in dist/tests/
    // If src/index.ts is run directly (e.g. via ts-node for tests), then '../index.js' might point to src/index.js
    // Let's assume the compiled output structure where index.js is at a level accessible via '../index.js' from 'dist/tests/index.js'
    // And 'lib' is a sibling to 'index.js'
    const indexPath = require.resolve('../index.js'); // Get absolute path to index.js
    const SUT_distPath = path.dirname(indexPath); // Get directory of index.js (e.g., /path/to/project/dist)
    const resolvedSUTLibPath = path.join(SUT_distPath, 'lib'); // Path to SUT's lib dir

    vi.doMock(path.join(resolvedSUTLibPath, 'config-service.js'), () => ({
      configService: currentMockConfigServiceInstance, // Use the current, fresh mock
      logger: currentMockLoggerInstance,             // Use the current, fresh mock
    }));
    vi.doMock(path.join(resolvedSUTLibPath, 'server.js'), () => ({
      startServer: mockStartServer,
      startProxyServer: mockStartProxyServer,
      ServerStartupError: ServerStartupError,
    }));
    // Mock SDK client components that are dynamically required in handleClientCommand
    vi.doMock('@modelcontextprotocol/sdk/client/index.js', () => ({
      Client: vi.fn().mockImplementation(() => mockMcpClientInstance),
    }));
    vi.doMock('@modelcontextprotocol/sdk/client/streamableHttp.js', () => ({
      StreamableHTTPClientTransport: vi.fn(),
    }));

    // Importing src/index.js executes main() at its end.
    // No need to destructure or call main explicitly if it's not exported.
    await import('../index.js'); 
    // Yargs fail handler might call process.exit. We catch errors from parseAsync
    // to allow assertions on console.error or logger.error before process.exit is checked.
    try {
      await main();
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
    
    it('should call startServerHandler with specified repoPath for "start" command', async () => {
      await runMainWithArgs(['start', '/my/repo/path']);
      expect(mockStartServer).toHaveBeenCalledWith('/my/repo/path');
    });

    it('should handle startServer failure and log via yargs .fail()', async () => {
      const startupError = new ServerStartupError("Server failed to boot", 1);
      mockStartServer.mockRejectedValue(startupError);
      process.env.VITEST_TESTING_FAIL_HANDLER = "true"; // To ensure error is caught by .fail() and not rethrown by runMainWithArgs
      await runMainWithArgs(['start']);
      expect(currentMockLoggerInstance.error).toHaveBeenCalledWith('CLI Error (yargs.fail):', expect.objectContaining({ message: "Server failed to boot" }));
      expect(mockProcessExit).toHaveBeenCalledWith(1);
      delete process.env.VITEST_TESTING_FAIL_HANDLER;
    });

    it('should handle startServer EADDRINUSE with exitCode 0 and attempt proxy start', async () => {
      const eaddrinuseError = new ServerStartupError('Port in use by CC', 0, { requestedPort: 3001, detectedServerPort: 3001, existingServerStatus: { service: "CodeCompass", version: "prev" }});
      mockStartServer.mockRejectedValue(eaddrinuseError);
      mockStartProxyServer.mockResolvedValue(undefined); // Proxy starts successfully

      await runMainWithArgs(['start']);
      expect(mockStartProxyServer).toHaveBeenCalledWith(3001, 3001, "prev");
      expect(mockLoggerInstance.error).not.toHaveBeenCalledWith('CLI Error (yargs.fail):', expect.anything());
      expect(mockProcessExit).not.toHaveBeenCalled(); // Proxy keeps process alive
    });
  });

  describe('Client Tool Commands', () => {
    it('should call handleClientCommand for "agent_query" with JSON parameters', async () => {
      await runMainWithArgs(['agent_query', '{"query":"test", "sessionId":"s1"}']);
      expect(mockAxiosGet).toHaveBeenCalledWith(`http://localhost:${mockConfigServiceInstance.HTTP_PORT}/api/ping`, expect.anything());
      expect(mockMcpClientInstance.callTool).toHaveBeenCalledWith({ name: 'agent_query', arguments: { query: 'test', sessionId: 's1' } });
      expect(mockConsoleLog).toHaveBeenCalledWith('Tool call success');
    });

    it('should call handleClientCommand for "get_changelog" (no params string needed, defaults to {})', async () => {
      await runMainWithArgs(['get_changelog']);
      expect(mockMcpClientInstance.callTool).toHaveBeenCalledWith({ name: 'get_changelog', arguments: {} });
      expect(mockConsoleLog).toHaveBeenCalledWith('Tool call success');
    });
    
    it('should call handleClientCommand for "get_indexing_status" (params string provided as empty JSON)', async () => {
      await runMainWithArgs(['get_indexing_status', '{}']);
      expect(mockMcpClientInstance.callTool).toHaveBeenCalledWith({ name: 'get_indexing_status', arguments: {} });
    });

    it('should handle client command failure (server not running) and log via yargs .fail()', async () => {
      const axiosError = new Error('ECONNREFUSED') as import('axios').AxiosError;
      axiosError.isAxiosError = true;
      axiosError.code = 'ECONNREFUSED';
      mockAxiosGet.mockRejectedValue(axiosError);
      process.env.VITEST_TESTING_FAIL_HANDLER = "true";
      await runMainWithArgs(['agent_query', '{"query":"test"}']);
      expect(mockConsoleError).toHaveBeenCalledWith(expect.stringContaining('CodeCompass server is not running'));
      expect(currentMockLoggerInstance.error).toHaveBeenCalledWith('CLI Error (yargs.fail):', expect.objectContaining({ message: expect.stringContaining('ECONNREFUSED') }));
      expect(mockProcessExit).toHaveBeenCalledWith(1);
      delete process.env.VITEST_TESTING_FAIL_HANDLER;
    });

    it('should handle invalid JSON parameters for client command and log via yargs .fail()', async () => {
      process.env.VITEST_TESTING_FAIL_HANDLER = "true";
      await runMainWithArgs(['agent_query', '{"query": "test"']); // Invalid JSON
      expect(mockConsoleError).toHaveBeenCalledWith(expect.stringContaining("Invalid JSON parameters for tool 'agent_query'"));
      expect(currentMockLoggerInstance.error).toHaveBeenCalledWith('CLI Error (yargs.fail):', expect.objectContaining({ message: expect.stringContaining('Invalid JSON parameters') }));
      expect(mockProcessExit).toHaveBeenCalledWith(1);
      delete process.env.VITEST_TESTING_FAIL_HANDLER;
    });
  });

  describe('Global Options', () => {
    it('--port option should set HTTP_PORT environment variable and be used by client commands', async () => {
      const customPort = 1234;
      // The yargs `apply` function for the port option sets process.env.HTTP_PORT.
      // When handleClientCommand dynamically requires configService, it should pick this up.
      // We need to ensure our mockConfigServiceInstance reflects this for the axios.get mock.
      // mockConfigServiceInstance.HTTP_PORT = customPort; // This direct assignment might be too simple if configService re-initializes

      // Temporarily update the mockConfigServiceInstance getter for HTTP_PORT for this test
      // This simulates configService picking up the new env var when it's dynamically required.
      const originalHttpPortDescriptor = Object.getOwnPropertyDescriptor(mockConfigServiceInstance, 'HTTP_PORT');
      Object.defineProperty(mockConfigServiceInstance, 'HTTP_PORT', {
        get: () => parseInt(process.env.HTTP_PORT || mockConfigServiceInstance.HTTP_PORT.toString()), // Read from process.env
        configurable: true
      });
    
      await runMainWithArgs(['--port', String(customPort), 'agent_query', '{"query":"test"}']);
          
      expect(process.env.HTTP_PORT).toBe(String(customPort));
      // mockConfigServiceInstance.HTTP_PORT (via getter) should now reflect customPort
      expect(mockAxiosGet).toHaveBeenCalledWith(`http://localhost:${customPort}/api/ping`, {"timeout": 2000});
      expect(mockConsoleLog).toHaveBeenCalledWith('Tool call success');
    
      // Restore original descriptor or value
      if (originalHttpPortDescriptor) {
        Object.defineProperty(mockConfigServiceInstance, 'HTTP_PORT', originalHttpPortDescriptor);
      } else {
         // Fallback if it wasn't a getter initially
        mockConfigServiceInstance.HTTP_PORT = originalMockConfigServiceInstance.HTTP_PORT;
      }
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
      expect(mockConsoleLog).toHaveBeenCalledWith(expect.stringContaining("Usage: codecompass"));
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
    it('should output raw JSON when --json flag is used on successful tool call', async () => {
      const rawToolResult = { content: [{ type: 'text', text: 'Success' }], id: '123' };
      mockMcpClientInstance.callTool.mockResolvedValue(rawToolResult);
      await runMainWithArgs(['agent_query', '{"query":"test"}', '--json']);
      
      expect(mockConsoleLog).toHaveBeenCalledWith(JSON.stringify(rawToolResult, null, 2));
      // Successful client command should exit 0, yargs default for resolved command.
      // No explicit process.exit(0) in handler, so yargs default behavior.
      // If yargs doesn't exit, then no call to mockProcessExit.
      // Let's assume yargs handles exit code 0 for success.
    });

    it('should output JSON error when --json flag is used and tool call fails with JSON-RPC error', async () => {
      const rpcError = {
        jsonrpc: "2.0",
        id: "err-123",
        error: {
          code: -32001,
          message: "Tool specific error",
          data: { reason: "invalid input" },
        },
      } as const;
      mockMcpClientInstance.callTool.mockRejectedValue(rpcError);
      process.env.VITEST_TESTING_FAIL_HANDLER = "true";
      await runMainWithArgs(['agent_query', '{"query":"test_error"}', '--json']);

      expect(mockConsoleError).toHaveBeenCalledWith(JSON.stringify(rpcError, null, 2));
      expect(mockProcessExit).toHaveBeenCalledWith(1);
      delete process.env.VITEST_TESTING_FAIL_HANDLER;
    });

    it('should output JSON error when --json flag is used and tool call fails with generic Error', async () => {
      const genericError = new Error("A generic client error occurred");
      mockMcpClientInstance.callTool.mockRejectedValue(genericError);
      process.env.VITEST_TESTING_FAIL_HANDLER = "true";
      await runMainWithArgs(['agent_query', '{"query":"generic_error"}', '--json']);

      expect(mockConsoleError).toHaveBeenCalledWith(JSON.stringify({
        error: { message: genericError.message, name: genericError.name }
      }, null, 2));
      expect(mockProcessExit).toHaveBeenCalledWith(1);
      delete process.env.VITEST_TESTING_FAIL_HANDLER;
    });

    it('should output JSON error when --json flag is used and server ping fails (ECONNREFUSED)', async () => {
      const axiosError = new Error('connect ECONNREFUSED') as import('axios').AxiosError;
      axiosError.isAxiosError = true;
      axiosError.code = 'ECONNREFUSED';
      mockAxiosGet.mockRejectedValue(axiosError);
      process.env.VITEST_TESTING_FAIL_HANDLER = "true"; // To align with original intent if .fail() is tested
      await runMainWithArgs(['agent_query', '{"query":"ping_fail"}', '--json']);
          
      const currentHttpPort = process.env.HTTP_PORT || mockConfigServiceInstance.HTTP_PORT;
      const expectedErrorMessage = `CodeCompass server is not running on port ${currentHttpPort}. The server is required for background repository synchronization and to process tool commands. Please start the server first (e.g., by running 'codecompass [repoPath]'). (Detail: ECONNREFUSED)`;
      expect(mockConsoleError).toHaveBeenCalledWith(JSON.stringify({
        error: { message: expectedErrorMessage }
      }, null, 2));
      expect(mockProcessExit).toHaveBeenCalledWith(1);
      delete process.env.VITEST_TESTING_FAIL_HANDLER; // Clean up env var
    });

    it('should output JSON error when --json flag is used and ping indicates non-CodeCompass server', async () => {
      const pingData = { service: "OtherService", version: "1.0" };
      mockAxiosGet.mockImplementation(async (url: string) => {
        if (url.includes('/api/ping')) {
          return { status: 200, data: pingData };
        }
        return { status: 404, data: {} };
      });
      process.env.VITEST_TESTING_FAIL_HANDLER = "true";
      await runMainWithArgs(['agent_query', '{"query":"wrong_server"}', '--json']);

      const currentHttpPort = process.env.HTTP_PORT || currentMockConfigServiceInstance.HTTP_PORT;
      const expectedErrorMessage = `A service is running on port ${currentHttpPort}, but it's not a CodeCompass server or it's unresponsive.`;
      expect(mockConsoleError).toHaveBeenCalledWith(JSON.stringify({
        error: { message: expectedErrorMessage, pingResponse: pingData }
      }, null, 2));
      expect(mockProcessExit).toHaveBeenCalledWith(1);
      delete process.env.VITEST_TESTING_FAIL_HANDLER;
    });
  });
});
