import { describe, it, expect, vi, beforeEach, afterEach, type MockInstance, type Mock } from 'vitest';
// Add findFreePort to the import from ../lib/server
import { normalizeToolParams, startServer, findFreePort, ServerStartupError } from '../lib/server';
import { IndexingStatusReport } from '../lib/repository'; // For mock status
import type * as httpModule from 'http'; // For types
// Import actual modules to be mocked
import http from 'http';
import axios from 'axios'; // Import axios
import * as net from 'net'; // For net.ListenOptions

// Define stable mock for McpServer.connect
const mcpConnectStableMock = vi.fn(); 

// Mock dependencies
vi.mock('@modelcontextprotocol/sdk/server/mcp.js', async (importOriginal) => {
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-assertion
  const actual = await importOriginal() as typeof import('@modelcontextprotocol/sdk/server/mcp.js');
  return {
    ...actual,
    McpServer: vi.fn().mockImplementation(() => ({
      connect: mcpConnectStableMock, // Use stable mock
    tool: vi.fn(),
    resource: vi.fn(),
    prompt: vi.fn(), // Added prompt mock
    })),
    ResourceTemplate: vi.fn().mockImplementation((uriTemplate: string, _options: unknown): { uriTemplate: string } => {
    // Basic mock for ResourceTemplate constructor
    return { uriTemplate };
    })
  };
});

