import { describe, it, expect, vi, beforeEach, afterEach, beforeAll } from 'vitest';
import { promises as fsPromises } from 'fs';
import path from 'path';
import { QdrantClient } from '@qdrant/js-client-rest';

// 1. Define ALL mock functions that the '../lib/agent' factory will use at the top level.
const AGENT_MOCK_PARSE_TOOL_CALLS = vi.fn();
const AGENT_MOCK_EXECUTE_TOOL_CALL = vi.fn();

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

// 3. THEN mock the SUT module ('../lib/agent') itself.
vi.mock('../lib/agent', async (importOriginal) => {
  const originalModule = await importOriginal<typeof import('../lib/agent')>();
  return {
    ...originalModule, 
    parseToolCalls: AGENT_MOCK_PARSE_TOOL_CALLS,
    executeToolCall: AGENT_MOCK_EXECUTE_TOOL_CALL,
  };
});

// 4. Import functions AFTER all vi.mock calls.
import { 
  runAgentLoop, 
  parseToolCalls,    // This IS AGENT_MOCK_PARSE_TOOL_CALLS
  executeToolCall,   // This IS AGENT_MOCK_EXECUTE_TOOL_CALL
  createAgentState, 
  generateAgentSystemPrompt, 
  toolRegistry 
} from '../lib/agent';
// For testing the *original* implementations of parseToolCalls, executeToolCall:
import * as actualAgentFunctionsOriginal from '../lib/agent'; 
// Import mocked dependencies
import { getLLMProvider } from '../lib/llm-provider';
import { getOrCreateSession, addQuery, addSuggestion, updateContext, getRecentQueries, getRelevantResults } from '../lib/state';
import { searchWithRefinement } from '../lib/query-refinement';
import { logger as mockedLoggerFromAgentPerspective, configService as agentTestConfig } from '../lib/config-service';
import { validateGitRepository, getRepositoryDiff, getCommitHistoryWithChanges } from '../lib/repository';
import git from 'isomorphic-git';
import { readFile, readdir, stat, access } from 'fs/promises';

const mockLLMProviderInstance = {
  generateText: vi.fn(),
  checkConnection: vi.fn().mockResolvedValue(true),
};
const mockQdrantClientInstance = {
  search: vi.fn(),
  scroll: vi.fn(),
} as unknown as QdrantClient;


describe('Agent', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    
    AGENT_MOCK_PARSE_TOOL_CALLS.mockReset().mockReturnValue([]);
    AGENT_MOCK_EXECUTE_TOOL_CALL.mockReset().mockResolvedValue({ status: 'default mock success' });
    
    (getLLMProvider as vi.Mock).mockResolvedValue(mockLLMProviderInstance);
    mockLLMProviderInstance.generateText.mockReset().mockResolvedValue('Default LLM response');
    mockLLMProviderInstance.checkConnection.mockReset().mockResolvedValue(true);
    
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
      const result = actualAgentFunctionsOriginal.parseToolCalls(output);
      expect(result).toHaveLength(1);
      expect(result[0]).toEqual({ tool: 'search_code', parameters: { query: 'authentication' } });
    });
    // ... other tests for agent.parseToolCalls ...
  });
  
  describe('executeToolCall (original)', () => {
    const repoPath = '/test/repo';
    it('should throw if tool requires model and model is unavailable', async () => {
      await expect(actualAgentFunctionsOriginal.executeToolCall(
        { tool: 'generate_suggestion', parameters: { query: 'test' } },
        mockQdrantClientInstance, repoPath, false
      )).rejects.toThrow('Tool generate_suggestion requires the suggestion model which is not available');
    });
    // ... other tests for agent.executeToolCall ...
  });
  
  describe('runAgentLoop', () => {
    const mockQdrantClient = mockQdrantClientInstance;
    const repoPath = '/test/repo';

    beforeEach(() => {
        mockLLMProviderInstance.generateText.mockResolvedValueOnce("LLM Verification OK"); 
    });

    it('should execute a tool call and then provide final response', async () => {
      mockLLMProviderInstance.generateText
        .mockResolvedValueOnce('TOOL_CALL: {"tool": "search_code", "parameters": {"query": "tool query"}}'); 
      
      AGENT_MOCK_PARSE_TOOL_CALLS
        .mockImplementationOnce((_output: string) => [{ tool: 'search_code', parameters: { query: 'tool query' } }])
        .mockReturnValueOnce([]); 
      
      AGENT_MOCK_EXECUTE_TOOL_CALL.mockResolvedValueOnce({ status: 'search_code executed', results: [] });

      mockLLMProviderInstance.generateText.mockResolvedValueOnce('Final response after tool.');
      
      await runAgentLoop('query with tool', 'session2', mockQdrantClient, repoPath, true);
      
      expect(AGENT_MOCK_EXECUTE_TOOL_CALL).toHaveBeenCalledTimes(1);
      expect(AGENT_MOCK_EXECUTE_TOOL_CALL).toHaveBeenCalledWith(
        expect.objectContaining({ tool: 'search_code' }),
        mockQdrantClient, repoPath, true
      );
      expect(addSuggestion).toHaveBeenCalledWith('session2', 'query with tool', expect.stringContaining('Final response after tool.'));
    });
    // ... other runAgentLoop tests ...
  });
  
  describe('createAgentState (original)', () => {
    it('should create a new agent state with the correct structure', () => {
      const result = actualAgentFunctionsOriginal.createAgentState('test_session', 'Find auth code'); 
      expect(result).toEqual({ sessionId: 'test_session', query: 'Find auth code', steps: [], context: [], isComplete: false });
    });
  });

  describe('generateAgentSystemPrompt (original)', () => {
    it('should include descriptions of all available tools', async () => {
      const prompt = actualAgentFunctionsOriginal.generateAgentSystemPrompt(toolRegistry); 
      for (const tool of toolRegistry) {
        expect(prompt).toContain(`Tool: ${tool.name}`);
      }
    });
    // ... other generateAgentSystemPrompt tests ...
  });
});
