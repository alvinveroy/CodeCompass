import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { 
  parseToolCalls, 
  createAgentState, 
  executeToolCall, // Add executeToolCall
  runAgentLoop,    // Add runAgentLoop
  // Import internal helpers if you decide to test them directly, 
  // otherwise they are tested via executeToolCall and runAgentLoop
  // getProcessedDiff, 
  // processSnippet,
  generateAgentSystemPrompt,
  toolRegistry // Import toolRegistry for checking prompt generation
} from '../lib/agent'; // Adjust path as necessary
import { QdrantClient } from '@qdrant/js-client-rest';
import { promises as fsPromises } from 'fs'; // For mocking fs.readFile etc.
import path from 'path';

// Mock for configService that agent.ts will use
vi.mock('../lib/config-service', () => {
  // Define the logger mock INSIDE the factory
  const loggerInstance = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  };
  return {
    __esModule: true,
    configService: { // Simplified config values for agent tests
      MAX_DIFF_LENGTH_FOR_CONTEXT_TOOL: 3000,
      MAX_SNIPPET_LENGTH_FOR_CONTEXT_NO_SUMMARY: 1500,
      MAX_FILES_FOR_SUGGESTION_CONTEXT_NO_SUMMARY: 15,
      AGENT_DEFAULT_MAX_STEPS: 2, // agent.ts will use this value
      AGENT_ABSOLUTE_MAX_STEPS: 3, // agent.ts will use this value
      REQUEST_ADDITIONAL_CONTEXT_MAX_SEARCH_RESULTS: 10,
      COLLECTION_NAME: 'test-collection',
      SUGGESTION_PROVIDER: 'ollama',
      SUGGESTION_MODEL: 'test-model',
      OLLAMA_HOST: 'http://localhost:11434',
      AGENT_QUERY_TIMEOUT: 60000,
      // Add other necessary config values used by agent.ts
    },
    logger: loggerInstance, // Use the instance defined within the factory
  };
});

// Import the actual configService for spying on its properties (like AGENT_DEFAULT_MAX_STEPS getter)
// This import happens AFTER the mock is defined, so it's fine.
// import { configService as actualConfigServiceModule } from '../lib/config-service';
// Note: Spying on actualConfigServiceModule getters for agent.ts behavior is complex
// if agent.ts receives a plain object mock. For now, agent.ts uses the plain values above.

// Mock other dependencies
vi.mock('../lib/llm-provider');
vi.mock('../lib/state');
vi.mock('../lib/query-refinement');
vi.mock('../lib/repository');
vi.mock('isomorphic-git');
vi.mock('fs/promises', () => {
  const readFileMock = vi.fn();
  const readdirMock = vi.fn();
  const mockFsPromises = {
    readFile: readFileMock,
    readdir: readdirMock,
    // Add other fs/promises functions if agent.ts starts using them
  };
  return {
    ...mockFsPromises, // Spread for named imports
    default: mockFsPromises, // Provide a default export
  };
});


// Import mocked versions for easier access in tests
// For fs/promises, we import the mocked named exports directly
import { getLLMProvider } from '../lib/llm-provider';
import { getOrCreateSession, addQuery, addSuggestion, updateContext, getRecentQueries } from '../lib/state';
import { searchWithRefinement } from '../lib/query-refinement';
// AFTER importing agent.ts (implicitly via other SUT imports), import the logger from the mocked module
// This logger will be the one created by the vi.mock factory.
import { logger as mockedLoggerFromAgentPerspective, configService as agentTestConfig } from '../lib/config-service'; // Import agentTestConfig
import { validateGitRepository, getRepositoryDiff } from '../lib/repository';
import git from 'isomorphic-git';
import { readFile, readdir } from 'fs/promises'; // Import mocked versions

// Define a reusable mock LLM provider
const mockLLMProviderInstance = {
  generateText: vi.fn(),
  checkConnection: vi.fn().mockResolvedValue(true),
};

// Define a reusable mock Qdrant client
const mockQdrantClientInstance = {
  search: vi.fn(),
  scroll: vi.fn(),
  // Add other QdrantClient methods if they are used by agent.ts
} as unknown as QdrantClient;