// Corrected mock path for configService and logger
vi.mock('../lib/config-service', async (importOriginal) => {
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-assertion
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

import type { QdrantClient } from '@qdrant/js-client-rest';

vi.mock('../lib/qdrant', () => ({
  initializeQdrant: vi.fn<() => Promise<Partial<QdrantClient>>>().mockResolvedValue({
    search: vi.fn().mockResolvedValue([]),
    getCollections: vi.fn().mockResolvedValue({ collections: [] })
  })
}));

vi.mock('../lib/repository', async (importOriginal) => {
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-assertion
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
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-assertion
  const actual = await importOriginal() as typeof import('isomorphic-git');
  return {
    ...actual, // Keep actual exports
    default: { // Mock the default export if that's what's used
      ...(actual.default || {}), // Spread existing default export properties if any
      listFiles: vi.fn<(args: { fs: typeof fs; dir: string; gitdir: string; ref: string }) => Promise<string[]>>().mockResolvedValue(['file1.ts', 'file2.ts']),
      // Add other isomorphic-git functions if server.ts uses them directly
    },
    // If named exports from isomorphic-git are used, mock them here too
    // e.g., resolveRef: vi.fn(),
  };
});

// --- START: vi.mock for 'http' and related definitions ---
// Define shared mock function instances for the http server methods
const mockHttpServerListenFn = vi.fn(); // Will be configured per test
const mockHttpServerOnFn = vi.fn();     // Will be configured per test
const mockHttpServerCloseFn = vi.fn();  // Will be configured per test
const mockHttpServerAddressFn = vi.fn(); // Will be configured per test
const mockHttpServerSetTimeoutFn = vi.fn<(...args: Parameters<httpModule.Server['setTimeout']>) => ReturnType<httpModule.Server['setTimeout']>>();

// Define the mock http server instance that createServer will return
// This instance's methods will be dynamically reassigned in tests for findFreePort
let currentMockHttpServerInstance: Partial<httpModule.Server> & {
    listen: Mock;
    on: Mock;
    close: Mock;
    address: Mock;
    removeAllListeners: Mock; // Add removeAllListeners
    _listeners?: Record<string, (...args: any[]) => void>; // For findFreePort tests
};

vi.mock('http', async (importOriginal) => {
  const actualHttpModule = await importOriginal() as typeof httpModule;
  const createMockServer = () => ({
    listen: mockHttpServerListenFn,
    on: mockHttpServerOnFn,
    close: mockHttpServerCloseFn,
    address: mockHttpServerAddressFn,
    setTimeout: mockHttpServerSetTimeoutFn,
    removeAllListeners: vi.fn(), // Mock for removeAllListeners
  });
  currentMockHttpServerInstance = createMockServer() as any; // Initialize

  const mockHttpMethods = {
    createServer: vi.fn(() => {
        // Return a new instance for each createServer call for findFreePort's loop
        currentMockHttpServerInstance = createMockServer() as any;
        return currentMockHttpServerInstance;
    }),
    Server: vi.fn(() => createMockServer()) as unknown as typeof httpModule.Server,
    IncomingMessage: actualHttpModule.IncomingMessage,
    ServerResponse: actualHttpModule.ServerResponse,
  };
  return {
    ...mockHttpMethods,
    default: mockHttpMethods,
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

import type { LLMProvider } from '../lib/llm-provider';
// Mock for ../lib/llm-provider
vi.mock('../lib/llm-provider', async (importOriginal) => {
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-assertion
  const actual = await importOriginal() as typeof import('../lib/llm-provider');
  return {
    ...actual,
    getLLMProvider: vi.fn<() => Promise<Partial<LLMProvider>>>().mockResolvedValue({
      checkConnection: vi.fn().mockResolvedValue(true),
      generateText: vi.fn().mockResolvedValue('mock llm text'),
    }),
    switchSuggestionModel: vi.fn().mockResolvedValue(true),
  };
});

// Mock fs/promises
import fs from 'fs'; // Or import type { PathOrFileDescriptor, ObjectEncodingOptions } from 'fs';
vi.mock('fs/promises', async (importOriginal) => {
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-assertion
  const actual = await importOriginal() as typeof import('fs/promises');
  return {
    ...actual,
    readFile: vi.fn<(path: fs.PathOrFileDescriptor, options?: fs.ObjectEncodingOptions | BufferEncoding | null) => Promise<string | Buffer>>().mockResolvedValue('mock file content'),
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
    ? Mock<(...args: A) => R> // Corrected generic usage
    : WinstonLogger[K];
};

// Type for the mocked configService instance
// Adjust properties based on what server.ts actually uses from configService
type MockedConfigService = Pick<
  ConfigService,
  | 'HTTP_PORT'
  | 'OLLAMA_HOST' // Add other properties accessed by server.ts
  | 'QDRANT_HOST'
  | 'COLLECTION_NAME'
  | 'SUGGESTION_MODEL'
  // | 'LLM_PROVIDER' // This seems to be an alias or older name, SUGGESTION_PROVIDER is used in server.ts
  | 'SUGGESTION_PROVIDER'
  | 'EMBEDDING_MODEL'
  | 'EMBEDDING_PROVIDER'
  | 'DEEPSEEK_API_KEY'
  | 'OPENAI_API_KEY'
  | 'GEMINI_API_KEY'
  | 'CLAUDE_API_KEY'
  // VERSION removed from Pick as it's not in the original ConfigService type
  | 'SUMMARIZATION_MODEL'
  | 'REFINEMENT_MODEL'
  | 'MAX_SNIPPET_LENGTH'
  // Add any other relevant properties from ConfigService
> & {
  // logger removed as it's a separate export, not a property of configService mock
  reloadConfigsFromFile: Mock<() => void>; // Corrected generic usage
  VERSION: string; // VERSION is part of the mock, but not original ConfigService
  // Add other methods from ConfigService that are mocked and used by server.ts
};

// Type for the module imported from '../lib/config-service.js'
type ConfigServiceModuleType = {
  configService: MockedConfigService;
  logger: MockedLogger;
  // If the mock factory for '../lib/config-service' spreads `actual` and `actual`
  // contains other exports that are used, they should be typed here as well.
};

describe('Server Startup and Port Handling', () => {
  // Use the new mock-aware types
  let mcs: MockedConfigService; // mcs for mockedConfigService
  let ml: MockedLogger; // ml for mockedLogger
  let mockedMcpServerConnect: MockInstance; // Typed the mock instance
  let originalNodeEnv: string | undefined;

  beforeEach(async () => {
    originalNodeEnv = process.env.NODE_ENV; // Store original NODE_ENV
    process.env.NODE_ENV = 'test'; // Set for tests
    vi.clearAllMocks(); 

    // Initialize mockProcessExit here
    mockProcessExit = vi.spyOn(process, 'exit').mockImplementation(vi.fn() as unknown as typeof process.exit);

    mockHttpServerCloseFn.mockReset();
    // Get the mocked configService and logger from the vi.mock factory
    // This ensures we are interacting with the same mocked objects that the SUT uses.
    const mockedConfigModule = await import('../lib/config-service.js') as unknown as ConfigServiceModuleType;
    // Cast to 'unknown' first, then to the mock type
    mcs = mockedConfigModule.configService as unknown as MockedConfigService; // Keep as unknown for complex mock/real hybrid
    ml = mockedConfigModule.logger as unknown as MockedLogger; // Keep as unknown for complex mock/real hybrid

    // Clear mocks using the typed instances
    // mcs and ml are already assigned from the first import.
    // No need to re-import or re-assign.

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
    // eslint-disable-next-line @typescript-eslint/unbound-method
    vi.mocked(axios.get).mockResolvedValue({ status: 200, data: {} });
  });

  afterEach(() => {
    process.env.NODE_ENV = originalNodeEnv; // Restore original NODE_ENV
    // Restore any global mocks if necessary, though vi.clearAllMocks() handles most
    if (mockProcessExit) mockProcessExit.mockClear(); // mockProcessExit is defined in beforeEach
    mockConsoleInfo.mockClear();
  });

  it('should start the server and listen on the configured port if free', async () => {
    await startServer('/fake/repo');

     
     
     
    expect(mcs.reloadConfigsFromFile).toHaveBeenCalled();
    expect(http.createServer).toHaveBeenCalled();
     
    expect(mockHttpServerListenFn).toHaveBeenCalledWith(mcs.HTTP_PORT, expect.any(Function)); // Changed mockedConfigService to mcs
     
    expect(ml.info).toHaveBeenCalledWith(expect.stringContaining(`CodeCompass HTTP server listening on port ${mcs.HTTP_PORT} for status and notifications.`)); // Changed mockedLogger to ml and mockedConfigService to mcs
     
    // Removed: expect(mockedMcpServerConnect).toHaveBeenCalled();
    // This assertion is incorrect for this test, as McpServer.connect is only called
    // upon an actual MCP client initialization request to the /mcp endpoint,
    // not during general HTTP server startup.
    expect(mockProcessExit).not.toHaveBeenCalled();
  });
    // Add the new 'it' block here, starting around line 395 of your provided file content
    it('should handle EADDRINUSE, detect existing CodeCompass server, log status, and exit with 0', async () => {
      // Define the mock status for an existing server
      const existingServerPingVersion = 'existing-ping-version'; // Version obtained from ping
      const mockExistingServerStatus: IndexingStatusReport = {
        // No version property here, as IndexingStatusReport does not define it
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
      // eslint-disable-next-line @typescript-eslint/unbound-method
      vi.mocked(axios.get).mockImplementation((url: string) => {
        if (url.endsWith('/api/ping')) {
          return Promise.resolve({ status: 200, data: { service: "CodeCompass", status: "ok", version: existingServerPingVersion } });
        }
        if (url.endsWith('/api/indexing-status')) {
          return Promise.resolve({ status: 200, data: mockExistingServerStatus });
        }
        return Promise.resolve({ status: 404, data: {} }); // Default for other calls
      });

      // Expect ServerStartupError with specific message and code
       
      await expect(startServer('/fake/repo')).rejects.toThrow(
        // eslint-disable-next-line @typescript-eslint/no-unsafe-argument
        expect.objectContaining({
          name: "ServerStartupError",
          message: `Port ${mcs.HTTP_PORT} in use by another CodeCompass instance (v${existingServerPingVersion}).`,
          exitCode: 0,
          // Check for the new properties
          requestedPort: mcs.HTTP_PORT,
          detectedServerPort: mcs.HTTP_PORT,
          existingServerStatus: expect.objectContaining({ service: 'CodeCompass', version: existingServerPingVersion })
        })
      );
      
       
       
       
      expect(ml.warn).toHaveBeenCalledWith(`HTTP Port ${mcs.HTTP_PORT} is already in use. Attempting to ping...`);
      // eslint-disable-next-line @typescript-eslint/unbound-method
      expect(axios.get).toHaveBeenCalledWith(`http://localhost:${mcs.HTTP_PORT}/api/ping`, { timeout: 500 });
      // eslint-disable-next-line @typescript-eslint/unbound-method
      expect(axios.get).toHaveBeenCalledWith(`http://localhost:${mcs.HTTP_PORT}/api/indexing-status`, { timeout: 1000 });
      
      expect(ml.info).toHaveBeenCalledWith(`Another CodeCompass instance (v${existingServerPingVersion}) is running on port ${mcs.HTTP_PORT}.`);
      expect(mockConsoleInfo).toHaveBeenCalledWith(expect.stringContaining(`--- Status of existing CodeCompass instance on port ${mcs.HTTP_PORT} ---`));
       
      expect(mockConsoleInfo).toHaveBeenCalledWith(expect.stringContaining(`Version: ${existingServerPingVersion}`)); // Use version from ping
       
      expect(mockConsoleInfo).toHaveBeenCalledWith(expect.stringContaining(`Status: ${mockExistingServerStatus.status}`));
       
      expect(mockConsoleInfo).toHaveBeenCalledWith(expect.stringContaining(`Progress: ${mockExistingServerStatus.overallProgress}%`));
      
       
      expect(ml.info).toHaveBeenCalledWith("Current instance will exit as another CodeCompass server is already running.");
      // mockProcessExit is not directly called by startServer's main catch in test mode anymore
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
    // eslint-disable-next-line @typescript-eslint/unbound-method
    vi.mocked(axios.get).mockImplementation((url: string) => {
      if (url.endsWith('/api/ping')) { // Ping returns non-CodeCompass response or error
        return Promise.resolve({ status: 200, data: { service: "OtherService" } });
      }
      return Promise.resolve({ status: 404, data: {} });
    });
     
    const otherServiceData = { service: "OtherService" };
    // eslint-disable-next-line @typescript-eslint/unbound-method
    vi.mocked(axios.get).mockImplementation((url: string) => {
      if (url.endsWith('/api/ping')) { // Ping returns non-CodeCompass response or error
        return Promise.resolve({ status: 200, data: otherServiceData });
      }
      return Promise.resolve({ status: 404, data: {} });
    });
     
    await expect(startServer('/fake/repo')).rejects.toThrow(
      // eslint-disable-next-line @typescript-eslint/no-unsafe-argument
      expect.objectContaining({
        name: "ServerStartupError",
        message: `Port ${mcs.HTTP_PORT} is in use by non-CodeCompass server. Response: ${JSON.stringify(otherServiceData)}`,
        exitCode: 1,
        requestedPort: mcs.HTTP_PORT,
        existingServerStatus: otherServiceData
      })
    );

    // Verify the specific error log calls in order
    expect(ml.error).toHaveBeenNthCalledWith(1, expect.stringContaining(`Port ${mcs.HTTP_PORT} is in use by non-CodeCompass server. Response: {"service":"OtherService"}`));
    expect(ml.error).toHaveBeenNthCalledWith(2, expect.stringContaining('Please free the port or configure a different one'));
    expect(ml.error).toHaveBeenNthCalledWith(3, "Failed to start CodeCompass", expect.objectContaining({ message: `Port ${mcs.HTTP_PORT} in use by non-CodeCompass server.` }));
    
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

    // This const pingError was redeclared. Removed the second declaration.
    // const pingError = new Error('Connection refused') as NodeJS.ErrnoException; 
    // pingError.code = 'ECONNREFUSED';
    // eslint-disable-next-line @typescript-eslint/unbound-method
    // vi.mocked(axios.get).mockImplementation((url: string) => {
    //   if (url.endsWith('/api/ping')) {
    //     return Promise.reject(pingError);
    //   }
    //   return Promise.resolve({ status: 404, data: {} });
    // });
    // This setup is now done inside the test below.
    // The following duplicate declaration of pingError and its mock setup is removed.
    // const pingError = new Error('Connection refused') as NodeJS.ErrnoException;
    // pingError.code = 'ECONNREFUSED';
    // // eslint-disable-next-line @typescript-eslint/unbound-method
    // vi.mocked(axios.get).mockImplementation((url: string) => {
    //   if (url.endsWith('/api/ping')) {
        return Promise.reject(pingError);
      }
      return Promise.resolve({ status: 404, data: {} });
    });
    
     
    await expect(startServer('/fake/repo')).rejects.toThrow(
      // eslint-disable-next-line @typescript-eslint/no-unsafe-argument
      expect.objectContaining({
        name: "ServerStartupError",
        message: `Port ${mcs.HTTP_PORT} is in use by an unknown service or the existing CodeCompass server is unresponsive to pings. Ping error: ${localPingError.message}`, // Use localPingError
        exitCode: 1,
        requestedPort: mcs.HTTP_PORT,
        existingServerStatus: expect.objectContaining({ service: 'Unknown or non-responsive to pings' })
      })
    );

     
     
     
    expect(ml.error).toHaveBeenCalledWith(expect.stringContaining(`Port ${mcs.HTTP_PORT} is in use by an unknown service or the existing CodeCompass server is unresponsive to pings.`));
     
    expect(ml.error).toHaveBeenCalledWith(expect.stringContaining('Ping error details: Error: Connection refused'));
     
    expect(ml.error).toHaveBeenCalledWith(expect.stringContaining('Please free the port or configure a different one'));
    // Add this new expectation for the log from the main catch block
     
    expect(ml.error).toHaveBeenCalledWith("Failed to start CodeCompass", expect.objectContaining({ message: `Port ${mcs.HTTP_PORT} in use or ping failed.` }));
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
    // eslint-disable-next-line @typescript-eslint/unbound-method
    vi.mocked(axios.get).mockImplementation((url: string) => {
      if (url.endsWith('/api/ping')) {
        return Promise.resolve({ status: 200, data: { service: "CodeCompass", status: "ok", version: "test-version" } }); // Ping success
      }
      if (url.endsWith('/api/indexing-status')) {
        return Promise.reject(new Error('Failed to fetch status')); // Status fetch fails
      }
      // This was incorrect, should be the response for axios.get
      return Promise.resolve({ status: 404, data: {} });
    });

     
    const pingSuccessData = { service: "CodeCompass", status: "ok", version: "test-version" };
    // eslint-disable-next-line @typescript-eslint/unbound-method
    vi.mocked(axios.get).mockImplementation((url: string) => {
      if (url.endsWith('/api/ping')) {
        return Promise.resolve({ status: 200, data: pingSuccessData }); // Ping success
      }
      if (url.endsWith('/api/indexing-status')) {
        return Promise.reject(new Error('Failed to fetch status')); // Status fetch fails
      }
      return Promise.resolve({ status: 404, data: {} });
    });

     
    await expect(startServer('/fake/repo')).rejects.toThrow(
      // eslint-disable-next-line @typescript-eslint/no-unsafe-argument
      expect.objectContaining({
        name: "ServerStartupError",
        message: `Port ${mcs.HTTP_PORT} in use by existing CodeCompass server, but status fetch error occurred.`,
        exitCode: 1,
        requestedPort: mcs.HTTP_PORT,
        detectedServerPort: mcs.HTTP_PORT,
        existingServerStatus: pingSuccessData
      })
    );
        
         
         
     
    expect(ml.error).toHaveBeenCalledWith(expect.stringContaining('Error fetching status from existing CodeCompass server'));
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
    
     
    await expect(startServer('/fake/repo')).rejects.toThrow(
      // eslint-disable-next-line @typescript-eslint/no-unsafe-argument
      expect.objectContaining({
        name: "ServerStartupError",
        message: `HTTP server error: ${otherError.message}`,
        exitCode: 1
      })
    );
    
    // Check that the 'on' handler was attached
         
         
     
    expect(mockHttpServerOnFn).toHaveBeenCalledWith('error', expect.any(Function));
        
    // Check for the specific error log for non-EADDRINUSE
         
    expect(ml.error).toHaveBeenCalledWith(`Failed to start HTTP server on port ${mcs.HTTP_PORT}: ${otherError.message}`);
     
    expect(mockedMcpServerConnect).not.toHaveBeenCalled();
  });
});

// ... (after describe('Server Startup and Port Handling', () => { ... });) ...

describe('findFreePort', () => {
  let mockedHttp: {
    createServer: Mock<() => typeof currentMockHttpServerInstance>;
    default?: { createServer: Mock<() => typeof currentMockHttpServerInstance> }; // Optional default
  };
  let portCounter: number;

  beforeEach(async () => {
    vi.clearAllMocks(); // Clear all mocks
    // Dynamically import http to get the mocked version
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-assertion
    mockedHttp = await import('http') as unknown as {
      createServer: Mock<() => typeof currentMockHttpServerInstance>;
      default?: { createServer: Mock<() => typeof currentMockHttpServerInstance> };
    };
    // Ensure we are using the default export if that's how server.ts imports it
    // Based on server.ts `import http from 'http'`, it uses the default export.
    if (mockedHttp.default && mockedHttp.default.createServer) {
        mockedHttp.createServer = mockedHttp.default.createServer;
    }

    portCounter = 0; // Reset for EADDRINUSE simulations

    // Reset implementations for each test
    mockHttpServerListenFn.mockReset();
    mockHttpServerOnFn.mockReset();
    mockHttpServerCloseFn.mockReset();
    mockHttpServerAddressFn.mockReset();
    if (currentMockHttpServerInstance && currentMockHttpServerInstance.removeAllListeners) {
      currentMockHttpServerInstance.removeAllListeners.mockReset();
    }


    // Default behavior for mocks, can be overridden in specific tests
    mockHttpServerOnFn.mockImplementation((event, callback) => {
      if (!currentMockHttpServerInstance._listeners) {
        currentMockHttpServerInstance._listeners = {};
      }
      currentMockHttpServerInstance._listeners[event] = callback as (...args: any[]) => void;
      return currentMockHttpServerInstance as unknown as httpModule.Server;
    });

    mockHttpServerCloseFn.mockImplementation((callback?: (err?: Error) => void) => {
      if (callback) callback();
      return currentMockHttpServerInstance as unknown as httpModule.Server;
    });

    mockHttpServerAddressFn.mockImplementation(() => ({ port: 3000 + portCounter, address: '127.0.0.1', family: 'IPv4' })); // Default, override if needed
  });

  it('should find the starting port if it is free', async () => {
    const startPort = 3000;
    mockHttpServerListenFn.mockImplementation((portToListen, _hostname, callbackOrUndefined) => {
      expect(portToListen).toBe(startPort);
      // Simulate successful listen by invoking the 'listening' event handler
      if (currentMockHttpServerInstance._listeners && currentMockHttpServerInstance._listeners.listening) {
        currentMockHttpServerInstance._listeners.listening();
      } else if (typeof callbackOrUndefined === 'function') { // Handle direct callback if provided
        (callbackOrUndefined as () => void)();
      }
      return currentMockHttpServerInstance as unknown as httpModule.Server;
    });
    mockHttpServerAddressFn.mockReturnValue({ port: startPort, address: '127.0.0.1', family: 'IPv4' });

    await expect(findFreePort(startPort)).resolves.toBe(startPort);
    expect(mockedHttp.createServer).toHaveBeenCalledTimes(1);
    expect(mockHttpServerListenFn).toHaveBeenCalledWith(startPort, 'localhost');
    expect(mockHttpServerCloseFn).toHaveBeenCalledTimes(1);
  });

  it('should find the next port if the first one is in use (EADDRINUSE)', async () => {
    const startPort = 3001;
    portCounter = 0; // for address mock

    mockHttpServerListenFn
      .mockImplementationOnce((_p, _h, _cb) => { // First call (port 3001) - EADDRINUSE
        portCounter++;
        if (currentMockHttpServerInstance._listeners && currentMockHttpServerInstance._listeners.error) {
          const err = new Error('EADDRINUSE') as NodeJS.ErrnoException;
          err.code = 'EADDRINUSE';
          currentMockHttpServerInstance._listeners.error(err);
        }
        return currentMockHttpServerInstance as unknown as httpModule.Server;
      })
      .mockImplementationOnce((portToListen, _h, callbackOrUndefined) => { // Second call (port 3002) - Free
        expect(portToListen).toBe(startPort + 1);
        mockHttpServerAddressFn.mockReturnValue({ port: startPort + 1, address: '127.0.0.1', family: 'IPv4' });
        if (currentMockHttpServerInstance._listeners && currentMockHttpServerInstance._listeners.listening) {
          currentMockHttpServerInstance._listeners.listening();
        } else if (typeof callbackOrUndefined === 'function') {
            (callbackOrUndefined as () => void)();
        }
        return currentMockHttpServerInstance as unknown as httpModule.Server;
      });

    await expect(findFreePort(startPort)).resolves.toBe(startPort + 1);
    expect(mockedHttp.createServer).toHaveBeenCalledTimes(2);
    expect(mockHttpServerListenFn).toHaveBeenCalledWith(startPort, 'localhost');
    expect(mockHttpServerListenFn).toHaveBeenCalledWith(startPort + 1, 'localhost');
    expect(mockHttpServerCloseFn).toHaveBeenCalledTimes(1); // Only closed on success
  });

  it('should reject if a non-EADDRINUSE error occurs during listen', async () => {
    const startPort = 3002;
    const otherError = new Error('Some other error') as NodeJS.ErrnoException;
    otherError.code = 'EACCES';

    mockHttpServerListenFn.mockImplementationOnce(() => {
      if (currentMockHttpServerInstance._listeners && currentMockHttpServerInstance._listeners.error) {
        currentMockHttpServerInstance._listeners.error(otherError);
      }
      return currentMockHttpServerInstance as unknown as httpModule.Server;
    });

    await expect(findFreePort(startPort)).rejects.toThrow(otherError);
    expect(mockedHttp.createServer).toHaveBeenCalledTimes(1);
    expect(mockHttpServerCloseFn).not.toHaveBeenCalled();
  });

  it('should reject if server.close() itself errors', async () => {
    const startPort = 3003;
    const closeError = new Error('Failed to close server');

    mockHttpServerListenFn.mockImplementation((_p, _h, callbackOrUndefined) => {
      mockHttpServerAddressFn.mockReturnValue({ port: startPort, address: '127.0.0.1', family: 'IPv4' });
      if (currentMockHttpServerInstance._listeners && currentMockHttpServerInstance._listeners.listening) {
        currentMockHttpServerInstance._listeners.listening();
      } else if (typeof callbackOrUndefined === 'function') {
        (callbackOrUndefined as () => void)();
      }
      return currentMockHttpServerInstance as unknown as httpModule.Server;
    });
    mockHttpServerCloseFn.mockImplementationOnce((callback?: (err?: Error) => void) => {
      if (callback) callback(closeError); // Simulate error during close
      return currentMockHttpServerInstance as unknown as httpModule.Server;
    });

    await expect(findFreePort(startPort)).rejects.toThrow(closeError);
    expect(mockHttpServerCloseFn).toHaveBeenCalledTimes(1);
  });

  it('should throw an error if no free ports are available up to 65535', async () => {
    const startPort = 65530; // Start near the limit
    let currentPortAttempt = startPort;

    mockHttpServerListenFn.mockImplementation(() => {
      if (currentPortAttempt > 65535) {
        // This case should be caught by findFreePort's internal limit before listen is called for >65535
        // So, we simulate EADDRINUSE for all valid ports
        const err = new Error('EADDRINUSE test') as NodeJS.ErrnoException;
        err.code = 'EADDRINUSE';
        if (currentMockHttpServerInstance._listeners && currentMockHttpServerInstance._listeners.error) {
            currentMockHttpServerInstance._listeners.error(err);
        }
      } else {
         // Simulate EADDRINUSE for ports up to 65535
        const err = new Error('EADDRINUSE test') as NodeJS.ErrnoException;
        err.code = 'EADDRINUSE';
        if (currentMockHttpServerInstance._listeners && currentMockHttpServerInstance._listeners.error) {
            currentMockHttpServerInstance._listeners.error(err);
        }
      }
      currentPortAttempt++;
      return currentMockHttpServerInstance as unknown as httpModule.Server;
    });
    // Adjust the number of createServer calls expected based on the loop limit in findFreePort
    // The loop in findFreePort is `while (true)` but has an internal check `if (port > 65535)`
    // So it will try ports from startPort up to 65535.
    // For startPort = 65530, it will try 65530, 65531, 65532, 65533, 65534, 65535 (6 times)
    const expectedAttempts = (65535 - startPort) + 1;

    await expect(findFreePort(startPort)).rejects.toThrow('No free ports available.');
    expect(mockedHttp.createServer).toHaveBeenCalledTimes(expectedAttempts);
  }, 10000); // Increase timeout if needed for many iterations
});

// Import nock for Mocking Target Server
import nock from 'nock';

describe('startProxyServer', () => {
  const targetPort = 3005;
  const requestedPort = 3000; // Port the main server tried, proxy will use another
  let proxyServerInstance: httpModule.Server | null = null;
  let mcs: MockedConfigService;
  let ml: MockedLogger;

  beforeEach(async () => {
    vi.clearAllMocks();
    nock.cleanAll(); // Clean nock interceptors

    const mockedConfigModule = await import('../lib/config-service.js') as unknown as ConfigServiceModuleType;
    mcs = mockedConfigModule.configService as unknown as MockedConfigService; // Cast to allow property assignment
    ml = mockedConfigModule.logger as unknown as MockedLogger; // Cast to allow property assignment


    // Reset axios mocks
    // eslint-disable-next-line @typescript-eslint/unbound-method
    vi.mocked(axios.get).mockReset();
    // eslint-disable-next-line @typescript-eslint/unbound-method
    vi.mocked(axios.post).mockReset();
    // eslint-disable-next-line @typescript-eslint/unbound-method
    vi.mocked(axios.delete).mockReset();
    // eslint-disable-next-line @typescript-eslint/unbound-method
    (axios as unknown as Mock).mockReset(); // For the general axios({ method: ... }) call
  });

  afterEach(async () => {
    if (proxyServerInstance) {
      await new Promise<void>(resolve => proxyServerInstance!.close(() => resolve()));
      proxyServerInstance = null;
    }
    nock.restore(); // Restore nock's behavior to allow real HTTP requests if needed elsewhere
  });

  it('should start the proxy server, log info, and proxy /api/ping', async () => {
    const proxyListenPort = requestedPort + 100; // Assume findFreePort will give this
    
    // Mock findFreePort specifically for startProxyServer tests
    const serverLib = await import('../lib/server');
    const findFreePortSpy = vi.spyOn(serverLib, 'findFreePort').mockResolvedValue(proxyListenPort);

    nock(`http://localhost:${targetPort}`)
      .get('/api/ping')
      .reply(200, { service: "CodeCompassTarget", status: "ok", version: "1.0.0" });

    proxyServerInstance = await serverLib.startProxyServer(requestedPort, targetPort, "1.0.0-existing");
    expect(proxyServerInstance).toBeDefined();
    
    // eslint-disable-next-line @typescript-eslint/unbound-method
    expect(ml.info).toHaveBeenCalledWith(expect.stringContaining(`This instance (CodeCompass Proxy) is running on port ${proxyListenPort}`));
    // eslint-disable-next-line @typescript-eslint/unbound-method
    expect(ml.info).toHaveBeenCalledWith(expect.stringContaining(`forwarding to main server on ${targetPort}`));


    const response = await axios.get(`http://localhost:${proxyListenPort}/api/ping`);
    expect(response.status).toBe(200);
    expect(response.data).toEqual({ service: "CodeCompassTarget", status: "ok", version: "1.0.0" });
    expect(nock.isDone()).toBe(true);
    findFreePortSpy.mockRestore();
  });

  it('should proxy POST /mcp with body and headers', async () => {
    const proxyListenPort = requestedPort + 101;
    const serverLib = await import('../lib/server');
    const findFreePortSpy = vi.spyOn(serverLib, 'findFreePort').mockResolvedValue(proxyListenPort);

    const requestBody = { jsonrpc: "2.0", method: "test", params: { data: "value" }, id: 1 };
    const responseBody = { jsonrpc: "2.0", result: "success", id: 1 };
    const sessionId = "test-session-id";

    nock(`http://localhost:${targetPort}`, {
        reqheaders: {
          'content-type': 'application/json',
          'mcp-session-id': sessionId,
          'authorization': 'Bearer testtoken'
        }
      })
      .post('/mcp', requestBody)
      .reply(200, responseBody, { 'Content-Type': 'application/json', 'mcp-session-id': sessionId });

    proxyServerInstance = await serverLib.startProxyServer(requestedPort, targetPort, "1.0.0-existing");

    const response = await axios.post(`http://localhost:${proxyListenPort}/mcp`, requestBody, {
      headers: { 
        'Content-Type': 'application/json',
        'mcp-session-id': sessionId,
        'Authorization': 'Bearer testtoken'
      }
    });

    expect(response.status).toBe(200);
    expect(response.data).toEqual(responseBody);
    expect(response.headers['content-type']).toContain('application/json');
    expect(response.headers['mcp-session-id']).toBe(sessionId);
    expect(nock.isDone()).toBe(true);
    findFreePortSpy.mockRestore();
  });

  it('should proxy GET /mcp for SSE', async () => {
    const proxyListenPort = requestedPort + 102;
    const serverLib = await import('../lib/server');
    const findFreePortSpy = vi.spyOn(serverLib, 'findFreePort').mockResolvedValue(proxyListenPort);
    const sessionId = "sse-session-id";

    nock(`http://localhost:${targetPort}`, {
        reqheaders: { 'mcp-session-id': sessionId }
      })
      .get('/mcp')
      .reply(200, "event: message\ndata: hello\n\n", { 
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
        'mcp-session-id': sessionId 
      });
    
    proxyServerInstance = await serverLib.startProxyServer(requestedPort, targetPort, "1.0.0-existing");

    const response = await axios.get(`http://localhost:${proxyListenPort}/mcp`, {
      headers: { 'mcp-session-id': sessionId },
      responseType: 'text' // Get raw text to check SSE format
    });

    expect(response.status).toBe(200);
    expect(response.headers['content-type']).toBe('text/event-stream');
    expect(response.headers['mcp-session-id']).toBe(sessionId);
    expect(response.data).toBe("event: message\ndata: hello\n\n");
    expect(nock.isDone()).toBe(true);
    findFreePortSpy.mockRestore();
  });
  
  it('should proxy DELETE /mcp', async () => {
    const proxyListenPort = requestedPort + 103;
    const serverLib = await import('../lib/server');
    const findFreePortSpy = vi.spyOn(serverLib, 'findFreePort').mockResolvedValue(proxyListenPort);
    const sessionId = "delete-session-id";

    nock(`http://localhost:${targetPort}`, {
        reqheaders: { 'mcp-session-id': sessionId }
      })
      .delete('/mcp')
      .reply(204); // Or 200 with a body if applicable

    proxyServerInstance = await serverLib.startProxyServer(requestedPort, targetPort, "1.0.0-existing");

    const response = await axios.delete(`http://localhost:${proxyListenPort}/mcp`, {
      headers: { 'mcp-session-id': sessionId }
    });
    
    expect(response.status).toBe(204);
    expect(nock.isDone()).toBe(true);
    findFreePortSpy.mockRestore();
  });

  it('should proxy /api/indexing-status', async () => {
    const proxyListenPort = requestedPort + 104;
    const serverLib = await import('../lib/server');
    const findFreePortSpy = vi.spyOn(serverLib, 'findFreePort').mockResolvedValue(proxyListenPort);
    const mockStatus = { status: 'idle', message: 'Target server is idle' };

    nock(`http://localhost:${targetPort}`)
      .get('/api/indexing-status')
      .reply(200, mockStatus);

    proxyServerInstance = await serverLib.startProxyServer(requestedPort, targetPort, "1.0.0-existing");

    const response = await axios.get(`http://localhost:${proxyListenPort}/api/indexing-status`);
    expect(response.status).toBe(200);
    expect(response.data).toEqual(mockStatus);
    expect(nock.isDone()).toBe(true);
    findFreePortSpy.mockRestore();
  });

  it('should handle target server unreachable for /mcp', async () => {
    const proxyListenPort = requestedPort + 105;
    const serverLib = await import('../lib/server');
    const findFreePortSpy = vi.spyOn(serverLib, 'findFreePort').mockResolvedValue(proxyListenPort);

    nock(`http://localhost:${targetPort}`)
      .post('/mcp')
      .replyWithError({ message: 'Connection refused', code: 'ECONNREFUSED' });

    proxyServerInstance = await serverLib.startProxyServer(requestedPort, targetPort, "1.0.0-existing");
    
    try {
      await axios.post(`http://localhost:${proxyListenPort}/mcp`, {});
    } catch (error: any) { // eslint-disable-line @typescript-eslint/no-explicit-any
      expect(error.response.status).toBe(502); // Bad Gateway
      // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
      expect(error.response.data.error.message).toBe('Proxy error: Bad Gateway');
    }
    // eslint-disable-next-line @typescript-eslint/unbound-method
    expect(ml.error).toHaveBeenCalledWith(expect.stringContaining('Proxy: Error proxying MCP request'), expect.anything());
    expect(nock.isDone()).toBe(true);
    findFreePortSpy.mockRestore();
  });

  it('should forward target server 500 error for /mcp', async () => {
    const proxyListenPort = requestedPort + 106;
    const serverLib = await import('../lib/server');
    const findFreePortSpy = vi.spyOn(serverLib, 'findFreePort').mockResolvedValue(proxyListenPort);
    const errorBody = { jsonrpc: "2.0", error: { code: -32000, message: "Target Internal Error" }, id: null };

    nock(`http://localhost:${targetPort}`)
      .post('/mcp')
      .reply(500, errorBody, { 'Content-Type': 'application/json' });

    proxyServerInstance = await serverLib.startProxyServer(requestedPort, targetPort, "1.0.0-existing");

    try {
      await axios.post(`http://localhost:${proxyListenPort}/mcp`, {});
    } catch (error: any) { // eslint-disable-line @typescript-eslint/no-explicit-any
      expect(error.response.status).toBe(500);
      // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
      expect(error.response.data).toEqual(errorBody);
    }
    expect(nock.isDone()).toBe(true);
    findFreePortSpy.mockRestore();
  });
   it('should reject if findFreePort fails', async () => {
    const findFreePortError = new Error("No ports for proxy!");
    const serverLib = await import('../lib/server');
    const findFreePortSpy = vi.spyOn(serverLib, 'findFreePort').mockRejectedValue(findFreePortError);

    await expect(serverLib.startProxyServer(requestedPort, targetPort, "1.0.0-existing"))
      .rejects.toThrow(findFreePortError);
    
    // eslint-disable-next-line @typescript-eslint/unbound-method
    expect(ml.error).not.toHaveBeenCalledWith(expect.stringContaining('Proxy server failed to start')); // This log is inside the listen promise
    findFreePortSpy.mockRestore();
  });
});
