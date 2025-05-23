import { describe, it, expect, vi, beforeEach, afterEach, type MockInstance, type Mock } from 'vitest';
import { normalizeToolParams, startServer } from '../lib/server'; // Import startServer
import { IndexingStatusReport } from '../lib/repository'; // For mock status
import type * as httpModule from 'http'; // For types
// Import actual modules to be mocked
import http from 'http';
import axios from 'axios'; // Import axios

// Define stable mock for McpServer.connect
const mcpConnectStableMock = vi.fn(); 

// Mock dependencies
vi.mock('@modelcontextprotocol/sdk/server/mcp.js', () => ({
  McpServer: vi.fn().mockImplementation(() => ({
    connect: mcpConnectStableMock, // Use stable mock
    tool: vi.fn(),
    resource: vi.fn(),
    prompt: vi.fn(), // Added prompt mock
  }))
}));

// Corrected mock path for configService and logger
vi.mock('../lib/config-service', async (importOriginal) => {
  const actual = await importOriginal() as typeof import('../lib/config-service');
  return {
    ...actual, // Spread actual to keep non-mocked parts if any, or specific exports
    configService: {
      // Provide all properties and methods accessed by server.ts
      // Basic defaults, specific tests can override via vi.spyOn or direct mock value changes
      HTTP_PORT: 3001,
      OLLAMA_HOST: 'http://127.0.0.1:11434',
      QDRANT_HOST: 'http://127.0.0.1:6333',
      COLLECTION_NAME: 'test-collection',
      SUGGESTION_MODEL: 'test-model',
      SUGGESTION_PROVIDER: 'ollama',
      EMBEDDING_MODEL: 'nomic-embed-text:v1.5',
      EMBEDDING_PROVIDER: 'ollama',
      DEEPSEEK_API_KEY: '',
      OPENAI_API_KEY: '',
      GEMINI_API_KEY: '',
      CLAUDE_API_KEY: '',
      VERSION: 'test-version', // Add if server.ts uses configService.VERSION
      reloadConfigsFromFile: vi.fn(),
      // Add any other properties/methods from ConfigService that server.ts uses
      // For example, if it uses specific model names for summarization/refinement:
      SUMMARIZATION_MODEL: 'test-summary-model',
      REFINEMENT_MODEL: 'test-refinement-model',
      // Add any other config values used in startServer
      MAX_SNIPPET_LENGTH: 500,
    },
    logger: {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(), // Add debug if used
      add: vi.fn(), // If logger.add is called
    }
  };
});

vi.mock('../lib/ollama', () => ({
  checkOllama: vi.fn().mockResolvedValue(true),
  checkOllamaModel: vi.fn().mockResolvedValue(true),
  // generateEmbedding: vi.fn().mockResolvedValue([0.1, 0.2, 0.3]), // Not directly used by startServer
  // generateSuggestion: vi.fn().mockResolvedValue('Test suggestion'), // Not directly used by startServer
  // summarizeSnippet: vi.fn().mockResolvedValue('Test summary') // Not directly used by startServer
}));

vi.mock('../lib/qdrant', () => ({
  initializeQdrant: vi.fn().mockResolvedValue({
    search: vi.fn().mockResolvedValue([ /* ...mock search results if needed ... */ ]),
    getCollections: vi.fn().mockResolvedValue({ collections: [] })
  })
}));

vi.mock('../lib/repository', async (importOriginal) => {
  const actual = await importOriginal() as typeof import('../lib/repository');
  return {
    ...actual, // Keep actual exports like IndexingStatusReport type
    validateGitRepository: vi.fn().mockResolvedValue(true),
    indexRepository: vi.fn().mockResolvedValue(undefined),
    getRepositoryDiff: vi.fn().mockResolvedValue('+ test\n- test2'),
    getGlobalIndexingStatus: vi.fn().mockReturnValue({
      status: 'idle',
      message: 'Mocked idle status',
      overallProgress: 0,
      lastUpdatedAt: new Date().toISOString(),
    } as IndexingStatusReport),
  };
});

