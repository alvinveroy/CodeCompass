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
const originalMockConfigServiceInstance = { HTTP_PORT: 3001 };
const mockConfigServiceInstance = { ...originalMockConfigServiceInstance }; // Mutable copy for tests

const mockLoggerInstance = {
  info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(),
};
vi.mock('./lib/config-service', () => ({
  configService: mockConfigServiceInstance,
  logger: mockLoggerInstance,
}));

const mockStartServer = vi.fn();
const mockServerStartupError = class ServerStartupError extends Error {
  exitCode: number;
  constructor(message: string, exitCode = 1) {
    super(message);
    this.name = "ServerStartupError";
    this.exitCode = exitCode;
  }
};
vi.mock('./lib/server', () => ({
  startServer: mockStartServer,
  ServerStartupError: mockServerStartupError,
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

    // Reset the mutable mockConfigServiceInstance to its original state
    Object.assign(mockConfigServiceInstance, originalMockConfigServiceInstance);
    delete process.env.HTTP_PORT; // Ensure HTTP_PORT env var is clean before each test

    mockProcessExit = vi.spyOn(process, 'exit').mockImplementation((() => {}) as typeof process.exit);
    mockConsoleLog = vi.spyOn(console, 'log').mockImplementation(() => {});
    mockConsoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    
    mockAxiosGet.mockImplementation(async (url: string) => {
      // Use the current HTTP_PORT from mockConfigServiceInstance for ping URL construction
      if (url === `http://localhost:${mockConfigServiceInstance.HTTP_PORT}/api/ping`) {
        return { status: 200, data: { service: "CodeCompass", version: "test-server" } };
      }
      return { status: 404, data: {} };
    });
    mockMcpClientInstance.callTool.mockResolvedValue({ content: [{ type: 'text', text: 'Tool call success' }] });
    mockStartServer.mockResolvedValue(undefined);
    mockMcpClientInstance.connect.mockResolvedValue(undefined);
    mockMcpClientInstance.close.mockResolvedValue(undefined);
  });

  afterEach(() => {
    process.env = originalProcessEnv;
    process.argv = originalArgv;
    vi.restoreAllMocks();
  });

  async function runMainWithArgs(args: string[]) {
    process.argv = ['node', 'index.js', ...args];
    vi.resetModules(); 
    const { main } = await import('../index');
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
      const startupError = new mockServerStartupError("Server failed to boot", 1);
      mockStartServer.mockRejectedValue(startupError);
      await runMainWithArgs(['start']); // Use explicit start command
      // Check logger.error from yargs .fail()
      expect(mockLoggerInstance.error).toHaveBeenCalledWith('CLI Error:', expect.objectContaining({ message: "Server failed to boot" }));
      // yargs should call process.exit(1) due to the error
      expect(mockProcessExit).toHaveBeenCalledWith(1);
    });

    it('should handle startServer EADDRINUSE with exitCode 0 and not log CLI Error', async () => {
      const eaddrinuseError = new mockServerStartupError("Port in use", 0);
      mockStartServer.mockRejectedValue(eaddrinuseError);
      await runMainWithArgs(['start']);
      // startServerHandler re-throws only if exitCode !== 0.
      // If exitCode is 0, the promise resolves, so .fail() is not hit for this.
      expect(mockLoggerInstance.error).not.toHaveBeenCalledWith('CLI Error:', expect.anything());
      expect(mockProcessExit).not.toHaveBeenCalled(); // yargs exits 0 by default on handler success
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

      await runMainWithArgs(['agent_query', '{"query":"test"}']);
      expect(mockConsoleError).toHaveBeenCalledWith(expect.stringContaining('CodeCompass server is not running'));
      expect(mockLoggerInstance.error).toHaveBeenCalledWith('CLI Error:', expect.objectContaining({ message: expect.stringContaining('ECONNREFUSED') }));
      expect(mockProcessExit).toHaveBeenCalledWith(1);
    });

    it('should handle invalid JSON parameters for client command and log via yargs .fail()', async () => {
      await runMainWithArgs(['agent_query', '{"query": "test"']); // Invalid JSON
      expect(mockConsoleError).toHaveBeenCalledWith(expect.stringContaining("Invalid JSON parameters for tool 'agent_query'"));
      expect(mockLoggerInstance.error).toHaveBeenCalledWith('CLI Error:', expect.objectContaining({ message: expect.stringContaining('Invalid JSON parameters') }));
      expect(mockProcessExit).toHaveBeenCalledWith(1);
    });
  });

  describe('Global Options', () => {
    it('--port option should set HTTP_PORT environment variable and be used by client commands', async () => {
      const customPort = 1234;
      // The yargs `apply` function for the port option sets process.env.HTTP_PORT.
      // When handleClientCommand dynamically requires configService, it should pick this up.
      // We need to ensure our mockConfigServiceInstance reflects this for the axios.get mock.
      mockConfigServiceInstance.HTTP_PORT = customPort;

      await runMainWithArgs(['--port', String(customPort), 'agent_query', '{"query":"test"}']);
      
      expect(process.env.HTTP_PORT).toBe(String(customPort));
      expect(mockAxiosGet).toHaveBeenCalledWith(`http://localhost:${customPort}/api/ping`, expect.anything());
      expect(mockConsoleLog).toHaveBeenCalledWith('Tool call success');
    });

    it('--version option should display version and exit', async () => {
      await runMainWithArgs(['--version']);
      expect(mockConsoleLog).toHaveBeenCalledWith(expect.any(String)); // Version string
      expect(mockProcessExit).toHaveBeenCalledWith(0);
    });

    it('--help option should display help and exit', async () => {
      await runMainWithArgs(['--help']);
      expect(mockConsoleLog).toHaveBeenCalledWith(expect.stringContaining("Usage: codecompass"));
      expect(mockProcessExit).toHaveBeenCalledWith(0);
    });
  });
  
  describe('Changelog Command', () => {
    it('should display changelog', async () => {
      vi.mocked(fs.statSync).mockReturnValue({ mtimeMs: Date.now() } as fs.Stats);
      vi.mocked(fs.readFileSync).mockReturnValue('## Test Changelog Content');

      await runMainWithArgs(['changelog']);
      expect(mockConsoleLog).toHaveBeenCalledWith('## Test Changelog Content');
      // Successful synchronous command handler in yargs resolves, leading to exit 0 by default.
    });
  });

  describe('Error Handling and Strict Mode by yargs', () => {
    it('should show error and help for unknown command', async () => {
      await runMainWithArgs(['unknowncommand']);
      // yargs prints its own error message to stderr for unknown commands
      // and often shows help. The exact message can vary.
      expect(mockConsoleError).toHaveBeenCalledWith(expect.stringContaining("Unknown argument: unknowncommand"));
      // Check if yargs' .fail() handler's logger was called
      expect(mockLoggerInstance.error).toHaveBeenCalledWith('CLI Usage Error:', expect.stringContaining("Unknown argument: unknowncommand"));
      expect(mockProcessExit).toHaveBeenCalledWith(1);
    });

    it('should show error and help for unknown option', async () => {
      await runMainWithArgs(['--unknown-option']);
      expect(mockConsoleError).toHaveBeenCalledWith(expect.stringContaining("Unknown argument: unknown-option"));
      expect(mockLoggerInstance.error).toHaveBeenCalledWith('CLI Usage Error:', expect.stringContaining("Unknown argument: unknown-option"));
      expect(mockProcessExit).toHaveBeenCalledWith(1);
    });
  });

  describe('Client Tool Commands with --json output flag', () => {
    it('should output raw JSON when --json flag is used on successful tool call', async () => {
      const rawToolResponse = {
        someData: "value",
        details: { nested: true, count: 1 },
        content: [{ type: 'text', text: 'This should not be printed directly' }]
      };
      mockMcpClientInstance.callTool.mockResolvedValue(rawToolResponse);

      await runMainWithArgs(['agent_query', '{"query":"test"}', '--json']);

      expect(mockConsoleLog).toHaveBeenCalledWith(JSON.stringify(rawToolResponse, null, 2));
      expect(mockProcessExit).toHaveBeenCalledWith(0);
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
      } as const; // Use 'as const' for precise typing
      mockMcpClientInstance.callTool.mockRejectedValue(rpcError);

      await runMainWithArgs(['agent_query', '{"query":"test_error"}', '--json']);

      expect(mockConsoleError).toHaveBeenCalledWith(JSON.stringify(rpcError, null, 2));
      expect(mockProcessExit).toHaveBeenCalledWith(1);
    });

    it('should output JSON error when --json flag is used and tool call fails with generic Error', async () => {
      const genericError = new Error("A generic client error occurred");
      mockMcpClientInstance.callTool.mockRejectedValue(genericError);

      await runMainWithArgs(['agent_query', '{"query":"generic_error"}', '--json']);

      expect(mockConsoleError).toHaveBeenCalledWith(JSON.stringify({
        error: { message: genericError.message, name: genericError.name }
      }, null, 2));
      expect(mockProcessExit).toHaveBeenCalledWith(1);
    });

    it('should output JSON error when --json flag is used and server ping fails (ECONNREFUSED)', async () => {
      const axiosError = new Error('connect ECONNREFUSED') as import('axios').AxiosError;
      axiosError.isAxiosError = true;
      axiosError.code = 'ECONNREFUSED';
      mockAxiosGet.mockRejectedValue(axiosError);

      await runMainWithArgs(['agent_query', '{"query":"ping_fail"}', '--json']);
      
      const expectedErrorMessage = `CodeCompass server is not running on port ${mockConfigServiceInstance.HTTP_PORT}. Please start the server first. (Detail: ECONNREFUSED)`;
      expect(mockConsoleError).toHaveBeenCalledWith(JSON.stringify({
        error: { message: expectedErrorMessage }
      }, null, 2));
      expect(mockProcessExit).toHaveBeenCalledWith(1);
    });

    it('should output JSON error when --json flag is used and ping indicates non-CodeCompass server', async () => {
      const pingData = { service: "OtherService", version: "1.0" };
      mockAxiosGet.mockImplementation(async (url: string) => {
        if (url.includes('/api/ping')) {
          return { status: 200, data: pingData };
        }
        return { status: 404, data: {} };
      });
      
      await runMainWithArgs(['agent_query', '{"query":"wrong_server"}', '--json']);

      const expectedErrorMessage = `A service is running on port ${mockConfigServiceInstance.HTTP_PORT}, but it's not a CodeCompass server or it's unresponsive.`;
      expect(mockConsoleError).toHaveBeenCalledWith(JSON.stringify({
        error: { message: expectedErrorMessage, pingResponse: pingData }
      }, null, 2));
      expect(mockProcessExit).toHaveBeenCalledWith(1);
    });
  });
});
