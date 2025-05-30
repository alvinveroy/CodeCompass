import { describe, it, expect, vi, beforeEach, afterEach, beforeAll, type Mock } from 'vitest';
import { Dirent } from 'fs'; // Import Dirent directly from 'fs'
import { z } from 'zod'; // For the parameters_schema
import type { CapabilityDefinition as AgentCapabilityDefinition } from '../lib/agent'; // Use 'type' import and alias if needed
// import path from 'path'; // DELETE THIS LINE
import { QdrantClient } from '@qdrant/js-client-rest';

// Near the top of the file, after imports but before the first describe block:
const createMockDirent = (name: string, isDir: boolean): Dirent => {
  const dirent = new Dirent();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-assignment
  const mockDirent = dirent as any;
  // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
  mockDirent.name = name;
  // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
  mockDirent.isFile = () => !isDir;
  // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
  mockDirent.isDirectory = () => isDir;
  // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
  mockDirent.isBlockDevice = () => false;
  // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
  mockDirent.isCharacterDevice = () => false;
  // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
  mockDirent.isSymbolicLink = () => false;
  // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
  mockDirent.isFIFO = () => false;
  // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
  mockDirent.isSocket = () => false;
  return dirent;
};

// 2. Mock external dependencies of agent.ts FIRST
vi.mock('../lib/config-service', () => {
  const loggerInstance = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
  return {
    __esModule: true,
    configService: {
      MAX_DIFF_LENGTH_FOR_CONTEXT_TOOL: 3000,
      MAX_SNIPPET_LENGTH_FOR_CONTEXT_NO_SUMMARY: 1500,
      MAX_FILES_FOR_SUGGESTION_CONTEXT_NO_SUMMARY: 15,
      AGENT_DEFAULT_MAX_STEPS: 2, 
      AGENT_ABSOLUTE_MAX_STEPS: 3, 
      REQUEST_ADDITIONAL_CONTEXT_MAX_SEARCH_RESULTS: 10,
      COLLECTION_NAME: 'test-collection',
      SUGGESTION_PROVIDER: 'ollama',
      SUGGESTION_MODEL: 'test-model',
      OLLAMA_HOST: 'http://localhost:11434',
      AGENT_QUERY_TIMEOUT: 60000, 
      MAX_REFINEMENT_ITERATIONS: 3, 
      QDRANT_SEARCH_LIMIT_DEFAULT: 5,
    },
    logger: loggerInstance,
  };
});

// Mock external dependencies (these are fine)
vi.mock('../lib/llm-provider');
vi.mock('../lib/state');
vi.mock('../lib/query-refinement');
vi.mock('../lib/repository');
vi.mock('isomorphic-git');
vi.mock('fs/promises', () => {
  const readFileMock = vi.fn();
  const readdirMock = vi.fn();
  const accessMock = vi.fn();
  const statMock = vi.fn();
  // Define a mock Dirent structure that fsPromises.readdir would resolve with
  const _mockDirent_fs_promises = (name: string, isDir: boolean, _basePath = '/test/repo/some/path'): Dirent => { // _basePath unused
    const dirent = new Dirent();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-assignment
    const mockDirent = dirent as any;
    // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
    mockDirent.name = name;
    // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
    mockDirent.isFile = () => !isDir;
    // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
    mockDirent.isDirectory = () => isDir;
    // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
    mockDirent.isBlockDevice = () => false;
    // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
    mockDirent.isCharacterDevice = () => false;
    // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
    mockDirent.isSymbolicLink = () => false;
    // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
    mockDirent.isFIFO = () => false;
    // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
    mockDirent.isSocket = () => false;
    // Standard fs.Dirent does not have 'path' or 'parentPath' properties.
    return dirent;
  };

  const mockFsPromises = {
    readFile: readFileMock,
    readdir: readdirMock,
    access: accessMock,
    stat: statMock,
    // If Dirent is used as a type like fsPromises.Dirent, it's not part of the value-level export
    // Dirent is a type from the module, not a property of the fsPromises object.
  };
  return {
    __esModule: true, // Important for CJS/ESM interop with mocks
    ...mockFsPromises, // Spread for named exports if any were used like `import { readFile } from 'fs/promises'`
    default: mockFsPromises, // For `import fsPromises from 'fs/promises'`
    // To make fsPromises.Dirent available as a type, it's usually handled by @types/node
    // The mock itself doesn't need to provide the Dirent type, just objects conforming to it.
  };
});

