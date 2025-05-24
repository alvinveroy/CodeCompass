import { describe, it, expect, vi, beforeEach, afterEach, afterAll, beforeAll, type Mock } from 'vitest';
import { spawn, type ChildProcess } from 'child_process';
import { Client as MCPClient } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import fs from 'fs-extra';
import path from 'path';
import os from 'os';
import git from 'isomorphic-git';
import http from 'isomorphic-git/http/node'; // For cloning if needed, or just local init

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
}));

const mockLLMProviderInstance = {
  checkConnection: vi.fn().mockResolvedValue(true),
  generateText: vi.fn().mockResolvedValue("Mocked LLM response for integration test."),
  generateEmbedding: vi.fn().mockImplementation(async (text: string) => {
    const { generateEmbedding: ollamaGenerateEmbedding } = await import('../../lib/ollama.js');
    return ollamaGenerateEmbedding(text);
  }),
  processFeedback: vi.fn().mockResolvedValue("Mocked improved LLM response."),
};
vi.mock('../../lib/llm-provider', () => ({
  getLLMProvider: vi.fn().mockResolvedValue(mockLLMProviderInstance),
  switchSuggestionModel: vi.fn().mockResolvedValue(true),
  clearProviderCache: vi.fn(),
  // Export LLMProvider type if needed by other mocks, though not strictly for this file.
}));

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


// Helper function to wait for server readiness
function waitForServerReady(childProcess: ChildProcess, timeout = 30000): Promise<void> {
  return new Promise((resolve, reject) => {
    let output = '';
    const onData = (data: Buffer) => {
      output += data.toString();
      // Adjusted readiness message to be more general
      if (output.includes("MCP active on stdio") || output.includes("Utility HTTP server is DISABLED")) {
        if (childProcess.stderr) childProcess.stderr.off('data', onData);
        if (childProcess.stdout) childProcess.stdout.off('data', onData); // Also check stdout if logs go there
        clearTimeout(timer);
        resolve();
      }
    };

    if (childProcess.stderr) childProcess.stderr.on('data', onData);
    // Sometimes readiness messages might go to stdout if stderr is not configured for all logs
    if (childProcess.stdout) childProcess.stdout.on('data', onData);


    const timer = setTimeout(() => {
      if (childProcess.stderr) childProcess.stderr.off('data', onData);
      if (childProcess.stdout) childProcess.stdout.off('data', onData);
      reject(new Error(`Timeout waiting for server to be ready. Last output: ${output.slice(-500)}`));
    }, timeout);

    childProcess.on('exit', (code, signal) => {
      clearTimeout(timer);
      if (childProcess.stderr) childProcess.stderr.off('data', onData);
      if (childProcess.stdout) childProcess.stdout.off('data', onData);
      reject(new Error(`Server process exited prematurely with code ${code}, signal ${signal}. Output: ${output.slice(-500)}`));
    });
    childProcess.on('error', (err) => {
      clearTimeout(timer);
      if (childProcess.stderr) childProcess.stderr.off('data', onData);
      if (childProcess.stdout) childProcess.stdout.off('data', onData);
      reject(new Error(`Server process failed to start: ${err.message}. Output: ${output.slice(-500)}`));
    });
  });
}

