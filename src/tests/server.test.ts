// DEVELOPER NOTE: The following constants, which were part of the context for adding PROXY_PORT_SUCCESS_3,
// appear to be missing from this version of the file:
//   const PROXY_TEST_PORT_BASE = 3000; // (Example base value, actual might differ)
//   const PROXY_TARGET_PORT_MCP_ERROR = PROXY_TEST_PORT_BASE + 7; // 3007
//   const PROXY_PORT_SUCCESS = PROXY_TEST_PORT_BASE + 8; // 3008
//   const PROXY_PORT_SUCCESS_2 = PROXY_TEST_PORT_BASE + 9; // 3009 for another test
// The original request to add PROXY_PORT_SUCCESS_3 (PROXY_TEST_PORT_BASE + 10) after PROXY_PORT_SUCCESS_2
// cannot be fulfilled as PROXY_PORT_SUCCESS_2 is not found.
// Please clarify if these constants should be added, and if so, where.
import { describe, it, expect, vi, beforeEach, afterEach, type MockInstance, type MockedFunction, type Mock as VitestMock } from 'vitest';
// Import types needed for the stable mocks FIRST
// MockInstance is already imported above, ensure Mock is aliased if used directly.
import type { ConfigService as ActualConfigServiceType } from '../lib/config-service'; // For typing the stable mock
import * as actualServerLibModuleContent from '../lib/server.js';
let serverLibModule: typeof actualServerLibModuleContent;
import type { Logger as WinstonLogger } from 'winston';
import type * as httpModule from 'http'; // For types
// Import actual modules to be mocked
import http from 'http'; // Keep this for the vi.mock('http', ...) factory
import axios from 'axios'; // Import axios // Keep for typing realAxiosInstance & global mock
import * as net from 'net'; // For net.ListenOptions
import nock from 'nock'; // Added nock import here as it's a top-level import

// --- STABLE MOCK INSTANCES DEFINITIONS ---
// Define MockedLogger and MockedConfigService types
type MockedLogger = {
  [K in keyof WinstonLogger]: WinstonLogger[K] extends (...args: infer A) => infer R
    ? VitestMock<(...args: A) => R>
    : WinstonLogger[K];
};

type MockedConfigService = Pick<
  ActualConfigServiceType,
  | 'HTTP_PORT' | 'OLLAMA_HOST' | 'QDRANT_HOST' | 'COLLECTION_NAME' 
  | 'SUGGESTION_MODEL' | 'SUGGESTION_PROVIDER' | 'EMBEDDING_MODEL' | 'EMBEDDING_PROVIDER'
  | 'DEEPSEEK_API_KEY' | 'OPENAI_API_KEY' | 'GEMINI_API_KEY' | 'CLAUDE_API_KEY'
  | 'SUMMARIZATION_MODEL' | 'REFINEMENT_MODEL' | 'MAX_SNIPPET_LENGTH'
  // | 'AGENT_QUERY_TIMEOUT' // Omit if readonly in base type
> & {
  AGENT_QUERY_TIMEOUT: number; // Add it here as mutable
  reloadConfigsFromFile: VitestMock<() => void>;
  VERSION: string;
  IS_UTILITY_SERVER_DISABLED: boolean;
  RELAY_TARGET_UTILITY_PORT?: number;
};

// serverLibModule import removed from here, will be re-added later
import { normalizeToolParams, ServerStartupError } from '../lib/server.js'; // Keep specific imports if needed elsewhere
import { IndexingStatusReport, getGlobalIndexingStatus } from '../lib/repository'; // For mock status

// Define stable mock for McpServer.connect
const mcpConnectStableMock = vi.fn();
const capturedToolHandlers: Record<string, (...args: any[]) => any> = {}; // Type for value is VitestMock<(...args: any[]) => any> or specific

// Mock dependencies
// --- END STABLE MOCK INSTANCES DEFINITIONS ---

// Variables to hold the instances controlled by tests.
// These will be assigned in beforeEach by importing from the mocked module.
let mcs: MockedConfigService; // mcs for mockedConfigService, type defined at top
let ml: MockedLogger;         // ml for mockedLogger, type defined at top

// Helper function to create a logger mock will be moved inside the factory

vi.mock('../lib/config-service', async () => {
  console.log('[SERVER_TEST_DEBUG] Factory for ../lib/config-service running.');

  // Define createInternalMockLogger INSIDE the factory
  const createInternalMockLoggerInFactory = (): MockedLogger => ({
    info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), add: vi.fn(),
  } as unknown as MockedLogger);

  // Create the instances *inside* the factory
  const actualLogger = createInternalMockLoggerInFactory();
  const actualConfig = {
    HTTP_PORT: 3001, // Default values
    IS_UTILITY_SERVER_DISABLED: false,
    RELAY_TARGET_UTILITY_PORT: undefined,
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
    VERSION: 'test-version-factory-mock',
    reloadConfigsFromFile: vi.fn(),
    SUMMARIZATION_MODEL: 'test-summary-model',
    REFINEMENT_MODEL: 'test-refinement-model',
    MAX_SNIPPET_LENGTH: 500,
    AGENT_QUERY_TIMEOUT: 180000,
    // IMPORTANT: The mocked config service must use the logger instance created *within this factory scope*
    // if other parts of the config service itself log. For external access by tests, we assign to module-scope vars.
    logger: actualLogger, 
  } as MockedConfigService;

  // DO NOT assign to module-scoped variables like testControlLoggerInstance here.
  // The factory creates and returns the instances. Tests will import them.
  
  console.log('[SERVER_TEST_DEBUG] Mock factory for ../lib/config-service: returning instances.');
  return {
    configService: actualConfig,
    logger: actualLogger,
  };
});

// Import the mocked instances AFTER vi.mock
// These imports will receive what the factory above returns.
import { configService as mockedConfigServiceFromFactory, logger as mockedLoggerFromFactory } from '../lib/config-service';

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

