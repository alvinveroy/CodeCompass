import { describe, it, expect, vi, beforeEach, afterEach, type Mock, type MockInstance } from 'vitest';
import axios from 'axios'; // Actual axios for type, will be mocked
// Import types from the SDK, actual implementation will be mocked
import type { Client as McpClientType, ClientOptions as McpClientOptionsType } from '@modelcontextprotocol/sdk/client/index.js';
import type { StreamableHTTPClientTransport as McpStreamableHTTPClientTransportType } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { ToolCallResponse } from '@modelcontextprotocol/sdk/types.js';

// Mock dependencies
vi.mock('axios');

const mockMcpClientInstance = {
  connect: vi.fn(),
  callTool: vi.fn(),
  close: vi.fn(),
};
vi.mock('@modelcontextprotocol/sdk/client/index.js', () => ({
  Client: vi.fn().mockImplementation(() => mockMcpClientInstance),
}));

vi.mock('@modelcontextprotocol/sdk/client/streamableHttp.js', () => ({
  StreamableHTTPClientTransport: vi.fn().mockImplementation(() => ({
    // Mock transport instance properties/methods if needed, though likely not directly used by index.ts
  })),
}));

// Mock configService and logger from '../lib/config-service'
// This mock needs to be active when index.ts dynamically requires it.
const mockConfigServiceInstance = {
  HTTP_PORT: 3001, // Default mock port
  // Add any other properties configService might expose that index.ts uses
};
const mockLoggerInstance = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
};
vi.mock('../lib/config-service', () => ({
  configService: mockConfigServiceInstance,
  logger: mockLoggerInstance,
}));


// We need to test the main function or executeClientCommand from index.ts
// Since index.ts uses dynamic require for server parts, and we want to isolate client logic,
// we might need to refactor executeClientCommand to be exportable or test via invoking the CLI.
// For now, let's assume we can get a handle on executeClientCommand or test `main`.

// To test `main` from index.ts, we'd typically mock process.argv and run it.
// Let's try to get `executeClientCommand` if possible, or prepare to test `main()`.

// For simplicity in this step, let's assume `executeClientCommand` can be imported or exposed for testing.
// If not, we'll adjust to test `main()`.
// The current `index.ts` doesn't export `executeClientCommand`.
// We will test `main()` by mocking `process.argv`.

let mockProcessExit: MockInstance<typeof process.exit>;
let mockConsoleLog: MockInstance<typeof console.log>;
let mockConsoleError: MockInstance<typeof console.error>;

