import { describe, it, expect, vi, beforeEach, afterEach, type Mock, type MockInstance } from 'vitest';
import yargs from 'yargs'; // We will be testing yargs' behavior
import { hideBin } from 'yargs/helpers';
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

const mockConfigServiceInstance = { HTTP_PORT: 3001 };
const mockLoggerInstance = {
  info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(),
};
vi.mock('./lib/config-service', () => ({ // Adjusted path
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
vi.mock('./lib/server', () => ({ // Adjusted path
  startServer: mockStartServer,
  ServerStartupError: mockServerStartupError,
}));
// --- End Mocks ---

// Import the main function from index.ts to be tested
// We need to ensure that when index.ts is imported, its yargs setup is fresh.
// This might require vi.resetModules() before each import if yargs instance is module-level.
// The current index.ts defines yargs setup inside main(), so it's fresh on each main() call.

let mockProcessExit: MockInstance<typeof process.exit>;
let mockConsoleLog: MockInstance<typeof console.log>;
let mockConsoleError: MockInstance<typeof console.error>;
let originalProcessEnv: NodeJS.ProcessEnv;

describe('CLI with yargs (index.ts)', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    originalProcessEnv = { ...process.env };

    mockProcessExit = vi.spyOn(process, 'exit').mockImplementation((() => {}) as typeof process.exit);
    mockConsoleLog = vi.spyOn(console, 'log').mockImplementation(() => {});
    mockConsoleError = vi.spyOn(console, 'error').mockImplementation(() => {});

    // Reset dynamic import mocks if necessary, though vi.resetAllMocks() should cover them.
    mockAxiosGet.mockReset();
    mockMcpClientInstance.connect.mockReset();
    mockMcpClientInstance.callTool.mockReset();
    mockMcpClientInstance.close.mockReset();
    mockStartServer.mockReset();
    
    // Default mock implementations
    mockAxiosGet.mockImplementation(async (url: string) => {
      if (url.includes('/api/ping')) {
        return { status: 200, data: { service: "CodeCompass", version: "test-server" } };
      }
      return { status: 404, data: {} };
    });
    mockMcpClientInstance.callTool.mockResolvedValue({ content: [{ type: 'text', text: 'Tool call success' }] });
    mockStartServer.mockResolvedValue(undefined); // Default successful server start
  });

  afterEach(() => {
    process.env = originalProcessEnv;
    vi.restoreAllMocks(); // Restores spies
  });

  // Helper to run the CLI's main function with specified args
  async function runMainWithArgs(args: string[]) {
    // The yargs instance in index.ts uses hideBin(process.argv)
    // So, we need to set process.argv accordingly.
    process.argv = ['node', 'index.js', ...args];
    // Dynamically import main each time to re-evaluate yargs with new process.argv
    vi.resetModules(); // Ensure index.ts is re-evaluated
    const { main } = await import('../index');
    return main();
  }

  describe('Server Start Command (default and "start")', () => {
    it('should call startServerHandler with default repoPath when no args', async () => {
      await runMainWithArgs([]);
      expect(mockStartServer).toHaveBeenCalledWith('.');
      expect(mockProcessExit).not.toHaveBeenCalled(); // Assuming successful start
    });

    it('should call startServerHandler with specified repoPath', async () => {
      await runMainWithArgs(['/my/repo']);
      expect(mockStartServer).toHaveBeenCalledWith('/my/repo');
    });
    
    it('should call startServerHandler with specified repoPath for "start" command', async () => {
      await runMainWithArgs(['start', '/my/repo/path']);
      expect(mockStartServer).toHaveBeenCalledWith('/my/repo/path');
    });

    it('should handle startServer failure', async () => {
      const startupError = new mockServerStartupError("Server failed", 1);
      mockStartServer.mockRejectedValue(startupError);
      await runMainWithArgs([]);
      expect(mockLoggerInstance.error).toHaveBeenCalledWith('CLI Error:', expect.objectContaining({ message: "Server failed" }));
      // yargs .fail should handle process.exit, but we can check if it was called if needed
      // For now, assume yargs handles exit based on error propagation.
    });
  });

  describe('Client Tool Commands', () => {
    it('should call handleClientCommand for a known tool', async () => {
      await runMainWithArgs(['agent_query', '{"query":"test"}']);
      expect(mockAxiosGet).toHaveBeenCalled(); // Verifies handleClientCommand was entered
      expect(mockMcpClientInstance.callTool).toHaveBeenCalledWith({ name: 'agent_query', arguments: { query: 'test' } });
      expect(mockConsoleLog).toHaveBeenCalledWith('Tool call success');
      // yargs should exit 0 on promise resolution from handler
    });

    it('should handle client command failure (e.g., server not running)', async () => {
      mockAxiosGet.mockRejectedValue(new Error('ECONNREFUSED'));
      await runMainWithArgs(['agent_query', '{"query":"test"}']);
      expect(mockConsoleError).toHaveBeenCalledWith(expect.stringContaining('CodeCompass server is not running'));
      // yargs .fail should handle process.exit
    });
    
    it('should correctly parse params for tools like get_changelog (no explicit params needed)', async () => {
      await runMainWithArgs(['get_changelog']);
      expect(mockMcpClientInstance.callTool).toHaveBeenCalledWith({ name: 'get_changelog', arguments: {} });
    });
  });

  describe('Global Options', () => {
    it('--port option should set HTTP_PORT environment variable', async () => {
      // This test needs to verify that process.env.HTTP_PORT is set *before*
      // configService is loaded by a command handler.
      // The yargs `apply` function for the port option handles this.
      // We can check if configService (when loaded by a handler) sees the correct port.
      
      // Temporarily modify the configService mock to reflect the port change for verification
      const customPort = 1234;
      const originalMockPort = mockConfigServiceInstance.HTTP_PORT;
      mockConfigServiceInstance.HTTP_PORT = customPort; // Simulate it being set

      await runMainWithArgs(['--port', String(customPort), 'agent_query', '{"query":"test"}']);
      
      expect(process.env.HTTP_PORT).toBe(String(customPort));
      // Verify axios ping uses the custom port
      expect(mockAxiosGet).toHaveBeenCalledWith(`http://localhost:${customPort}/api/ping`, expect.anything());

      mockConfigServiceInstance.HTTP_PORT = originalMockPort; // Reset for other tests
      delete process.env.HTTP_PORT;
    });

    it('--version option should display version and exit', async () => {
      // yargs handles this internally. We check console output and exit.
      // Need to mock getPackageVersion if it's not already.
      // Assuming getPackageVersion is part of index.ts and works.
      // If getPackageVersion is complex or external, mock it here.
      // For now, assume it's simple and part of index.ts.
      // No, index.ts calls getPackageVersion, so we don't need to mock it here if it's self-contained.

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
      // Mock fs for displayChangelog
      // const mockFs = await import('fs'); // fs is already imported at the top
      vi.mocked(fs.statSync).mockReturnValue({ mtimeMs: Date.now() } as fs.Stats);
      vi.mocked(fs.readFileSync).mockReturnValue('## Test Changelog Content');

      await runMainWithArgs(['changelog']);
      expect(mockConsoleLog).toHaveBeenCalledWith('## Test Changelog Content');
      expect(mockProcessExit).not.toHaveBeenCalled(); // Changelog command should not exit itself, yargs handles flow
    });
  });

  describe('Error Handling and Strict Mode', () => {
    it('should show help and error for unknown command', async () => {
      await runMainWithArgs(['unknowncommand']);
      expect(mockConsoleError).toHaveBeenCalledWith(expect.stringContaining("Unknown argument: unknowncommand"));
      // yargs .fail should also trigger help display or specific error message
      // expect(mockConsoleLog).toHaveBeenCalledWith(expect.stringContaining("Usage: codecompass")); // yargs might show help
      // yargs handles exit
    });

    it('should show help and error for unknown option', async () => {
      await runMainWithArgs(['--unknown-option']);
      expect(mockConsoleError).toHaveBeenCalledWith(expect.stringContaining("Unknown argument: unknown-option"));
      // yargs handles exit
    });
  });
});
