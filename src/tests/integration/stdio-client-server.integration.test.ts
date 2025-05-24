import { describe, it, expect, vi, beforeEach, afterAll, beforeAll, type Mock } from 'vitest';
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
  // Add other methods if they are called during indexing/search
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
    const { generateEmbedding: ollamaGenerateEmbedding } = await import('../../lib/ollama');
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
    const { configService: actualConfigService } = require('../../lib/config-service');
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
    serverProcess = spawn('node', [mainScriptPath, 'start', testRepoPath], { stdio: ['pipe', 'pipe', 'pipe'] });
    
    // serverProcess.stderr?.pipe(process.stderr); // For debugging server output

    await waitForServerReady(serverProcess);

    const transport = new StdioClientTransport({
      readableStream: serverProcess.stdout!,
      writableStream: serverProcess.stdin!,
    });
    const client = new MCPClient({ name: "integration-test-client", version: "0.1.0" });

    await client.connect(transport);
    expect(client.state).toBe('connected');

    const statusResult = await client.callTool({ name: 'get_indexing_status', arguments: {} });
    expect(statusResult).toBeDefined();
    expect(statusResult.content).toBeInstanceOf(Array);
    expect(statusResult.content![0].type).toBe('text');
    // Depending on how fast initial indexing is, status could be 'idle' or 'indexing_...'
    // For a small repo, it might complete very quickly.
    // Let's check for key phrases.
    expect(statusResult.content![0].text).toContain('# Indexing Status');
    // Add more specific assertions based on expected initial state if necessary

    await client.close();
    expect(client.state).toBe('closed');
  }, 40000); // Increased timeout for this test

  // More tests will be added here for search, agent_query, etc.
});
