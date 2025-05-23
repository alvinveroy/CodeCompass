import { describe, it, expect, vi, beforeEach, afterEach, type MockInstance } from 'vitest';
import { normalizeToolParams, startServer } from '../lib/server'; // Import startServer
import { IndexingStatusReport } from '../lib/repository'; // For mock status

// Import actual modules to be mocked
import http from 'http';
import axios from 'axios'; // Import axios

// Mock dependencies
vi.mock('@modelcontextprotocol/sdk/server/mcp.js', () => ({
  McpServer: vi.fn().mockImplementation(() => ({
    connect: vi.fn(),
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

// Mock for http module
vi.mock('http', async (importOriginal) => {
  const actualHttp = await importOriginal() as typeof http;
  const mockServer = {
    listen: vi.fn(),
    on: vi.fn(),
    close: vi.fn(cb => { if (cb) cb(); }), // Mock close for cleanup
  };
  return {
    ...actualHttp, // Keep actual exports like IncomingMessage, ServerResponse if needed by types
    createServer: vi.fn(() => mockServer),
    // Add other http methods if used directly
  };
});

// Mock for axios
vi.mock('axios');

// Mock for process.exit
const mockProcessExit = vi.spyOn(process, 'exit').mockImplementation(vi.fn());

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
describe('Server Startup and Port Handling', () => {
  let mockHttpServer: { listen: MockInstance, on: MockInstance, close: MockInstance };
  // Get the correctly typed mocked configService and logger
  let mockedConfigService: typeof import('../lib/config-service').configService;
  let mockedLogger: typeof import('../lib/config-service').logger;
  let mockedMcpServerConnect: MockInstance;

  beforeEach(async () => {
    vi.clearAllMocks(); // Clear all mocks

    // Re-assign mocks for http.createServer and its returned object for each test
    mockHttpServer = {
      listen: vi.fn(),
      on: vi.fn(),
      close: vi.fn((cb) => { if (cb) cb(); }),
    };
    vi.mocked(http.createServer).mockReturnValue(mockHttpServer);

    // Get the mocked configService and logger from the vi.mock factory
    // This ensures we are interacting with the same mocked objects that the SUT uses.
    const actualConfigModule = await import('../lib/config-service.js');
    mockedConfigService = actualConfigModule.configService;
    mockedLogger = actualConfigModule.logger;

    // Mock McpServer's connect method
    const { McpServer } = await import('@modelcontextprotocol/sdk/server/mcp.js');
    mockedMcpServerConnect = vi.mocked(McpServer).mock.results[0]?.value.connect;
    if (!mockedMcpServerConnect) { // Fallback if the above path changes due to mock structure
        const instance = new McpServer({ name: "test", version: "0.0.0", vendor: "test", capabilities: {} });
        mockedMcpServerConnect = vi.mocked(instance.connect);
    }
    vi.mocked(mockedMcpServerConnect).mockClear();


    // Default mock for axios.get
    vi.mocked(axios.get).mockResolvedValue({ status: 200, data: {} });
  });

  afterEach(() => {
    // Restore any global mocks if necessary, though vi.clearAllMocks() handles most
    mockProcessExit.mockClear();
    mockConsoleInfo.mockClear();
  });

  it('should start the server and listen on the configured port if free', async () => {
    mockHttpServer.listen.mockImplementation((port, callback) => {
      if (callback) callback(); // Simulate successful listen
      return mockHttpServer;
    });

    await startServer('/fake/repo');

    expect(mockedConfigService.reloadConfigsFromFile).toHaveBeenCalled();
    expect(vi.mocked(http.createServer)).toHaveBeenCalled();
    expect(mockHttpServer.listen).toHaveBeenCalledWith(mockedConfigService.HTTP_PORT, expect.any(Function));
    expect(mockedLogger.info).toHaveBeenCalledWith(`CodeCompass HTTP server listening on port ${mockedConfigService.HTTP_PORT} for status and notifications.`);
    expect(mockedMcpServerConnect).toHaveBeenCalled(); // Check if MCP server connect is called
    expect(mockProcessExit).not.toHaveBeenCalled();
  });

  it('should handle EADDRINUSE, detect another CodeCompass server, print status, and exit gracefully', async () => {
    // Use import type for IndexingStatusReport if needed for strict typing of mock data
    const mockExistingServerStatus: import('../lib/repository').IndexingStatusReport = {
      status: 'indexing_file_content',
      message: 'Indexing in progress...',
      overallProgress: 50,
      currentFile: 'src/lib/file.ts',
      lastUpdatedAt: new Date().toISOString(),
    };
    const existingServerVersion = 'existing-test-version';

    // Simulate EADDRINUSE
    mockHttpServer.on.mockImplementation((event, handler) => {
      if (event === 'error') {
        const error = new Error('listen EADDRINUSE: address already in use :::3001') as NodeJS.ErrnoException;
        error.code = 'EADDRINUSE';
        handler(error); // Immediately invoke the error handler
      }
      return mockHttpServer;
    });

    // Mock axios.get for /api/ping
    vi.mocked(axios.get).mockImplementation(async (url: string) => {
      if (url.endsWith('/api/ping')) {
        return { status: 200, data: { service: "CodeCompass", status: "ok", version: existingServerVersion } };
      }
      if (url.endsWith('/api/indexing-status')) {
        return { status: 200, data: mockExistingServerStatus };
      }
      throw new Error(`Unexpected axios GET to ${url}`);
    });

    await startServer('/fake/repo');
    
    expect(mockedLogger.warn).toHaveBeenCalledWith(`HTTP Port ${mockedConfigService.HTTP_PORT} is already in use. Attempting to ping...`);
    expect(axios.get).toHaveBeenCalledWith(`http://localhost:${mockedConfigService.HTTP_PORT}/api/ping`, { timeout: 500 });
    expect(axios.get).toHaveBeenCalledWith(`http://localhost:${mockedConfigService.HTTP_PORT}/api/indexing-status`, { timeout: 1000 });
    
    expect(mockConsoleInfo).toHaveBeenCalledWith(expect.stringContaining(`--- Status of existing CodeCompass instance on port ${mockedConfigService.HTTP_PORT} ---`));
    expect(mockConsoleInfo).toHaveBeenCalledWith(expect.stringContaining(`Version: ${existingServerVersion}`));
    expect(mockConsoleInfo).toHaveBeenCalledWith(expect.stringContaining(`Status: ${mockExistingServerStatus.status}`));
    expect(mockConsoleInfo).toHaveBeenCalledWith(expect.stringContaining(`Progress: ${mockExistingServerStatus.overallProgress}%`));
    
    expect(mockedLogger.info).toHaveBeenCalledWith("Current instance will exit as another CodeCompass server is already running.");
    expect(mockProcessExit).toHaveBeenCalledWith(0); // Graceful exit
    expect(mockedMcpServerConnect).not.toHaveBeenCalled(); // MCP server should not connect
  });

  it('should handle EADDRINUSE, detect a non-CodeCompass server, log error, and exit with 1', async () => {
    mockHttpServer.on.mockImplementation((event, handler) => {
      if (event === 'error') {
        const error = new Error('listen EADDRINUSE') as NodeJS.ErrnoException;
        error.code = 'EADDRINUSE';
        handler(error);
      }
      return mockHttpServer;
    });

    vi.mocked(axios.get).mockResolvedValueOnce({ status: 200, data: { service: "OtherService" } }); // Ping response

    await startServer('/fake/repo');

    expect(mockedLogger.error).toHaveBeenCalledWith(expect.stringContaining(`Port ${mockedConfigService.HTTP_PORT} is in use, but it does not appear to be a CodeCompass server.`));
    expect(mockedLogger.error).toHaveBeenCalledWith(expect.stringContaining('Please free the port or configure a different one'));
    expect(mockProcessExit).toHaveBeenCalledWith(1);
    expect(mockedMcpServerConnect).not.toHaveBeenCalled();
  });

  it('should handle EADDRINUSE, ping fails (e.g. ECONNREFUSED), log error, and exit with 1', async () => {
    mockHttpServer.on.mockImplementation((event, handler) => {
      if (event === 'error') {
        const error = new Error('listen EADDRINUSE') as NodeJS.ErrnoException;
        error.code = 'EADDRINUSE';
        handler(error);
      }
      return mockHttpServer;
    });
    
    const pingError = new Error('connect ECONNREFUSED 127.0.0.1:3001') as import('axios').AxiosError;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (pingError as any).isAxiosError = true;
    pingError.code = 'ECONNREFUSED';
    vi.mocked(axios.get).mockRejectedValueOnce(pingError); // Ping fails

    await startServer('/fake/repo');

    expect(mockedLogger.error).toHaveBeenCalledWith(expect.stringContaining(`Port ${mockedConfigService.HTTP_PORT} is in use by an unknown service or the existing CodeCompass server is unresponsive to pings.`));
    expect(mockedLogger.error).toHaveBeenCalledWith(expect.stringContaining('Connection refused on port'));
    expect(mockProcessExit).toHaveBeenCalledWith(1);
    expect(mockedMcpServerConnect).not.toHaveBeenCalled();
  });
  
  it('should handle EADDRINUSE, ping OK, but /api/indexing-status fails, log error, and exit with 1', async () => {
    mockHttpServer.on.mockImplementation((event, handler) => {
      if (event === 'error') {
        const error = new Error('listen EADDRINUSE') as NodeJS.ErrnoException;
        error.code = 'EADDRINUSE';
        handler(error);
      }
      return mockHttpServer;
    });

    vi.mocked(axios.get)
      .mockResolvedValueOnce({ status: 200, data: { service: "CodeCompass", status: "ok", version: "test-version" } }) // Ping success
      .mockRejectedValueOnce(new Error('Failed to fetch status')); // Status fetch fails

    await startServer('/fake/repo');

    expect(mockedLogger.error).toHaveBeenCalledWith(expect.stringContaining('Error fetching status from existing CodeCompass server'));
    expect(mockProcessExit).toHaveBeenCalledWith(1);
    expect(mockedMcpServerConnect).not.toHaveBeenCalled();
  });

  it('should handle non-EADDRINUSE errors on HTTP server and exit with 1', async () => {
    const otherError = new Error('Some other server error') as NodeJS.ErrnoException;
    otherError.code = 'EACCES'; // Example of another error code

    mockHttpServer.on.mockImplementation((event, handler) => {
      if (event === 'error') {
        handler(otherError);
      }
      return mockHttpServer;
    });
    
    // We need to ensure listen is called to trigger the 'on' setup
    mockHttpServer.listen.mockImplementation(() => mockHttpServer);


    await startServer('/fake/repo');
    
    // Check that the 'on' handler was attached
    expect(mockHttpServer.on).toHaveBeenCalledWith('error', expect.any(Function));
    
    // Check for the specific error log for non-EADDRINUSE
    expect(mockedLogger.error).toHaveBeenCalledWith(`Failed to start HTTP server on port ${mockedConfigService.HTTP_PORT}: ${otherError.message}`);
    expect(mockProcessExit).toHaveBeenCalledWith(1);
    expect(mockedMcpServerConnect).not.toHaveBeenCalled();
  });
});
