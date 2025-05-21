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

// Keep existing mocks for configService and logger
vi.mock('../lib/config-service', () => ({
  configService: {
    MAX_DIFF_LENGTH_FOR_CONTEXT_TOOL: 3000,
    MAX_SNIPPET_LENGTH_FOR_CONTEXT_NO_SUMMARY: 1500,
    MAX_FILES_FOR_SUGGESTION_CONTEXT_NO_SUMMARY: 15,
    AGENT_DEFAULT_MAX_STEPS: 2, // Lower for easier testing of loop limits
    AGENT_ABSOLUTE_MAX_STEPS: 3, // Lower for easier testing
    REQUEST_ADDITIONAL_CONTEXT_MAX_SEARCH_RESULTS: 10,
    COLLECTION_NAME: 'test-collection',
    SUGGESTION_PROVIDER: 'ollama',
    SUGGESTION_MODEL: 'test-model',
    OLLAMA_HOST: 'http://localhost:11434', // Add any other configs used by agent.ts
    AGENT_QUERY_TIMEOUT: 60000, // Add if used directly, though timeouts are often hardcoded in tests
    // Add other necessary config values used by agent.ts
  },
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

// Mock other dependencies
vi.mock('../lib/llm-provider');
vi.mock('../lib/state');
vi.mock('../lib/query-refinement');
vi.mock('../lib/repository');
vi.mock('isomorphic-git'); // Auto-mock for isomorphic-git, specific functions will be spied/mocked below
vi.mock('fs/promises', async (importOriginal) => {
  const actual = await importOriginal() as typeof fsPromises;
  return {
    ...actual, // Spread actual module to keep other exports if any
    readFile: vi.fn(),
    readdir: vi.fn(),
    // Add other fs methods if used by agent.ts directly or indirectly
  };
});


// Import mocked versions for easier access in tests
// For fs/promises, we import the mocked named exports directly
import { getLLMProvider } from '../lib/llm-provider';
import { getOrCreateSession, addQuery, addSuggestion, updateContext, getRecentQueries } from '../lib/state';
import { searchWithRefinement } from '../lib/query-refinement';
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
    vi.mocked(readFile).mockResolvedValue('Default file content');
    vi.mocked(readdir).mockResolvedValue([{ name: 'entry1', isDirectory: () => false } as fsPromises.Dirent]);
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
          const { configService } = await vi.importActual('../lib/config-service') as any; // Get actual for default
          (searchWithRefinement as jest.Mock).mockResolvedValueOnce({ results: [], refinedQuery: 'more refined', relevanceScore: 0 });
          
          await executeToolCall(
            { tool: 'request_additional_context', parameters: { context_type: 'MORE_SEARCH_RESULTS', query_or_path: 'original query' } },
            mockQdrantClient, repoPath, suggestionModelAvailable
          );
          expect(searchWithRefinement).toHaveBeenCalledWith(
            mockQdrantClient, 
            'original query', 
            expect.any(Array), 
            configService.REQUEST_ADDITIONAL_CONTEXT_MAX_SEARCH_RESULTS // Check the limit
          );
        });
      });

      describe('type: FULL_FILE_CONTENT', () => {
        it('should read file if path is valid', async () => {
          (readFile as jest.Mock).mockResolvedValueOnce('Full file data');
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
      (parseToolCalls as unknown as jest.Mock).mockReturnValueOnce([]); // No tool calls

      const result = await runAgentLoop('simple query', 'session1', mockQdrantClient, repoPath, true);

      expect(mockLLMProviderInstance.generateText).toHaveBeenCalledTimes(1); // For initial reasoning
      expect(result).toContain('Final agent response, no tools needed.');
      expect(addSuggestion).toHaveBeenCalledWith('session1', 'simple query', 'Final agent response, no tools needed.');
    });

    it('should execute a tool call and then provide final response', async () => {
      mockLLMProviderInstance.generateText
        .mockResolvedValueOnce('TOOL_CALL: {"tool": "search_code", "parameters": {"query": "tool query"}}') // Agent reasoning
        .mockResolvedValueOnce('Final response after tool.'); // Agent final response
      
      (parseToolCalls as unknown as jest.Mock)
        .mockReturnValueOnce([{ tool: 'search_code', parameters: { query: 'tool query' } }])
        .mockReturnValueOnce([]); // No more tool calls

      // Mock executeToolCall for 'search_code'
      const agentModule = await import('../lib/agent');
      const mockExecuteToolCall = vi.spyOn(agentModule, 'executeToolCall'); 
      mockExecuteToolCall.mockImplementation(async (toolCall) => {
        if (toolCall.tool === 'search_code') {
          return { status: 'search_code executed', results: [] };
        }
        return {};
      });
      
      const result = await runAgentLoop('query with tool', 'session2', mockQdrantClient, repoPath, true);

      expect(mockLLMProviderInstance.generateText).toHaveBeenCalledTimes(2);
      expect(mockExecuteToolCall).toHaveBeenCalledWith(
        expect.objectContaining({ tool: 'search_code' }),
        mockQdrantClient, repoPath, true
      );
      expect(result).toContain('Final response after tool.');
      mockExecuteToolCall.mockRestore(); // Clean up spy
    });

    it('should extend loop if request_more_processing_steps is called and within absolute max', async () => {
      const { configService, logger } = await vi.importActual('../lib/config-service') as any;
      const originalDefaultSteps = configService.AGENT_DEFAULT_MAX_STEPS;
      const originalAbsoluteSteps = configService.AGENT_ABSOLUTE_MAX_STEPS;
      // For this test, ensure default < absolute
      configService.AGENT_DEFAULT_MAX_STEPS = 1; 
      configService.AGENT_ABSOLUTE_MAX_STEPS = 2;

      mockLLMProviderInstance.generateText
        .mockResolvedValueOnce('TOOL_CALL: {"tool": "request_more_processing_steps", "parameters": {"reasoning": "need more"}}') // Step 1
        .mockResolvedValueOnce('Final response in extended step.'); // Step 2 (extended)
      
      (parseToolCalls as unknown as jest.Mock)
        .mockReturnValueOnce([{ tool: 'request_more_processing_steps', parameters: { reasoning: 'need more' } }])
        .mockReturnValueOnce([]); // No tool calls in extended step

      const agentModule = await import('../lib/agent');
      const mockExecuteToolCall = vi.spyOn(agentModule, 'executeToolCall');
      mockExecuteToolCall.mockImplementation(async (toolCall) => {
        if (toolCall.tool === 'request_more_processing_steps') {
          return { status: 'acknowledged' };
        }
        return {};
      });

      const result = await runAgentLoop('extend loop query', 'session3', mockQdrantClient, repoPath, true);

      expect(logger.info).toHaveBeenCalledWith(expect.stringContaining('Agent requested more processing steps. Extending currentMaxSteps to absoluteMaxSteps.'));
      expect(result).toContain('Final response in extended step.');
      expect(mockLLMProviderInstance.generateText).toHaveBeenCalledTimes(2); // Reasoning for step 1, reasoning for step 2

      mockExecuteToolCall.mockRestore();
      configService.AGENT_DEFAULT_MAX_STEPS = originalDefaultSteps;
      configService.AGENT_ABSOLUTE_MAX_STEPS = originalAbsoluteSteps;
    });

    it('should terminate if absoluteMaxSteps is reached, even with extension request', async () => {
      const { configService, logger } = await vi.importActual('../lib/config-service') as any;
      configService.AGENT_DEFAULT_MAX_STEPS = 1;
      configService.AGENT_ABSOLUTE_MAX_STEPS = 1; // Absolute max is 1

      mockLLMProviderInstance.generateText
        .mockResolvedValueOnce('TOOL_CALL: {"tool": "request_more_processing_steps", "parameters": {"reasoning": "try to extend"}}') // Step 1
        .mockResolvedValueOnce('This should not be called for reasoning again'); // Should not reach here for 2nd reasoning
      
      (parseToolCalls as unknown as jest.Mock)
        .mockReturnValueOnce([{ tool: 'request_more_processing_steps', parameters: { reasoning: 'try to extend' } }]);
        // The loop should break after the first step due to absoluteMaxSteps.
        // Then, a final response is generated.

      const agentModule = await import('../lib/agent');
      const mockExecuteToolCall = vi.spyOn(agentModule, 'executeToolCall');
      mockExecuteToolCall.mockImplementation(async (toolCall) => {
        if (toolCall.tool === 'request_more_processing_steps') {
          return { status: 'acknowledged' };
        }
        return {};
      });
      
      // Mock for the final response generation after loop termination
      mockLLMProviderInstance.generateText.mockResolvedValueOnce('Final response after hitting absolute max.');


      const result = await runAgentLoop('absolute max query', 'session4', mockQdrantClient, repoPath, true);
      
      expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('Agent loop reached absolute maximum steps (1) and will terminate.'));
      // The LLM is called once for the first step's reasoning, and once for the forced final response.
      expect(mockLLMProviderInstance.generateText).toHaveBeenCalledTimes(2); 
      expect(result).toContain('Final response after hitting absolute max.');
      expect(result).toContain('[Note: The agent utilized the maximum allowed processing steps.]');

      mockExecuteToolCall.mockRestore();
    });
    
    it('should handle agent reasoning timeout by using fallback tool call', async () => {
      const { logger } = await vi.importActual('../lib/config-service') as any;
      mockLLMProviderInstance.generateText
          .mockRejectedValueOnce(new Error("Agent reasoning timed out")) // First call (reasoning) times out
          .mockResolvedValueOnce("Final response after fallback."); // Second call (final response after fallback tool)

      (parseToolCalls as unknown as jest.Mock)
          .mockImplementationOnce((outputFromLLM) => { // For the timed-out reasoning
              // This mock will be called with the fallback JSON string
              if (outputFromLLM.includes("search_code")) {
                  return [{ tool: 'search_code', parameters: { query: 'fallback query' } }];
              }
              return [];
          })
          .mockReturnValueOnce([]); // No tool calls after fallback tool execution

      const agentModule = await import('../lib/agent');
      const mockExecuteToolCall = vi.spyOn(agentModule, 'executeToolCall');
      mockExecuteToolCall.mockResolvedValue({ status: 'fallback search_code executed', results: [] });

      const result = await runAgentLoop('reasoning timeout query', 'session5', mockQdrantClient, repoPath, true);

      expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining("Agent (step 1): Reasoning timed out or failed: Agent reasoning timed out"));
      expect(mockExecuteToolCall).toHaveBeenCalledWith(
          expect.objectContaining({ tool: 'search_code' }), // Check that fallback tool was called
          mockQdrantClient, repoPath, true
      );
      expect(result).toContain("Final response after fallback.");
      mockExecuteToolCall.mockRestore();
    });

    it('should handle tool execution timeout by adding error to prompt', async () => {
      const { logger } = await vi.importActual('../lib/config-service') as any;
      mockLLMProviderInstance.generateText
          .mockResolvedValueOnce('TOOL_CALL: {"tool": "search_code", "parameters": {"query": "tool query"}}') // Agent reasoning
          .mockResolvedValueOnce('Final response after tool timeout.'); // Agent final response

      (parseToolCalls as unknown as jest.Mock)
          .mockReturnValueOnce([{ tool: 'search_code', parameters: { query: 'tool query' } }])
          .mockReturnValueOnce([]); // No more tool calls

      const agentModule = await import('../lib/agent');
      const mockExecuteToolCall = vi.spyOn(agentModule, 'executeToolCall');
      mockExecuteToolCall.mockRejectedValue(new Error("Tool execution timed out: search_code")); // Simulate timeout

      const result = await runAgentLoop('tool timeout query', 'session6', mockQdrantClient, repoPath, true);

      expect(logger.error).toHaveBeenCalledWith("Error executing tool search_code", { error: "Tool execution timed out: search_code" });
      // Check that the prompt for the LLM (for final response) contains the error message
      const lastLLMCallArgs = mockLLMProviderInstance.generateText.mock.calls;
      const finalPromptArg = lastLLMCallArgs[lastLLMCallArgs.length -1][0];
      expect(finalPromptArg).toContain("Error executing tool search_code: Tool execution timed out: search_code");
      expect(result).toContain("Final response after tool timeout.");
      mockExecuteToolCall.mockRestore();
    });

  });

  describe('generateAgentSystemPrompt', () => {
    it('should include descriptions of all available tools', () => {
      const prompt = generateAgentSystemPrompt(toolRegistry); // Use the actual toolRegistry
      for (const tool of toolRegistry) {
        expect(prompt).toContain(`Tool: ${tool.name}`);
        expect(prompt).toContain(tool.description);
        expect(prompt).toContain(JSON.stringify(tool.parameters, null, 2));
      }
    });

    it('should include critical context assessment and handling instructions', () => {
      const prompt = generateAgentSystemPrompt([]); // No tools for this check
      expect(prompt).toContain("CRITICAL CONTEXT ASSESSMENT:");
      expect(prompt).toContain("HANDLING INSUFFICIENT CONTEXT:");
      expect(prompt).toContain("request_additional_context");
      expect(prompt).toContain("request_more_processing_steps");
    });
  });
});