describe('CLI Client Mode (index.ts)', () => {
  beforeEach(() => {
    vi.resetAllMocks(); // Reset all mocks

    // Re-assign mocks for configService and logger for clarity if they were modified
    vi.mocked(mockLoggerInstance.info);
    vi.mocked(mockLoggerInstance.warn);
    vi.mocked(mockLoggerInstance.error);
    vi.mocked(mockLoggerInstance.debug);

    // Mock process.exit
    mockProcessExit = vi.spyOn(process, 'exit').mockImplementation((() => {}) as typeof process.exit);
    // Mock console.log and console.error
    mockConsoleLog = vi.spyOn(console, 'log').mockImplementation(() => {});
    mockConsoleError = vi.spyOn(console, 'error').mockImplementation(() => {});

    // Reset axios mock
    vi.mocked(axios.get).mockReset();
    // Reset MCP client mocks
    mockMcpClientInstance.connect.mockReset();
    mockMcpClientInstance.callTool.mockReset();
    mockMcpClientInstance.close.mockReset();

    // Default successful ping
    vi.mocked(axios.get).mockImplementation(async (url: string) => {
      if (url.endsWith('/api/ping')) {
        return {
          status: 200,
          data: { service: "CodeCompass", version: "test-server-version" },
        };
      }
      throw new Error(`axios.get mock not implemented for ${url}`);
    });

    // Default successful tool call
    mockMcpClientInstance.callTool.mockResolvedValue({
      content: [{ type: 'text', text: 'Mocked tool response' }],
    } as ToolCallResponse);
    mockMcpClientInstance.connect.mockResolvedValue(undefined);
    mockMcpClientInstance.close.mockResolvedValue(undefined);
  });

  afterEach(() => {
    // Restore original implementations
    mockProcessExit.mockRestore();
    mockConsoleLog.mockRestore();
    mockConsoleError.mockRestore();
    process.argv = originalProcessArgv; // Restore original argv
  });

  // Store original process.argv
  const originalProcessArgv = [...process.argv];

  async function runCli(...args: string[]) {
    process.argv = ['node', 'index.js', ...args];
    // Dynamically import main from index.ts to run with mocked argv
    // This ensures index.ts runs in the context of the mocks defined in this test file.
    const { main } = await import('../index'); // Assuming main is exported or index.ts runs on import
    await main();
  }

  it('should execute a tool successfully in client mode', async () => {
    await runCli('agent_query', '{"query": "test"}');

    expect(axios.get).toHaveBeenCalledWith(`http://localhost:${mockConfigServiceInstance.HTTP_PORT}/api/ping`, { timeout: 2000 });
    expect(mockMcpClientInstance.connect).toHaveBeenCalled();
    expect(mockMcpClientInstance.callTool).toHaveBeenCalledWith({
      name: 'agent_query',
      arguments: { query: 'test' },
    });
    expect(mockConsoleLog).toHaveBeenCalledWith('Mocked tool response');
    expect(mockMcpClientInstance.close).toHaveBeenCalled();
    expect(mockProcessExit).toHaveBeenCalledWith(0);
  });

  it('should handle server not running (ping ECONNREFUSED)', async () => {
    const axiosError = new Error('connect ECONNREFUSED') as import('axios').AxiosError;
    axiosError.isAxiosError = true;
    axiosError.code = 'ECONNREFUSED';
    vi.mocked(axios.get).mockRejectedValue(axiosError);

    await runCli('agent_query', '{"query": "test"}');

    expect(mockConsoleError).toHaveBeenCalledWith(expect.stringContaining('CodeCompass server is not running'));
    expect(mockProcessExit).toHaveBeenCalledWith(1);
    expect(mockMcpClientInstance.connect).not.toHaveBeenCalled();
  });

  it('should handle non-CodeCompass server response from ping', async () => {
    vi.mocked(axios.get).mockResolvedValue({
      status: 200,
      data: { service: "OtherService", version: "1.0" },
    });

    await runCli('agent_query', '{"query": "test"}');

    expect(mockConsoleError).toHaveBeenCalledWith(expect.stringContaining("not a CodeCompass server or it's unresponsive"));
    expect(mockProcessExit).toHaveBeenCalledWith(1);
  });

  it('should handle invalid JSON parameters', async () => {
    await runCli('agent_query', '{"query": "test"'); // Invalid JSON

    expect(mockConsoleError).toHaveBeenCalledWith(expect.stringContaining("Invalid JSON parameters for tool 'agent_query'"));
    expect(mockProcessExit).toHaveBeenCalledWith(1);
    expect(axios.get).not.toHaveBeenCalled(); // Ping shouldn't happen if params are invalid
  });

  it('should handle MCP client tool execution error (JSON-RPC error)', async () => {
    const rpcError = {
      jsonrpc: "2.0",
      id: "123",
      error: {
        code: -32000,
        message: "Server tool execution failed",
        data: { details: "some error detail" },
      },
    } as const; // Use 'as const' for precise typing of the mock error
    mockMcpClientInstance.callTool.mockRejectedValue(rpcError);

    await runCli('agent_query', '{"query": "test"}');

    expect(mockConsoleError).toHaveBeenCalledWith(expect.stringContaining("Error executing tool 'agent_query': Server tool execution failed (Code: -32000)"));
    expect(mockConsoleError).toHaveBeenCalledWith(expect.stringContaining('Details: {"details":"some error detail"}'));
    expect(mockProcessExit).toHaveBeenCalledWith(1);
  });
  
  it('should respect --port argument for client mode connection', async () => {
    const customPort = 3005;
    mockConfigServiceInstance.HTTP_PORT = customPort; // Simulate configService picking up the port

    await runCli('--port', String(customPort), 'agent_query', '{"query": "test"}');
    
    expect(axios.get).toHaveBeenCalledWith(`http://localhost:${customPort}/api/ping`, { timeout: 2000 });
    expect(mockMcpClientInstance.connect).toHaveBeenCalled();
    expect(mockConsoleLog).toHaveBeenCalledWith('Mocked tool response');
    expect(mockProcessExit).toHaveBeenCalledWith(0);

    // Reset port for other tests if necessary, though beforeEach should handle it
    mockConfigServiceInstance.HTTP_PORT = 3001;
  });

});