describe('Agent', () => {
  beforeEach(() => {
    vi.clearAllMocks(); // Clears call counts and mock implementations

    // Reset the methods of the logger that agent.ts will use
    // This logger is now imported as mockedLoggerFromAgentPerspective
    mockedLoggerFromAgentPerspective.info.mockReset();
    mockedLoggerFromAgentPerspective.warn.mockReset();
    mockedLoggerFromAgentPerspective.error.mockReset();
    mockedLoggerFromAgentPerspective.debug.mockReset();
    
    // Setup default mock implementations
    (getLLMProvider as jest.Mock).mockResolvedValue(mockLLMProviderInstance);
    mockLLMProviderInstance.generateText.mockResolvedValue('Default LLM response'); // Default for reasoning
    
    (validateGitRepository as jest.Mock).mockResolvedValue(true);
    (getRepositoryDiff as jest.Mock).mockResolvedValue('Default diff content');
    (searchWithRefinement as jest.Mock).mockResolvedValue({ 
      results: [], 
      refinedQuery: 'refined query', 
      relevanceScore: 0 
    });
    (git.listFiles as jest.Mock).mockResolvedValue(['file1.ts', 'file2.js']);
    (getOrCreateSession as jest.Mock).mockImplementation((sessionIdParam, repoPath) => ({
      id: sessionIdParam || 'default-test-session', // Use passed sessionId or a default
      queries: [], suggestions: [], context: {} 
    }));
    (addQuery as jest.Mock).mockImplementation(() => {});
    (addSuggestion as jest.Mock).mockImplementation(() => {});
    (updateContext as jest.Mock).mockImplementation(() => {});
    (getRecentQueries as jest.Mock).mockReturnValue([]);
    
    // More specific default mocks for readFile and readdir if needed, or set them per test.
    vi.mocked(readFile).mockImplementation(async (p: string | Buffer | URL, options?: any) => {
      // Make this mock more generic or rely on per-test mocks for specific paths
      // For this specific test, the path will be absolute after path.resolve(repoPath, queryOrPath)
      // console.log(`[Generic readFile mock] Called with path: ${p}`);
      if (typeof p === 'string' && p.endsWith('src/valid.ts')) { // A bit more flexible
          return 'Full file data for src/valid.ts';
      }
      return 'Default file content from generic mock';
    });
    vi.mocked(readdir).mockImplementation(async (p) => {
      // console.log(`readdir mock called with: ${p}`);
      if (p === path.resolve(repoPath, 'src')) return [{ name: 'file.ts', isDirectory: () => false }, { name: 'subdir', isDirectory: () => true }] as fsPromises.Dirent[];
      return [{ name: 'entry1', isDirectory: () => false } as fsPromises.Dirent];
    });
  });

  // ... existing tests for parseToolCalls and createAgentState ...

  // Add new describe blocks for other functions
  describe('parseToolCalls', () => {
    it('should parse valid tool calls', () => {
      // Use a simple string with exact formatting
      const output = `I will use tools.
TOOL_CALL: {"tool":"search_code","parameters":{"query":"authentication"}}
TOOL_CALL: {"tool":"get_repository_context","parameters":{"query":"project structure"}}`;
      
      const result = parseToolCalls(output);
      
      expect(result).toHaveLength(2);
      expect(result[0]).toEqual({
        tool: 'search_code',
        parameters: { query: 'authentication' }
      });
      expect(result[1]).toEqual({
        tool: 'get_repository_context',
        parameters: { query: 'project structure' }
      });
    });
    
    it('should handle malformed JSON', () => {
      const output = `
        I'll use the search_code tool.
        
        TOOL_CALL: {"tool": "search_code", "parameters": {"query": "authentication}
        
        This JSON is malformed.
      `;
      
      const result = parseToolCalls(output);
      
      expect(result).toHaveLength(0);
    });
    
    it('should return empty array when no tool calls are found', () => {
      const output = 'This response has no tool calls.';
      
      const result = parseToolCalls(output);
      
      expect(result).toHaveLength(0);
    });
  });
  
  describe('createAgentState', () => {
    it('should create a new agent state with the correct structure', () => {
      const sessionId = 'test_session';
      const query = 'Find authentication code';
      
      const result = createAgentState(sessionId, query);
      
      expect(result).toEqual({
        sessionId,
        query,
        steps: [],
        context: [],
        isComplete: false
      });
    });
  });

  // As getProcessedDiff is an internal async function, we need to import it if we want to test it directly.
  // However, it's often better to test such helpers via the public functions that use them (e.g. executeToolCall).
  // If direct testing is preferred:
  // import { getProcessedDiff } from '../lib/agent'; // This won't work as it's not exported.
  // For direct testing, you might need to temporarily export it or use a technique like babel-plugin-rewire.
  // Assuming for now it's tested indirectly. If direct tests are added, structure them like:

  /*
  describe('getProcessedDiff (internal helper)', () => {
    const { configService } = vi.mocked(await import('../lib/config-service')); // Get mocked config

    it('should return original diff if not too long', async () => {
      (getRepositoryDiff as jest.Mock).mockResolvedValue('Short diff');
      // Need to call getProcessedDiff. How? If not exported, test via executeToolCall.
      // For this example, let's assume we can call it.
      // const result = await getProcessedDiff('repo/path', true); 
      // expect(result).toBe('Short diff');
    });
    // ... other test cases as outlined in the general plan ...
  });
  */
  // For now, we will assume getProcessedDiff and processSnippet are tested via executeToolCall.

  describe('executeToolCall', () => {
    // Common setup for executeToolCall tests
    const mockQdrantClient = mockQdrantClientInstance; // Use the shared mock
    const repoPath = '/test/repo';
    const suggestionModelAvailable = true;

    describe('tool: search_code', () => {
      it('should call searchWithRefinement and process snippets', async () => {
        (searchWithRefinement as jest.Mock).mockResolvedValueOnce({
          results: [
            { payload: { filepath: 'file.ts', content: 'snippet content', is_chunked: false, last_modified: '2023-01-01' }, score: 0.9 },
            { payload: { filepath: 'chunked.ts', content: 'chunked snippet', is_chunked: true, chunk_index: 0, total_chunks: 2, last_modified: '2023-01-01' }, score: 0.8 }
          ],
          refinedQuery: 'refined test query',
          relevanceScore: 0.85
        });

        const result = await executeToolCall(
          { tool: 'search_code', parameters: { query: 'test query' } },
          mockQdrantClient, repoPath, suggestionModelAvailable
        ) as any;

        expect(searchWithRefinement).toHaveBeenCalledWith(mockQdrantClient, 'test query', expect.any(Array));
        expect(result.refinedQuery).toBe('refined test query');
        expect(result.results).toHaveLength(2);
        expect(result.results[0].filepath).toBe('file.ts');
        expect(result.results[0].snippet).toContain('snippet content'); // Assuming processSnippet returns it as is if short
        expect(result.results[1].filepath).toContain('(Chunk 1/2)');
        expect(addQuery).toHaveBeenCalled();
      });

      it('should throw if query parameter is not a string', async () => {
        await expect(executeToolCall(
          { tool: 'search_code', parameters: { query: 123 } },
          mockQdrantClient, repoPath, suggestionModelAvailable
        )).rejects.toThrow("Parameter 'query' for tool 'search_code' must be a string");
      });
    });

    describe('tool: get_repository_context', () => {
      it('should call getRepositoryDiff, searchWithRefinement, and process snippets', async () => {
        (getRepositoryDiff as jest.Mock).mockResolvedValueOnce('Test diff content');
        (searchWithRefinement as jest.Mock).mockResolvedValueOnce({
          results: [{ payload: { filepath: 'file.ts', content: 'context snippet', is_chunked: false, last_modified: '2023-01-01' }, score: 0.9 }],
          refinedQuery: 'refined context query',
          relevanceScore: 0.9
        });

        const result = await executeToolCall(
          { tool: 'get_repository_context', parameters: { query: 'context query' } },
          mockQdrantClient, repoPath, suggestionModelAvailable
        ) as any;

        expect(getRepositoryDiff).toHaveBeenCalledWith(repoPath);
        expect(searchWithRefinement).toHaveBeenCalledWith(mockQdrantClient, 'context query', expect.any(Array));
        expect(result.diff).toBe('Test diff content'); // Assuming getProcessedDiff returns it as is
        expect(result.results[0].snippet).toContain('context snippet');
        expect(addQuery).toHaveBeenCalled();
      });
      // Add test for diff summarization path within get_repository_context -> getProcessedDiff
    });
    
    describe('tool: generate_suggestion', () => {
      it('should gather context and call LLM for suggestion', async () => {
          (getRepositoryDiff as jest.Mock).mockResolvedValueOnce('Diff for suggestion');
          (searchWithRefinement as jest.Mock).mockResolvedValueOnce({
              results: [{ payload: { filepath: 'file.ts', content: 'suggestion snippet', is_chunked: false, last_modified: '2023-01-01' }, score: 0.9 }],
              refinedQuery: 'refined suggestion query',
              relevanceScore: 0.9
          });
          mockLLMProviderInstance.generateText.mockResolvedValueOnce('Generated suggestion text');

          const result = await executeToolCall(
              { tool: 'generate_suggestion', parameters: { query: 'suggestion query' } },
              mockQdrantClient, repoPath, suggestionModelAvailable
          ) as any;
          
          expect(mockLLMProviderInstance.generateText).toHaveBeenCalledWith(expect.stringContaining('**Instruction**:'));
          expect(result.suggestion).toBe('Generated suggestion text');
          expect(addSuggestion).toHaveBeenCalled();
      });
      // Add test for file list summarization path
    });

    describe('tool: request_additional_context', () => {
      describe('type: MORE_SEARCH_RESULTS', () => {
        it('should call searchWithRefinement with increased limit', async () => {
          const agentMockConfig = (await import('../lib/config-service')).configService; // Get the mocked config
          
          (searchWithRefinement as jest.Mock).mockResolvedValueOnce({ results: [], refinedQuery: 'more refined', relevanceScore: 0 });
          (git.listFiles as jest.Mock).mockResolvedValueOnce(['fileA.ts', 'fileB.ts']); // Specific mock for this test if needed

          await executeToolCall(
            { tool: 'request_additional_context', parameters: { context_type: 'MORE_SEARCH_RESULTS', query_or_path: 'original query' } },
            mockQdrantClient, repoPath, suggestionModelAvailable
          );
          expect(searchWithRefinement).toHaveBeenCalledWith(
            mockQdrantClient, 
            'original query', 
            ['fileA.ts', 'fileB.ts'], // Expect the files from git.listFiles
            agentMockConfig.REQUEST_ADDITIONAL_CONTEXT_MAX_SEARCH_RESULTS // This is 10
          );
        });
      });

      describe('type: FULL_FILE_CONTENT', () => {
        it('should read file if path is valid', async () => {
            // The generic readFile mock might be sufficient if it correctly identifies the path.
            // If not, re-mock readFile here for this specific test:
            // vi.mocked(readFile).mockImplementationOnce(async (p) => {
            //   if (p === path.resolve(repoPath, 'src/valid.ts')) return 'Full file data for src/valid.ts';
            //   throw new Error(`readFile mock in test: unexpected path ${p}`);
            // });

          const result = await executeToolCall(
            { tool: 'request_additional_context', parameters: { context_type: 'FULL_FILE_CONTENT', query_or_path: 'src/valid.ts' } },
            mockQdrantClient, repoPath, suggestionModelAvailable
          ) as any;
            // executeToolCall resolves path like: path.resolve(repoPath, queryOrPath)
          expect(readFile).toHaveBeenCalledWith(path.resolve(repoPath, 'src/valid.ts'), 'utf8');
          expect(result.content).toBe('Full file data for src/valid.ts'); // Ensure this matches the mock
        });

        it('should throw if path is outside repository', async () => {
          await expect(executeToolCall(
            { tool: 'request_additional_context', parameters: { context_type: 'FULL_FILE_CONTENT', query_or_path: '../outside.txt' } },
            mockQdrantClient, repoPath, suggestionModelAvailable
          )).rejects.toThrow('Access denied: Path "../outside.txt" is outside the repository.');
        });
        // Add tests for summarization of large files
      });

      describe('type: DIRECTORY_LISTING', () => {
          it('should list directory entries', async () => {
              vi.mocked(readdir).mockResolvedValueOnce([
                { name: 'file.ts', isDirectory: () => false }, 
                { name: 'subdir', isDirectory: () => true }
              ] as fsPromises.Dirent[]);
              const result = await executeToolCall(
                  { tool: 'request_additional_context', parameters: { context_type: 'DIRECTORY_LISTING', query_or_path: 'src' } },
                  mockQdrantClient, repoPath, suggestionModelAvailable
              ) as any;
              expect(readdir).toHaveBeenCalledWith(path.resolve(repoPath, 'src'), { withFileTypes: true });
              expect(result.listing).toEqual([
                  { name: 'file.ts', type: 'file' },
                  { name: 'subdir', type: 'directory' }
              ]);
          });
          // Add test for truncation of many directory entries
      });
      
      describe('type: ADJACENT_FILE_CHUNKS', () => {
          it('should call qdrantClient.scroll for adjacent chunks', async () => {
              (mockQdrantClient.scroll as jest.Mock)
                  .mockResolvedValueOnce({ points: [{ payload: { chunk_index: 0, content: 'prev chunk' } }], next_page_offset: null }) // Prev chunk
                  .mockResolvedValueOnce({ points: [{ payload: { chunk_index: 2, content: 'next chunk' } }], next_page_offset: null }); // Next chunk

              const result = await executeToolCall(
                  { tool: 'request_additional_context', parameters: { context_type: 'ADJACENT_FILE_CHUNKS', query_or_path: 'file.ts', chunk_index: 1 } },
                  mockQdrantClient, repoPath, suggestionModelAvailable
              ) as any;

              expect(mockQdrantClient.scroll).toHaveBeenCalledTimes(2);
              expect(mockQdrantClient.scroll).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ filter: expect.objectContaining({ must: expect.arrayContaining([expect.objectContaining({ key: 'chunk_index', match: { value: 0 } })]) }) }));
              expect(mockQdrantClient.scroll).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ filter: expect.objectContaining({ must: expect.arrayContaining([expect.objectContaining({ key: 'chunk_index', match: { value: 2 } })]) }) }));
              expect(result.retrieved_chunks).toEqual(expect.arrayContaining([
                  expect.objectContaining({ chunk_index: 0, snippet: 'prev chunk' }),
                  expect.objectContaining({ chunk_index: 2, snippet: 'next chunk' })
              ]));
          });
      });
    });

    describe('tool: request_more_processing_steps', () => {
      it('should return acknowledgment', async () => {
        const result = await executeToolCall(
          { tool: 'request_more_processing_steps', parameters: { reasoning: 'need more' } },
          mockQdrantClient, repoPath, suggestionModelAvailable
        );
        expect(result).toEqual(expect.objectContaining({ status: 'Request for more processing steps acknowledged.' }));
      });
    });

    it('should throw if tool requires model and model is unavailable', async () => {
      await expect(executeToolCall(
        { tool: 'generate_suggestion', parameters: { query: 'test' } },
        mockQdrantClient, repoPath, false // suggestionModelAvailable = false
      )).rejects.toThrow('Tool generate_suggestion requires the suggestion model which is not available');
    });

    it('should throw for an unknown tool', async () => {
      await expect(executeToolCall(
        { tool: 'non_existent_tool', parameters: {} },
        mockQdrantClient, repoPath, suggestionModelAvailable
      )).rejects.toThrow('Tool not found: non_existent_tool');
    });
  });

  describe('runAgentLoop', () => {
    const mockQdrantClient = mockQdrantClientInstance;
    const repoPath = '/test/repo';

    beforeEach(() => { // Added beforeEach for runAgentLoop describe block
      // Reset mocks that are part of the ../lib/agent mock factory or spied upon
      // Assuming executeToolCall and parseToolCalls are mocked via vi.mock factory for agent.ts
      // If they are spied on an actual import, this is correct.
      // If they are vi.fn() from a vi.mock factory, they are reset by vi.clearAllMocks() in the outer beforeEach.
      // For clarity, explicitly reset them if they are indeed from a mock factory and used across tests.
      // If executeToolCall and parseToolCalls are directly imported and then spied, this is fine.
      // Based on the problem description, they should be mocked via the factory.
      // So, vi.mocked(executeToolCall) and vi.mocked(parseToolCalls) will refer to the factory's mocks.
      vi.mocked(executeToolCall).mockReset();
      vi.mocked(parseToolCalls).mockReset();
    });

    it('should complete and return final response if agent does not call tools', async () => {
      mockLLMProviderInstance.generateText.mockReset();
      mockLLMProviderInstance.generateText
        .mockResolvedValueOnce("Test response from verifyLLMProvider")
        .mockResolvedValueOnce('Final agent response, no tools needed.');
      
      vi.mocked(parseToolCalls).mockReturnValueOnce([]);

      // Clear logger mocks for this specific test run
      mockedLoggerFromAgentPerspective.info.mockClear();
      mockedLoggerFromAgentPerspective.warn.mockClear();
      mockedLoggerFromAgentPerspective.error.mockClear();
      mockedLoggerFromAgentPerspective.debug.mockClear();

      const result = await runAgentLoop('simple query', 'session1', mockQdrantClient, repoPath, true);

      expect(mockLLMProviderInstance.generateText).toHaveBeenCalledTimes(2);
      expect(result).toContain('Final agent response, no tools needed.');
      expect(addSuggestion).toHaveBeenCalledWith('session1', 'simple query', 'Final agent response, no tools needed.');
    });

    it('should execute a tool call and then provide final response', async () => {
      mockLLMProviderInstance.generateText.mockReset();
      mockLLMProviderInstance.generateText
        .mockResolvedValueOnce("Test response from verifyLLMProvider")
        .mockResolvedValueOnce('TOOL_CALL: {"tool": "search_code", "parameters": {"query": "tool query"}}')
        .mockResolvedValueOnce('Final response after tool.');
      
      vi.mocked(parseToolCalls)
        .mockImplementationOnce((output: string) => {
          if (output === 'TOOL_CALL: {"tool": "search_code", "parameters": {"query": "tool query"}}') {
            return [{ tool: 'search_code', parameters: { query: 'tool query' } }];
          }
          return [];
        })
        .mockReturnValueOnce([]); // For the second reasoning step (final response)

      const execSpy = vi.mocked(executeToolCall).mockResolvedValue({ status: 'search_code executed', results: [] });
      
      // Clear all logger mocks for this specific test run
      mockedLoggerFromAgentPerspective.info.mockClear();
      mockedLoggerFromAgentPerspective.warn.mockClear();
      mockedLoggerFromAgentPerspective.error.mockClear();
      mockedLoggerFromAgentPerspective.debug.mockClear();

      const result = await runAgentLoop('query with tool', 'session2', mockQdrantClient, repoPath, true);

      expect(mockLLMProviderInstance.generateText).toHaveBeenCalledTimes(3);
      expect(execSpy).toHaveBeenCalledTimes(1);
      expect(execSpy).toHaveBeenCalledWith(
        expect.objectContaining({ tool: 'search_code' }),
        mockQdrantClient, repoPath, true
      );
      expect(result).toContain('Final response after tool.');
      expect(addSuggestion).toHaveBeenCalledWith('session2', 'query with tool', expect.stringContaining('Final response after tool.'));
    });

    it('should extend loop if request_more_processing_steps is called and within absolute max', async () => {
      // Agent will use AGENT_DEFAULT_MAX_STEPS: 2 and AGENT_ABSOLUTE_MAX_STEPS: 3 from the mock configService
      mockLLMProviderInstance.generateText.mockReset();
      mockLLMProviderInstance.generateText
        .mockResolvedValueOnce("Test response from verifyLLMProvider") // Verification
        .mockResolvedValueOnce('TOOL_CALL: {"tool": "request_more_processing_steps", "parameters": {"reasoning": "need more"}}') // Step 1
        .mockResolvedValueOnce('TOOL_CALL: {"tool": "search_code", "parameters": {"query": "second step query"}}')       // Step 2 (extended)
        .mockResolvedValueOnce('Final response in extended step.');                                                       // Step 3 (extended, final)

      vi.mocked(parseToolCalls)
        .mockReturnValueOnce([{ tool: 'request_more_processing_steps', parameters: { reasoning: 'need more' } }])
        .mockReturnValueOnce([{ tool: 'search_code', parameters: { query: 'second step query' } }])
        .mockReturnValueOnce([]); // For final response

      vi.mocked(executeToolCall).mockImplementation(async (toolCall) => {
        if (toolCall.tool === 'request_more_processing_steps') return { status: 'acknowledged' };
        if (toolCall.tool === 'search_code') return { status: 'search executed', results: []};
        return { status: 'unknown tool executed' };
      });

      mockedLoggerFromAgentPerspective.info.mockClear();
      mockedLoggerFromAgentPerspective.warn.mockClear();
      mockedLoggerFromAgentPerspective.error.mockClear();
      mockedLoggerFromAgentPerspective.debug.mockClear();

      const result = await runAgentLoop('extend loop query', 'session3', mockQdrantClient, repoPath, true);

      expect(mockedLoggerFromAgentPerspective.info).toHaveBeenCalledWith(
        'Agent requested more processing steps. Extending currentMaxSteps to absoluteMaxSteps.'
      );
      expect(result).toContain('Final response in extended step.');
      expect(mockLLMProviderInstance.generateText).toHaveBeenCalledTimes(4); // verify + 3 reasoning steps
    });

    it('should terminate if absoluteMaxSteps is reached, even with extension request', async () => {
      // The current mock has AGENT_DEFAULT_MAX_STEPS: 2, AGENT_ABSOLUTE_MAX_STEPS: 3.
      mockLLMProviderInstance.generateText.mockReset();
      mockLLMProviderInstance.generateText
        .mockResolvedValueOnce("Test response from verifyLLMProvider") // Verification
        .mockResolvedValueOnce('TOOL_CALL: {"tool": "search_code", "parameters": {"query": "step 1 query"}}') // Step 0
        .mockResolvedValueOnce('TOOL_CALL: {"tool": "request_more_processing_steps", "parameters": {"reasoning": "extend from step 2"}}') // Step 1
        .mockResolvedValueOnce('TOOL_CALL: {"tool": "request_more_processing_steps", "parameters": {"reasoning": "try to extend again from step 3"}}') // Step 2
        .mockResolvedValueOnce('Final response after hitting absolute max.'); // Final response generation

      vi.mocked(parseToolCalls)
        .mockReturnValueOnce([{ tool: 'search_code', parameters: { query: 'step 1 query' } }])
        .mockReturnValueOnce([{ tool: 'request_more_processing_steps', parameters: { reasoning: 'extend from step 2' } }])
        .mockReturnValueOnce([{ tool: 'request_more_processing_steps', parameters: { reasoning: 'try to extend again from step 3' } }])
        .mockReturnValueOnce([]); // For final response generation

      vi.mocked(executeToolCall).mockImplementation(async (toolCall) => {
        if (toolCall.tool === 'search_code') return { status: 'search executed', results: []};
        if (toolCall.tool === 'request_more_processing_steps') return { status: 'acknowledged' };
        return { status: 'unknown tool executed' };
      });

      // Clear all logger mocks for this specific test run
      mockedLoggerFromAgentPerspective.info.mockClear();
      mockedLoggerFromAgentPerspective.warn.mockClear();
      mockedLoggerFromAgentPerspective.error.mockClear();
      mockedLoggerFromAgentPerspective.debug.mockClear();

      const result = await runAgentLoop('absolute max query', 'session4', mockQdrantClient, repoPath, true);

      // The order of these warnings might vary depending on exact logic flow if both conditions are met closely.
      // Check for both, but don't assume order unless the SUT guarantees it.
      // The SUT logs "Agent requested more processing steps, but already at or beyond absoluteMaxSteps." first if applicable,
      // then "Agent loop reached absolute maximum steps (...) and will terminate." if the loop condition step >= absoluteMaxSteps is met.
      expect(mockedLoggerFromAgentPerspective.warn).toHaveBeenCalledWith(
        'Agent requested more processing steps, but already at or beyond absoluteMaxSteps.'
      );
      expect(mockedLoggerFromAgentPerspective.warn).toHaveBeenCalledWith(
        `Agent loop reached absolute maximum steps (${agentTestConfig.AGENT_ABSOLUTE_MAX_STEPS}) and will terminate.`
      );
      expect(mockLLMProviderInstance.generateText).toHaveBeenCalledTimes(5); // verify + 3 reasoning steps + 1 final response
      expect(result).toContain('Final response after hitting absolute max.');
      expect(result).toContain('[Note: The agent utilized the maximum allowed processing steps.]');
      expect(addSuggestion).toHaveBeenCalledWith('session4', 'absolute max query', expect.stringContaining('Final response after hitting absolute max.'));
    });

    it('should handle agent reasoning timeout by using fallback tool call', async () => {
      // const agentConfigForTest = (await import('../lib/config-service')).configService; // Use agentTestConfig instead

      mockLLMProviderInstance.generateText.mockReset();
      mockLLMProviderInstance.generateText
          .mockResolvedValueOnce("Test response from verifyLLMProvider") // Verification
          .mockImplementationOnce(() => {
            return new Promise((_, reject) =>
                setTimeout(() => reject(new Error("Simulated Agent reasoning timed out by test")), agentTestConfig.AGENT_QUERY_TIMEOUT + 200)
            );
          })
          .mockResolvedValueOnce("Final response after fallback.");
      
      vi.mocked(parseToolCalls)
          .mockImplementationOnce((outputFromLLM) => {
              if (outputFromLLM === `TOOL_CALL: ${JSON.stringify({tool: "search_code",parameters: { query: "reasoning timeout query", sessionId: "session5" }})}`) {
                  return [{ tool: 'search_code', parameters: { query: 'reasoning timeout query', sessionId: 'session5' } }];
              }
              return [];
          })
          .mockReturnValueOnce([]);

      const executeToolCallSpy = vi.mocked(executeToolCall).mockResolvedValue({ status: 'fallback search_code executed', results: [] });
      
      mockedLoggerFromAgentPerspective.warn.mockClear();
      mockedLoggerFromAgentPerspective.info.mockClear();
      mockedLoggerFromAgentPerspective.error.mockClear();
      mockedLoggerFromAgentPerspective.debug.mockClear();

      const result = await runAgentLoop('reasoning timeout query', 'session5', mockQdrantClient, repoPath, true);

      expect(mockedLoggerFromAgentPerspective.warn).toHaveBeenCalledWith("Agent (step 1): Reasoning timed out or failed: Agent reasoning timed out");
      expect(executeToolCallSpy).toHaveBeenCalledWith(
          expect.objectContaining({ tool: 'search_code', parameters: { query: 'reasoning timeout query', sessionId: 'session5' } }),
          mockQdrantClient, repoPath, true
      );
      expect(result).toContain("Final response after fallback.");
      expect(addSuggestion).toHaveBeenCalledWith('session5', 'reasoning timeout query', expect.stringContaining('Final response after fallback.'));
    }, agentTestConfig.AGENT_QUERY_TIMEOUT + 10000);

    it('should handle tool execution timeout by adding error to prompt', async () => {
      mockLLMProviderInstance.generateText.mockReset();
      mockLLMProviderInstance.generateText
          .mockResolvedValueOnce("Test response from verifyLLMProvider")
          .mockResolvedValueOnce('TOOL_CALL: {"tool": "search_code", "parameters": {"query": "tool query"}}')
          .mockResolvedValueOnce('Final response after tool timeout.');

      vi.mocked(parseToolCalls)
          .mockReturnValueOnce([{ tool: 'search_code', parameters: { query: 'tool query' } }])
          .mockReturnValueOnce([]);
      
      const toolExecutionTimeoutError = new Error("Simulated Tool execution timed out: search_code");
      vi.mocked(executeToolCall).mockImplementationOnce(async () => {
        // Simulate the timeout behavior of Promise.race in agent.ts
        return new Promise((_, reject) => {
            setTimeout(() => reject(toolExecutionTimeoutError), 10); // Short delay, actual timeout is in agent.ts
        });
      });
      
      mockedLoggerFromAgentPerspective.info.mockClear();
      mockedLoggerFromAgentPerspective.warn.mockClear();
      mockedLoggerFromAgentPerspective.error.mockClear();
      mockedLoggerFromAgentPerspective.debug.mockClear();

      const result = await runAgentLoop('tool timeout query', 'session6', mockQdrantClient, repoPath, true);

      // The error logged by agent.ts is the raw error message string
      expect(mockedLoggerFromAgentPerspective.error).toHaveBeenCalledWith(
        "Error executing tool search_code", 
        { error: "Simulated Tool execution timed out: search_code" } 
      );
      
      expect(mockLLMProviderInstance.generateText).toHaveBeenCalledTimes(3); 
      const llmCalls = mockLLMProviderInstance.generateText.mock.calls;
      // The last call to generateText (index 2) should contain the error message in its prompt.
      const finalPromptArg = llmCalls[2][0]; 
      expect(finalPromptArg).toContain("Error executing tool search_code: Simulated Tool execution timed out: search_code");
      expect(result).toContain("Final response after tool timeout.");
      expect(addSuggestion).toHaveBeenCalledWith('session6', 'tool timeout query', expect.stringContaining('Simulated Tool execution timed out: search_code'));
    }, 90000 + 10000); // Vitest test timeout

  });

  describe('generateAgentSystemPrompt', () => {
    // Import generateAgentSystemPrompt from the module where it's defined
    // This requires generateAgentSystemPrompt to be exported from agent.ts
    
    it('should include descriptions of all available tools', async () => {
      // generateAgentSystemPrompt and toolRegistry are directly imported at the top
      const prompt = generateAgentSystemPrompt(toolRegistry); // Use the actual toolRegistry
      for (const tool of toolRegistry) {
        expect(prompt).toContain(`Tool: ${tool.name}`);
        expect(prompt).toContain(tool.description);
        expect(prompt).toContain(JSON.stringify(tool.parameters, null, 2));
      }
    });

    it('should include critical context assessment and handling instructions', async () => {
      // generateAgentSystemPrompt is directly imported
      const prompt = generateAgentSystemPrompt([]); // No tools for this check
      expect(prompt).toContain("CRITICAL CONTEXT ASSESSMENT:");
      expect(prompt).toContain("HANDLING INSUFFICIENT CONTEXT:");
      expect(prompt).toContain("request_additional_context");
      expect(prompt).toContain("request_more_processing_steps");
    });
});

});
