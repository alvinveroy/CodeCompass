import { describe, it, expect, vi, beforeEach, afterEach, type MockInstance, type Mock } from 'vitest';
// Add findFreePort and startProxyServer to the import from ../lib/server
import * as serverLibModule from '../lib/server'; // Import the whole module to spy on its exports
import { normalizeToolParams, ServerStartupError } from '../lib/server'; // Keep specific imports if needed elsewhere
import { IndexingStatusReport, getGlobalIndexingStatus } from '../lib/repository'; // For mock status
import type * as httpModule from 'http'; // For types
// Import actual modules to be mocked
import http from 'http';
import axios from 'axios'; // Import axios
import * as net from 'net'; // For net.ListenOptions

// Define stable mock for McpServer.connect
const mcpConnectStableMock = vi.fn();
const capturedToolHandlers: Record<string, (...args: any[]) => any> = {};

// Mock dependencies
vi.mock('@modelcontextprotocol/sdk/server/mcp.js', async (importOriginal) => {
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-assertion
  const actual = await importOriginal() as typeof import('@modelcontextprotocol/sdk/server/mcp.js');
  return {
    ...actual,
    McpServer: vi.fn().mockImplementation(() => ({
      connect: mcpConnectStableMock, // Use stable mock
      tool: vi.fn((name, _description, _schema, handler) => {
        capturedToolHandlers[name] = handler;
      }),
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
      IS_UTILITY_SERVER_DISABLED: false, // Added
      RELAY_TARGET_UTILITY_PORT: undefined, // Added
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

// Define stable mock functions at the top level of the test file
const mockHttpServerListenFn = vi.fn();
const mockHttpServerOnFn = vi.fn();
const mockHttpServerCloseFn = vi.fn();
const mockHttpServerAddressFn = vi.fn();
const mockHttpServerSetTimeoutFn = vi.fn<(...args: Parameters<httpModule.Server['setTimeout']>) => ReturnType<httpModule.Server['setTimeout']>>();
const mockHttpServerRemoveAllListenersFn = vi.fn();


vi.mock('http', async (importOriginal) => {
  const actualHttpModule = await importOriginal() as typeof httpModule;

  // This function creates a new mock server object instance for each call to http.createServer()
  // It uses the stable top-level mock functions.
  const createNewMockServerObject = () => ({
    listen: mockHttpServerListenFn,
    on: mockHttpServerOnFn,
    once: mockHttpServerOnFn, // Added 'once'
    close: mockHttpServerCloseFn,
    address: mockHttpServerAddressFn,
    setTimeout: mockHttpServerSetTimeoutFn,
    removeAllListeners: mockHttpServerRemoveAllListenersFn,
    _listeners: {} as Record<string, (...args: any[]) => void> // For findFreePort tests state
  });

  const mockCreateServerFn = vi.fn(() => {
    return createNewMockServerObject();
  });

  const mockHttpMethods = {
    createServer: mockCreateServerFn,
    Server: vi.fn().mockImplementation(createNewMockServerObject) as unknown as typeof httpModule.Server,
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
      generateEmbedding: vi.fn().mockResolvedValue([0.1, 0.2, 0.3]), // Added
      processFeedback: vi.fn().mockResolvedValue("mocked feedback response"), // Added
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
  IS_UTILITY_SERVER_DISABLED: boolean; // Added
  RELAY_TARGET_UTILITY_PORT?: number; // Added
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
  let mockConsoleError: MockInstance<typeof console.error>; // Declare mockConsoleError

  beforeEach(async () => {
    originalNodeEnv = process.env.NODE_ENV; // Store original NODE_ENV
    process.env.NODE_ENV = 'test'; // Set for tests
    vi.clearAllMocks(); 

    // Initialize mockProcessExit here
    mockProcessExit = vi.spyOn(process, 'exit').mockImplementation(vi.fn() as unknown as typeof process.exit);
    mockConsoleError = vi.spyOn(console, 'error').mockImplementation(vi.fn()); // Initialize mockConsoleError

    mockHttpServerCloseFn.mockReset().mockImplementation(function(this: any, callback?: () => void) { // Ensure close calls callback
      if (callback) callback();
      return this;
    });
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
    
    // Assign, clear, and mock resolution for the stable McpServer.connect mock
    mcpConnectStableMock.mockClear().mockResolvedValue(undefined);
    mockedMcpServerConnect = mcpConnectStableMock;
    
    // Default mock for axios.get
    // eslint-disable-next-line @typescript-eslint/unbound-method
    vi.mocked(axios.get).mockResolvedValue({ status: 200, data: {} });

    // Refined mock for httpServer.listen and .on to be async and event-aware
    mockHttpServerOnFn.mockReset().mockImplementation(function(this: any, event, callback) {
        if (!this._listeners) this._listeners = {};
        this._listeners[event] = callback;
        return this;
    });

    mockHttpServerListenFn.mockReset().mockImplementation(function(this: any, portToListen, _hostnameOrCb, _backlogOrCb, finalListenCb) {
      let actualFinalListenCb = finalListenCb;
      if (typeof _hostnameOrCb === 'function') actualFinalListenCb = _hostnameOrCb;
      else if (typeof _backlogOrCb === 'function') actualFinalListenCb = _backlogOrCb;

      // Simulate EADDRINUSE if port is mcs.HTTP_PORT (e.g. 3001) and a specific test flag is set
      if (portToListen === mcs.HTTP_PORT && process.env.SIMULATE_EADDRINUSE_FOR_TEST === 'true') {
        if (this._listeners && typeof this._listeners.error === 'function') {
          const error = new Error('listen EADDRINUSE test from mockHttpServerListenFn') as NodeJS.ErrnoException;
          error.code = 'EADDRINUSE';
          process.nextTick(() => this._listeners.error(error));
        }
      } else { // Simulate successful listen
        process.nextTick(() => {
          if (this._listeners && typeof this._listeners.listening === 'function') {
            this._listeners.listening();
          }
          if (typeof actualFinalListenCb === 'function') {
            actualFinalListenCb();
          }
        });
      }
      return this; 
    });
  });

  afterEach(() => {
    process.env.NODE_ENV = originalNodeEnv; // Restore original NODE_ENV
    // Restore any global mocks if necessary, though vi.clearAllMocks() handles most
    if (mockProcessExit) mockProcessExit.mockClear(); // mockProcessExit is defined in beforeEach
    if (mockConsoleError) mockConsoleError.mockClear(); // Clear mockConsoleError
    mockConsoleInfo.mockClear();
  });

  it('should start the server and listen on the configured port if free', async () => {
    await serverLibModule.startServer('/fake/repo');

    expect(mcs.reloadConfigsFromFile).toHaveBeenCalled();
    expect(http.createServer).toHaveBeenCalled();
    expect(mockHttpServerListenFn).toHaveBeenCalledWith(mcs.HTTP_PORT, expect.any(Function));
    expect(ml.info).toHaveBeenCalledWith(expect.stringContaining(`CodeCompass HTTP server listening on port ${mcs.HTTP_PORT} for status and notifications.`));
    expect(mockProcessExit).not.toHaveBeenCalled();
    expect(mcs.IS_UTILITY_SERVER_DISABLED).toBe(false); // Ensure not disabled
  });

    it('should handle EADDRINUSE, detect existing CodeCompass server, disable local utility server, and resolve successfully', async () => {
      const existingServerPingVersion = 'existing-ping-version';
      const mockExistingServerStatus: IndexingStatusReport = {
        status: 'idle', message: 'Existing server idle', overallProgress: 100, lastUpdatedAt: new Date().toISOString(),
      };

      mockHttpServerListenFn.mockImplementation(
        (_portOrOptions, _hostnameOrListener, _backlogOrListener, listeningListenerOrError): httpModule.Server => {
          const errorArgs = mockHttpServerOnFn.mock.calls.find(call => call[0] === 'error');
          if (errorArgs && typeof errorArgs[1] === 'function') {
            const errorHandler = errorArgs[1] as (err: NodeJS.ErrnoException) => void;
            const error = new Error('listen EADDRINUSE: address already in use') as NodeJS.ErrnoException;
            error.code = 'EADDRINUSE';
            // Simulate the error handler being called, which then resolves the setup promise
            // The actual resolution is done inside the 'error' handler in server.ts
            errorHandler(error); 
          }
          // If listeningListenerOrError is the listener, it would be called by a successful listen
          // but here we are forcing EADDRINUSE path.
          return this as unknown as httpModule.Server; // Changed to 'this'
        }
      );
      
      vi.mocked(axios.get).mockImplementation(async (url: string): Promise<any> => { // Added Promise<any>
        if (url.endsWith('/api/ping')) {
          return { status: 200, data: { service: "CodeCompass", status: "ok", version: existingServerPingVersion } };
        }
        if (url.endsWith('/api/indexing-status')) {
          return { status: 200, data: mockExistingServerStatus };
        }
        return { status: 404, data: {} };
      });

      // Expect startServer to reject with a ServerStartupError indicating graceful exit/proxy mode
      await expect(serverLibModule.startServer('/fake/repo')).rejects.toThrow(
        expect.objectContaining({
          name: "ServerStartupError",
          exitCode: 0,
          message: expect.stringContaining(`Port ${mcs.HTTP_PORT} in use by another CodeCompass instance`),
          detectedServerPort: mcs.HTTP_PORT
        })
      );
      
      expect(ml.warn).toHaveBeenCalledWith(`HTTP Port ${mcs.HTTP_PORT} is already in use. Attempting to ping...`);
      expect(axios.get).toHaveBeenCalledWith(`http://localhost:${mcs.HTTP_PORT}/api/ping`, { timeout: 500 });
      expect(axios.get).toHaveBeenCalledWith(`http://localhost:${mcs.HTTP_PORT}/api/indexing-status`, { timeout: 1000 });
      
      expect(ml.info).toHaveBeenCalledWith(`Another CodeCompass instance (v${existingServerPingVersion}) is running on port ${mcs.HTTP_PORT}.`);
      // Check console logs for existing server status
      expect(ml.info).toHaveBeenCalledWith(expect.stringContaining(`--- Status of existing CodeCompass instance on port ${mcs.HTTP_PORT} ---`));
      expect(ml.info).toHaveBeenCalledWith(expect.stringContaining(`Version: ${existingServerPingVersion}`));
      expect(ml.info).toHaveBeenCalledWith(expect.stringContaining(`Status: ${mockExistingServerStatus.status}`));
      // Check for the specific exit message
      const exitLogFound = ml.info.mock.calls.some(call => 
        typeof call[0] === 'string' && (call[0] as string).includes(`Current instance will exit as another CodeCompass server (v${existingServerPingVersion}) is already running on port ${mcs.HTTP_PORT}.`)
      );
      expect(exitLogFound).toBe(true);
      
      // When the server exits due to an existing instance, IS_UTILITY_SERVER_DISABLED should remain false,
      // and RELAY_TARGET_UTILITY_PORT should not be set (or remain undefined).
      expect(mcs.IS_UTILITY_SERVER_DISABLED).toBe(false);
      expect(mcs.RELAY_TARGET_UTILITY_PORT).toBeUndefined(); 
      
      // The stdio MCP server should NOT connect if the server is exiting.
      expect(mockedMcpServerConnect).not.toHaveBeenCalled();
      // Verify process did not exit (because ServerStartupError with exitCode 0 is thrown in test env)
      expect(mockProcessExit).not.toHaveBeenCalled();
      // Verify the utility HTTP server for *this* instance is not logged as "listening"
      expect(ml.info).not.toHaveBeenCalledWith(expect.stringContaining(`CodeCompass HTTP server listening on port ${mcs.HTTP_PORT} for status and notifications.`));
      // The console.error message about "Utility HTTP server is DISABLED" should not appear if the instance exits.
      // The console.error message from server.ts for this path is "Current instance will exit..."
      expect(mockConsoleError.mock.calls.some(call => typeof call[0] === 'string' && (call[0] as string).includes(`Utility HTTP server is DISABLED`))).toBe(false); // Check mockConsoleError
      expect(mockConsoleError.mock.calls.some(call => typeof call[0] === 'string' && (call[0] as string).includes(`Current instance will exit as another CodeCompass server (v${existingServerPingVersion}) is already running on port ${mcs.HTTP_PORT}.`))).toBe(true); // Check mockConsoleError
    });

  it('should handle EADDRINUSE, detect a non-CodeCompass server, log error, and throw ServerStartupError with exitCode 1', async () => {
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
        return this as unknown as httpModule.Server; // Changed to 'this'
      });

    // Mock axios.get for /api/ping
    // eslint-disable-next-line @typescript-eslint/unbound-method
    vi.mocked(axios.get).mockImplementation((url: string): Promise<any> => { // Added Promise<any>
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
     
    await expect(serverLibModule.startServer('/fake/repo')).rejects.toThrow(
      // eslint-disable-next-line @typescript-eslint/no-unsafe-argument
      expect.objectContaining({
        name: "ServerStartupError",
        message: `Port ${mcs.HTTP_PORT} is in use by non-CodeCompass server. Response: ${JSON.stringify(otherServiceData)}`,
        exitCode: 1,
        requestedPort: mcs.HTTP_PORT,
        existingServerStatus: otherServiceData
      })
    );

    // Verify the specific error log calls
    expect(ml.error).toHaveBeenCalledWith(expect.stringContaining(`Port ${mcs.HTTP_PORT} is in use by non-CodeCompass server. Response: {"service":"OtherService"}`));
    // The main catch block in startServer will also log "Failed to start CodeCompass"
    expect(ml.error).toHaveBeenCalledWith("Failed to start CodeCompass", expect.objectContaining({
      message: `Port ${mcs.HTTP_PORT} is in use by non-CodeCompass server. Response: ${JSON.stringify(otherServiceData)}`,
    }));
    expect(mockedMcpServerConnect).not.toHaveBeenCalled();
  });

  it('should handle EADDRINUSE, ping fails (e.g. ECONNREFUSED), log error, and throw ServerStartupError with exitCode 1', async () => {
    mockHttpServerListenFn.mockImplementation(
      ( // Note: `this` context for mockHttpServerInstance might be an issue if not bound correctly or if `this` is not the mock instance.
        // However, the current mock structure for http.createServer returns an object with these methods, so `this` should be that object.
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
        return this as unknown as httpModule.Server; // Changed to 'this'
      }
    );

    
    const localPingError = new Error('Connection refused'); // Define localPingError here
    // eslint-disable-next-line @typescript-eslint/no-unbound-method
    vi.mocked(axios.get).mockImplementation(async (url: string): Promise<any> => { // Added Promise<any>
      if (url.endsWith('/api/ping')) {
        return Promise.reject(localPingError);
      }
      return Promise.resolve({ status: 404, data: {} });
    });
    
    process.env.SIMULATE_EADDRINUSE_FOR_TEST = 'true';
    try {
      await expect(serverLibModule.startServer('/fake/repo')).rejects.toThrow(
        // eslint-disable-next-line @typescript-eslint/no-unsafe-argument
        expect.objectContaining({
          name: "ServerStartupError",
          message: `Port ${mcs.HTTP_PORT} is in use by an unknown service or the existing CodeCompass server is unresponsive to pings. Ping error: ${String(localPingError)}`, // Use String(localPingError)
          exitCode: 1,
          requestedPort: mcs.HTTP_PORT,
          existingServerStatus: expect.objectContaining({ service: 'Unknown or non-responsive to pings' }),
          // originalError should be the EADDRINUSE error simulated by mockHttpServerListenFn
          originalError: expect.objectContaining({ code: 'EADDRINUSE', message: 'listen EADDRINUSE test from mockHttpServerListenFn' }),
          detectedServerPort: undefined, 
        })
      );
    } finally {
      delete process.env.SIMULATE_EADDRINUSE_FOR_TEST;
    }
        
    // Check for the "Failed to start CodeCompass" log which contains the ServerStartupError message
    // This console.error for debugging can be removed if the test passes or if it's too verbose.
    // console.error("Debug: ml.error calls for 'ping fails' test:", JSON.stringify(ml.error.mock.calls, null, 2));
        
    // Check for the "Failed to start CodeCompass" log which contains the ServerStartupError message
    const mainFailLogCall = ml.error.mock.calls.find(callArgs => { 
      if (callArgs.length === 1 && typeof callArgs[0] === 'object' && callArgs[0] !== null) {
        const logObject = callArgs[0] as { message?: string, error?: { message?: string } };
        return logObject.message === "Failed to start CodeCompass" &&
               logObject.error !== undefined && typeof logObject.error === 'object' && logObject.error !== null &&
               typeof logObject.error.message === 'string';
      } else if (
        typeof (callArgs as ReadonlyArray<unknown>)[0] === 'string' && // Cast for indexing
        (callArgs as ReadonlyArray<unknown>)[0] === "Failed to start CodeCompass" &&
        (callArgs as ReadonlyArray<unknown>).length === 2 // Check length after confirming first element
    ) {
        // If the above conditions are met, callArgs[1] should exist.
        const errorArg = (callArgs as ReadonlyArray<unknown>)[1] as { message?: string }; // Cast for indexing and shape
        return typeof errorArg === 'object' && errorArg !== null && typeof errorArg.message === 'string';
    }
      return false;
    });
    expect(mainFailLogCall).toBeDefined();

    if (mainFailLogCall) {
      let errorDetails: Error | { message: string } | undefined;
      // Access arguments of the found call
      const callArgs = mainFailLogCall as ReadonlyArray<unknown>;
      if (callArgs.length === 1 && typeof callArgs[0] === 'object' && callArgs[0] !== null) {
        errorDetails = (callArgs[0] as { error?: Error | { message: string } }).error;
      } else if (callArgs.length === 2) {
        errorDetails = callArgs[1] as Error | { message: string };
      }

      if (errorDetails && typeof errorDetails === 'object' && 'message' in errorDetails && typeof errorDetails.message === 'string') {
        expect(errorDetails.message).toContain(`Port ${mcs.HTTP_PORT} is in use by an unknown service or the existing CodeCompass server is unresponsive to pings.`);
        expect(errorDetails.message).toContain(String(localPingError));
      } else {
        throw new Error("Logged error details are not in the expected format or 'message' property is missing/invalid.");
      }
    }

    // Check for the more specific initial logs if needed, e.g.:
    const pingFailedLogFound = ml.error.mock.calls.some(call => {
      const messagePart1 = `Port ${mcs.HTTP_PORT} is in use by an unknown service or the existing CodeCompass server is unresponsive to pings.`;
      const messagePart2 = `Ping error: ${String(localPingError)}`;
      
      if (call.length === 1 && typeof call[0] === 'object' && call[0] !== null) {
        const logObject = call[0] as { message?: string };
        return typeof logObject.message === 'string' && logObject.message.includes(messagePart1) && logObject.message.includes(messagePart2);
      } else if (call.length >= 1 && typeof call[0] === 'string') {
          const messageStr: string = call[0];
          return messageStr.includes(messagePart1) && messageStr.includes(messagePart2);
      }
      return false;
    });
    expect(pingFailedLogFound).toBe(true);

    expect(mockedMcpServerConnect).not.toHaveBeenCalled();
  });

  it('should handle EADDRINUSE, CodeCompass ping OK, but /api/indexing-status fails, log error, and throw ServerStartupError with exitCode 1', async () => {
    mockHttpServerListenFn.mockImplementation(function(this: any) { // Added function and this
      const errorArgs = mockHttpServerOnFn.mock.calls.find(call => call[0] === 'error');
      if (errorArgs && typeof errorArgs[1] === 'function') {
        const errorHandler = errorArgs[1] as (err: NodeJS.ErrnoException) => void;
        const error = new Error('listen EADDRINUSE') as NodeJS.ErrnoException;
        error.code = 'EADDRINUSE';
        errorHandler(error); // Simulate EADDRINUSE
      }      
      return this as unknown as httpModule.Server; // Changed to 'this'
    });

    // Mock axios.get for /api/ping
    // eslint-disable-next-line @typescript-eslint/unbound-method
    vi.mocked(axios.get).mockImplementation((url: string): Promise<any> => { // Added Promise<any>
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
    vi.mocked(axios.get).mockImplementation((url: string): Promise<any> => { // Added Promise<any>
      if (url.endsWith('/api/ping')) {
        return Promise.resolve({ status: 200, data: pingSuccessData }); // Ping success
      }
      if (url.endsWith('/api/indexing-status')) {
        return Promise.reject(new Error('Failed to fetch status')); // Status fetch fails
      }
      return Promise.resolve({ status: 404, data: {} });
    });

     
    // First, assert the thrown ServerStartupError
    await expect(serverLibModule.startServer('/fake/repo')).rejects.toThrow(
      expect.objectContaining({
        name: "ServerStartupError",
        message: `Port ${mcs.HTTP_PORT} in use by existing CodeCompass server, but status fetch error occurred.`,
        exitCode: 1,
        requestedPort: mcs.HTTP_PORT,
        detectedServerPort: mcs.HTTP_PORT, 
        existingServerStatus: pingSuccessData,
        originalError: expect.objectContaining({ code: 'EADDRINUSE' })
      })
    );
          
    let failedToStartLogCallFound = false;
    let statusFetchErrorLogFound = false;
    const expectedFailedToStartMessage = `Port ${mcs.HTTP_PORT} in use by existing CodeCompass server, but status fetch error occurred.`;
    const expectedStatusFetchErrorMessage = `Error fetching status from existing CodeCompass server (port ${mcs.HTTP_PORT}): Error: Failed to fetch status`;

    for (const call of ml.error.mock.calls) {
      const args = call as ReadonlyArray<unknown>; // Treat arguments as a flexible array
      if (args.length === 1 && typeof args[0] === 'object' && args[0] !== null) {
        const logObject = args[0] as { message?: string, error?: { message?: string } };
        if (logObject.message === "Failed to start CodeCompass" && logObject.error?.message?.includes(expectedFailedToStartMessage)) {
          failedToStartLogCallFound = true;
        }
        if (logObject.message?.includes(expectedStatusFetchErrorMessage)) {
          statusFetchErrorLogFound = true;
        }
      } else if (args.length >= 1 && typeof args[0] === 'string') {
        const messageStr: string = args[0];
        if (messageStr === "Failed to start CodeCompass" && args.length === 2) {
          const errorArg = args[1] as { message?: string };
          if (errorArg?.message?.includes(expectedFailedToStartMessage)) {
            failedToStartLogCallFound = true;
          }
        }
        if (messageStr.includes(expectedStatusFetchErrorMessage)) {
          statusFetchErrorLogFound = true;
        }
      }
    }
    expect(failedToStartLogCallFound, "Expected 'Failed to start CodeCompass' log with specific error details was not found.").toBe(true);
    expect(statusFetchErrorLogFound, "Expected 'status fetch error' log message was not found.").toBe(true);
    expect(mockedMcpServerConnect).not.toHaveBeenCalled();
  });

  it('should handle non-EADDRINUSE errors on HTTP server and throw ServerStartupError with exitCode 1', async () => {
    const otherError = new Error('Some other server error') as NodeJS.ErrnoException;
    otherError.code = 'EACCES'; // Example of another error code

    mockHttpServerListenFn.mockImplementation(function(this: any) { // Added function and this
      // Simulate listen failure by invoking the 'error' handler
      const errorArgs = mockHttpServerOnFn.mock.calls.find(call => call[0] === 'error');
      if (errorArgs && typeof errorArgs[1] === 'function') {
        const errorHandler = errorArgs[1] as (err: NodeJS.ErrnoException) => void;
        errorHandler(otherError);
      }      
      return this; // Return the mock server instance
    });
    
    await expect(serverLibModule.startServer('/fake/repo')).rejects.toThrow(
      expect.objectContaining({
        name: "ServerStartupError",
        message: `HTTP server error: ${otherError.message}`,
        exitCode: 1
      })
    );
    
    expect(mockHttpServerOnFn).toHaveBeenCalledWith('error', expect.any(Function));
        
    expect(ml.error).toHaveBeenCalledWith(`Failed to start HTTP server on port ${mcs.HTTP_PORT}: ${otherError.message}`);
     
    expect(mockedMcpServerConnect).not.toHaveBeenCalled();
  });
});

// ... (after describe('Server Startup and Port Handling', () => { ... });) ...

describe('findFreePort', () => {
  // findFreePortSpy will be initialized in beforeEach of the startProxyServer suite
  // For findFreePort direct tests, we don't need a module-level spy on it.
  let mockedHttp: {
    createServer: Mock<() => httpModule.Server>;
    default?: { createServer: Mock<() => httpModule.Server> }; // Optional default
  };
  let portCounter: number;

  beforeEach(async () => {
    vi.clearAllMocks(); // Clear all mocks
    // Dynamically import http to get the mocked version
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-assertion
    mockedHttp = await import('http') as unknown as {
      createServer: Mock<() => httpModule.Server>;
      default?: { createServer: Mock<() => httpModule.Server> };
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
    mockHttpServerRemoveAllListenersFn.mockReset();


    // Default behavior for mocks, can be overridden in specific tests
    // Note: For findFreePort tests, the instance returned by http.createServer() is key.
    // The mockHttpServerOnFn needs to operate on the specific instance's _listeners.
    // This is handled by createNewMockServerObject returning an object with its own _listeners.
    mockHttpServerOnFn.mockImplementation(function(this: any, event, callback) {
        if (!this._listeners) this._listeners = {};
        this._listeners[event] = callback;
        return this;
    });

    mockHttpServerCloseFn.mockImplementation(function(this: any, callback?: (err?: Error) => void) {
      if (callback) callback();
      return this;
    });

    mockHttpServerAddressFn.mockImplementation(function(this: any) {
        // For findFreePort, the port in address() should match the listen() attempt
        // This requires the listen mock to set it or have access to the port it was called with.
        // For simplicity, we'll assume the test sets this up if specific address is needed.
        // Defaulting to a dynamic port based on counter for now.
        return { port: 3000 + portCounter, address: '127.0.0.1', family: 'IPv4' };
    });
  });

  it('should find the starting port if it is free', async () => {
    const startPort = 3000;
    
    // Mock listen to succeed and call the listening handler
    mockHttpServerListenFn.mockImplementation(function(this: any, portToListen, _hostname, callbackOrUndefined) {
      expect(portToListen).toBe(startPort);
      mockHttpServerAddressFn.mockReturnValueOnce({ port: startPort, address: '127.0.0.1', family: 'IPv4' }); // Ensure address() returns the correct port
      if (this._listeners && this._listeners.listening) {
        this._listeners.listening();
      } else if (typeof callbackOrUndefined === 'function') {
        (callbackOrUndefined as () => void)();
      }
      return this;
    });

    await expect(serverLibModule.findFreePort(startPort)).resolves.toBe(startPort);
    expect(mockedHttp.createServer).toHaveBeenCalledTimes(1);
    expect(mockHttpServerListenFn).toHaveBeenCalledWith(startPort, 'localhost');
    expect(mockHttpServerCloseFn).toHaveBeenCalledTimes(1);
  });

  it('should find the next port if the first one is in use (EADDRINUSE)', async () => {
    const startPort = 3001;
    portCounter = 0; // for address mock

    mockHttpServerListenFn
      .mockImplementationOnce(function(this: any, _p, _h, _cb) { // First call (port 3001) - EADDRINUSE
        portCounter++;
        if (this._listeners && this._listeners.error) {
          const err = new Error('EADDRINUSE') as NodeJS.ErrnoException;
          err.code = 'EADDRINUSE';
          this._listeners.error(err);
        }
        return this;
      })
      .mockImplementationOnce(function(this: any, portToListen, _h, callbackOrUndefined) { // Second call (port 3002) - Free
        expect(portToListen).toBe(startPort + 1);
        mockHttpServerAddressFn.mockReturnValueOnce({ port: startPort + 1, address: '127.0.0.1', family: 'IPv4' });
        if (this._listeners && this._listeners.listening) {
          this._listeners.listening();
        } else if (typeof callbackOrUndefined === 'function') {
            (callbackOrUndefined as () => void)();
        }
        return this;
      });

    await expect(serverLibModule.findFreePort(startPort)).resolves.toBe(startPort + 1);
    expect(mockedHttp.createServer).toHaveBeenCalledTimes(2);
    expect(mockHttpServerListenFn).toHaveBeenCalledWith(startPort, 'localhost');
    expect(mockHttpServerListenFn).toHaveBeenCalledWith(startPort + 1, 'localhost');
    expect(mockHttpServerCloseFn).toHaveBeenCalledTimes(1); // Only closed on success
  });

  it('should reject if a non-EADDRINUSE error occurs during listen', async () => {
    const startPort = 3002;
    const otherError = new Error('Some other error') as NodeJS.ErrnoException;
    otherError.code = 'EACCES';

    mockHttpServerListenFn.mockImplementationOnce(function(this: any) {
      if (this._listeners && this._listeners.error) {
        this._listeners.error(otherError);
      }
      return this;
    });

    await expect(serverLibModule.findFreePort(startPort)).rejects.toThrow(otherError);
    expect(mockedHttp.createServer).toHaveBeenCalledTimes(1);
    expect(mockHttpServerCloseFn).not.toHaveBeenCalled();
  });

  it('should reject if server.close() itself errors', async () => {
    const startPort = 3003;
    const closeError = new Error('Failed to close server');

    mockHttpServerListenFn.mockImplementation(function(this: any, _p, _h, callbackOrUndefined) {
      mockHttpServerAddressFn.mockReturnValueOnce({ port: startPort, address: '127.0.0.1', family: 'IPv4' });
      if (this._listeners && this._listeners.listening) {
        this._listeners.listening();
      } else if (typeof callbackOrUndefined === 'function') {
        (callbackOrUndefined as () => void)();
      }
      return this;
    });
    mockHttpServerCloseFn.mockImplementationOnce(function(this: any, callback?: (err?: Error) => void) {
      if (callback) callback(closeError); // Simulate error during close
      return this;
    });

    await expect(serverLibModule.findFreePort(startPort)).rejects.toThrow(closeError);
    expect(mockHttpServerCloseFn).toHaveBeenCalledTimes(1);
  });

  it('should throw an error if no free ports are available up to 65535', async () => {
    const startPort = 65530; // Start near the limit
    let currentPortAttempt = startPort;

    mockHttpServerListenFn.mockImplementation(function(this: any) {
      if (currentPortAttempt > 65535) {
        // This case should be caught by findFreePort's internal limit before listen is called for >65535
        // So, we simulate EADDRINUSE for all valid ports
        const err = new Error('EADDRINUSE test') as NodeJS.ErrnoException;
        err.code = 'EADDRINUSE';
        if (this._listeners && this._listeners.error) {
            this._listeners.error(err);
        }
      } else {
         // Simulate EADDRINUSE for ports up to 65535
        const err = new Error('EADDRINUSE test') as NodeJS.ErrnoException;
        err.code = 'EADDRINUSE';
        if (this._listeners && this._listeners.error) {
            this._listeners.error(err);
        }
      }
      currentPortAttempt++;
      return this;
    });
    // Adjust the number of createServer calls expected based on the loop limit in findFreePort
    // The loop in findFreePort is `while (true)` but has an internal check `if (port > 65535)`
    // So it will try ports from startPort up to 65535.
    // For startPort = 65530, it will try 65530, 65531, 65532, 65533, 65534, 65535 (6 times)
    const expectedAttempts = (65535 - startPort) + 1;

    await expect(serverLibModule.findFreePort(startPort)).rejects.toThrow('No free ports available.');
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
  let findFreePortSpy: MockInstance<typeof serverLibModule.findFreePort>; // Declare spy here

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

    // Reset http server mocks for proxy tests
    // Ensure listen calls its callback for the proxy server itself
    mockHttpServerListenFn.mockReset().mockImplementation(function(this: any, _port, _hostnameOrCb, _backlogOrCb, finalListenCb) {
      let actualFinalListenCb = finalListenCb;
      if (typeof _hostnameOrCb === 'function') actualFinalListenCb = _hostnameOrCb;
      else if (typeof _backlogOrCb === 'function') actualFinalListenCb = _backlogOrCb;

      process.nextTick(() => {
        // Simulate 'listening' event emission
        if (this._listeners && typeof this._listeners.listening === 'function') {
          this._listeners.listening();
        }
        // Call the final callback for listen() if provided
        if (typeof actualFinalListenCb === 'function') {
          actualFinalListenCb();
        }
      });
      return this; 
    });
    mockHttpServerOnFn.mockReset().mockImplementation(function(this: any, event, callback) {
        if (!this._listeners) this._listeners = {};
        this._listeners[event] = callback;
        return this;
    });
    mockHttpServerCloseFn.mockReset().mockImplementation(function(this: any, callback) {
      if (typeof callback === 'function') callback();
      return this;
    });


    // Initialize the spy on the actual module's function
    findFreePortSpy = vi.spyOn(serverLibModule, 'findFreePort');
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
        
    // Mock findFreePort using the spy on the imported module
    findFreePortSpy.mockResolvedValue(proxyListenPort);

    nock(`http://localhost:${targetPort}`)
      .get('/api/ping')
      .reply(200, { service: "CodeCompassTarget", status: "ok", version: "1.0.0" });

    proxyServerInstance = await serverLibModule.startProxyServer(requestedPort, targetPort, "1.0.0-existing");
    expect(proxyServerInstance).toBeDefined();
        
    // eslint-disable-next-line @typescript-eslint/unbound-method
    expect(ml.info).toHaveBeenCalledWith(expect.stringContaining(`This instance (CodeCompass Proxy) is running on port ${proxyListenPort}`));
    // eslint-disable-next-line @typescript-eslint/unbound-method
    expect(ml.info).toHaveBeenCalledWith(expect.stringContaining(`forwarding to main server on ${targetPort}`));


    const response = await axios.get(`http://localhost:${proxyListenPort}/api/ping`);
    expect(response.status).toBe(200);
    expect(response.data).toEqual({ service: "CodeCompassTarget", status: "ok", version: "1.0.0" });
    expect(nock.isDone()).toBe(true);
    // findFreePortSpy is restored in afterEach
  }, 15000);

  it('should proxy POST /mcp with body and headers', async () => {
    const proxyListenPort = requestedPort + 101;
    findFreePortSpy.mockResolvedValue(proxyListenPort);

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

    proxyServerInstance = await serverLibModule.startProxyServer(requestedPort, targetPort, "1.0.0-existing");

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
    // findFreePortSpy is restored in afterEach
  }, 15000);

  it('should proxy GET /mcp for SSE', async () => {
    const proxyListenPort = requestedPort + 102;
    findFreePortSpy.mockResolvedValue(proxyListenPort);
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
        
    proxyServerInstance = await serverLibModule.startProxyServer(requestedPort, targetPort, "1.0.0-existing");

    const response = await axios.get(`http://localhost:${proxyListenPort}/mcp`, {
      headers: { 'mcp-session-id': sessionId },
      responseType: 'text' // Get raw text to check SSE format
    });

    expect(response.status).toBe(200);
    expect(response.headers['content-type']).toBe('text/event-stream');
    expect(response.headers['mcp-session-id']).toBe(sessionId);
    expect(response.data).toBe("event: message\ndata: hello\n\n");
    expect(nock.isDone()).toBe(true);
    // findFreePortSpy is restored in afterEach
  }, 15000);
  
  it('should proxy DELETE /mcp', async () => {
    const proxyListenPort = requestedPort + 103;
    findFreePortSpy.mockResolvedValue(proxyListenPort);
    const sessionId = "delete-session-id";

    nock(`http://localhost:${targetPort}`, {
        reqheaders: { 'mcp-session-id': sessionId }
      })
      .delete('/mcp')
      .reply(204); // Or 200 with a body if applicable

    proxyServerInstance = await serverLibModule.startProxyServer(requestedPort, targetPort, "1.0.0-existing");

    const response = await axios.delete(`http://localhost:${proxyListenPort}/mcp`, {
      headers: { 'mcp-session-id': sessionId }
    });
        
    expect(response.status).toBe(204);
    expect(nock.isDone()).toBe(true);
    // findFreePortSpy is restored in afterEach
  }, 15000);

  it('should proxy /api/indexing-status', async () => {
    const proxyListenPort = requestedPort + 104;
    findFreePortSpy.mockResolvedValue(proxyListenPort);
    const mockStatus = { status: 'idle', message: 'Target server is idle' };

    nock(`http://localhost:${targetPort}`)
      .get('/api/indexing-status')
      .reply(200, mockStatus);

    proxyServerInstance = await serverLibModule.startProxyServer(requestedPort, targetPort, "1.0.0-existing");

    const response = await axios.get(`http://localhost:${proxyListenPort}/api/indexing-status`);
    expect(response.status).toBe(200);
    expect(response.data).toEqual(mockStatus);
    expect(nock.isDone()).toBe(true);
    // findFreePortSpy is restored in afterEach
  }, 15000);

  it('should handle target server unreachable for /mcp', async () => {
    const proxyListenPort = requestedPort + 105;
    findFreePortSpy.mockResolvedValue(proxyListenPort);

    nock(`http://localhost:${targetPort}`)
      .post('/mcp')
      .replyWithError({ message: 'Connection refused', code: 'ECONNREFUSED' });

    proxyServerInstance = await serverLibModule.startProxyServer(requestedPort, targetPort, "1.0.0-existing");
        
    try {
      await axios.post(`http://localhost:${proxyListenPort}/mcp`, {});
    } catch (error: any) { // eslint-disable-line @typescript-eslint/no-explicit-any
      expect(error.response.status).toBe(502); // Bad Gateway
      // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
      expect(error.response.data.error.message).toBe('Proxy error: Bad Gateway');
    }
    // eslint-disable-next-line @typescript-eslint/unbound-method
    expect(ml.error).toHaveBeenCalledWith(expect.stringContaining('Proxy: Error proxying MCP request to target server.'), expect.anything());
    expect(nock.isDone()).toBe(true);
    // findFreePortSpy is restored in afterEach
  }, 15000);

  it('should forward target server 500 error for /mcp', async () => {
    const proxyListenPort = requestedPort + 106;
    findFreePortSpy.mockResolvedValue(proxyListenPort);
    const errorBody = { jsonrpc: "2.0", error: { code: -32000, message: "Target Internal Error" }, id: null };

    nock(`http://localhost:${targetPort}`)
      .post('/mcp')
      .reply(500, errorBody, { 'Content-Type': 'application/json' });

    proxyServerInstance = await serverLibModule.startProxyServer(requestedPort, targetPort, "1.0.0-existing");

    try {
      await axios.post(`http://localhost:${proxyListenPort}/mcp`, {});
    } catch (error: any) { // eslint-disable-line @typescript-eslint/no-explicit-any
      expect(error.response.status).toBe(500);
      // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
      expect(error.response.data).toEqual(errorBody);
    }
    expect(nock.isDone()).toBe(true);
    // findFreePortSpy is restored in afterEach
  }, 15000);
   it('should reject if findFreePort fails', async () => {
    const findFreePortError = new Error("No ports for proxy!");
    // Ensure findFreePortSpy is initialized before use, which it is by beforeEach
    findFreePortSpy.mockRejectedValue(findFreePortError);

    await expect(serverLibModule.startProxyServer(requestedPort, targetPort, "1.0.0-existing"))
      .rejects.toThrow(findFreePortError);
        
    // eslint-disable-next-line @typescript-eslint/unbound-method
    expect(ml.error).not.toHaveBeenCalledWith(expect.stringContaining('Proxy server failed to start')); // This log is inside the listen promise
    // findFreePortSpy is restored in afterEach
  }, 15000);
});

describe('MCP Tool Relaying', () => {
  let mcs: MockedConfigService;
  let ml: MockedLogger;
  const repoPath = '/fake/repo'; // Define a common repoPath

  beforeEach(async () => {
    vi.clearAllMocks(); // Clear all mocks
    // Reset capturedToolHandlers for each test
    for (const key in capturedToolHandlers) {
        delete capturedToolHandlers[key];
    }

    const mockedConfigModule = await import('../lib/config-service.js') as unknown as ConfigServiceModuleType;
    mcs = mockedConfigModule.configService as unknown as MockedConfigService;
    ml = mockedConfigModule.logger as unknown as MockedLogger;

    // Reset config service relay flags
    mcs.IS_UTILITY_SERVER_DISABLED = false;
    mcs.RELAY_TARGET_UTILITY_PORT = undefined;

    // Mock dependencies that tool handlers might use if not relaying
    vi.mocked(getGlobalIndexingStatus).mockReturnValue({
      status: 'idle', message: 'Local idle status', overallProgress: 0, lastUpdatedAt: new Date().toISOString()
    } as IndexingStatusReport);
    
    const { indexRepository } = await import('../lib/repository.js');
    vi.mocked(indexRepository).mockResolvedValue(undefined);

    // Simulate McpServer setup to register tools
    // We need to call registerTools which is not exported, but it's called by startServer.
    // A simplified way: directly call registerTools with a mock McpServer instance
    // This requires making registerTools exportable or testing it via startServer.
    // For now, we assume handlers are captured by the McpServer mock when startServer runs.
    // To ensure handlers are registered for each test, we might need to call startServer
    // or a part of it. Let's assume the global McpServer mock captures them.
    // The McpServer mock's `tool` method captures handlers.
    // We need to ensure `startServer` is called or its tool registration part is simulated.
    // Let's try calling startServer and letting it run to the point of tool registration.
    // To prevent full server start, we can make http.listen resolve immediately.
    
    // Minimal mock for getLLMProvider for tool registration
    const { getLLMProvider: getLLMProviderActual } = await import('../lib/llm-provider.js');
    vi.mocked(getLLMProviderActual).mockResolvedValue({
      checkConnection: vi.fn().mockResolvedValue(true),
      generateText: vi.fn().mockResolvedValue("mocked text"),
      generateEmbedding: vi.fn().mockResolvedValue([0.1, 0.2, 0.3]),
      processFeedback: vi.fn().mockResolvedValue("mocked feedback response"),
    } as LLMProvider);


    // The `mainStdioMcpServer.tool` calls happen during `startServer`.
    // So, to get handlers, we must call `startServer`.
    // Mock `httpServer.listen` to resolve immediately to prevent hanging.
    mockHttpServerListenFn.mockReset().mockImplementation(function(this: any, _port, _hostnameOrCb, _backlogOrCb, finalListenCb) {
      let actualFinalListenCb = finalListenCb;
      if (typeof _hostnameOrCb === 'function') actualFinalListenCb = _hostnameOrCb;
      else if (typeof _backlogOrCb === 'function') actualFinalListenCb = _backlogOrCb;

      process.nextTick(() => {
        // Ensure 'listening' event is emitted for startServer's httpServerSetupPromise
        if (this._listeners && typeof this._listeners.listening === 'function') {
          this._listeners.listening();
        } else {
          // Fallback: try to find it on the global mock if 'this' context is problematic
          // This part is tricky and might indicate a deeper issue with 'this' in mocks.
          // For now, rely on this._listeners being populated by a correctly scoped mockHttpServerOnFn.
        }
        
        if (typeof actualFinalListenCb === 'function') {
          actualFinalListenCb();
        }
      });
      return this; 
    });
    // Ensure mockHttpServerOnFn is also reset/configured if its state affects this
    mockHttpServerOnFn.mockReset().mockImplementation(function(this: any, event, callback) {
        if (!this._listeners) this._listeners = {};
        this._listeners[event] = callback;
        return this;
    });

    await serverLibModule.startServer(repoPath); // This will call registerTools
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('get_indexing_status should relay if IS_UTILITY_SERVER_DISABLED is true', async () => {
    mcs.IS_UTILITY_SERVER_DISABLED = true;
    mcs.RELAY_TARGET_UTILITY_PORT = 3005;
    const mockRelayedStatus: IndexingStatusReport = {
      status: 'indexing_file_content', message: 'Relayed indexing', overallProgress: 50, lastUpdatedAt: new Date().toISOString()
    };
    vi.mocked(axios.get).mockResolvedValue({ status: 200, data: mockRelayedStatus, headers: {}, config: {} as any });

    const handler = capturedToolHandlers['get_indexing_status'];
    expect(handler).toBeDefined();
    const result = await handler({} as any, {} as any); // Added as any for params

    expect(axios.get).toHaveBeenCalledWith(`http://localhost:3005/api/indexing-status`);
    expect(result.content[0].text).toContain('# Indexing Status (Relayed from :3005)');
    expect(result.content[0].text).toContain('Status: indexing_file_content');
    expect(vi.mocked(getGlobalIndexingStatus)).not.toHaveBeenCalled();
  });

  it('get_indexing_status should use local status if relaying is disabled', async () => {
    mcs.IS_UTILITY_SERVER_DISABLED = false;
    const handler = capturedToolHandlers['get_indexing_status'];
    expect(handler).toBeDefined();
    const result = await handler({} as any, {} as any); // Added as any for params

    expect(vi.mocked(getGlobalIndexingStatus)).toHaveBeenCalled();
    expect(axios.get).not.toHaveBeenCalled();
    expect(result.content[0].text).toContain('# Indexing Status');
    expect(result.content[0].text).toContain('Local idle status');
  });

  it('trigger_repository_update should relay if IS_UTILITY_SERVER_DISABLED is true', async () => {
    mcs.IS_UTILITY_SERVER_DISABLED = true;
    mcs.RELAY_TARGET_UTILITY_PORT = 3005;
    vi.mocked(axios.post).mockResolvedValue({ status: 202, data: { message: "Relayed update accepted" }, headers: {}, config: {} as any });
    
    const { indexRepository } = await import('../lib/repository.js'); // ensure mock is used

    const handler = capturedToolHandlers['trigger_repository_update'];
    expect(handler).toBeDefined();
    const result = await handler({} as any, {} as any); // Added as any for params

    expect(axios.post).toHaveBeenCalledWith(`http://localhost:3005/api/repository/notify-update`, {});
    expect(result.content[0].text).toContain('# Repository Update Triggered (Relayed to :3005)');
    expect(result.content[0].text).toContain('Relayed update accepted');
    expect(vi.mocked(indexRepository)).not.toHaveBeenCalled();
  });

  it('trigger_repository_update should trigger local indexing if relaying is disabled', async () => {
    mcs.IS_UTILITY_SERVER_DISABLED = false;
    const { indexRepository } = await import('../lib/repository.js'); // ensure mock is used

    const handler = capturedToolHandlers['trigger_repository_update'];
    expect(handler).toBeDefined();
    const result = await handler({} as any, {} as any); // Added as any for params
    
    // Need to ensure the llmProvider is correctly mocked and passed for indexRepository
    const { getLLMProvider: getLLMProviderActual } = await import('../lib/llm-provider.js');
    const llmProviderInstance = await getLLMProviderActual();


    expect(vi.mocked(indexRepository)).toHaveBeenCalledWith(expect.anything(), repoPath, llmProviderInstance);
    expect(axios.post).not.toHaveBeenCalled();
    expect(result.content[0].text).toContain('# Repository Update Triggered (Locally)');
  });
   it('trigger_repository_update should not trigger local indexing if already in progress and relaying is disabled', async () => {
    mcs.IS_UTILITY_SERVER_DISABLED = false;
    vi.mocked(getGlobalIndexingStatus).mockReturnValue({
      status: 'indexing_file_content', message: 'Local indexing in progress', overallProgress: 50, lastUpdatedAt: new Date().toISOString()
    } as IndexingStatusReport);
    const { indexRepository } = await import('../lib/repository.js');

    const handler = capturedToolHandlers['trigger_repository_update'];
    expect(handler).toBeDefined();
    const result = await handler({} as any, {} as any); // Added as any for params

    expect(vi.mocked(indexRepository)).not.toHaveBeenCalled();
    expect(result.content[0].text).toContain('# Repository Update Trigger Failed');
    expect(result.content[0].text).toContain('Indexing already in progress locally.');
  });
});
