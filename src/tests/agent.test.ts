// ... other top-level imports ...
import { promises as fsPromises } from 'fs';
import path from 'path';
import { QdrantClient } from '@qdrant/js-client-rest'; // Ensure QdrantClient is imported

// These will hold the mock functions created by the factory for '../lib/agent'
let AGENT_FACTORY_MOCK_PARSE_TOOL_CALLS: vi.Mock;
let AGENT_FACTORY_MOCK_EXECUTE_TOOL_CALL: vi.Mock;

vi.mock('../lib/agent', async (importOriginal) => {
  const originalModule = await importOriginal<typeof import('../lib/agent')>();
  const parseMockInFactory = vi.fn();
  const execMockInFactory = vi.fn();
  AGENT_FACTORY_MOCK_PARSE_TOOL_CALLS = parseMockInFactory;
  AGENT_FACTORY_MOCK_EXECUTE_TOOL_CALL = execMockInFactory;
  return {
    ...originalModule,
    parseToolCalls: parseMockInFactory,
    executeToolCall: execMockInFactory,
    // Keep other exports like createAgentState, generateAgentSystemPrompt, toolRegistry as original
  };
});

// Import functions AFTER the vi.mock factory.
// runAgentLoop, createAgentState, etc. are original. parseToolCalls and executeToolCall are mocks.
import { 
  runAgentLoop, 
  createAgentState, 
  generateAgentSystemPrompt,
  // toolRegistry, // Not typically mocked, and not directly used by runAgentLoop tests here
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
      AGENT_DEFAULT_MAX_STEPS: 2, // Default for tests
      AGENT_ABSOLUTE_MAX_STEPS: 3, // Default for tests
      REQUEST_ADDITIONAL_CONTEXT_MAX_SEARCH_RESULTS: 10,
      COLLECTION_NAME: 'test-collection',
      SUGGESTION_PROVIDER: 'ollama',
      SUGGESTION_MODEL: 'test-model',
      OLLAMA_HOST: 'http://localhost:11434',
      AGENT_QUERY_TIMEOUT: 60000, // Example timeout
      // Ensure all config values used by agent.ts or its direct dependencies are here
      // For example, if query-refinement defaults are used by searchWithRefinement called from agent:
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
vi.mock('fs/promises', () => { // Ensure this mock is complete for fs/promises
  const readFileMock = vi.fn();
  const readdirMock = vi.fn();
  // Add other fs/promises functions if agent.ts or its direct dependencies use them
  const accessMock = vi.fn();
  const statMock = vi.fn();
  const mockFsPromises = {
    readFile: readFileMock,
    readdir: readdirMock,
    access: accessMock,
    stat: statMock,
  };
  return {
    ...mockFsPromises, // Allow named imports
    default: mockFsPromises, // Allow default import
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
    // Reset the factory-created mocks using the module-scoped variables
    if (AGENT_FACTORY_MOCK_PARSE_TOOL_CALLS) AGENT_FACTORY_MOCK_PARSE_TOOL_CALLS.mockReset().mockReturnValue([]);
    if (AGENT_FACTORY_MOCK_EXECUTE_TOOL_CALL) AGENT_FACTORY_MOCK_EXECUTE_TOOL_CALL.mockReset().mockResolvedValue({ status: 'default mock success' });
    
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
      
      // The factory-created AGENT_FACTORY_MOCK_PARSE_TOOL_CALLS will be used by SUT
      if (!AGENT_FACTORY_MOCK_PARSE_TOOL_CALLS) throw new Error("Parse mock not init");
      AGENT_FACTORY_MOCK_PARSE_TOOL_CALLS
        .mockImplementationOnce((_output: string) => [{ tool: 'search_code', parameters: { query: 'tool query' } }]);
      
      // The factory-created AGENT_FACTORY_MOCK_EXECUTE_TOOL_CALL will be used by SUT
      if (!AGENT_FACTORY_MOCK_EXECUTE_TOOL_CALL) throw new Error("Execute mock not init");
      AGENT_FACTORY_MOCK_EXECUTE_TOOL_CALL.mockResolvedValueOnce({ status: 'search_code executed', results: [] });

      // After tool execution, LLM generates final response (no more tool calls)
      // This is the third call to generateText in this test's flow.
      mockLLMProviderInstance.generateText.mockResolvedValueOnce('Final response after tool.');
      // AGENT_FACTORY_MOCK_PARSE_TOOL_CALLS for the second reasoning step (should return no tools)
      AGENT_FACTORY_MOCK_PARSE_TOOL_CALLS.mockReturnValueOnce([]); 
      
      await runAgentLoop('query with tool', 'session2', mockQdrantClient, repoPath, true); 
      
      expect(AGENT_FACTORY_MOCK_EXECUTE_TOOL_CALL).toHaveBeenCalledTimes(1);
      expect(AGENT_FACTORY_MOCK_EXECUTE_TOOL_CALL).toHaveBeenCalledWith(
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
      const result = actualAgentFunctions.createAgentState('test_session', 'Find auth code'); // Use actual
      expect(result).toEqual({ sessionId: 'test_session', query: 'Find auth code', steps: [], context: [], isComplete: false });
    });
  });

  describe('generateAgentSystemPrompt', () => { // Test the original generateAgentSystemPrompt
    it('should include descriptions of all available tools', async () => {
      const prompt = actualAgentFunctions.generateAgentSystemPrompt(actualAgentFunctions.toolRegistry); // Use actual
      for (const tool of actualAgentFunctions.toolRegistry) { // Use actual
        expect(prompt).toContain(`Tool: ${tool.name}`);
      }
    });
    // ... other generateAgentSystemPrompt tests ...
  });
});