// SUT functions will be called via ActualAgentModule

// Import mocked dependencies
import { getLLMProvider } from '../lib/llm-provider';
import { getOrCreateSession, addQuery, addSuggestion, updateContext, getRecentQueries, /* getRelevantResults */ } from '../lib/state'; // Corrected: removed _getRelevantResults
import { searchWithRefinement } from '../lib/query-refinement';
// import { logger, configService } from '../lib/config-service'; // Corrected: import logger, configService
import { validateGitRepository, getRepositoryDiff, /* getCommitHistoryWithChanges */ } from '../lib/repository'; // Corrected: removed _getCommitHistoryWithChanges
import git from 'isomorphic-git';
import { readFile, readdir, /* stat, access */ } from 'fs/promises'; // Corrected: import stat, access

// For testing the *original* parseToolCalls and executeToolCall:
let ActualAgentModule: typeof import('../lib/agent');

beforeAll(async () => {
  ActualAgentModule = await vi.importActual('../lib/agent');
  // runAgentLoopSUT will be assigned from ActualAgentModule in the relevant describe block
});
const mockLLMProviderInstance = {
  generateText: vi.fn(),
  checkConnection: vi.fn().mockResolvedValue(true),
};
const mockQdrantClientInstance = {
  search: vi.fn(),
  scroll: vi.fn(),
} as unknown as QdrantClient;