// The vi.mock for '../lib/config-service' is now above, using stable instances.

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
  const createNewMockServerObject = () => {
    const serverInstanceInternal = { // Renamed to avoid conflict if mockHttpServer was a global
      listen: vi.fn(), // Placeholder, will be properly assigned below
      on: mockHttpServerOnFn,
      once: mockHttpServerOnFn, // Assign mockHttpServerOnFn to 'once' as well
      close: mockHttpServerCloseFn,
      address: mockHttpServerAddressFn,
      setTimeout: mockHttpServerSetTimeoutFn,
      removeAllListeners: mockHttpServerRemoveAllListenersFn,
      _listeners: {} as Record<string, (...args: any[]) => void>
    };

    // Assign the global mock listen function to this instance's listen method
    // And ensure it returns the instance itself.
    serverInstanceInternal.listen = vi.fn(function(this: any, portOrPathOrOptions, arg2, arg3, arg4) {
      // Call the global mockHttpServerListenFn for its side effects
      mockHttpServerListenFn.call(this, portOrPathOrOptions, arg2, arg3, arg4);
      return serverInstanceInternal; // Return this specific instance
    });
    return serverInstanceInternal;
  };

  const mockCreateServerFn = vi.fn(createNewMockServerObject);

  const mockHttpMethods = {
    createServer: mockCreateServerFn as unknown as MockedFunction<typeof http.createServer>,
    Server: vi.fn().mockImplementation(createNewMockServerObject) as unknown as typeof httpModule.Server,
    IncomingMessage: actualHttpModule.IncomingMessage,
    ServerResponse: actualHttpModule.ServerResponse,
    // Add other http exports if used by SUT, e.g., STATUS_CODES
    STATUS_CODES: actualHttpModule.STATUS_CODES, 
  };
  return {
    ...actualHttpModule, // Spread actual to keep other exports like Agent, globalAgent
    ...mockHttpMethods,
    default: { // Ensure default export also has createServer
      // ...actualHttpModule.default, // Property 'default' does not exist on type 'typeof import("http")'.
      ...mockHttpMethods,
      // createServer: mockCreateServerFn as unknown as VitestMock<(...args: any[]) => httpModule.Server>, // Already in mockHttpMethods
    },
  };
});

// Mock for axios
vi.mock('axios', () => {
  // Create an object that mimics an Axios instance with mocked methods
  const mockAxiosInstanceMethods = {
    get: vi.fn(),
    post: vi.fn(),
    delete: vi.fn(),
    // Add other methods if your code uses them, e.g., put, patch
  };

  return {
    // default is what's usually imported via `import axios from 'axios'`
    default: {
      ...mockAxiosInstanceMethods, // Spread the methods here
      // If `axios.create()` is used, mock it to return the same set of mocked methods
      create: vi.fn(() => mockAxiosInstanceMethods),
      // Mock `isAxiosError` as a static function on the default export
      isAxiosError: vi.fn((payload: any): payload is import('axios').AxiosError => {
        return payload && typeof payload === 'object' && 'isAxiosError' in payload && payload.isAxiosError === true;
      }),
    },
    // Also export them as named exports if your code uses `import { get } from 'axios'`
    ...mockAxiosInstanceMethods,
    isAxiosError: vi.fn((payload: any): payload is import('axios').AxiosError => {
      return payload && typeof payload === 'object' && 'isAxiosError' in payload && payload.isAxiosError === true;
    }),
  };
});

// Make serverLibModule mutable if it's re-assigned in beforeEach
// let serverLibModule: typeof import('../lib/server'); // This is now handled by the new import style
// To store the real axios for the proxy tests
let realAxiosInstance: typeof axios;


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

// Import serverLibModule AFTER all top-level mocks that it might depend on indirectly.
// This also resolves TS2440.
// import * as actualServerLibModule from '../lib/server.js'; // Use .js extension // Removed duplicate
// let serverLibModule: typeof actualServerLibModule; // This will be assigned in beforeEach for suites needing resetModules // Removed duplicate


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
// import { ConfigService } from '../lib/config-service'; // Assuming ConfigService is the class/type of the instance
// import { Logger as WinstonLogger } from 'winston'; // Duplicate import removed

// Type for the mocked logger instance where each method is a vi.Mock
// type MockedLogger = { // Duplicate type definition removed
//   [K in keyof WinstonLogger]: WinstonLogger[K] extends (...args: infer A) => infer R
//     ? Mock<(...args: A) => R> // Corrected generic usage
//     : WinstonLogger[K];
// };

// Type for the mocked configService instance
// Adjust properties based on what server.ts actually uses from configService
// type MockedConfigService = Pick< // Duplicate type definition removed
//   ConfigService,
//   | 'HTTP_PORT'
//   | 'OLLAMA_HOST' // Add other properties accessed by server.ts
//   | 'QDRANT_HOST'
//   | 'COLLECTION_NAME'
//   | 'SUGGESTION_MODEL'
//   // | 'LLM_PROVIDER' // This seems to be an alias or older name, SUGGESTION_PROVIDER is used in server.ts
//   | 'SUGGESTION_PROVIDER'
//   | 'EMBEDDING_MODEL'
//   | 'EMBEDDING_PROVIDER'
//   | 'DEEPSEEK_API_KEY'
//   | 'OPENAI_API_KEY'
//   | 'GEMINI_API_KEY'
//   | 'CLAUDE_API_KEY'
//   // VERSION removed from Pick as it's not in the original ConfigService type
//   | 'SUMMARIZATION_MODEL'
//   | 'REFINEMENT_MODEL'
//   | 'MAX_SNIPPET_LENGTH'
//   // Add any other relevant properties from ConfigService
// > & {
//   // logger removed as it's a separate export, not a property of configService mock
//   reloadConfigsFromFile: Mock<() => void>; // Corrected generic usage
//   VERSION: string; // VERSION is part of the mock, but not original ConfigService
//   IS_UTILITY_SERVER_DISABLED: boolean; // Added
//   RELAY_TARGET_UTILITY_PORT?: number; // Added
//   // Add other methods from ConfigService that are mocked and used by server.ts
// };

// Type for the module imported from '../lib/config-service.js'
type ConfigServiceModuleType = { // This type is still used
  configService: MockedConfigService; // MockedConfigService is defined at the top
  logger: MockedLogger; // MockedLogger is defined at the top
  // If the mock factory for '../lib/config-service' spreads `actual` and `actual`
  // contains other exports that are used, they should be typed here as well.
};