describe('Stdio Client-Server Integration Tests', () => {
  let testRepoPath: string;
  let serverProcess: ChildProcess | null = null;
  const mainScriptPath = path.resolve(__dirname, '../../../dist/index.js'); // Adjust if structure differs

  beforeAll(async () => {
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
    if (serverProcess && !serverProcess.killed) {
      serverProcess.kill('SIGTERM');
      await new Promise(resolve => setTimeout(resolve, 500)); // Give it time to exit
      if (!serverProcess.killed) serverProcess.kill('SIGKILL');
    }
    if (testRepoPath) {
      await fs.remove(testRepoPath);
      console.log(`Test repository removed from: ${testRepoPath}`);
    }
  });

  beforeEach(() => {
    // Reset mocks for LLM provider before each test if needed
    vi.clearAllMocks(); // This clears call history etc. Re-mock implementations if they are stateful per test.
    // Re-apply mock implementations if vi.clearAllMocks clears them
     vi.mocked(mockLLMProviderInstance.generateText).mockResolvedValue("Mocked LLM response for integration test.");

    // Ensure configService mock is reset or its relevant properties are set for the test
    // This might involve dynamically importing and mocking configService if its state needs to be test-specific
    // For now, we assume the top-level vi.mock for configService in unit tests is sufficient or
    // that the server uses defaults that are compatible with these integration tests.
    // If specific config (like EMBEDDING_DIMENSION) is crucial, ensure it's correctly mocked.
    const { configService: actualConfigService } = require('../../lib/config-service.js');
    vi.spyOn(actualConfigService, 'EMBEDDING_DIMENSION', 'get').mockReturnValue(768);

  });

  afterEach(async () => {
    if (serverProcess && !serverProcess.killed) {
      serverProcess.kill('SIGTERM');
      // Wait for graceful exit or timeout
      const exitPromise = new Promise(resolve => serverProcess!.on('exit', resolve));
      const timeoutPromise = new Promise(resolve => setTimeout(resolve, 1000)); // 1s timeout
      await Promise.race([exitPromise, timeoutPromise]);
      if (!serverProcess.killed) {
        serverProcess.kill('SIGKILL');
      }
      serverProcess = null;
    }
  });

  it('should start the server, connect a client via stdio, and call get_indexing_status', async () => {
    // Ensure Qdrant's getCollection is mocked for the initial check in initializeQdrant
    // This might be called if indexRepository runs automatically on start.
    // The collection name will be derived from configService.COLLECTION_NAME.
    // The mock for initializeQdrant already handles getCollection.

    serverProcess = spawn('node', [mainScriptPath, 'start', testRepoPath], { stdio: ['pipe', 'pipe', 'pipe'] });
    
    // serverProcess.stderr?.pipe(process.stderr); // For debugging server output

    await waitForServerReady(serverProcess);

    const transport = new StdioClientTransport({
      // For StdioClientTransport:
      // - `stdin` is the stream to write client requests TO (which is the server's stdin)
      // - `stdout` is the stream to read server responses FROM (which is the server's stdout)
      stdin: serverProcess.stdin!,
      stdout: serverProcess.stdout!,
    });
    const client = new MCPClient({ name: "integration-test-client", version: "0.1.0" });

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
    serverProcess = spawn('node', [mainScriptPath, 'start', testRepoPath], { stdio: ['pipe', 'pipe', 'pipe'] });
    await waitForServerReady(serverProcess);

    const client = new MCPClient({ name: "integration-test-client", version: "0.1.0" });
    const transport = new StdioClientTransport({
      stdin: serverProcess.stdin!,
      stdout: serverProcess.stdout!,
    });
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
      if (statusText.includes("Status: idle") || statusText.includes("Status: completed")) {
        if (statusText.includes("Overall Progress: 100%")) {
           indexingComplete = true;
           console.log("Integration test: Indexing reported as complete.");
        } else if (statusText.includes("Status: idle") && !statusText.includes("Overall Progress:")) {
            // Handle older status format or cases where progress might not be 100% but it's idle after initial
            console.log("Integration test: Indexing reported as idle, assuming complete for test.");
            indexingComplete = true;
        }
      }
      if (!indexingComplete) {
        attempts++;
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
    // Check if the mocked LLM summary is present (generateText is mocked)
    expect(searchResultText).toContain("Mocked LLM response for integration test.");


    await client.close();
  }, 60000); // Increased timeout for indexing and search

  it('should execute agent_query and get a mocked LLM response', async () => {
    serverProcess = spawn('node', [mainScriptPath, 'start', testRepoPath], { stdio: ['pipe', 'pipe', 'pipe'] });
    await waitForServerReady(serverProcess);

    const client = new MCPClient({ name: "integration-test-client", version: "0.1.0" });
    const transport = new StdioClientTransport({
      stdin: serverProcess.stdin!,
      stdout: serverProcess.stdout!,
    });
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
    expect(agentResultText).toContain("This is the agent's plan and summary based on the query about file1.");

    await client.close();
  }, 45000);

  it('should call get_changelog and retrieve content from the test CHANGELOG.md', async () => {
    serverProcess = spawn('node', [mainScriptPath, 'start', testRepoPath], { stdio: ['pipe', 'pipe', 'pipe'] });
    await waitForServerReady(serverProcess);

    const client = new MCPClient({ name: "integration-test-client", version: "0.1.0" });
    const transport = new StdioClientTransport({
      stdin: serverProcess.stdin!,
      stdout: serverProcess.stdout!,
    });
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
    serverProcess = spawn('node', [mainScriptPath, 'start', testRepoPath], { stdio: ['pipe', 'pipe', 'pipe'] });
    await waitForServerReady(serverProcess);

    const client = new MCPClient({ name: "integration-test-client", version: "0.1.0" });
    const transport = new StdioClientTransport({
      stdin: serverProcess.stdin!,
      stdout: serverProcess.stdout!,
    });
    await client.connect(transport);

    // Clear any calls from initial auto-indexing if it happened
    mockQdrantClientInstance.upsert.mockClear();
    mockQdrantClientInstance.search.mockClear(); 
    
    // The mock for qdrant.ts has batchUpsertVectors at the module level
    const qdrantModule = await import('../../lib/qdrant.js');
    vi.mocked(qdrantModule.batchUpsertVectors).mockClear();


    // Call trigger_repository_update
    const triggerResult = await client.callTool({ name: 'trigger_repository_update', arguments: {} });
    expect(triggerResult.content![0].text).toContain('# Repository Update Triggered (Locally)');

    // Wait a bit for indexing to potentially start and make calls
    await new Promise(resolve => setTimeout(resolve, 1000)); 

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
  }, 45000);

  it('should call switch_suggestion_model and get a success response', async () => {
    serverProcess = spawn('node', [mainScriptPath, 'start', testRepoPath], { stdio: ['pipe', 'pipe', 'pipe'] });
    await waitForServerReady(serverProcess);

    const client = new MCPClient({ name: "integration-test-client", version: "0.1.0" });
    const transport = new StdioClientTransport({
      stdin: serverProcess.stdin!,
      stdout: serverProcess.stdout!,
    });
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
    serverProcess = spawn('node', [mainScriptPath, 'start', testRepoPath], { stdio: ['pipe', 'pipe', 'pipe'] });
    await waitForServerReady(serverProcess);

    const client = new MCPClient({ name: "integration-test-client", version: "0.1.0" });
    const transport = new StdioClientTransport({
      stdin: serverProcess.stdin!,
      stdout: serverProcess.stdout!,
    });
    await client.connect(transport);

    const sessionId = `test-session-${Date.now()}`;
    const query1 = "first search query for session history";
    const query2 = "second agent query for session history";

    // Mock Qdrant search for these specific queries
    mockQdrantClientInstance.search.mockResolvedValueOnce([
      { id: 'q1', score: 0.8, payload: { dataType: 'file_chunk', filepath: 'file1.ts', file_content_chunk: 'content1' } }
    ]).mockResolvedValueOnce([ // For agent_query's internal search
      { id: 'q2', score: 0.7, payload: { dataType: 'file_chunk', filepath: 'file2.txt', file_content_chunk: 'content2' } }
    ]);
    mockLLMProviderInstance.generateText.mockResolvedValue("Agent response for session history test.");


    await client.callTool({ name: 'search_code', arguments: { query: query1, sessionId } });
    await client.callTool({ name: 'agent_query', arguments: { query: query2, sessionId } });

    const historyResult = await client.callTool({ name: 'get_session_history', arguments: { sessionId } });
    expect(historyResult).toBeDefined();
    expect(historyResult.content).toBeInstanceOf(Array);
    const historyText = historyResult.content![0].text as string;

    expect(historyText).toContain(`# Session History (${sessionId})`);
    expect(historyText).toContain(`Query 1: "${query1}"`);
    expect(historyText).toContain(`Query 2: "${query2}"`); // Agent query also gets logged
    expect(historyText).toContain('## Queries (2)'); // Expecting two queries

    await client.close();
  }, 50000);

  it('should call generate_suggestion and get a mocked LLM response', async () => {
    serverProcess = spawn('node', [mainScriptPath, 'start', testRepoPath], { stdio: ['pipe', 'pipe', 'pipe'] });
    await waitForServerReady(serverProcess);
    
    const client = new MCPClient({ name: "integration-test-client", version: "0.1.0" });
    const transport = new StdioClientTransport({
      stdin: serverProcess.stdin!,
      stdout: serverProcess.stdout!,
    });
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
      { id: 'sugg-ctx', score: 0.85, payload: { dataType: 'file_chunk', filepath: 'file1.ts', file_content_chunk: 'context for suggestion' } }
    ]);
    mockLLMProviderInstance.generateText.mockResolvedValue("This is a generated suggestion based on context.");

    const suggestionQuery = "Suggest how to use file1.ts";
    const suggestionResult = await client.callTool({ name: 'generate_suggestion', arguments: { query: suggestionQuery } });
    
    expect(suggestionResult).toBeDefined();
    expect(suggestionResult.content).toBeInstanceOf(Array);
    const suggestionText = suggestionResult.content![0].text as string;

    expect(suggestionText).toContain(`# Code Suggestion for: "${suggestionQuery}"`);
    expect(suggestionText).toContain("This is a generated suggestion based on context.");
    expect(suggestionText).toContain("Context Used");
    expect(suggestionText).toContain("File: file1.ts");

    await client.close();
  }, 60000);

  it('should call get_repository_context and get a mocked LLM summary', async () => {
    serverProcess = spawn('node', [mainScriptPath, 'start', testRepoPath], { stdio: ['pipe', 'pipe', 'pipe'] });
    await waitForServerReady(serverProcess);

    const client = new MCPClient({ name: "integration-test-client", version: "0.1.0" });
    const transport = new StdioClientTransport({
      readableStream: serverProcess.stdout!,
      writableStream: serverProcess.stdin!,
    });
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
      { id: 'repo-ctx', score: 0.75, payload: { dataType: 'file_chunk', filepath: 'file2.txt', file_content_chunk: 'repository context information' } }
    ]);
    mockLLMProviderInstance.generateText.mockResolvedValue("This is a summary of the repository context.");

    const repoContextQuery = "What is the main purpose of this repo?";
    const repoContextResult = await client.callTool({ name: 'get_repository_context', arguments: { query: repoContextQuery } });
    
    expect(repoContextResult).toBeDefined();
    expect(repoContextResult.content).toBeInstanceOf(Array);
    const repoContextText = repoContextResult.content![0].text as string;

    expect(repoContextText).toContain(`# Repository Context Summary for: "${repoContextQuery}"`);
    expect(repoContextText).toContain("This is a summary of the repository context.");
    expect(repoContextText).toContain("Relevant Information Used for Summary");
    expect(repoContextText).toContain("File: file2.txt");

    await client.close();
  }, 60000);
});