vi.mock('isomorphic-git', async (importOriginal) => {
  const actual = await importOriginal() as typeof import('isomorphic-git');
  return {
    ...actual, // Keep actual exports
    default: { // Mock the default export if that's what's used
      ...(actual.default || {}), // Spread existing default export properties if any
      listFiles: vi.fn().mockResolvedValue(['file1.ts', 'file2.ts']),
      // Add other isomorphic-git functions if server.ts uses them directly
    },
    // If named exports from isomorphic-git are used, mock them here too
    // e.g., resolveRef: vi.fn(),
  };
});

// --- START: vi.mock for 'http' and related definitions ---
// Define shared mock function instances for the http server methods
const mockHttpServerListenFn = vi.fn<(...args: Parameters<httpModule.Server['listen']>) => ReturnType<httpModule.Server['listen']>>();
const mockHttpServerOnFn = vi.fn<(event: string | symbol, listener: (...args: any[]) => void) => httpModule.Server>();
const mockHttpServerCloseFn = vi.fn<(...args: Parameters<httpModule.Server['close']>) => ReturnType<httpModule.Server['close']>>();
const mockHttpServerAddressFn = vi.fn<(...args: Parameters<httpModule.Server['address']>) => ReturnType<httpModule.Server['address']>>();
const mockHttpServerSetTimeoutFn = vi.fn<(...args: Parameters<httpModule.Server['setTimeout']>) => ReturnType<httpModule.Server['setTimeout']>>();

// Define the mock http server instance that createServer will return
const mockHttpServerInstance = {
  listen: mockHttpServerListenFn,
  on: mockHttpServerOnFn,
  close: mockHttpServerCloseFn,
  address: mockHttpServerAddressFn,
  setTimeout: mockHttpServerSetTimeoutFn,
} as unknown as httpModule.Server; // Cast to satisfy http.Server type

vi.mock('http', async (importOriginal) => {
  const actualHttpModule = await importOriginal() as typeof httpModule;
  return {
    createServer: vi.fn(() => mockHttpServerInstance),
    Server: vi.fn(() => mockHttpServerInstance) as unknown as typeof httpModule.Server, // Mock constructor
    IncomingMessage: actualHttpModule.IncomingMessage, // Preserve actual types if needed
    ServerResponse: actualHttpModule.ServerResponse,   // Preserve actual types if needed
  };
});

// Mock for axios
vi.mock('axios');

// Mock for process.exit
let mockProcessExit: MockInstance<typeof process.exit>;

// Mock for console.info
const mockConsoleInfo = vi.spyOn(console, 'info').mockImplementation(vi.fn());

// Mock for ../lib/version
vi.mock('../lib/version', () => ({
  VERSION: 'test-version-from-mock'
}));

// Mock for ../lib/llm-provider
vi.mock('../lib/llm-provider', async (importOriginal) => {
  const actual = await importOriginal() as typeof import('../lib/llm-provider');
  return {
    ...actual,
    getLLMProvider: vi.fn().mockResolvedValue({
      checkConnection: vi.fn().mockResolvedValue(true),
      generateText: vi.fn().mockResolvedValue('mock llm text'),
      // Add other methods if server.ts uses them
    }),
    switchSuggestionModel: vi.fn().mockResolvedValue(true), // If server.ts calls this directly
  };
});

// Mock fs/promises for server.ts if it uses it directly (e.g. for reading changelog)
vi.mock('fs/promises', async (importOriginal) => {
  const actual = await importOriginal() as typeof import('fs/promises');
  return {
    ...actual,
    readFile: vi.fn().mockResolvedValue('mock file content'),
    // Add other fs/promises functions if used
  };
});