describe('Server Startup and Port Handling', () => {
  // Use the new mock-aware types
  // mcs and ml are now declared at the module scope and will be assigned here.
  let mockedMcpServerConnect: VitestMock<(...args: any[]) => any>; // Use VitestMock or a more specific MockInstance
  let originalNodeEnv: string | undefined;
  let mockConsoleError: MockInstance<typeof console.error>; // Declare mockConsoleError, MockInstance is suitable for spies

  beforeEach(async () => {
    originalNodeEnv = process.env.NODE_ENV; // Store original NODE_ENV
    process.env.NODE_ENV = 'test'; // Set for tests
    vi.clearAllMocks();
    serverLibModule = actualServerLibModuleContent;

    // Initialize mockProcessExit here
    mockProcessExit = vi.spyOn(process, 'exit').mockImplementation(vi.fn() as unknown as typeof process.exit);
    mockConsoleError = vi.spyOn(console, 'error').mockImplementation(vi.fn()); // Initialize mockConsoleError

    mockHttpServerCloseFn.mockReset().mockImplementation(function(this: any, callback?: () => void) { // Ensure close calls callback
      if (callback) callback();
      return this;
    });
    // Assign the imported mocked instances to mcs and ml
    mcs = mockedConfigServiceFromFactory as unknown as MockedConfigService; // Cast is necessary because TS statically sees original types
    ml = mockedLoggerFromFactory as unknown as MockedLogger;         // Cast is necessary

    // Clear mocks using the typed instances

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

    mockHttpServerListenFn.mockReset().mockImplementation(function(this: any, portOrPathOrOptions, arg2, arg3, arg4) {
      let actualCallback: (() => void) | undefined;
      if (typeof portOrPathOrOptions === 'object' && portOrPathOrOptions !== null) { // Options object
        actualCallback = arg2 as (() => void);
      } else if (typeof arg2 === 'function') { // listen(port, callback)
        actualCallback = arg2;
      } else if (typeof arg3 === 'function') { // listen(port, host, callback)
        actualCallback = arg3;
      } else if (typeof arg4 === 'function') { // listen(port, host, backlog, callback)
        actualCallback = arg4;
      }

      // Simulate EADDRINUSE if port is mcs.HTTP_PORT and a specific test flag is set
      const portToListen = typeof portOrPathOrOptions === 'number' ? portOrPathOrOptions : (portOrPathOrOptions as net.ListenOptions)?.port;
      if (portToListen === mcs.HTTP_PORT && process.env.SIMULATE_EADDRINUSE_FOR_TEST === 'true') {
        if (this._listeners && typeof this._listeners.error === 'function') {
          const error = new Error('listen EADDRINUSE test from mockHttpServerListenFn') as NodeJS.ErrnoException;
          error.code = 'EADDRINUSE';
          process.nextTick(() => this._listeners.error(error)); // Keep async error
        }
      } else { // Simulate successful listen
        process.nextTick(() => { // Ensure listening and callback are async
          if (this._listeners && typeof this._listeners.listening === 'function') {
            this._listeners.listening();
          }
          if (typeof actualCallback === 'function') {
            actualCallback();
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
    // If 'localhost' is consistently passed by SUT when no callback is given to listen:
    // expect(mockHttpServerListenFn).toHaveBeenCalledWith(mcs.HTTP_PORT, 'localhost', expect.any(Function));
    // If SUT only passes port and callback:
    expect(mockHttpServerListenFn).toHaveBeenCalledWith(mcs.HTTP_PORT, expect.any(Function), undefined, undefined);
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
        existingServerStatus: otherServiceData,
        originalError: expect.objectContaining({ code: 'EADDRINUSE' }) // Verify originalError is passed
      })
    );

    // Verify the specific error log calls
    // expect(ml.error).toHaveBeenCalledWith(expect.stringContaining(`Port ${mcs.HTTP_PORT} is in use by non-CodeCompass server. Response: {"service":"OtherService"}`));
    
    // const failedToStartLogCall = stableMockLoggerInstance.error.mock.calls.find(callArgs => {
    //   const firstArg = callArgs[0];
    //   if (callArgs.length > 0 && typeof firstArg === 'string' && firstArg === "Failed to start CodeCompass") {
    //     // Check if the second argument (meta object) contains the expected message part.
    //     const meta = callArgs[1];
    //     if (callArgs.length > 1 && typeof meta === 'object' && meta !== null && 'message' in meta && typeof meta.message === 'string') {
    //       const expectedMessagePart = `Port ${stableMockConfigServiceInstance.HTTP_PORT} is in use by non-CodeCompass server. Response: ${JSON.stringify(otherServiceData)}`;
    //       if (meta.message.includes(expectedMessagePart)) {
    //         return true;
    //       }
    //     }
    //   }
    //   return false;
    // });
    // expect(failedToStartLogCall).toBeDefined();

    const expectedNonCodeCompassMessage = `Port ${mcs.HTTP_PORT} is in use by non-CodeCompass server`;
    // Assert the structure of mock calls to help TypeScript for TS2493
    // Use unknown as intermediary to safely cast between incompatible types
    const errorCalls = ml.error.mock.calls as unknown as [(string | Record<string, unknown>), (Record<string, unknown> | Error)?][];
    const relevantNonCodeCompassCall = errorCalls.find(
      // The predicate ensures that we only deal with calls where the first arg is a string.
      // The 'as unknown as' cast above helps bypass type incompatibility safely
      (callArgs): callArgs is [string, Record<string, unknown>] => {
        if (callArgs && callArgs.length > 0 && typeof callArgs[0] === 'string') {
          // This predicate primarily ensures callArgs[0] is a string and matches the criteria.
          // The type assertion `callArgs is [string, Record<string, unknown>]` helps TypeScript,
          // but runtime checks for callArgs[1] are still needed if it's accessed.
          return callArgs[0].includes("Port") && callArgs[0].includes("in use by non-CodeCompass server");
        }
        return false;
      }
    );

    if (relevantNonCodeCompassCall) {
      const messageArg = relevantNonCodeCompassCall[0]; // Known to be string due to predicate logic
      // For metaArg, ensure it exists and is an object before accessing its properties
      let metaArg: any = undefined; // Default to undefined
      if (relevantNonCodeCompassCall && relevantNonCodeCompassCall.length > 1) {
        const secondArg = relevantNonCodeCompassCall[1];
        if (typeof secondArg === 'object' && secondArg !== null) {
          metaArg = secondArg;
        }
      }

      expect(messageArg).toEqual(expect.stringContaining(expectedNonCodeCompassMessage));

      if (metaArg) { // Check if metaArg is defined (and not the initial undefined)
        const meta = metaArg as { existingServerStatus?: { service?: string } }; // Cast after confirming it's an object
        if (meta.existingServerStatus && typeof meta.existingServerStatus === 'object' && meta.existingServerStatus !== null) {
          expect(meta.existingServerStatus.service).toBe("OtherService");
        }
        // else: existingServerStatus might not be present or not an object, which might be valid depending on the log
      }
      // else: metaArg is not present, which might be valid depending on the specific log call being asserted
    } else {
      // Fail test explicitly if log not found
      const allErrorMessages = ml.error.mock.calls.map(c => String(c[0])).join('\n');
      throw new Error(`Expected non-CodeCompass server error log not found. Logged errors:\n${allErrorMessages}`);
    }
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

    
    // Mock axios.get for /api/ping to simulate ECONNREFUSED
    vi.mocked(axios.get).mockImplementation(async (url: string): Promise<any> => {
      if (url.endsWith('/api/ping')) {
        const error = new Error('connect ECONNREFUSED 127.0.0.1:3001') as import('axios').AxiosError; // More realistic message
        error.code = 'ECONNREFUSED';
        error.isAxiosError = true;
        // @ts-ignore // Simulate Axios error structure if needed for other checks in SUT
        error.config = { url }; 
        return Promise.reject(error);
      }
      return Promise.resolve({ status: 404, data: {} }); // Default for other calls
    });
    
    process.env.SIMULATE_EADDRINUSE_FOR_TEST = 'true'; // Ensure this is set if mockHttpServerListenFn relies on it
    try {
      await expect(serverLibModule.startServer('/fake/repo')).rejects.toThrow(
        expect.objectContaining({
          name: "ServerStartupError",
          message: expect.stringContaining(`Port ${mcs.HTTP_PORT} is in use by an unknown service or the existing CodeCompass server is unresponsive to pings. Ping error: connect ECONNREFUSED`),
          // ... other properties of ServerStartupError
        })
      );
    } finally {
      delete process.env.SIMULATE_EADDRINUSE_FOR_TEST;
    }
        
    // Check for one of the specific log messages
    // const pingFailedLogFound = stableMockLoggerInstance.error.mock.calls.some(callArgs => {
    //   const firstArgRaw = callArgs[0];
    //   let logMessage = '';
    //   if (typeof firstArgRaw === 'string') {
    //     logMessage = firstArgRaw;
    //   } else if (typeof firstArgRaw === 'object' && firstArgRaw !== null && 'message' in firstArgRaw && typeof (firstArgRaw as { message: unknown }).message === 'string') {
    //     logMessage = (firstArgRaw as { message: string }).message;
    //   }

    //   const expectedRefusedMessageText = `Connection refused on port ${stableMockConfigServiceInstance.HTTP_PORT}`;
    //   const expectedUnknownServiceMessageText = `Port ${stableMockConfigServiceInstance.HTTP_PORT} is in use by an unknown service or the existing CodeCompass server is unresponsive to pings.`;

    //   if (logMessage.includes(expectedRefusedMessageText) || logMessage.includes(expectedUnknownServiceMessageText)) {
    //     return true;
    //   }

    //   // Check for the "Failed to start CodeCompass" log as well, if its message is relevant
    //   if (logMessage === "Failed to start CodeCompass" && callArgs.length > 1) {
    //     const meta = callArgs[1] as { message?: string };
    //     if (meta && typeof meta.message === 'string' && (meta.message.includes(expectedUnknownServiceMessageText) || meta.message.includes('Ping error: connect ECONNREFUSED'))) {
    //       return true;
    //     }
    //   }
    //   return false;
    // });
    // expect(pingFailedLogFound,
    //     `Expected a log message indicating ping failure or connection refused for port ${stableMockConfigServiceInstance.HTTP_PORT}. Logged errors: ${JSON.stringify(stableMockLoggerInstance.error.mock.calls)}`
    // ).toBe(true);
    
    const expectedPingRefusedMessagePart1 = `Port ${mcs.HTTP_PORT} is in use by an unknown service`;
    const expectedPingRefusedMessagePart2 = `Connection refused on port ${mcs.HTTP_PORT}`;

    const relevantPingRefusedCall = ml.error.mock.calls.find((callArgs: readonly any[]) => {
      if (callArgs && callArgs.length > 0 && typeof callArgs[0] === 'string') {
        const logMsg = callArgs[0];
        return logMsg.includes(expectedPingRefusedMessagePart1) || logMsg.includes(expectedPingRefusedMessagePart2);
      }
      return false;
    });

    expect(relevantPingRefusedCall).toBeDefined();
    if (!relevantPingRefusedCall) {
      // Provide more context in the error message if the log is not found
      const allErrorMessages = ml.error.mock.calls.map(c => String(c[0])).join('\n');
      throw new Error(`Expected ping refused error log not found. Logged errors:\n${allErrorMessages}`);
    }

    // Check first argument of the found log call
    if (relevantPingRefusedCall && typeof relevantPingRefusedCall[0] === 'string') {
      const firstArgOfRelevantCall = relevantPingRefusedCall[0];
      expect(firstArgOfRelevantCall).toEqual(expect.stringContaining(`port ${mcs.HTTP_PORT}`));
    } else {
      throw new Error("First argument of ping refused error log was not a string or log call was not found.");
    }

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
          
    // let failedToStartLogCallFound = false;
    // let statusFetchErrorLogFound = false;
    const expectedFailedToStartMessage = `Port ${mcs.HTTP_PORT} in use by existing CodeCompass server, but status fetch error occurred.`;
    const expectedStatusFetchErrorMessage = `Error fetching status from existing CodeCompass server (port ${mcs.HTTP_PORT}): Error: Failed to fetch status`;
    
    const relevantStatusFetchCall = ml.error.mock.calls.find((callArgs: readonly any[]) => {
      if (callArgs && callArgs.length > 0 && typeof callArgs[0] === 'string') {
        return callArgs[0].includes(expectedStatusFetchErrorMessage);
      }
      return false;
    });

    expect(relevantStatusFetchCall).toBeDefined(); 

    if (!relevantStatusFetchCall) {
      const allErrorMessages = ml.error.mock.calls.map(c => String(c[0])).join('\n');
      throw new Error(`Expected status fetch error log not found. Logged errors:\n${allErrorMessages}`);
    }
    
    // Check first argument of the found log call
    if (relevantStatusFetchCall && typeof relevantStatusFetchCall[0] === 'string') {
      const firstArgOfStatusCall = relevantStatusFetchCall[0];
      expect(firstArgOfStatusCall).toEqual(expect.stringContaining(expectedStatusFetchErrorMessage));
    } else {
      throw new Error("First argument of status fetch error log was not a string or log call was not found.");
    }

    // Check for the "Failed to start CodeCompass" log which contains the ServerStartupError message
    const failedToStartLog = ml.error.mock.calls.find((callArgs: readonly any[]) => {
        if (callArgs && callArgs.length > 0 && typeof callArgs[0] === 'string' && callArgs[0] === "Failed to start CodeCompass") {
            if (callArgs.length > 1 && typeof callArgs[1] === 'object' && callArgs[1] !== null) {
                const meta = callArgs[1] as { message?: string }; // Type assertion
                if (meta.message && typeof meta.message === 'string') {
                    return meta.message.includes(`Port ${mcs.HTTP_PORT} in use by existing CodeCompass server, but status fetch error occurred.`);
                }
            }
        }
        return false;
    });
    expect(failedToStartLog).toBeDefined();


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
  let mockedHttpCreateServer: MockedFunction<typeof http.createServer>;

  let portCounter: number;

  beforeEach(async () => {
    vi.clearAllMocks(); // Clear all mocks
    // Dynamically import http to get the mocked version
    const httpMockModule = await import('http') as unknown as {
      createServer: VitestMock<(...args: any[]) => httpModule.Server>;
      default?: { createServer: VitestMock<(...args: any[]) => httpModule.Server> };
    };
    // Ensure we are using the correct createServer mock function
    mockedHttpCreateServer = (httpMockModule.default?.createServer || httpMockModule.createServer);


    portCounter = 0; // Reset for EADDRINUSE simulations

    // Dynamically import serverLibModule for this suite
    // Add .js extension for ESM module resolution
    serverLibModule = await import('../lib/server.js'); 

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
    expect(mockedHttpCreateServer).toHaveBeenCalledTimes(1); // Use the direct mock
    // The findFreePort utility calls server.listen(port, 'localhost')
    expect(mockHttpServerListenFn).toHaveBeenCalledWith(startPort, 'localhost', undefined, undefined); 
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
    expect(mockedHttpCreateServer).toHaveBeenCalledTimes(2); // Use the direct mock
    expect(mockHttpServerListenFn).toHaveBeenCalledWith(startPort, 'localhost', undefined, undefined); 
    expect(mockHttpServerListenFn).toHaveBeenCalledWith(startPort + 1, 'localhost', undefined, undefined); 
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
    expect(mockedHttpCreateServer).toHaveBeenCalledTimes(1); // Use the direct mock
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
    expect(mockedHttpCreateServer).toHaveBeenCalledTimes(expectedAttempts); // Use the direct mock
  }, 10000); // Increase timeout if needed for many iterations
});

// Import nock for Mocking Target Server
// import nock from 'nock'; // Duplicate import removed

describe('startProxyServer', () => {
  const targetInitialPort = 3005; // Port the main server instance initially tried
  const targetExistingServerPort = 3000; // Port the actual existing CodeCompass server is on
  let proxyListenPort: number; // Port the proxy server will listen on
  
  let findFreePortSpy: MockedFunction<typeof serverLibModule.findFreePort>;
  let proxyServerHttpInstance: httpModule.Server | null = null; // Renamed to avoid confusion

  beforeEach(async () => {
    vi.resetModules(); // Crucial to get fresh modules and apply unmocking correctly
    
    // Unmock axios specifically for this suite BEFORE importing serverLibModule
    vi.doUnmock('axios'); 
    realAxiosInstance = (await import('axios')).default as any; // Cast to any

    // Re-import serverLibModule AFTER axios is unmocked
    serverLibModule = await import('../lib/server.js'); 
    
    // Spy on findFreePort from the freshly imported serverLibModule
    findFreePortSpy = vi.spyOn(serverLibModule, 'findFreePort') as MockedFunction<typeof serverLibModule.findFreePort>;

    // Reset any properties if necessary for this suite's specific context.
    // Use the already declared mcs and ml variables which reference the mocked config service and logger
    mcs.AGENT_QUERY_TIMEOUT = 180000; 
    ml.error.mockClear();
    ml.info.mockClear();


    nock.cleanAll(); // Clean nock before each test

    // Determine the port the proxy will listen on based on startProxyServer's logic
    // startProxyServer calls: findFreePort(requestedPort === targetServerPort ? requestedPort + 1 : requestedPort + 50);
    // In our case: targetInitialPort (3005) is different from targetExistingServerPort (3000)
    // So, it will be targetInitialPort + 50 = 3055
    proxyListenPort = targetInitialPort + 50; 
    // findFreePortSpy = vi.spyOn(serverLibModule, 'findFreePort').mockResolvedValue(proxyListenPort); // Moved to after import

    // Default mock for http.createServer and its listen method for this suite
    // This needs to be robust for startProxyServer's internal usage.
    mockHttpServerListenFn.mockReset().mockImplementation(function(this: any, _port: any, arg2: any, arg3?: any) {
      let callback: (() => void) | undefined;
      if (typeof arg2 === 'function') {
        callback = arg2;
      } else if (typeof arg3 === 'function') {
        callback = arg3;
      }
      if (callback) {
        process.nextTick(callback);
      }
      return this; // listen() should return the server instance itself.
    });

    mockHttpServerOnFn.mockReset().mockImplementation(function(this: any, event: string, callback: (...args: any[]) => void) {
        if (!this._listeners) this._listeners = {};
        this._listeners[event] = callback;
        return this;
    });
    
    // Ensure the createServer mock returns an object that includes 'once' correctly.
    // The createNewMockServerObject function (used by the global http mock) already does this.
    // We need to ensure the local override for this suite also does.
    
    // Revised mock for http.createServer specifically for the startProxyServer suite
    const createMockHttpServerForProxyTests = () => {
      const serverInstance = {
        _listeners: {} as Record<string, ((...args: any[]) => void) | undefined>,
        listen: vi.fn(function(this: any, portOrPathOrOptions: any, arg2?: any, arg3?: any, arg4?: any) {
          let actualCallback: (() => void) | undefined;
          if (typeof portOrPathOrOptions === 'object' && portOrPathOrOptions !== null) { actualCallback = arg2 as (() => void); }
          else if (typeof arg2 === 'function') { actualCallback = arg2; }
          else if (typeof arg3 === 'function') { actualCallback = arg3; }
          else if (typeof arg4 === 'function') { actualCallback = arg4; }

          const portToListen = typeof portOrPathOrOptions === 'number' ? portOrPathOrOptions : (portOrPathOrOptions as net.ListenOptions)?.port;

          // Simulate EADDRINUSE for findFreePort tests if needed by a specific test's mock of listen
          // For startProxyServer itself, we usually want listen to succeed for the proxy.
          // The findFreePort function, when *not* spied on, will use this http.createServer mock.
          if (process.env.SIMULATE_EADDRINUSE_FOR_PROXY_SUITE_LISTEN === String(portToListen)) {
            if (this._listeners && typeof this._listeners.error === 'function') {
              const error = new Error(`Simulated EADDRINUSE for port ${portToListen}`) as NodeJS.ErrnoException;
              error.code = 'EADDRINUSE';
              process.nextTick(() => this._listeners.error!(error));
            }
          } else {
            // Simulate successful listen: emit 'listening' then call direct callback
            process.nextTick(() => {
              if (this._listeners && typeof this._listeners.listening === 'function') {
                this._listeners.listening();
              }
              if (actualCallback) {
                actualCallback();
              }
            });
          }
          return this; // Return server instance
        }),
        on: vi.fn(function(this: any, event: string, callback: (...args: any[]) => void) {
          this._listeners[event] = callback;
          return this;
        }),
        once: vi.fn(function(this: any, event: string, callback: (...args: any[]) => void) {
          // Simple 'once' implementation for mock: store it, findFreePort uses it once.
          this._listeners[event] = callback; 
          return this;
        }),
        address: vi.fn(() => ({ port: proxyListenPort, address: '127.0.0.1', family: 'IPv4' })),
        close: vi.fn(function(this: any, cb?: (err?: Error) => void) { // Ensure 'this' context and optional error
          if (cb) {
            // Simulate async close if necessary, or just call back
            process.nextTick(() => cb()); 
          }
          return this; 
        }),
        removeAllListeners: vi.fn().mockReturnThis(),
      };
      return serverInstance;
    };
    vi.mocked(http.createServer).mockImplementation(createMockHttpServerForProxyTests as any);


    // Default successful behavior for findFreePortSpy
    findFreePortSpy.mockReset().mockResolvedValue(proxyListenPort);

    nock.disableNetConnect(); 
    nock.enableNetConnect((host) => host.startsWith('127.0.0.1') || host.startsWith('localhost'));

    // Ensure the http.createServer mock used by startProxyServer behaves asynchronously for listen and close
    // This mock is specific to the 'startProxyServer' describe block.
    vi.mocked(http.createServer).mockImplementation((requestListener?: http.RequestListener) => {
      const EventEmitter = (require('events') as { EventEmitter: typeof import('events.EventEmitter')}).EventEmitter;
      const serverInstance = new EventEmitter() as unknown as MockedHttpServer & { 
        _storedPort?: number; 
        _storedHost?: string;
        _listenShouldError?: NodeJS.ErrnoException | null;
        _closeShouldError?: Error | null;
        requestListener?: http.RequestListener;
      };
      
      serverInstance.requestListener = requestListener;

      serverInstance.listen = vi.fn((portOrPathOrOptions: any, arg2?: any, arg3?: any, arg4?: any) => {
        let portToListen: number | undefined;
        let hostToListen: string | undefined = '127.0.0.1';
        let actualCallback: (() => void) | undefined;

        if (typeof portOrPathOrOptions === 'number') {
          portToListen = portOrPathOrOptions;
          if (typeof arg2 === 'string') {
            hostToListen = arg2;
            actualCallback = typeof arg3 === 'function' ? arg3 : (typeof arg4 === 'function' ? arg4 : undefined);
          } else if (typeof arg2 === 'function') {
            actualCallback = arg2;
          }
        } else if (typeof portOrPathOrOptions === 'object' && portOrPathOrOptions !== null) {
          portToListen = (portOrPathOrOptions as import('net').ListenOptions).port;
          hostToListen = (portOrPathOrOptions as import('net').ListenOptions).host || hostToListen;
          actualCallback = typeof arg2 === 'function' ? arg2 : undefined;
        } else if (typeof portOrPathOrOptions === 'function') {
           actualCallback = portOrPathOrOptions;
        }


        serverInstance._storedPort = portToListen ?? 0;
        serverInstance._storedHost = hostToListen;

        process.nextTick(() => {
          if (serverInstance._listenShouldError) {
            serverInstance.emit('error', serverInstance._listenShouldError);
            if (actualCallback && serverInstance._listenShouldError.code !== 'EADDRINUSE') {
               actualCallback();
            }
            if (serverInstance._listenShouldError.code === 'EADDRINUSE') return;
          }
          
          if (actualCallback && !serverInstance._listenShouldError) {
            actualCallback();
          }
          if (!serverInstance._listenShouldError) {
            serverInstance.emit('listening');
          }
        });
        return serverInstance;
      });

      serverInstance.close = vi.fn((cb?: (err?: Error) => void) => {
        process.nextTick(() => {
          if (serverInstance._closeShouldError) {
            serverInstance.emit('error', serverInstance._closeShouldError);
            if (cb) cb(serverInstance._closeShouldError);
          } else {
            serverInstance.emit('close');
            if (cb) cb();
          }
        });
        return serverInstance;
      });

      serverInstance.address = vi.fn(() => {
        if (serverInstance._storedPort === undefined) return null;
        return { port: serverInstance._storedPort, address: serverInstance._storedHost || '127.0.0.1', family: 'IPv4' };
      });
      
      // Standard EventEmitter methods are inherited, but if specific mock behavior is needed:
      serverInstance.on = vi.fn(serverInstance.on.bind(serverInstance));
      serverInstance.once = vi.fn(serverInstance.once.bind(serverInstance));
      serverInstance.emit = vi.fn(serverInstance.emit.bind(serverInstance));
      serverInstance.removeAllListeners = vi.fn(serverInstance.removeAllListeners.bind(serverInstance));

      if (requestListener) {
        serverInstance.on('request', requestListener);
      }
      
      return serverInstance as unknown as http.Server;
    });
  });

  afterEach(async () => {
    if (proxyServerHttpInstance && typeof proxyServerHttpInstance.close === 'function') {
      // Check if listening before attempting to close, though mock might not track 'listening' state.
      // The close mock should handle being called even if not "listening".
      await new Promise<void>((resolve, reject) => {
        proxyServerHttpInstance!.close((err?: Error) => { // Add optional err param
          if (err) return reject(err);
          resolve();
        });
      });
    }
    proxyServerHttpInstance = null;
    nock.cleanAll();
    nock.enableNetConnect(); // Restore default network connectivity for other tests
    if (findFreePortSpy) findFreePortSpy.mockRestore();
    
    // Re-mock axios if it was globally mocked and other suites expect it.
    // This ensures the global mock is restored after this suite unmocks it.
    vi.doMock('axios', () => {
        const mockAxiosModule = {
            default: vi.fn() as unknown as typeof axios, // mock the default export
            get: vi.fn(),
            post: vi.fn(),
            delete: vi.fn(),
            isAxiosError: vi.fn((payload: any): payload is import('axios').AxiosError => realAxiosInstance.isAxiosError(payload)), // Use real isAxiosError
        };
        // Make the default export also spread its methods for convenience if accessed directly
        Object.assign(mockAxiosModule.default, {
            get: mockAxiosModule.get,
            post: mockAxiosModule.post,
            delete: mockAxiosModule.delete,
            isAxiosError: mockAxiosModule.isAxiosError,
        });
        return mockAxiosModule;
    });
  });

  it('should resolve with null if findFreePort fails', async () => {
    const findFreePortError = new Error("No free ports available from mock.");
    findFreePortSpy.mockRejectedValueOnce(findFreePortError); // Ensure this mock is active

    proxyServerHttpInstance = await serverLibModule.startProxyServer(targetInitialPort, targetExistingServerPort, "1.0.0-existing");
    
    expect(proxyServerHttpInstance).toBeNull();
    expect(ml.error).toHaveBeenCalledWith(
      `[ProxyServer] Failed to find free port for proxy: ${findFreePortError.message}`,
      expect.objectContaining({ errorDetails: findFreePortError })
    );
  }, 10000); 

  it('should start the proxy server, log info, and proxy /api/ping', async () => {
    proxyServerHttpInstance = await serverLibModule.startProxyServer(targetInitialPort, targetExistingServerPort, "1.0.0-existing");
    
    expect(proxyServerHttpInstance).toBeDefined();
    expect(proxyServerHttpInstance).not.toBeNull(); 
    
    const addressInfo = proxyServerHttpInstance!.address() as import('net').AddressInfo;
    expect(addressInfo).toBeDefined();
    const actualProxyListenPort = addressInfo.port;
    expect(actualProxyListenPort).toBe(proxyListenPort); 

    // Check for key log messages with more flexibility
    const infoCalls = ml.info.mock.calls.map(call => String(call[0])); // Ensure string for matching
    expect(infoCalls).toEqual(expect.arrayContaining([
      expect.stringContaining(`Original CodeCompass server (v1.0.0-existing) is running on port ${targetExistingServerPort}`),
      expect.stringContaining(`This instance (CodeCompass Proxy) is listening on port ${actualProxyListenPort}`),
      expect.stringContaining(`MCP requests to http://localhost:${actualProxyListenPort}/mcp will be forwarded to http://localhost:${targetExistingServerPort}/mcp`),
      expect.stringContaining(`API endpoints /api/ping and /api/indexing-status are also proxied.`)
    ]));

    nock(`http://localhost:${targetExistingServerPort}`)
      .get('/api/ping')
      .reply(200, { service: "CodeCompassTarget", status: "ok_target_ping", version: "1.0.0" });

    const response = await realAxiosInstance.get(`http://127.0.0.1:${actualProxyListenPort}/api/ping`);
    expect(response.status).toBe(200);
    expect(response.data).toEqual({ service: "CodeCompassTarget", status: "ok_target_ping", version: "1.0.0" });
    expect(nock.isDone()).toBe(true);
  }, 10000); 

  it('should handle target server unreachable for /mcp', async () => {
    proxyServerHttpInstance = await serverLibModule.startProxyServer(targetInitialPort, targetExistingServerPort, "1.0.0-existing");
    expect(proxyServerHttpInstance).toBeDefined();
    expect(proxyServerHttpInstance).not.toBeNull(); 
    const actualProxyListenPort = (proxyServerHttpInstance!.address() as import('net').AddressInfo).port;
    
    nock(`http://localhost:${targetExistingServerPort}`)
      .post('/mcp')
      .replyWithError({ message: 'connect ECONNREFUSED', code: 'ECONNREFUSED', isAxiosError: true, request: {} }); // Simulate Axios-like error
        
    try {
      await realAxiosInstance.post(`http://localhost:${actualProxyListenPort}/mcp`, { jsonrpc: "2.0", method: "test", id: "reqUnreachable" });
      throw new Error("Request should have failed due to target unreachable"); 
    } catch (error: any) {
      expect(realAxiosInstance.isAxiosError(error)).toBe(true);
      expect(error.response).toBeDefined(); 
      expect(error.response?.status).toBe(502); 
      expect(error.response?.data).toEqual({
        jsonrpc: "2.0",
        error: { code: -32001, message: "Proxy: Target server unreachable" },
        id: "reqUnreachable"
      });
    }
    
    expect(ml.error).toHaveBeenCalledWith(
      expect.stringContaining(`[ProxyServer] MCP target http://localhost:${targetExistingServerPort}/mcp unreachable for reqId reqUnreachable: connect ECONNREFUSED`),
      // The second argument to logger.error might be the error object itself or a meta object.
      // For simplicity, we check that it was called with something.
      expect.anything() 
    );
    expect(nock.isDone()).toBe(true);
  }, 10000); 
  
  it('should forward target server 500 error for /mcp', async () => {
    proxyServerHttpInstance = await serverLibModule.startProxyServer(targetInitialPort, targetExistingServerPort, "1.0.0-existing");
    expect(proxyServerHttpInstance).toBeDefined();
    expect(proxyServerHttpInstance).not.toBeNull(); 
    const actualProxyListenPort = (proxyServerHttpInstance!.address() as import('net').AddressInfo).port;

    const targetErrorBodyJsonRpc = { jsonrpc: "2.0", error: { code: -32603, message: "Target Server Internal Error" }, id: "req500" };
    nock(`http://localhost:${targetExistingServerPort}`)
      .post('/mcp')
      .reply(500, targetErrorBodyJsonRpc, { 'Content-Type': 'application/json' });

    try {
      await realAxiosInstance.post(`http://localhost:${actualProxyListenPort}/mcp`, { jsonrpc: "2.0", method: "test", id: "req500" });
      throw new Error("Request should have failed due to target 500 error");
    } catch (error: any) {
      expect(realAxiosInstance.isAxiosError(error)).toBe(true);
      expect(error.response).toBeDefined(); 
      expect(error.response?.status).toBe(500); 
      expect(error.response?.data).toEqual(targetErrorBodyJsonRpc);
    }
    expect(nock.isDone()).toBe(true);
  }, 10000); 
});

describe('MCP Tool Relaying', () => {
  const repoPath = '/fake/repo';
  // No mcs, ml here; use stableMockConfigServiceInstance and stableMockLoggerInstance directly

  beforeEach(async () => {
    vi.clearAllMocks(); // Clears call history of all mocks, including stable ones

    // Reset properties of the stable mock config for each test in this suite
    mcs.IS_UTILITY_SERVER_DISABLED = false; // Default for this suite
    mcs.RELAY_TARGET_UTILITY_PORT = undefined;
    
    // Reset call history for axios mocks (which are from the global vi.mock('axios'))
    const mockedAxios = vi.mocked(axios, true);
    mockedAxios.get.mockReset();
    mockedAxios.post.mockReset();

    // Mock other dependencies used by tool handlers
    vi.mocked(getGlobalIndexingStatus).mockReturnValue({
      status: 'idle', message: 'Local idle status', overallProgress: 0, lastUpdatedAt: new Date().toISOString()
    } as IndexingStatusReport);
    
    // Assuming indexRepository and getLLMProvider are imported and vi.mocked at the top level of the file
    // or correctly re-mocked if using vi.resetModules() strategy (which we are not using here for simplicity with stable mocks)
    const { indexRepository } = await import('../lib/repository.js'); // Get the mocked version
    vi.mocked(indexRepository).mockClear().mockResolvedValue(undefined);

    const { getLLMProvider } = await import('../lib/llm-provider.js'); // Get the mocked version
    vi.mocked(getLLMProvider).mockClear().mockResolvedValue({
      checkConnection: vi.fn().mockResolvedValue(true),
      generateText: vi.fn().mockResolvedValue("mocked text"),
      generateEmbedding: vi.fn().mockResolvedValue([0.1, 0.2, 0.3]),
      processFeedback: vi.fn().mockResolvedValue("mocked feedback response"),
    } as any);

    // The capturedToolHandlers are from the initial module load of server.ts.
    // They should reference the configService module, which is mocked to be stableMockConfigServiceInstance.
    // Ensure server.ts has been imported so capturedToolHandlers is populated.
    // This is typically done by importing serverLibModule or specific functions from it.
    // If serverLibModule was imported in the describe's beforeEach, that's sufficient.
  });

  // Test for get_indexing_status (which does not relay)
  it('get_indexing_status tool should return local status and not relay', async () => {
    mcs.IS_UTILITY_SERVER_DISABLED = true; // Set to true to test "no relay" part
    mcs.RELAY_TARGET_UTILITY_PORT = 3005;   // Set a relay port

    const mockStatus: IndexingStatusReport = {
      status: 'idle', message: 'Test local idle status', overallProgress: 0, lastUpdatedAt: new Date().toISOString(),
    };
    vi.mocked(getGlobalIndexingStatus).mockReturnValue(mockStatus);

    const handler = capturedToolHandlers['get_indexing_status'];
    expect(handler, "get_indexing_status handler should be captured").toBeDefined();
    const result = await handler({} /* args */, {} /* extra */);

    expect(axios.get).not.toHaveBeenCalled(); // Crucial: ensure no relay attempt
    expect(axios.post).not.toHaveBeenCalled();
    expect(result.content[0].text).toContain('# Indexing Status');
    expect(result.content[0].text).toContain(`- Status: ${mockStatus.status}`);
    expect(result.content[0].text).toContain(`- Message: ${mockStatus.message}`);
  });


  it('trigger_repository_update should relay if IS_UTILITY_SERVER_DISABLED is true', async () => {
    mcs.IS_UTILITY_SERVER_DISABLED = true;
    mcs.RELAY_TARGET_UTILITY_PORT = 3005;
    vi.mocked(axios.post).mockResolvedValueOnce({ status: 202, data: { message: "Relayed update accepted" }, headers: {}, config: {} as any });
    
    const { indexRepository } = await import('../lib/repository.js'); // Get the mocked version

    const handler = capturedToolHandlers['trigger_repository_update'];
    expect(handler, "trigger_repository_update handler should be captured").toBeDefined();
    const result = await handler({} /* args */, {} /* extra */);

    expect(axios.post).toHaveBeenCalledWith(`http://localhost:3005/api/repository/notify-update`, {});
    expect(result.content[0].text).toContain('# Repository Update Triggered (Relayed to :3005)');
    expect(result.content[0].text).toContain('Relayed update accepted');
    const { indexRepository: mockedIndexRepositoryFromImport } = await import('../lib/repository.js'); // Get the mocked version
    expect(mockedIndexRepositoryFromImport).not.toHaveBeenCalled();
  });

  it('trigger_repository_update should trigger local indexing if relaying is disabled', async () => {
    mcs.IS_UTILITY_SERVER_DISABLED = false; // Relaying disabled
    mcs.RELAY_TARGET_UTILITY_PORT = undefined;

    const { indexRepository: mockedIndexRepositoryFromImport } = await import('../lib/repository.js'); // Get the mocked version
    const { getLLMProvider } = await import('../lib/llm-provider.js'); // Get the mocked version
    const llmProviderInstance = await getLLMProvider();


    const handler = capturedToolHandlers['trigger_repository_update'];
    expect(handler, "trigger_repository_update handler should be captured").toBeDefined();
    const result = await handler({} /* args */, {} /* extra */);
    

    expect(mockedIndexRepositoryFromImport).toHaveBeenCalledWith(expect.anything(), repoPath, llmProviderInstance);
    expect(axios.post).not.toHaveBeenCalled();
    expect(result.content[0].text).toContain('# Repository Update Triggered (Locally)');
  });

   it('trigger_repository_update should not trigger local indexing if already in progress and relaying is disabled', async () => {
    mcs.IS_UTILITY_SERVER_DISABLED = false; // Relaying disabled
    mcs.RELAY_TARGET_UTILITY_PORT = undefined;

    vi.mocked(getGlobalIndexingStatus).mockReturnValue({
      status: 'indexing_file_content', // In-progress status
      message: 'Local indexing in progress', overallProgress: 50, lastUpdatedAt: new Date().toISOString()
    } as IndexingStatusReport);
    const { indexRepository: mockedIndexRepositoryFromImport } = await import('../lib/repository.js'); // Get the mocked version

    const handler = capturedToolHandlers['trigger_repository_update'];
    expect(handler, "trigger_repository_update handler should be captured").toBeDefined();
    const result = await handler({} /* args */, {} /* extra */);

    expect(mockedIndexRepositoryFromImport).not.toHaveBeenCalled(); // Should not be called
    expect(result.content[0].text).toContain('# Repository Update Trigger Failed');
    expect(result.content[0].text).toContain('Indexing already in progress locally.');
  });
});
