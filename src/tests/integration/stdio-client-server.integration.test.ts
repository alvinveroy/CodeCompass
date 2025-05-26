import { describe, it, expect, vi, beforeEach, afterEach, afterAll, beforeAll, type Mock } from 'vitest';
import { spawn, type ChildProcess, type ChildProcess as NodeChildProcess, type SpawnOptions } from 'child_process'; // Use NodeChildProcess
import { Client as MCPClient } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import fs from 'fs-extra';
import path from 'path';
import os from 'os';
// actualConfigServiceForMock will be initialized in beforeAll
let actualConfigServiceForMock: typeof import('../../lib/config-service').configService;

// CustomStdioClientTransportOptions interface removed as it's no longer used.

// Interface for StdioClientTransport constructor parameters
interface StdioTransportParams {
  command: string;
  args?: string[];
  options?: SpawnOptions;
}

// Local interface for StdioClientTransport options when spawning a process
// interface MyStdioClientTransportOptions { // This interface is no longer needed
//   command: string;
//   args: string[];
//   processEnv?: NodeJS.ProcessEnv;
//   // processCwd?: string; // Example of another potential option
// }

import git from 'isomorphic-git';
import http from 'isomorphic-git/http/node'; // For cloning if needed, or just local init
// import { generateText as ollamaGenerateText } from '../../lib/ollama.js'; // Removed as per Attempt 16 plan

// Mock external services and providers
const mockQdrantClientInstance = {
  search: vi.fn().mockResolvedValue([]),
  upsert: vi.fn().mockResolvedValue(undefined),
  getCollections: vi.fn().mockResolvedValue({ collections: [{ name: 'test-collection' }] }), // Assume collection exists
  createCollection: vi.fn().mockResolvedValue(undefined),
  getCollection: vi.fn().mockResolvedValue({
    status: 'ok',
    config: {
      params: {
        vectors: { size: 768, distance: 'Cosine' } // Align with default EMBEDDING_DIMENSION
      }
    }
  }),
  scroll: vi.fn().mockResolvedValue({ points: [], next_page_offset: null }), // Added for stale entry cleanup
  delete: vi.fn().mockResolvedValue({ status: 'ok' }), // Added for stale entry cleanup (deleting points)
  deleteCollection: vi.fn().mockResolvedValue(undefined), 
};
vi.mock('../../lib/qdrant', () => ({
  initializeQdrant: vi.fn().mockResolvedValue(mockQdrantClientInstance),
  getQdrantClient: vi.fn().mockReturnValue(mockQdrantClientInstance),
  batchUpsertVectors: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../lib/ollama', () => ({
  checkOllama: vi.fn().mockResolvedValue(true),
  checkOllamaModel: vi.fn().mockResolvedValue(true),
  generateEmbedding: vi.fn().mockImplementation(async (text: string) => {
    // Use configService for EMBEDDING_DIMENSION if possible, or a default
    // For tests, configService might not be easily accessible here without complex dynamic imports.
    // Let's use a fixed default dimension for mock embeddings.
    const dimension = 768; // Default for nomic-embed-text
    return Array(dimension).fill(0.1).map((_, i) => (i + 1) * 0.001 * text.length); // Simple deterministic mock
  }),
  generateText: vi.fn().mockResolvedValue("Mocked Ollama text response for integration"), // Added for Attempt 14
}));

const mockLLMProviderInstance = {
  checkConnection: vi.fn(),
  generateText: vi.fn(),
  generateEmbedding: vi.fn(),
  processFeedback: vi.fn(),
  // Uncomment this:
  mockId: 'test-suite-mock-llm-provider-instance' // Unique ID
};

vi.mock('../../lib/llm-provider', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../lib/llm-provider')>();
  // Uncomment this log:
  console.log('[INTEGRATION_TEST_DEBUG] Mocked getLLMProvider FACTORY RUNNING, returning mockLLMProviderInstance ID:', mockLLMProviderInstance.mockId); // Log with ID
  return {
    ...actual,
    getLLMProvider: vi.fn(() => {
      // This log is crucial (can be kept or removed if the factory log is preferred)
      // console.log('[INTEGRATION_TEST_DEBUG] Mocked getLLMProvider CALLED in factory. Returning shared mock instance.');
      return mockLLMProviderInstance; // Return the shared instance
    }),
    switchSuggestionModel: vi.fn().mockResolvedValue(true), // Keep other mocked exports
    clearProviderCache: vi.fn(),
    // Export LLMProvider type if needed by other mocks, though not strictly for this file.
  };
});