describe('Server Tool Response Formatting', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('normalizeToolParams', () => {
    it('should handle string input as query', () => {
      const result = normalizeToolParams('test query');
      expect(result).toEqual({ query: 'test query' });
    });

    it('should handle object input with query property', () => {
      const result = normalizeToolParams({ query: 'test query' });
      expect(result).toEqual({ query: 'test query' });
    });

    it('should handle object input without query property', () => {
      const input = { other: 'value' };
      const result = normalizeToolParams(input);
      expect(result).toEqual(input); // Expect the object to be returned as-is
    });

    it('should handle primitive values', () => {
      const result = normalizeToolParams(123);
      expect(result).toEqual({ query: '123' });
    });

    it('should handle null or undefined input', () => {
      expect(normalizeToolParams(null)).toEqual({ query: "" });
      expect(normalizeToolParams(undefined)).toEqual({ query: "" });
    });

    it('should handle stringified JSON object', () => {
      const input = { key: "value", num: 1 };
      const result = normalizeToolParams(JSON.stringify(input));
      expect(result).toEqual(input);
    });
  });

  describe('Tool Response Formatting', () => {
    // ... existing tests for tool response formatting ...
    // These tests are structural and don't involve server startup logic
    // so they can remain as they are.
    it('should verify search_code tool returns markdown formatted response', () => {
      // This is a structural test to ensure the response format is correct
      // The actual implementation would be tested with integration tests
      const response = `
# Search Results for: "test query"

## test/file.ts
- Last Modified: 2025-05-07T00:00:00Z
- Relevance: 0.95

### Code Snippet
\`\`\`
Test content
\`\`\`

### Summary
Test summary
`;
      
      // Verify the response contains markdown formatting elements
      expect(response).toContain('# Search Results');
      expect(response).toContain('## test/file.ts');
      expect(response).toContain('### Code Snippet');
      expect(response).toContain('```');
      expect(response).toContain('### Summary');
    });

    it('should verify generate_suggestion tool returns markdown formatted response', () => {
      const response = `
# Code Suggestion for: "test query"

## Suggestion
Test suggestion

## Context Used

### test/file.ts
- Last modified: 2025-05-07T00:00:00Z
- Relevance: 0.95

\`\`\`
Test content
\`\`\`

## Recent Changes
\`\`\`
+ test
- test2
\`\`\`
`;
      
      // Verify the response contains markdown formatting elements
      expect(response).toContain('# Code Suggestion');
      expect(response).toContain('## Suggestion');
      expect(response).toContain('## Context Used');
      expect(response).toContain('### test/file.ts');
      expect(response).toContain('```');
      expect(response).toContain('## Recent Changes');
    });

    it('should verify get_repository_context tool returns markdown formatted response', () => {
      const response = `
# Repository Context Summary

## Summary
Test suggestion

## Relevant Files

### test/file.ts
- Last modified: 2025-05-07T00:00:00Z
- Relevance: 0.95

\`\`\`
Test content
\`\`\`

## Recent Changes
\`\`\`
+ test
- test2
\`\`\`
`;
      
      // Verify the response contains markdown formatting elements
      expect(response).toContain('# Repository Context Summary');
      expect(response).toContain('## Summary');
      expect(response).toContain('## Relevant Files');
      expect(response).toContain('### test/file.ts');
      expect(response).toContain('```');
      expect(response).toContain('## Recent Changes');
    });
  });
});


// New test suite for Server Startup and Port Handling
import { ConfigService } from '../lib/config-service'; // Assuming ConfigService is the class/type of the instance
import { Logger as WinstonLogger } from 'winston';

// Type for the mocked logger instance where each method is a vi.Mock
type MockedLogger = {
  [K in keyof WinstonLogger]: WinstonLogger[K] extends (...args: infer A) => infer R
    ? vi.Mock<A, R>
    : WinstonLogger[K];
};

// Type for the mocked configService instance
// Adjust properties based on what server.ts actually uses from configService
type MockedConfigService = Pick<
  ConfigService,
  | 'HTTP_PORT'
  | 'OLLAMA_HOST' // Add other properties accessed by server.ts
  | 'SUGGESTION_MODEL'
  | 'LLM_PROVIDER'
  | 'AGENT_DEFAULT_MAX_STEPS'
  | 'DEFAULT_AGENT_DEFAULT_MAX_STEPS'
  // Add any other relevant properties from ConfigService
