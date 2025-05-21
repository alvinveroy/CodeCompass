import { describe, it, expect, vi, beforeEach, afterEach, beforeAll } from 'vitest';
import { promises as fsPromises } from 'fs';
import path from 'path';
import { QdrantClient } from '@qdrant/js-client-rest';

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

// REMOVE: vi.mock('../lib/agent', ...) - We will spy on the actual module for internal calls.

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
  const mockFsPromises = {
    readFile: readFileMock,
    readdir: readdirMock,
    access: accessMock,
    stat: statMock,
  };
  return {
    ...mockFsPromises,
    default: mockFsPromises,
  };
});

// Import functions from the SUT module directly
import {
  runAgentLoop, createAgentState, generateAgentSystemPrompt, toolRegistry,
  // Ensure parseToolCalls and executeToolCall are imported if they are to be spied on
  // or tested directly. If they are not exported, vi.spyOn will work on the module object.
  // Assuming they are exported for clarity or if direct testing of originals is also done.
  // If not exported, vi.spyOn(ActualAgentModule, 'name') still works for non-exported functions.
  // For this refactor, we are spying on them via ActualAgentModule.
} from '../lib/agent';

// Import mocked dependencies
import { getLLMProvider } from '../lib/llm-provider';
import { getOrCreateSession, addQuery, addSuggestion, updateContext, getRecentQueries, getRelevantResults } from '../lib/state';
import { searchWithRefinement } from '../lib/query-refinement';
import { logger as mockedLoggerFromAgentPerspective, configService as agentTestConfig } from '../lib/config-service';
import { validateGitRepository, getRepositoryDiff, getCommitHistoryWithChanges } from '../lib/repository';
import git from 'isomorphic-git';
import { readFile, readdir, stat, access } from 'fs/promises';

// For testing the *original* parseToolCalls and executeToolCall:
let ActualAgentModule: typeof import('../lib/agent');

beforeAll(async () => {
  ActualAgentModule = await vi.importActual('../lib/agent');
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

    (getLLMProvider as vi.Mock).mockResolvedValue(mockLLMProviderInstance);
    mockLLMProviderInstance.generateText.mockReset().mockResolvedValue('Default LLM response');
    mockLLMProviderInstance.checkConnection.mockReset().mockResolvedValue(true);

    // Spies will be setup in specific describe/test blocks if needed
    // and restored in afterEach of those blocks.
    
    mockedLoggerFromAgentPerspective.info.mockReset();
    mockedLoggerFromAgentPerspective.warn.mockReset();
    mockedLoggerFromAgentPerspective.error.mockReset();
    mockedLoggerFromAgentPerspective.debug.mockReset();

    (validateGitRepository as vi.Mock).mockReset().mockResolvedValue(true);
    (getRepositoryDiff as vi.Mock).mockReset().mockResolvedValue('Default diff content');
    (searchWithRefinement as vi.Mock).mockReset().mockResolvedValue({ results: [], refinedQuery: 'refined query', relevanceScore: 0 });
    vi.mocked(git.listFiles).mockReset().mockResolvedValue(['file1.ts', 'file2.js']); // Use vi.mocked for default exports
    (getOrCreateSession as vi.Mock).mockReset().mockImplementation((sessionIdParam, _repoPath) => ({ id: sessionIdParam || 'default-test-session', queries: [], suggestions: [], context: {} }));
    (addQuery as vi.Mock).mockReset();
    (addSuggestion as vi.Mock).mockReset();
    (updateContext as vi.Mock).mockReset();
    (getRecentQueries as vi.Mock).mockReset().mockReturnValue([]);
    vi.mocked(readFile).mockReset().mockResolvedValue('Default file content from generic mock');
    vi.mocked(readdir).mockReset().mockResolvedValue([{ name: 'entry1', isDirectory: () => false } as fsPromises.Dirent]);
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
      await expect(ActualAgentModule.executeToolCall(
        { tool: 'generate_suggestion', parameters: { query: 'test' } },
        mockQdrantClientInstance, repoPath, false
      )).rejects.toThrow('Tool generate_suggestion requires the suggestion model which is not available');
    });
  });
  
  describe('runAgentLoop', () => {
    const mockQdrantClient = mockQdrantClientInstance;
    const repoPath = '/test/repo';
    let parseToolCallsSpy: vi.SpyInstance;
    let executeToolCallSpy: vi.SpyInstance;

    beforeEach(() => {
        mockLLMProviderInstance.generateText.mockResolvedValueOnce("LLM Verification OK"); 

        // Spy on the internal functions of the *actual* module for this test suite
        parseToolCallsSpy = vi.spyOn(ActualAgentModule, 'parseToolCalls');
        executeToolCallSpy = vi.spyOn(ActualAgentModule, 'executeToolCall');

        // Default mock implementations for the spies
        parseToolCallsSpy.mockReturnValue([]);
        executeToolCallSpy.mockResolvedValue({ status: 'default mock success from spy' });
    });

    afterEach(() => {
        // Restore spies to their original implementations after each test in this suite
        parseToolCallsSpy.mockRestore();
        executeToolCallSpy.mockRestore();
    });

    it('should execute a tool call and then provide final response', async () => {
      mockLLMProviderInstance.generateText
        .mockResolvedValueOnce('TOOL_CALL: {"tool": "search_code", "parameters": {"query": "tool query"}}'); // LLM output for tool selection

      // Let the original ActualAgentModule.parseToolCalls run for the first call.
      // It should parse the TOOL_CALL from mockLLMProviderInstance.generateText.
      // Ensure subsequent calls to parseToolCalls (if any within the loop for one tool) return empty.
      parseToolCallsSpy.mockReturnValueOnce([]); // If called again, stop tool processing.

      executeToolCallSpy.mockResolvedValueOnce({ status: 'search_code executed', results: [] });

      mockLLMProviderInstance.generateText.mockResolvedValueOnce('Final response after tool.'); 

      // Call the original runAgentLoop. It will use the spied versions of parseToolCalls and executeToolCall.
      await ActualAgentModule.runAgentLoop('query with tool', 'session2', mockQdrantClient, repoPath, true);

      // Assert on the spies
      expect(executeToolCallSpy).toHaveBeenCalledTimes(1);
      expect(executeToolCallSpy).toHaveBeenCalledWith(
        expect.objectContaining({ tool: 'search_code' }),
        mockQdrantClient, repoPath, true
      );
      expect(addSuggestion).toHaveBeenCalledWith('session2', 'query with tool', expect.stringContaining('Final response after tool.'));
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
      const prompt = generateAgentSystemPrompt(toolRegistry); // Use imported toolRegistry
      for (const tool of toolRegistry) { // Assert against the imported toolRegistry
        expect(prompt).toContain(`Tool: ${tool.name}`);
      }
    });
  });
});