// Partially mock repository.ts: use actual indexRepository and getGlobalIndexingStatus
vi.mock('../../lib/repository', async () => {
  const actualRepository = await vi.importActual('../../lib/repository') as typeof import('../../lib/repository');
  return {
    ...actualRepository, // Use actual implementations by default
    validateGitRepository: vi.fn().mockResolvedValue(true), // Mock specific functions
    getRepositoryDiff: vi.fn().mockResolvedValue('+ test\n- test2'), // Mock specific functions
    // indexRepository and getGlobalIndexingStatus will be the actual implementations
  };
});


// waitForServerReady function removed as StdioClientTransport now manages its own process.

describe('Stdio Client-Server Integration Tests', () => {
  let testRepoPath: string;
  // serverProcess variable removed as StdioClientTransport will manage its own process.
  const mainScriptPath = path.resolve(__dirname, '../../../dist/index.js'); // Adjust if structure differs
  let transport: StdioClientTransport; // Declare transport here to be accessible in beforeEach
  let client: MCPClient; // Declare client here

  beforeAll(async () => {
    // Dynamically import configService
    const configServiceModule = await import('../../lib/config-service.js');
    actualConfigServiceForMock = configServiceModule.configService;

    // Create a temporary directory for the Git repository
    testRepoPath = await fs.mkdtemp(path.join(os.tmpdir(), 'codecompass-integration-test-'));
    
    // Initialize a Git repository
    await git.init({ fs, dir: testRepoPath });
    
    // Create some files
    await fs.writeFile(path.join(testRepoPath, 'file1.ts'), 'console.log("Hello from file1");\nconst x = 10;');
    await fs.writeFile(path.join(testRepoPath, 'file2.txt'), 'This is a test file with some text content.');
    await fs.ensureDir(path.join(testRepoPath, 'subdir'));
    await fs.writeFile(path.join(testRepoPath, 'subdir', 'file3.ts'), 'export function greet() { return "Hello from subdir"; }');
    await fs.writeFile(path.join(testRepoPath, 'CHANGELOG.md'), '# Test Changelog\n\n- Initial setup for integration tests.');
    
    // Make an initial commit
    await git.add({ fs, dir: testRepoPath, filepath: '.' });
    await git.commit({
      fs,
      dir: testRepoPath,
      message: 'Initial commit for integration test',
      author: { name: 'Test User', email: 'test@example.com' },
    });
    console.log(`Test repository created at: ${testRepoPath}`);
  });

  afterAll(async () => {
    // serverProcess cleanup removed from afterAll.
    if (testRepoPath) {
      await fs.remove(testRepoPath);
      console.log(`Test repository removed from: ${testRepoPath}`);
    }
  });

  beforeEach(() => {
    // Reset mocks for LLM provider before each test if needed
    vi.clearAllMocks(); // Clears call history etc. for all mocks
    // Re-apply mock implementations if vi.clearAllMocks clears them
    // Re-apply default mock for generateText before specific tests use mockResolvedValueOnce
    // vi.mocked(mockLLMProviderInstance.generateText).mockResolvedValue("Mocked LLM response for integration test.");
    // mockLLMProviderInstance.generateText.mockResolvedValue("Mocked LLM response for integration test."); // Ensure this is the one used if vi.mocked isn't sufficient
    
    // Re-initialize/reset the mock functions on the SHARED instance
    // Re-assign methods for robust mocking after vi.clearAllMocks()
    mockLLMProviderInstance.checkConnection = vi.fn();
    mockLLMProviderInstance.generateText = vi.fn();
    mockLLMProviderInstance.generateEmbedding = vi.fn();
    mockLLMProviderInstance.processFeedback = vi.fn();
      
    // Ensure configService mock is reset or its relevant properties are set for the test
    // This might involve dynamically importing and mocking configService if its state needs to be test-specific
    // For now, we assume the top-level vi.mock for configService in unit tests is sufficient or
    // that the server uses defaults that are compatible with these integration tests.
    // If specific config (like EMBEDDING_DIMENSION) is crucial, ensure it's correctly mocked.
    vi.spyOn(actualConfigServiceForMock, 'EMBEDDING_DIMENSION', 'get').mockReturnValue(768);

    // Add this to ensure previous test's transport is fully closed if not already
    if (transport && typeof transport.close === 'function') {
        transport.close();
    }
    if (client && typeof client.close === 'function') {
        // Vitest's `afterEach` runs before `beforeEach` of the next test.
        // Explicitly awaiting here might be redundant if afterEach handles it,
        // but can be a safeguard. Consider if await is truly needed or if
        // just calling close is sufficient if afterEach guarantees cleanup.
        // For now, let's keep it simple without await here, assuming afterEach does its job.
        client.close().catch(err => console.error("Error closing client in beforeEach pre-cleanup:", err));
    }

    // Setup transport and client for each test to ensure fresh state and proper env application
    const baseSpawnEnv = {
      ...process.env,
      NODE_ENV: 'test', // Crucial for configService behavior in spawned process
      HTTP_PORT: '0', // Ensure dynamic port for the server utility HTTP interface
      LLM_PROVIDER: "ollama", // Added for Attempt 14
      SUGGESTION_PROVIDER: "ollama", // Added for Attempt 14
      EMBEDDING_PROVIDER: "ollama", // Added for Attempt 14
      // Unique worker ID for test isolation if needed by other parts of the system
      VITEST_WORKER_ID: process.env.VITEST_WORKER_ID || `integration_worker_${Math.random().toString(36).substring(7)}`,
      // CODECOMPASS_INTEGRATION_TEST_MOCK_LLM: 'true', // Removed: Rely on Vitest module mock
    };
    const currentTestSpawnEnv = { ...baseSpawnEnv };
    // Ensure CODECOMPASS_INTEGRATION_TEST_MOCK_LLM is NOT set in currentTestSpawnEnv
    // as we are relying on the Vitest module mock.
    delete (currentTestSpawnEnv as {[key: string]: any})['CODECOMPASS_INTEGRATION_TEST_MOCK_LLM'];
    // eslint-disable-next-line no-console
    console.log(`[INTEGRATION_BEFORE_EACH_SPAWN_ENV] For test "${expect.getState().currentTestName}": ${JSON.stringify(currentTestSpawnEnv)}`);

    transport = new StdioClientTransport({
      command: process.execPath,
      args: [mainScriptPath, 'start', testRepoPath, '--port', '0'], // --port 0 passed to CLI
      options: { env: currentTestSpawnEnv } // Spawn environment
    } as StdioTransportParams);
    client = new MCPClient({ name: "integration-test-client", version: "0.1.0" });
  });

  afterEach(async () => {
    // serverProcess cleanup removed from afterEach.
    if (client) {
      await client.close().catch(err => console.error("Error closing client in afterEach:", err));
      client = undefined as any; // Help GC and prevent reuse, cast to any to satisfy TS if client is not initially undefined
    }
    if (transport) {
      transport.close(); // This should terminate the child process
      transport = undefined as any; // Help GC, cast to any
    }
  });

  it('should start the server, connect a client via stdio, and call get_indexing_status', async () => {
    // Ensure Qdrant's getCollection is mocked for the initial check in initializeQdrant
    // This might be called if indexRepository runs automatically on start.
    // The collection name will be derived from configService.COLLECTION_NAME.
    // The mock for initializeQdrant already handles getCollection.
    const spawnEnv = { ...process.env, HTTP_PORT: '0' }; // Ensure utility server also uses dynamic port

    // serverProcess spawning and waitForServerReady removed.
    // serverProcess spawning and waitForServerReady removed.
    // StdioClientTransport now spawns its own process.
    // transport and client are now initialized in beforeEach

    await client.connect(transport);
    // expect(client.state).toBe('connected'); // Property 'state' may not be public or exist

    const statusResult = await client.callTool({ name: 'get_indexing_status', arguments: {} });
    expect(statusResult).toBeDefined();
    expect(statusResult.content).toBeInstanceOf(Array);
    expect(statusResult.content![0].type).toBe('text');
    // Depending on how fast initial indexing is, status could be 'idle' or 'indexing_...'
    // For a small repo, it might complete very quickly.
    // The real getGlobalIndexingStatus will be called.
    const statusText = statusResult.content![0].text as string;
    expect(statusText).toContain('# Indexing Status');
    // Initial status could be 'idle' if indexing is super fast, or 'initializing', 'listing_files', etc.
    // A more robust check might be to see if it eventually becomes 'idle' or 'completed'.
    // For this basic test, just checking the header is fine.
    console.log("Initial get_indexing_status result:", statusText.split('\n')[1]); // Log the status line

    await client.close();
    // expect(client.state).toBe('closed'); // Property 'state' may not be public or exist
  }, 40000); // Increased timeout for this test

  it('should trigger indexing, wait for completion, and perform a search_code', async () => {
    // serverProcess spawning and waitForServerReady removed.
    // StdioClientTransport now spawns its own process.
    // transport and client are now initialized in beforeEach
    await client.connect(transport);

    // 1. Trigger indexing explicitly via the tool to ensure it runs for the test.
    // The server might start initial indexing automatically, this ensures we test the tool.
    console.log("Integration test: Triggering repository update for search_code test.");
    await client.callTool({ name: 'trigger_repository_update', arguments: {} });
    
    // Give a brief moment for the trigger to take effect and status to change
    await new Promise(resolve => setTimeout(resolve, 200));


    // 2. Wait for indexing to complete by polling get_indexing_status
    // This now uses the REAL getGlobalIndexingStatus.
    let indexingComplete = false;
    let attempts = 0;
    const maxAttempts = 60; // Wait up to 30 seconds (60 * 500ms)
    while (!indexingComplete && attempts < maxAttempts) {
      const statusResult = await client.callTool({ name: 'get_indexing_status', arguments: {} });
      const statusText = statusResult.content![0].text as string;
      // Updated completion check
      if (statusText.includes("Status: completed") || statusText.includes("Status: idle")) {
        if (statusText.includes("Overall Progress: 100%") || statusText.includes("Status: completed")) {
            indexingComplete = true;
            // eslint-disable-next-line no-console
            console.log("Integration test: Indexing reported as complete/idle with 100% or completed status.");
        } else if (statusText.includes("Status: idle") && attempts > 10) { // If idle for a bit (e.g., 5s), assume done
            // eslint-disable-next-line no-console
            console.log("Integration test: Indexing reported as idle after several attempts, assuming complete for test.");
            indexingComplete = true;
        }
      }
      if (!indexingComplete) {
        attempts++;
        // eslint-disable-next-line no-console
        await new Promise(resolve => setTimeout(resolve, 500)); // Poll every 500ms
      }
    }
    if (!indexingComplete) {
      const finalStatus = await client.callTool({ name: 'get_indexing_status', arguments: {} });
      console.error("Final indexing status before failing test:", finalStatus.content![0].text);
      throw new Error(`Indexing did not complete within the timeout. Attempts: ${attempts}`);
    }

    // 3. Mock Qdrant search response for "Hello from file1"
    const mockSearchResults = [
      {
        id: 'file1.ts-chunk0',
        score: 0.9,
        payload: {
          dataType: 'file_chunk',
          filepath: 'file1.ts',
          file_content_chunk: 'console.log("Hello from file1");',
          chunk_index: 0,
          total_chunks: 1,
          last_modified: new Date().toISOString(),
        },
      },
    ];
    mockQdrantClientInstance.search.mockResolvedValue(mockSearchResults as any); // Cast as any for simplified mock

    // 4. Perform search_code
    const searchQuery = "Hello from file1";
    const searchResult = await client.callTool({ name: 'search_code', arguments: { query: searchQuery } });
    
    expect(searchResult).toBeDefined();
    expect(searchResult.content).toBeInstanceOf(Array);
    const searchResultText = searchResult.content![0].text as string;
    expect(searchResultText).toContain(`# Search Results for: "${searchQuery}"`);
    expect(searchResultText).toContain('## file1.ts');
    expect(searchResultText).toContain('console.log("Hello from file1")');
    // Check for the non-LLM summary because the snippet is short
    expect(searchResultText).toContain('### Summary');
    // Check that the actual code snippet is present
    expect(searchResultText).toContain('console.log("Hello from file1");');
    expect(searchResultText).toContain('const x = 10;');

    await client.close();
  }, 60000); // Increased timeout for indexing and search

  it('should execute agent_query and get a mocked LLM response', async () => {
    // serverProcess spawning and waitForServerReady removed.
    // StdioClientTransport now spawns its own process.
    // transport and client are now initialized in beforeEach
    await client.connect(transport);
    
    // Ensure LLM generateText is mocked for the agent's synthesis step
    mockLLMProviderInstance.generateText.mockResolvedValueOnce("This is the agent's plan and summary based on the query about file1.");

    const agentQueryResult = await client.callTool({ name: 'agent_query', arguments: { query: "What is in file1.ts?" } });
    expect(agentQueryResult).toBeDefined();
    expect(agentQueryResult.content).toBeInstanceOf(Array);
    const agentResultText = agentQueryResult.content![0].text as string;
    
    // The agent_query response is complex. We check for the final mocked synthesis.
    // The exact content depends on the agent's internal plan and capabilities it calls.
    // For this test, we're primarily interested that it ran and the LLM mock was hit for synthesis.
    // Check for some indication of successful agent processing and context usage.
    expect(agentResultText).toContain('file1.ts'); // Ensure it mentions the file
    expect(agentResultText).toContain('console.log("Hello from file1")'); // Ensure it used context
    await client.close();
  }, 45000);

  it('should call get_changelog and retrieve content from the test CHANGELOG.md', async () => {
    // serverProcess spawning and waitForServerReady removed.
    // StdioClientTransport now spawns its own process.
    // transport and client are now initialized in beforeEach
    await client.connect(transport);

    const changelogResult = await client.callTool({ name: 'get_changelog', arguments: {} });
    expect(changelogResult).toBeDefined();
    expect(changelogResult.content).toBeInstanceOf(Array);
    const changelogText = changelogResult.content![0].text as string;

    expect(changelogText).toContain('# Test Changelog');
    expect(changelogText).toContain('- Initial setup for integration tests.');
    // It also includes the version from configService.VERSION (mocked as 'test-version')
    // The spawned server will use its own configService, which gets VERSION from lib/version.ts
    // Let's import the real VERSION to check against.
    const { VERSION: actualVersion } = await import('../../lib/version.js');
    expect(changelogText).toContain(`(v${actualVersion})`);


    await client.close();
  }, 40000);

  it('should call trigger_repository_update and verify indexing starts', async () => {
    // serverProcess spawning and waitForServerReady removed.
    // StdioClientTransport now spawns its own process.
    // transport and client are now initialized in beforeEach
    await client.connect(transport);

    // Clear any calls from initial auto-indexing if it happened
    mockQdrantClientInstance.upsert.mockClear();
    mockQdrantClientInstance.search.mockClear(); 
    
    // The mock for qdrant.ts has batchUpsertVectors at the module level
    const qdrantModule = await import('../../lib/qdrant.js');
    vi.mocked(qdrantModule.batchUpsertVectors).mockClear();


    // Wait for indexing to be idle if it started automatically
    let currentStatusText = '';
    for (let i = 0; i < 60; i++) { // Poll for max 30 seconds (increased from 20 polls / 10s)
      const statusResult = await client.callTool({ name: 'get_indexing_status', arguments: {} });
      currentStatusText = (statusResult.content![0] as {text: string}).text;
      if (currentStatusText.includes("Status: idle") || currentStatusText.includes("Status: completed")) break;
      await new Promise(resolve => setTimeout(resolve, 500));
    }
    expect(currentStatusText).toMatch(/Status: (idle|completed)/);

    // Call trigger_repository_update
    const triggerResult = await client.callTool({ name: 'trigger_repository_update', arguments: {} });
    expect(triggerResult.content![0].text).toContain('# Repository Update Triggered (Locally)');

    // Wait a bit longer for indexing to potentially start and make calls
    await new Promise(resolve => setTimeout(resolve, 5000)); // Increased wait time to 5 seconds

    // Verify that batchUpsertVectors was called, indicating indexing ran
    // This relies on the real indexRepository calling the mocked batchUpsertVectors
    expect(qdrantModule.batchUpsertVectors).toHaveBeenCalled();
    
    // Optionally, check status
    const statusResult = await client.callTool({ name: 'get_indexing_status', arguments: {} });
    const statusText = statusResult.content![0].text as string;
    console.log("Indexing status after trigger_repository_update:", statusText.split('\n')[1]);
    // Status might be 'indexing_file_content', 'indexing_commits_diffs', or quickly back to 'idle'/'completed'
    // A more robust check would be to see it transition through states if possible, or just that it's not 'error'.
    expect(statusText).not.toContain("Status: error");


    await client.close();
  }, 60000); // Increased overall test timeout

  it('should call switch_suggestion_model and get a success response', async () => {
    // serverProcess spawning and waitForServerReady removed.
    // StdioClientTransport now spawns its own process.
    // transport and client are now initialized in beforeEach
    await client.connect(transport);

    const modelSwitchArgs = { model: 'deepseek-coder', provider: 'deepseek' };
    // Mock the underlying switchSuggestionModel from llm-provider to return true for this test
    // as the actual provider availability checks are complex and mocked.
    const llmProviderModule = await import('../../lib/llm-provider.js');
    vi.mocked(llmProviderModule.switchSuggestionModel).mockResolvedValue(true);
    // Also ensure getLLMProvider's checkConnection for the "new" provider returns true
    // This is tricky as getLLMProvider is called internally by the tool.
    // For this integration test, we'll rely on the switchSuggestionModel mock and the tool's response.

    const switchResult = await client.callTool({ name: 'switch_suggestion_model', arguments: modelSwitchArgs });
    expect(switchResult).toBeDefined();
    expect(switchResult.content).toBeInstanceOf(Array);
    const switchResultText = switchResult.content![0].text as string;

    expect(switchResultText).toContain('# Suggestion Model Switched');
    expect(switchResultText).toContain(`Successfully switched to model '${modelSwitchArgs.model}' using provider '${modelSwitchArgs.provider}'`);
    
    // Verify that configService.persistModelConfiguration was called (indirectly, via switchSuggestionModel)
    // This requires spying on the actual configService instance used by the spawned server, which is hard.
    // Unit tests for switchSuggestionModel should cover this. Here, we focus on the tool's response.

    await client.close();
  }, 40000);

  it('should perform some actions and then retrieve session history with get_session_history', async () => {
    // serverProcess spawning and waitForServerReady removed.
    // StdioClientTransport now spawns its own process.
    // transport and client are now initialized in beforeEach
    await client.connect(transport);

    const testSessionId = `manual-session-${Date.now()}`; // Create a manual session ID

    const query1 = "first search query for session history";
    const query2 = "second agent query for session history";

    // Mock Qdrant search for these specific queries
    mockQdrantClientInstance.search.mockResolvedValueOnce([
      { id: 'q1', score: 0.8, payload: { dataType: 'file_chunk', filepath: 'file1.ts', file_content_chunk: 'content1', chunk_index: 0, total_chunks: 1, last_modified: 'date' } }
    ] as any).mockResolvedValueOnce([ // For agent_query's internal search
      { id: 'q2', score: 0.7, payload: { dataType: 'file_chunk', filepath: 'file2.txt', file_content_chunk: 'content2', chunk_index: 0, total_chunks: 1, last_modified: 'date' } }
    ] as any);
    mockLLMProviderInstance.generateText.mockResolvedValue("Agent response for session history test.");

    // Pass testSessionId in arguments
    await client.callTool({ name: 'search_code', arguments: { query: query1, sessionId: testSessionId } });
    await client.callTool({ name: 'agent_query', arguments: { query: query2, sessionId: testSessionId } });

    const historyResult = await client.callTool({ name: 'get_session_history', arguments: { sessionId: testSessionId } });
    expect(historyResult).toBeDefined();
    expect(historyResult.content).toBeInstanceOf(Array);
    const historyText = historyResult.content![0].text as string;

    expect(historyText).toContain(`# Session History (${testSessionId})`);
    expect(historyText).toContain(`Query 1: "${query1}"`);
    expect(historyText).toContain(`Query 2: "${query2}"`); // Agent query also gets logged
    expect(historyText).toContain('## Queries (2)'); // Expecting two queries

    await client.close();
  }, 50000);

  it('should call generate_suggestion and get a mocked LLM response', async () => {
    // serverProcess spawning and waitForServerReady removed.
    // transport and client are now initialized in beforeEach
    await client.connect(transport);

    // Wait for indexing (similar to search_code test)
    let indexingComplete = false, attempts = 0;
    while (!indexingComplete && attempts < 60) {
      const statusResult = await client.callTool({ name: 'get_indexing_status', arguments: {} });
      if ((statusResult.content![0].text as string).includes("Status: idle") || (statusResult.content![0].text as string).includes("Status: completed")) indexingComplete = true;
      else { attempts++; await new Promise(resolve => setTimeout(resolve, 500)); }
    }
    if (!indexingComplete) throw new Error("Indexing did not complete for generate_suggestion test.");

    mockQdrantClientInstance.search.mockResolvedValue([ // Mock search results for context
      { id: 'sugg-ctx', score: 0.85, payload: { dataType: 'file_chunk', filepath: 'file1.ts', file_content_chunk: 'context for suggestion', chunk_index: 0, total_chunks: 1, last_modified: 'date' } }
    ]);
    
    // Mock LLMProvider's generateText for this specific test
    mockLLMProviderInstance.generateText.mockClear(); // Clear any previous specific mocks
    // Configure the method on the SHARED instance for this specific call
    const specificSuggestionResponse = "This is a generated suggestion based on context from file1.ts";
    // mockLLMProviderInstance.generateText // This line was incomplete in the plan, assuming it's for the specific response
    //     .mockResolvedValueOnce("Mocked refined query for generate_suggestion") // For potential refinement step
    //     .mockResolvedValueOnce(specificSuggestionResponse); // For final suggestion
    mockLLMProviderInstance.generateText.mockResolvedValueOnce(specificSuggestionResponse);


    const suggestionQuery = "Suggest how to use file1.ts";
    const result = await client.callTool({ name: 'generate_suggestion', arguments: { query: suggestionQuery } });
    
    expect(result).toBeDefined();
    expect(result.content).toBeInstanceOf(Array);
    // const suggestionText = result.content![0].text as string;
    const suggestionText = (result.content as Array<{text?: string}>)[0]?.text;


    expect(suggestionText).toContain(`# Code Suggestion for: "${suggestionQuery}"`);
    // Check for key parts of a suggestion response
    expect(suggestionText).toContain("## Suggestion");
    // expect(suggestionText).toContain(specificSuggestionResponse); // Check for specific mocked content
    // The plan's assertion was: expect(suggestionText).toContain(specificResponse);
    // where specificResponse was the same as specificSuggestionResponse.
    expect(suggestionText).toContain(specificSuggestionResponse);
    // Optionally, still check that "Context Used" section exists if it's part of the format
    expect(suggestionText).toContain("Context Used");
    // And that file1.ts is mentioned somewhere in that context section if important
    expect(suggestionText).toMatch(/Context Used[\s\S]*file1\.ts/);

    await client.close();
  }, 60000);

  it('should call get_repository_context and get a mocked LLM summary', async () => {
    // serverProcess spawning and waitForServerReady removed.
    // transport and client are now initialized in beforeEach
    await client.connect(transport);

    // Wait for indexing
    let indexingComplete = false, attempts = 0;
    while (!indexingComplete && attempts < 60) {
      const statusResult = await client.callTool({ name: 'get_indexing_status', arguments: {} });
      if ((statusResult.content![0].text as string).includes("Status: idle") || (statusResult.content![0].text as string).includes("Status: completed")) indexingComplete = true;
      else { attempts++; await new Promise(resolve => setTimeout(resolve, 500)); }
    }
    if (!indexingComplete) throw new Error("Indexing did not complete for get_repository_context test.");

    mockQdrantClientInstance.search.mockResolvedValue([ // Mock search results for context
      { id: 'repo-ctx', score: 0.75, payload: { dataType: 'file_chunk', filepath: 'file2.txt', file_content_chunk: 'repository context information', chunk_index: 0, total_chunks: 1, last_modified: 'date' } }
    ]);

    // Mock LLMProvider's generateText for this specific test
    mockLLMProviderInstance.generateText.mockClear(); // Clear any previous specific mocks
    const specificSummaryResponse = "This is a summary of the repository context, using info from file2.txt";
    mockLLMProviderInstance.generateText
        .mockResolvedValueOnce("Mocked refined query for get_repository_context") // For potential refinement step
        .mockResolvedValueOnce(specificSummaryResponse); // For final summary

    const repoContextQuery = "What is the main purpose of this repo?";
    const repoContextResult = await client.callTool({ name: 'get_repository_context', arguments: { query: repoContextQuery } });
    
    expect(repoContextResult).toBeDefined();
    expect(repoContextResult.content).toBeInstanceOf(Array);
    const repoContextText = repoContextResult.content![0].text as string;

    expect(repoContextText).toContain(`# Repository Context Summary for: "${repoContextQuery}"`);
    // Check for key parts of a repo context summary
    expect(repoContextText).toContain("## Summary");
    expect(repoContextText).toContain(specificSummaryResponse); // Check for specific mocked content
    // Optionally, still check that "Relevant Information Used for Summary" section exists
    expect(repoContextText).toContain("Relevant Information Used for Summary");
    // And that file2.txt is mentioned somewhere in that context section if important
    expect(repoContextText).toMatch(/Relevant Information Used for Summary[\s\S]*file2\.txt/);

    await client.close();
  }, 60000);
});
