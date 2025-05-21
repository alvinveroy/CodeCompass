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
import { logger as mockedLoggerFromAgentPerspective } from '../lib/config-service';
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
    (getOrCreateSession as jest.Mock).mockReturnValue({ id: 'test-session', queries: [], suggestions: [], context: {} });
    (addQuery as jest.Mock).mockImplementation(() => {});
    (addSuggestion as jest.Mock).mockImplementation(() => {});
    (updateContext as jest.Mock).mockImplementation(() => {});
    (getRecentQueries as jest.Mock).mockReturnValue([]);
    
    // More specific default mocks for readFile and readdir if needed, or set them per test.
    vi.mocked(readFile).mockImplementation(async (p) => {
      // console.log(`readFile mock called with: ${p}`);
      if (p === path.resolve(repoPath, 'src/valid.ts')) return 'Full file data for src/valid.ts';
      return 'Default file content';
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
          // Use the mocked configService from the top of the file
          const { configService: mockedConfigService } = await vi.importActual('../lib/config-service') as any; 
          (searchWithRefinement as jest.Mock).mockResolvedValueOnce({ results: [], refinedQuery: 'more refined', relevanceScore: 0 });
          
          await executeToolCall(
            { tool: 'request_additional_context', parameters: { context_type: 'MORE_SEARCH_RESULTS', query_or_path: 'original query' } },
            mockQdrantClient, repoPath, suggestionModelAvailable
          );
          expect(searchWithRefinement).toHaveBeenCalledWith(
            mockQdrantClient, 
            'original query', 
            expect.any(Array), // files array
            mockedConfigService.REQUEST_ADDITIONAL_CONTEXT_MAX_SEARCH_RESULTS, // customLimit
            undefined, // maxRefinements (should be default from configService)
            undefined // relevanceThreshold (should be default from searchWithRefinement)
          );
        });
      });

      describe('type: FULL_FILE_CONTENT', () => {
        it('should read file if path is valid', async () => {
          // readFile mock in beforeEach should handle this if path is correct
          // vi.mocked(readFile).mockResolvedValueOnce('Full file data'); // This might override specific path mock if not careful
          const result = await executeToolCall(
            { tool: 'request_additional_context', parameters: { context_type: 'FULL_FILE_CONTENT', query_or_path: 'src/valid.ts' } },
            mockQdrantClient, repoPath, suggestionModelAvailable
          ) as any;
          expect(readFile).toHaveBeenCalledWith(path.resolve(repoPath, 'src/valid.ts'), 'utf8');
          expect(result.content).toBe('Full file data');
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

    it('should complete and return final response if agent does not call tools', async () => {
      mockLLMProviderInstance.generateText.mockResolvedValueOnce('Final agent response, no tools needed.');
      
      const agentModule = await import('../lib/agent');
      const parseToolCallsSpy = vi.spyOn(agentModule, 'parseToolCalls').mockReturnValueOnce([]);

      const result = await runAgentLoop('simple query', 'session1', mockQdrantClient, repoPath, true);

      expect(mockLLMProviderInstance.generateText).toHaveBeenCalledTimes(1); // Initial reasoning + test message from provider verification
      expect(result).toContain('Final agent response, no tools needed.');
      expect(addSuggestion).toHaveBeenCalledWith('session1', 'simple query', 'Final agent response, no tools needed.');
    });

    it('should execute a tool call and then provide final response', async () => {
      mockLLMProviderInstance.generateText
        .mockResolvedValueOnce('TOOL_CALL: {"tool": "search_code", "parameters": {"query": "tool query"}}') // Agent reasoning
        .mockResolvedValueOnce('Final response after tool.'); // Agent final response
      
      const agentModule = await import('../lib/agent');
      const parseToolCallsSpy = vi.spyOn(agentModule, 'parseToolCalls')
        .mockReturnValueOnce([{ tool: 'search_code', parameters: { query: 'tool query' } }])
        .mockReturnValueOnce([]); 

      // Spy on executeToolCall from the imported module
      const executeToolCallSpy = vi.spyOn(agentModule, 'executeToolCall').mockImplementation(async (toolCall) => {
        if (toolCall.tool === 'search_code') {
          return { status: 'search_code executed', results: [] };
        }
        return {};
      });
      
      const result = await runAgentLoop('query with tool', 'session2', mockQdrantClient, repoPath, true);

      expect(mockLLMProviderInstance.generateText).toHaveBeenCalledTimes(2); // Reasoning + Final response
      expect(executeToolCallSpy).toHaveBeenCalledWith(
        expect.objectContaining({ tool: 'search_code' }),
        mockQdrantClient, repoPath, true
      );
      expect(result).toContain('Final response after tool.');
      executeToolCallSpy.mockRestore(); 
      parseToolCallsSpy.mockRestore();
    });

    it('should extend loop if request_more_processing_steps is called and within absolute max', async () => {
      // Agent will use AGENT_DEFAULT_MAX_STEPS: 2 and AGENT_ABSOLUTE_MAX_STEPS: 3 from the mock configService
      mockLLMProviderInstance.generateText
        .mockResolvedValueOnce('TOOL_CALL: {"tool": "request_more_processing_steps", "parameters": {"reasoning": "need more"}}') // Step 1
        .mockResolvedValueOnce('TOOL_CALL: {"tool": "search_code", "parameters": {"query": "second step query"}}') // Step 2 (extended)
        .mockResolvedValueOnce('Final response in extended step.'); // Step 3 (extended)

      const agentModule = await import('../lib/agent');
      const parseToolCallsSpy = vi.spyOn(agentModule, 'parseToolCalls')
        .mockReturnValueOnce([{ tool: 'request_more_processing_steps', parameters: { reasoning: 'need more' } }])
        .mockReturnValueOnce([{ tool: 'search_code', parameters: { query: 'second step query' } }])
        .mockReturnValueOnce([]);

      const executeToolCallSpy = vi.spyOn(agentModule, 'executeToolCall').mockImplementation(async (toolCall) => {
        if (toolCall.tool === 'request_more_processing_steps') return { status: 'acknowledged' };
        if (toolCall.tool === 'search_code') return { status: 'search executed', results: []};
        return {};
      });

      const result = await runAgentLoop('extend loop query', 'session3', mockQdrantClient, repoPath, true);

      expect(mockedLoggerFromAgentPerspective.info).toHaveBeenCalledWith(expect.stringContaining('Agent requested more processing steps. Extending currentMaxSteps to absoluteMaxSteps.'));
      expect(result).toContain('Final response in extended step.');
      // Initial reasoning, reasoning for step 2, reasoning for final response
      expect(mockLLMProviderInstance.generateText).toHaveBeenCalledTimes(3);

      executeToolCallSpy.mockRestore();
      parseToolCallsSpy.mockRestore();
    });

    it('should terminate if absoluteMaxSteps is reached, even with extension request', async () => {
      // To test this, we need AGENT_DEFAULT_MAX_STEPS to be 1 and AGENT_ABSOLUTE_MAX_STEPS to be 1
      // This requires modifying the mock configService for this specific test or using a more dynamic mock.
      // For simplicity, let's assume the mock config is: AGENT_DEFAULT_MAX_STEPS: 1, AGENT_ABSOLUTE_MAX_STEPS: 1
      // This would require a more complex setup for the mock configService, or a separate test file.
      // Given the current static mock, this specific scenario is hard to test accurately without altering the shared mock.
      // Acknowledging this limitation. If the mock was:
      // AGENT_DEFAULT_MAX_STEPS: 1, AGENT_ABSOLUTE_MAX_STEPS: 1
      // Then:
      mockLLMProviderInstance.generateText
        .mockResolvedValueOnce('TOOL_CALL: {"tool": "request_more_processing_steps", "parameters": {"reasoning": "try to extend"}}') // Step 1, tries to extend
        .mockResolvedValueOnce('Final response after hitting absolute max.'); // LLM called for final response after loop terminates

      const agentModule = await import('../lib/agent');
      const parseToolCallsSpy = vi.spyOn(agentModule, 'parseToolCalls')
        .mockReturnValueOnce([{ tool: 'request_more_processing_steps', parameters: { reasoning: 'try to extend' } }])
        .mockReturnValueOnce([]); // For the final response generation

      const executeToolCallSpy = vi.spyOn(agentModule, 'executeToolCall').mockImplementation(async (toolCall) => {
        if (toolCall.tool === 'request_more_processing_steps') return { status: 'acknowledged' };
        return {};
      });

      // Temporarily override config for this test if possible, or note that this test assumes specific mock values.
      // The current mock has AGENT_DEFAULT_MAX_STEPS: 2, AGENT_ABSOLUTE_MAX_STEPS: 3.
      // Let's test with those values. The loop will run for default steps (2), then extend to absolute (3).
      // If request_more_processing_steps is called on step 2, currentMaxSteps becomes 3.
      // Loop runs for step 0, 1. Tool call on step 1 (index 1) is request_more_processing_steps.
      // currentMaxSteps becomes 3. Loop continues for step 2.
      // If on step 2 (index 2), it calls request_more_processing_steps again, it's already at absoluteMaxSteps.
      // The loop condition `step < currentMaxSteps` (2 < 3) is true.
      // After step 2 completes, step becomes 3. `3 < 3` is false. Loop terminates.
      // If it tries to extend at step 2 (index 2), currentMaxSteps is already 3.
      // The warning "Agent loop reached absolute maximum steps (3) and will terminate." will be logged *before* step 3 (index 3) would run.

      // Let's adjust the test to match the existing mock values (default=2, absolute=3)
      // Agent tries to extend on its 2nd reasoning step (step index 1), currentMaxSteps becomes 3.
      // Agent does one more step (step index 2).
      // If it tries to extend again on 3rd reasoning step (step index 2), it's already at absolute.
      mockLLMProviderInstance.generateText.mockReset();
      mockLLMProviderInstance.generateText
        .mockResolvedValueOnce('TOOL_CALL: {"tool": "search_code", "parameters": {"query": "step 1 query"}}') // Step 0
        .mockResolvedValueOnce('TOOL_CALL: {"tool": "request_more_processing_steps", "parameters": {"reasoning": "extend from step 2"}}') // Step 1
        .mockResolvedValueOnce('TOOL_CALL: {"tool": "request_more_processing_steps", "parameters": {"reasoning": "try to extend again from step 3"}}') // Step 2
        .mockResolvedValueOnce('Final response after hitting absolute max.'); // Final response generation

      parseToolCallsSpy.mockReset();
      parseToolCallsSpy
        .mockReturnValueOnce([{ tool: 'search_code', parameters: { query: 'step 1 query' } }])
        .mockReturnValueOnce([{ tool: 'request_more_processing_steps', parameters: { reasoning: 'extend from step 2' } }])
        .mockReturnValueOnce([{ tool: 'request_more_processing_steps', parameters: { reasoning: 'try to extend again from step 3' } }])
        .mockReturnValueOnce([]);


      const result = await runAgentLoop('absolute max query', 'session4', mockQdrantClient, repoPath, true);

      expect(mockedLoggerFromAgentPerspective.warn).toHaveBeenCalledWith(expect.stringContaining('Agent requested more processing steps, but already at or beyond absoluteMaxSteps.'));
      expect(mockedLoggerFromAgentPerspective.warn).toHaveBeenCalledWith(expect.stringContaining('Agent loop reached absolute maximum steps (3) and will terminate.'));
      expect(mockLLMProviderInstance.generateText).toHaveBeenCalledTimes(4); // 3 reasoning steps + 1 final response
      expect(result).toContain('Final response after hitting absolute max.');
      expect(result).toContain('[Note: The agent utilized the maximum allowed processing steps.]');

      executeToolCallSpy.mockRestore();
      parseToolCallsSpy.mockRestore();
    });

    it('should handle agent reasoning timeout by using fallback tool call', async () => {
      mockLLMProviderInstance.generateText
          .mockRejectedValueOnce(new Error("Agent reasoning timed out"))
          .mockResolvedValueOnce("Final response after fallback.");

      const agentModule = await import('../lib/agent');
      const parseToolCallsSpy = vi.spyOn(agentModule, 'parseToolCalls')
          .mockImplementationOnce((outputFromLLM) => {
              if (outputFromLLM.includes("search_code")) { // Check if fallback was inserted
                  return [{ tool: 'search_code', parameters: { query: 'reasoning timeout query' } }];
              }
              return [];
          })
          .mockReturnValueOnce([]); // For final response

      const executeToolCallSpy = vi.spyOn(agentModule, 'executeToolCall').mockResolvedValue({ status: 'fallback search_code executed', results: [] });

      const result = await runAgentLoop('reasoning timeout query', 'session5', mockQdrantClient, repoPath, true);

      expect(mockedLoggerFromAgentPerspective.warn).toHaveBeenCalledWith(expect.stringContaining("Agent (step 1): Reasoning timed out or failed: Agent reasoning timed out"));
      expect(executeToolCallSpy).toHaveBeenCalledWith(
          expect.objectContaining({ tool: 'search_code', parameters: { query: 'reasoning timeout query' } }),
          mockQdrantClient, repoPath, true
      );
      expect(result).toContain("Final response after fallback.");
      executeToolCallSpy.mockRestore();
      parseToolCallsSpy.mockRestore();
    });

    it('should handle tool execution timeout by adding error to prompt', async () => {
      mockLLMProviderInstance.generateText
          .mockResolvedValueOnce('TOOL_CALL: {"tool": "search_code", "parameters": {"query": "tool query"}}')
          .mockResolvedValueOnce('Final response after tool timeout.');

      const agentModule = await import('../lib/agent');
      const parseToolCallsSpy = vi.spyOn(agentModule, 'parseToolCalls')
          .mockReturnValueOnce([{ tool: 'search_code', parameters: { query: 'tool query' } }])
          .mockReturnValueOnce([]);

      const executeToolCallSpy = vi.spyOn(agentModule, 'executeToolCall').mockRejectedValue(new Error("Tool execution timed out: search_code"));

      const result = await runAgentLoop('tool timeout query', 'session6', mockQdrantClient, repoPath, true);

      expect(mockedLoggerFromAgentPerspective.error).toHaveBeenCalledWith("Error executing tool search_code", { error: "Tool execution timed out: search_code" });
      const lastLLMCallArgs = mockLLMProviderInstance.generateText.mock.calls;
      const finalPromptArg = lastLLMCallArgs[lastLLMCallArgs.length -1][0]; // Second call to generateText
      expect(finalPromptArg).toContain("Error executing tool search_code: Tool execution timed out: search_code");
      expect(result).toContain("Final response after tool timeout.");
      executeToolCallSpy.mockRestore(); // Corrected from mockExecuteToolCall
      parseToolCallsSpy.mockRestore();
    });

  });

  describe('generateAgentSystemPrompt', () => {
    // Import generateAgentSystemPrompt from the module where it's defined
    // This requires generateAgentSystemPrompt to be exported from agent.ts
    
    it('should include descriptions of all available tools', async () => {
      const agentModule = await import('../lib/agent');
      const prompt = agentModule.generateAgentSystemPrompt(agentModule.toolRegistry); // Use the actual toolRegistry
      for (const tool of agentModule.toolRegistry) {
        expect(prompt).toContain(`Tool: ${tool.name}`);
        expect(prompt).toContain(tool.description);
        expect(prompt).toContain(JSON.stringify(tool.parameters, null, 2));
      }
    });

    it('should include critical context assessment and handling instructions', async () => {
      const agentModule = await import('../lib/agent');
      const prompt = agentModule.generateAgentSystemPrompt([]); // No tools for this check
      expect(prompt).toContain("CRITICAL CONTEXT ASSESSMENT:");
      expect(prompt).toContain("HANDLING INSUFFICIENT CONTEXT:");
      expect(prompt).toContain("request_additional_context");
      expect(prompt).toContain("request_more_processing_steps");
    });
  });
});