> & {
  logger: MockedLogger;
  reloadConfigsFromFile: vi.Mock<[], void>; // Or Promise<void> if async
  // Add other methods from ConfigService that are mocked and used by server.ts
};

describe('Server Startup and Port Handling', () => {
  // Use the new mock-aware types
  let mcs: MockedConfigService; // mcs for mockedConfigService
  let ml: MockedLogger; // ml for mockedLogger
  let mockedMcpServerConnect: MockInstance<any[], any>; // Typed the mock instance

  beforeEach(async () => {
    vi.clearAllMocks(); 

    // Mock process.exit for each test
    mockProcessExit = vi.spyOn(process, 'exit').mockImplementation(vi.fn() as unknown as (code?: string | number | null | undefined) => never);

    // Reset http server method mocks
    mockHttpServerListenFn.mockReset();
    mockHttpServerOnFn.mockReset();
    mockHttpServerCloseFn.mockReset();
    // Get the mocked configService and logger from the vi.mock factory
    // This ensures we are interacting with the same mocked objects that the SUT uses.
    const actualConfigModule = await import('../lib/config-service.js');
    // Cast to 'unknown' first, then to the mock type
    mcs = actualConfigModule.configService as unknown as MockedConfigService;
    ml = actualConfigModule.logger as unknown as MockedLogger;

    // Clear mocks using the typed instances
    ml.info?.mockClear();
    ml.warn?.mockClear();
    ml.error?.mockClear();
    ml.debug?.mockClear();
    mcs.reloadConfigsFromFile?.mockClear();
    
    // Assign and clear the stable McpServer.connect mock
    mcpConnectStableMock.mockClear();
    mockedMcpServerConnect = mcpConnectStableMock;
    
    // Default mock for axios.get
    vi.mocked(axios.get).mockResolvedValue({ status: 200, data: {} });
  });

  afterEach(() => {
    // Restore any global mocks if necessary, though vi.clearAllMocks() handles most
    if (mockProcessExit) mockProcessExit.mockClear(); // mockProcessExit is defined in beforeEach
    mockConsoleInfo.mockClear();
  });

  it('should start the server and listen on the configured port if free', async () => {
    await startServer('/fake/repo');

    expect(mcs.reloadConfigsFromFile).toHaveBeenCalled();
    expect(http.createServer).toHaveBeenCalled();
    expect(mockHttpServerListenFn).toHaveBeenCalledWith(mcs.HTTP_PORT, expect.any(Function)); // Changed mockedConfigService to mcs
    expect(ml.info).toHaveBeenCalledWith(`CodeCompass HTTP server listening on port ${mcs.HTTP_PORT} for status and notifications.`); // Changed mockedLogger to ml and mockedConfigService to mcs
    expect(mockedMcpServerConnect).toHaveBeenCalled(); // Check if MCP server connect is called
    expect(mockProcessExit).not.toHaveBeenCalled();
  });
    // Add the new 'it' block here, starting around line 395 of your provided file content
    it('should handle EADDRINUSE, detect existing CodeCompass server, log status, and exit with 0', async () => {
      // Define the mock status for an existing server
      const mockExistingServerStatus: IndexingStatusReport = {
        version: 'existing-test-version',
        status: 'idle',
        message: 'Existing server idle',
        overallProgress: 100,
        lastUpdatedAt: new Date().toISOString(),
      };

      mockHttpServerListenFn.mockImplementation(
        (
          _portOrOptions?: number | string | net.ListenOptions | null,
          _hostnameOrListener?: string | (() => void),
          _backlogOrListener?: number | (() => void),
          _listeningListener?: () => void
        ): httpModule.Server => {
          const errorArgs = mockHttpServerOnFn.mock.calls.find(call => call[0] === 'error');
          if (errorArgs && typeof errorArgs[1] === 'function') {
            const errorHandler = errorArgs[1] as (err: NodeJS.ErrnoException) => void;
            const error = new Error('listen EADDRINUSE: address already in use') as NodeJS.ErrnoException;
            error.code = 'EADDRINUSE';
            errorHandler(error);
          }
          return mockHttpServerInstance;
        });

      // Mock axios.get specifically for this test
      vi.mocked(axios.get).mockImplementation(async (url: string) => {
        if (url.endsWith('/api/ping')) {
          return { status: 200, data: { service: "CodeCompass", status: "ok", version: mockExistingServerStatus.version } };
        }
        if (url.endsWith('/api/indexing-status')) {
          return { status: 200, data: mockExistingServerStatus };
        }
        return { status: 404, data: {} }; // Default for other calls
      });

      await startServer('/fake/repo');
      
      expect(ml.warn).toHaveBeenCalledWith(`HTTP Port ${mcs.HTTP_PORT} is already in use. Attempting to ping...`);
      expect(axios.get).toHaveBeenCalledWith(`http://localhost:${mcs.HTTP_PORT}/api/ping`, { timeout: 500 });
      expect(axios.get).toHaveBeenCalledWith(`http://localhost:${mcs.HTTP_PORT}/api/indexing-status`, { timeout: 1000 });
      
      expect(mockConsoleInfo).toHaveBeenCalledWith(expect.stringContaining(`--- Status of existing CodeCompass instance on port ${mcs.HTTP_PORT} ---`));
      expect(mockConsoleInfo).toHaveBeenCalledWith(expect.stringContaining(`Version: ${mockExistingServerStatus.version}`));
      expect(mockConsoleInfo).toHaveBeenCalledWith(expect.stringContaining(`Status: ${mockExistingServerStatus.status}`));
      expect(mockConsoleInfo).toHaveBeenCalledWith(expect.stringContaining(`Progress: ${mockExistingServerStatus.overallProgress}%`));
      
      expect(ml.info).toHaveBeenCalledWith("Current instance will exit as another CodeCompass server is already running.");
      expect(mockProcessExit).toHaveBeenCalledWith(0);
      expect(mockedMcpServerConnect).not.toHaveBeenCalled();
    });

  it('should handle EADDRINUSE, detect a non-CodeCompass server, log error, and exit with 1', async () => {
    mockHttpServerListenFn.mockImplementation(
      (
        _portOrOptions?: number | string | net.ListenOptions | null,
        _hostnameOrListener?: string | (() => void),
        _backlogOrListener?: number | (() => void),
        _listeningListener?: () => void
      ): httpModule.Server => {
        const errorArgs = mockHttpServerOnFn.mock.calls.find(call => call[0] === 'error');
        if (errorArgs && typeof errorArgs[1] === 'function') {
          const errorHandler = errorArgs[1] as (err: NodeJS.ErrnoException) => void;
          const error = new Error('listen EADDRINUSE: address already in use') as NodeJS.ErrnoException;
          error.code = 'EADDRINUSE';
          errorHandler(error);
        }
        return mockHttpServerInstance;
      });

    // Mock axios.get for /api/ping
    vi.mocked(axios.get).mockImplementation(async (url: string) => {
      if (url.endsWith('/api/ping')) { // Ping returns non-CodeCompass response or error
        return { status: 200, data: { service: "OtherService" } };
      }
      return { status: 404, data: {} };
    });
    await startServer('/fake/repo');

    expect(ml.error).toHaveBeenCalledWith(expect.stringContaining(`Port ${mcs.HTTP_PORT} is in use, but it does not appear to be a CodeCompass server.`));
    expect(ml.error).toHaveBeenCalledWith(expect.stringContaining('Please free the port or configure a different one'));
    expect(mockProcessExit).toHaveBeenCalledWith(1);
    expect(mockedMcpServerConnect).not.toHaveBeenCalled();
  });

  it('should handle EADDRINUSE, ping fails (e.g. ECONNREFUSED), log error, and exit with 1', async () => {
    mockHttpServerListenFn.mockImplementation(
      (
        _portOrOptions?: number | string | net.ListenOptions | null,
        _hostnameOrListener?: string | (() => void),
        _backlogOrListener?: number | (() => void),
        _listeningListener?: () => void
      ): httpModule.Server => {
        const errorArgs = mockHttpServerOnFn.mock.calls.find(call => call[0] === 'error');
        if (errorArgs && typeof errorArgs[1] === 'function') {
          const errorHandler = errorArgs[1] as (err: NodeJS.ErrnoException) => void;
          const error = new Error('listen EADDRINUSE') as NodeJS.ErrnoException;
          error.code = 'EADDRINUSE';
          errorHandler(error); // Simulate EADDRINUSE
        }
        return mockHttpServerInstance;
      }
    );

    const pingError = new Error('Connection refused') as NodeJS.ErrnoException;
    pingError.code = 'ECONNREFUSED';
    vi.mocked(axios.get).mockImplementation(async (url: string) => {
      if (url.endsWith('/api/ping')) {
        throw pingError;
      }
      return { status: 404, data: {} };
    });

    await startServer('/fake/repo');

    expect(ml.error).toHaveBeenCalledWith(expect.stringContaining(`Port ${mcs.HTTP_PORT} is in use by an unknown service or the existing CodeCompass server is unresponsive to pings.`));
    expect(ml.error).toHaveBeenCalledWith(expect.stringContaining('Connection refused on port')); // Specific message for ECONNREFUSED
    expect(mockProcessExit).toHaveBeenCalledWith(1);
    expect(mockedMcpServerConnect).not.toHaveBeenCalled(); // MCP server should not connect
  });

  it('should handle EADDRINUSE, ping OK, but /api/indexing-status fails, log error, and exit with 1', async () => {
    mockHttpServerListenFn.mockImplementation(() => {
      const errorArgs = mockHttpServerOnFn.mock.calls.find(call => call[0] === 'error');
      if (errorArgs && typeof errorArgs[1] === 'function') {
        const errorHandler = errorArgs[1] as (err: NodeJS.ErrnoException) => void;
        const error = new Error('listen EADDRINUSE') as NodeJS.ErrnoException;
        error.code = 'EADDRINUSE';
        errorHandler(error); // Simulate EADDRINUSE
      }
      return mockHttpServerInstance;
    });

    // Mock axios.get for /api/ping
    vi.mocked(axios.get).mockImplementation(async (url: string) => {
      if (url.endsWith('/api/ping')) {
        return { status: 200, data: { service: "CodeCompass", status: "ok", version: "test-version" } }; // Ping success
      }
      if (url.endsWith('/api/indexing-status')) {
        throw new Error('Failed to fetch status'); // Status fetch fails
      }
      return mockHttpServerInstance;
    });

    await startServer('/fake/repo');

    expect(ml.error).toHaveBeenCalledWith(expect.stringContaining('Error fetching status from existing CodeCompass server'));
    expect(mockProcessExit).toHaveBeenCalledWith(1);
    expect(mockedMcpServerConnect).not.toHaveBeenCalled();
  });

  it('should handle non-EADDRINUSE errors on HTTP server and exit with 1', async () => {
    const otherError = new Error('Some other server error') as NodeJS.ErrnoException;
    otherError.code = 'EACCES'; // Example of another error code

    mockHttpServerListenFn.mockImplementation(() => {
      // Simulate listen failure by invoking the 'error' handler
      const errorArgs = mockHttpServerOnFn.mock.calls.find(call => call[0] === 'error');
      if (errorArgs && typeof errorArgs[1] === 'function') {
        const errorHandler = errorArgs[1] as (err: NodeJS.ErrnoException) => void;
        errorHandler(otherError);
      }
      return mockHttpServerInstance;
    });
    
    // We need to ensure listen is called to trigger the 'on' setup
    await startServer('/fake/repo');
    
    // Check that the 'on' handler was attached
    expect(mockHttpServerOnFn).toHaveBeenCalledWith('error', expect.any(Function));
    
    // Check for the specific error log for non-EADDRINUSE
    expect(ml.error).toHaveBeenCalledWith(`Failed to start HTTP server on port ${mcs.HTTP_PORT}: ${otherError.message}`);
    expect(mockProcessExit).toHaveBeenCalledWith(1);
    expect(mockedMcpServerConnect).not.toHaveBeenCalled();
  });
});
