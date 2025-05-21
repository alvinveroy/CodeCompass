// ... other top-level imports ...
import { promises as fsPromises } from 'fs';
import path from 'path';
import { QdrantClient } from '@qdrant/js-client-rest'; // Ensure QdrantClient is imported

vi.mock('../lib/agent', async (importOriginal) => {
  const originalModule = await importOriginal<typeof import('../lib/agent')>();
  return {
    ...originalModule, // Spread original module to keep non-mocked exports
    // Overwrite specific functions with mocks created directly in the factory
    parseToolCalls: vi.fn(),
    executeToolCall: vi.fn(),
    // Keep other exports like createAgentState, generateAgentSystemPrompt, toolRegistry as original
  };
});

// Import functions AFTER the vi.mock factory.
// runAgentLoop, createAgentState, etc. are original. parseToolCalls and executeToolCall are mocks.
import { 
  runAgentLoop, 
  createAgentState, 
  generateAgentSystemPrompt,
  toolRegistry,
  parseToolCalls, // This is now the mock from the factory
  executeToolCall // This is now the mock from the factory
} from '../lib/agent'; 
// Import the actual functions for direct testing using a namespace import
import * as actualAgentFunctions from '../lib/agent'; 
    
// Mock dependencies used by agent.ts
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
    },
    logger: loggerInstance,
  };
});
vi.mock('../lib/llm-provider');
vi.mock('../lib/state');
vi.mock('../lib/query-refinement'); 
vi.mock('../lib/repository');     
vi.mock('isomorphic-git');
vi.mock('fs/promises', () => { // Ensure this mock is complete for fs/promises
  const readFileMock = vi.fn();
  const readdirMock = vi.fn();
  const mockFsPromises = {
    readFile: readFileMock,
    readdir: readdirMock,
  };
  return {
    ...mockFsPromises,
    default: mockFsPromises,
  };
});


// Import mocked dependencies
import { getLLMProvider } from '../lib/llm-provider';
import { getOrCreateSession, addQuery, addSuggestion, updateContext, getRecentQueries } from '../lib/state';
import { searchWithRefinement } from '../lib/query-refinement';
import { logger as mockedLoggerFromAgentPerspective, configService as agentTestConfig } from '../lib/config-service'; 
import { validateGitRepository, getRepositoryDiff } from '../lib/repository';
import git from 'isomorphic-git';
import { readFile, readdir } from 'fs/promises'; 

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
    // Reset the imported mocks (which are from the factory)
    (parseToolCalls as vi.Mock).mockReset().mockReturnValue([]);
    (executeToolCall as vi.Mock).mockReset().mockResolvedValue({ status: 'default mock success' });
    
    (getLLMProvider as vi.Mock).mockResolvedValue(mockLLMProviderInstance);
    mockLLMProviderInstance.generateText.mockReset().mockResolvedValue('Default LLM response');
    mockLLMProviderInstance.checkConnection.mockReset().mockResolvedValue(true); // Reset checkConnection
    
    // Reset other general mocks
    mockedLoggerFromAgentPerspective.info.mockReset();
    mockedLoggerFromAgentPerspective.warn.mockReset();
    mockedLoggerFromAgentPerspective.error.mockReset();
    mockedLoggerFromAgentPerspective.debug.mockReset();

    (validateGitRepository as vi.Mock).mockReset().mockResolvedValue(true);
    (getRepositoryDiff as vi.Mock).mockReset().mockResolvedValue('Default diff content');
    (searchWithRefinement as vi.Mock).mockReset().mockResolvedValue({ results: [], refinedQuery: 'refined query', relevanceScore: 0 });
    (git.listFiles as vi.Mock).mockReset().mockResolvedValue(['file1.ts', 'file2.js']);
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
      const result = actualAgentFunctions.parseToolCalls(output);
      expect(result).toHaveLength(1);
      expect(result[0]).toEqual({ tool: 'search_code', parameters: { query: 'authentication' } });
    });
    // ... other tests for actualAgentFunctions.parseToolCalls ...
  });
  
  describe('executeToolCall (original)', () => {
    const repoPath = '/test/repo'; // Define repoPath for these tests
    it('should throw if tool requires model and model is unavailable', async () => {
      await expect(actualAgentFunctions.executeToolCall(
        { tool: 'generate_suggestion', parameters: { query: 'test' } },
        mockQdrantClientInstance, repoPath, false // suggestionModelAvailable = false
      )).rejects.toThrow('Tool generate_suggestion requires the suggestion model which is not available');
    });
    // ... other tests for actualAgentFunctions.executeToolCall ...
  });
  
  describe('runAgentLoop', () => {
    const mockQdrantClient = mockQdrantClientInstance;
    const repoPath = '/test/repo';

    beforeEach(() => {
        // Ensure LLM verification passes by default for runAgentLoop tests
        // The first call to generateText in runAgentLoop is for verification.
        mockLLMProviderInstance.generateText.mockResolvedValueOnce("LLM Verification OK"); 
    });

    it('should execute a tool call and then provide final response', async () => {
      // LLM generates reasoning with a tool call
      // After the initial "LLM Verification OK", the next call is for step 1 reasoning.
      mockLLMProviderInstance.generateText
        .mockResolvedValueOnce('TOOL_CALL: {"tool": "search_code", "parameters": {"query": "tool query"}}'); // Step 1 reasoning
      
      // The imported parseToolCalls (which is a mock) will be used for the above LLM output
      (parseToolCalls as vi.Mock)
        .mockImplementationOnce((_output: string) => [{ tool: 'search_code', parameters: { query: 'tool query' } }]);
      
      // The imported executeToolCall (mock) will be used
      (executeToolCall as vi.Mock).mockResolvedValueOnce({ status: 'search_code executed', results: [] });

      // After tool execution, LLM generates final response (no more tool calls)
      // This is the third call to generateText in this test's flow.
      mockLLMProviderInstance.generateText.mockResolvedValueOnce('Final response after tool.');
      // parseToolCalls (mock) for the second reasoning step (should return no tools)
      (parseToolCalls as vi.Mock).mockReturnValueOnce([]); 
      
      await runAgentLoop('query with tool', 'session2', mockQdrantClient, repoPath, true); 
      
      expect(executeToolCall).toHaveBeenCalledTimes(1);
      expect(executeToolCall).toHaveBeenCalledWith(
        expect.objectContaining({ tool: 'search_code' }),
        mockQdrantClient, repoPath, true
      );
      // ... other assertions for runAgentLoop ...
      expect(addSuggestion).toHaveBeenCalledWith('session2', 'query with tool', expect.stringContaining('Final response after tool.'));
    });
    // ... other runAgentLoop tests ...
  });
  
  describe('createAgentState', () => { // Test the original createAgentState
    it('should create a new agent state with the correct structure', () => {
      const result = createAgentState('test_session', 'Find auth code');
      expect(result).toEqual({ sessionId: 'test_session', query: 'Find auth code', steps: [], context: [], isComplete: false });
    });
  });

  describe('generateAgentSystemPrompt', () => { // Test the original generateAgentSystemPrompt
    it('should include descriptions of all available tools', async () => {
      const prompt = generateAgentSystemPrompt(toolRegistry);
      for (const tool of toolRegistry) {
        expect(prompt).toContain(`Tool: ${tool.name}`);
      }
    });
    // ... other generateAgentSystemPrompt tests ...
  });
});