describe('Agent', () => {
  beforeEach(async () => {
    vi.clearAllMocks(); // Clear all mocks from previous tests

    (getLLMProvider as Mock).mockResolvedValue(mockLLMProviderInstance);
     
     
    mockLLMProviderInstance.generateText.mockReset().mockResolvedValue("Default LLM response");
    mockLLMProviderInstance.checkConnection.mockReset().mockResolvedValue(true);

    // Clear logger mocks (assuming logger is imported from config-service which is mocked)
    const { logger: agentLogger } = await vi.importActual<typeof import('../lib/config-service')>('../lib/config-service'); 
    if (agentLogger && typeof (agentLogger.info as Mock).mockClear === 'function') { // Check if logger and its methods are mocks
      (Object.values(agentLogger) as Mock[]).forEach(mockFn => mockFn.mockClear?.());
    }

     
    mockLLMProviderInstance.generateText.mockReset().mockResolvedValue("Default LLM response");
    mockLLMProviderInstance.checkConnection.mockReset().mockResolvedValue(true);

    // Clear logger mocks (assuming logger is imported from config-service which is mocked)
    // const { logger: agentLogger } = await vi.importActual<typeof import('../lib/config-service')>('../lib/config-service'); // Duplicate removed
    // if (agentLogger && typeof (agentLogger.info as Mock).mockClear === 'function') { 
    //   (Object.values(agentLogger) as Mock[]).forEach(mockFn => mockFn.mockClear?.());
    // }

    vi.mocked(validateGitRepository).mockReset().mockResolvedValue(true);
    (getRepositoryDiff as Mock).mockReset().mockResolvedValue('Default diff content');
     
    (searchWithRefinement as Mock).mockReset().mockResolvedValue({ results: [] as import('../lib/types').DetailedQdrantSearchResult[], refinedQuery: 'refined query', relevanceScore: 0 });
    vi.mocked(git.listFiles).mockReset().mockResolvedValue(['file1.ts', 'file2.js']); // Use vi.mocked for default exports
    (getOrCreateSession as Mock).mockReset().mockImplementation((sessionIdParam?: string, _repoPath?: string) => {
      return { id: sessionIdParam || 'default-test-session', queries: [], suggestions: [], context: {} };
    });
    (addQuery as Mock).mockReset();
    (addSuggestion as Mock).mockReset();
    (updateContext as Mock).mockReset();
    (getRecentQueries as Mock).mockReset().mockReturnValue([]);
    vi.mocked(readFile).mockReset().mockResolvedValue('Default file content from generic mock');
    // Mock readdir to resolve with an array of these mock Dirent objects.
    // The cast to `Dirent[]` should be sufficient if createMockDirent returns valid Dirent-like objects.
    // Use 'as any' to resolve the stubborn TS2345 error for the mock.
    // This is acceptable in tests where the precise generic of Dirent isn't crucial.
    // Using the top-level createMockDirent
     
    vi.mocked(readdir).mockReset().mockResolvedValue([createMockDirent('entry1', false)] as unknown as Dirent<Buffer>[]);
  });
  afterEach(() => { vi.restoreAllMocks(); });

  describe('parseToolCalls (original)', () => {
    it('should parse valid tool calls', () => {
      const output = `TOOL_CALL: {"tool":"search_code","parameters":{"query":"authentication"}}`;
      // Test the original function using ActualAgentModule
      const result = ActualAgentModule.parseToolCalls(output);
      expect(result).toHaveLength(1);
      expect(result[0]).toEqual({ tool: 'search_code', parameters: { query: 'authentication' } });
    });
  });
  
  describe('executeToolCall (original)', () => {
    const repoPath = '/test/repo';
    it('should throw if tool requires model and model is unavailable', async () => {
      // Test the original function using ActualAgentModule
      try {
        await ActualAgentModule.executeToolCall(
          { tool: 'agent_query', parameters: { user_query: 'test' } }, // agent_query requires a model
          mockQdrantClientInstance, repoPath, false // suggestionModelAvailable = false
        );
        // If it doesn't throw, fail the test
        expect(true).toBe(false); // Should not reach here
      } catch (e) {
        const errorResult = e instanceof Error ? e : new Error(String(e));
        expect(errorResult.message).toContain('Tool agent_query requires the suggestion model which is not available');
      }
    });
  });
  
  describe('runAgentLoop', () => {
    const mockQdrantClient = mockQdrantClientInstance;
    const repoPath = '/test/repo';
    // We will not spy on parseToolCalls or executeToolCall directly for runAgentLoop tests.
    // We will control their behavior by mocking their dependencies or the LLM responses.
    let runAgentLoopSUT_local: typeof ActualAgentModule.runAgentLoop; // SUT for this block

    beforeEach(() => {
        // Assign SUT for this block
        runAgentLoopSUT_local = ActualAgentModule.runAgentLoop;

        // General setup for LLM provider mock for this describe block. Tests can override.
         
        mockLLMProviderInstance.generateText.mockReset().mockResolvedValue("LLM Verification OK");
        // Ensure dependencies of executeToolCall are reset/mocked as needed for each test
        const mockSearchResult: import('../lib/types').DetailedQdrantSearchResult = {
            id: 'search-res-1',
            score: 0.8,
            payload: {
              dataType: 'file_chunk',
              filepath: 'file.ts',
              file_content_chunk: 'mock snippet',
              chunk_index: 0,
              total_chunks: 1,
              last_modified: '2023-01-01'
            } as import('../lib/types').FileChunkPayload // Explicit cast for clarity in test
            // No vector or version needed as per DetailedQdrantSearchResult
        };
        vi.mocked(searchWithRefinement).mockClear().mockResolvedValue({ results: [mockSearchResult], refinedQuery: 'refined', relevanceScore: 0.8 });
    });

    afterEach(() => {
        // vi.restoreAllMocks() in the outer afterEach will handle restoring these spies.
        // vi.resetAllMocks(); // If outer afterEach doesn't cover vi.fn() instances, keep this.
                           // But vi.restoreAllMocks() should cover spies.
    });

    it('should execute a tool call and then provide final response', async () => {
      // Correct sequence for mockLLMProviderInstance.generateText:
      // 1. Verification call in runAgentLoop
      // 2. Agent reasoning call (should return TOOL_CALL string)
      // 3. Final response call (if loop ends or max steps reached)
      
      // Mock setup for mockLLMProviderInstance.generateText
      mockLLMProviderInstance.generateText
        .mockReset()
        .mockResolvedValueOnce("LLM Verification OK") // For currentProvider.generateText("Test message") in runAgentLoop
        .mockResolvedValueOnce('TOOL_CALL: {"tool": "agent_query", "parameters": {"user_query": "query with tool", "session_id": "session2"}}') // For agentPrompt in runAgentLoop
        .mockResolvedValueOnce('Final response from orchestrator.'); // For the first LLM call within runAgentQueryOrchestrator (assuming it gives a direct final answer for this test)

      // The actual parseToolCalls will be used.
      // The actual executeToolCall will be used. We need to ensure its dependencies are mocked.
      // searchWithRefinement is already mocked in beforeEach.
      // getRepositoryDiff is mocked in global beforeEach.
      // validateGitRepository is mocked in global beforeEach.

      await runAgentLoopSUT_local('query with tool', 'session2', mockQdrantClient, repoPath, true);

      // Assertion for generateText call count
      expect(mockLLMProviderInstance.generateText).toHaveBeenCalledTimes(3); // Verification, Outer Loop, Orchestrator's 1st call

      // Assertions for what each call was made with
      expect(mockLLMProviderInstance.generateText).toHaveBeenNthCalledWith(1, "Test message");
      expect(mockLLMProviderInstance.generateText).toHaveBeenNthCalledWith(2, expect.stringContaining('User query: query with tool')); // Outer loop prompt
      expect(mockLLMProviderInstance.generateText).toHaveBeenNthCalledWith(3, expect.stringContaining('Original User Query: query with tool')); // Orchestrator's prompt

      // Verify that searchWithRefinement is NOT directly called by runAgentLoop or its immediate executeToolCall for agent_query.
      // searchWithRefinement would be called by a capability *inside* the orchestrator.
      // For this specific test, if we are mocking the orchestrator to give a direct final answer,
      // then searchWithRefinement (or other capabilities) wouldn't be called.
      // If the test intends to check a capability call, the orchestrator's LLM mock needs to output a capability call.
      // For now, assuming the orchestrator's first LLM call yields the final answer:
      expect(searchWithRefinement).not.toHaveBeenCalled();
      
      const addSuggestionSpy = addSuggestion as Mock;
      expect(addSuggestionSpy).toHaveBeenCalledWith('session2', 'query with tool', expect.stringContaining('Final response from orchestrator.'));
    });
  });
  
  describe('createAgentState (original)', () => {
    it('should create a new agent state with the correct structure', () => {
      const result = ActualAgentModule.createAgentState('test_session', 'Find auth code');
      expect(result).toEqual({ sessionId: 'test_session', query: 'Find auth code', steps: [], context: [], isComplete: false });
    });
  });

  describe('generateAgentSystemPrompt (original)', () => {
    it('should include descriptions of all available tools', () => { 
      const mockCapabilityDefinitionsForPrompt: AgentCapabilityDefinition[] = [
        {
          name: 'capability_searchCodeSnippets', // Example
          description: 'Searches for code.',
          parameters_schema: z.object({ query: z.string().describe("The search query.") })
        }
        // Add more mock capabilities if the test needs to verify their presence in the prompt
      ];
      const prompt = ActualAgentModule.generateAgentSystemPrompt(mockCapabilityDefinitionsForPrompt);
      // Update assertions to match mockCapabilityDefinitionsForPrompt
      expect(prompt).toContain("capability_searchCodeSnippets");
      expect(prompt).toContain("Searches for code.");
      expect(prompt).toContain(JSON.stringify(mockCapabilityDefinitionsForPrompt[0].parameters_schema._def || { description: mockCapabilityDefinitionsForPrompt[0].parameters_schema.description }, null, 2));
    });
  });
});
