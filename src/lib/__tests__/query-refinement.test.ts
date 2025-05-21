import { describe, it, expect, vi, beforeEach } from 'vitest';
import { QdrantClient } from '@qdrant/js-client-rest';

// Import functions to test
import { searchWithRefinement } from '../query-refinement';
// For testing internal functions directly, they need to be exported from query-refinement.ts
// e.g., export { refineQuery, extractKeywords, ... };
// If not exported, they are tested indirectly via searchWithRefinement.
// Let's assume they are exported for more granular testing:
import { refineQuery, extractKeywords, broadenQuery, focusQueryBasedOnResults, tweakQuery } from '../query-refinement';


// Mock dependencies
vi.mock('../config-service', () => ({
  configService: {
    COLLECTION_NAME: 'test_refine_collection',
    QDRANT_SEARCH_LIMIT_DEFAULT: 5,
    MAX_REFINEMENT_ITERATIONS: 2, // For testing loop limits
  },
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('../ollama'); // For generateEmbedding
vi.mock('../../utils/text-utils'); // For preprocessText (Corrected path)

// Import mocked versions
import { generateEmbedding } from '../ollama';
import { preprocessText } from '../../utils/text-utils'; // Corrected path
import { configService, logger } from '../config-service';
import { DetailedQdrantSearchResult } from '../types';


// Define a reusable mock Qdrant client
const mockQdrantClientInstance = {
  search: vi.fn(),
} as unknown as QdrantClient;

describe('Query Refinement Utilities', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Default mock for generateEmbedding
    vi.mocked(generateEmbedding).mockResolvedValue([0.1, 0.2, 0.3]); // Default embedding
    // Default mock for preprocessText
    vi.mocked(preprocessText).mockImplementation(text => text.toLowerCase().trim());
  });

  describe('searchWithRefinement', () => {
    it('should return results without refinement if relevance threshold is met initially', async () => {
      const mockResults = [{ id: '1', score: 0.8, payload: { content: 'highly relevant' } }];
      vi.mocked(mockQdrantClientInstance.search).mockResolvedValue(mockResults as any);

      const { results, refinedQuery, relevanceScore } = await searchWithRefinement(
        mockQdrantClientInstance,
        'initial query',
        [], // files
        undefined, // customLimit
        undefined, // maxRefinements (uses configService.MAX_REFINEMENT_ITERATIONS = 2)
        0.75 // relevanceThreshold
      );
      
      expect(mockQdrantClientInstance.search).toHaveBeenCalledTimes(1);
      expect(results).toEqual(mockResults);
      expect(refinedQuery).toBe('initial query');
      expect(relevanceScore).toBe(0.8);
      // To test refinementCount, searchWithRefinement needs to return it.
      // For now, we check calls to search.
      // expect(refinementCount).toBe(0); // If returned
      expect(logger.info).toHaveBeenCalledWith(expect.stringContaining('Completed search with 0 refinements'));
    });

    it('should refine query up to maxRefinements if threshold not met', async () => {
      // Simulate low relevance initially, then slightly better, then good enough
      vi.mocked(mockQdrantClientInstance.search)
        .mockResolvedValueOnce([{ id: 'r1', score: 0.2, payload: { content: 'low relevance' } }] as any) // Iteration 0
        .mockResolvedValueOnce([{ id: 'r2', score: 0.5, payload: { content: 'medium relevance' } }] as any) // Iteration 1 (after 1st refinement)
        .mockResolvedValueOnce([{ id: 'r3', score: 0.8, payload: { content: 'high relevance' } }] as any); // Iteration 2 (after 2nd refinement)

      // Mock refineQuery to return predictable refined queries
      // This requires refineQuery to be exported and mockable, or we test its actual logic.
      // For now, let's assume we can mock its effect by how search results change.
      // The internal refineQuery will be called. We check the number of search calls.
      // configService.MAX_REFINEMENT_ITERATIONS is 2, so loop runs for i=0,1,2 (3 times)

      const { results, relevanceScore } = await searchWithRefinement(
        mockQdrantClientInstance,
        'original query',
        [],
        undefined,
        undefined, // Uses configService.MAX_REFINEMENT_ITERATIONS = 2
        0.75
      );
      
      expect(mockQdrantClientInstance.search).toHaveBeenCalledTimes(3); // Initial + 2 refinements
      expect(results[0].id).toBe('r3'); // Should return the best results from the last successful iteration
      expect(relevanceScore).toBe(0.8);
      expect(logger.info).toHaveBeenCalledWith(expect.stringContaining('Completed search with 2 refinements'));
    });

    it('should use customLimit if provided', async () => {
      vi.mocked(mockQdrantClientInstance.search).mockResolvedValue([{ id: '1', score: 0.9, payload: {} }] as any);
      await searchWithRefinement(mockQdrantClientInstance, 'query', [], 15);
      expect(mockQdrantClientInstance.search).toHaveBeenCalledWith(
        configService.COLLECTION_NAME,
        expect.objectContaining({ limit: 15 })
      );
    });
    
    it('should apply file filter if files array is provided', async () => {
        vi.mocked(mockQdrantClientInstance.search).mockResolvedValue([{ id: '1', score: 0.9, payload: {} }] as any);
        const filesToFilter = ['src/file1.ts', 'src/file2.ts'];
        await searchWithRefinement(mockQdrantClientInstance, 'query', filesToFilter);
        expect(mockQdrantClientInstance.search).toHaveBeenCalledWith(
            configService.COLLECTION_NAME,
            expect.objectContaining({
                filter: { must: [{ key: "filepath", match: { any: filesToFilter } }] }
            })
        );
    });

    it('should handle empty search results gracefully during refinement', async () => {
        vi.mocked(mockQdrantClientInstance.search)
            .mockResolvedValueOnce([]) // Iteration 0 - no results
            .mockResolvedValueOnce([]) // Iteration 1 - still no results
            .mockResolvedValueOnce([]); // Iteration 2 - still no results (loop finishes due to maxRefinements)

        const { results, relevanceScore } = await searchWithRefinement(
            mockQdrantClientInstance, 'query for no results', [], undefined, undefined, 0.7
        );
        expect(mockQdrantClientInstance.search).toHaveBeenCalledTimes(3); // configService.MAX_REFINEMENT_ITERATIONS is 2 (0, 1, 2)
        expect(results).toEqual([]);
        expect(relevanceScore).toBe(0);
        expect(logger.info).toHaveBeenCalledWith(expect.stringContaining('Completed search with 2 refinements'));
    });
  });

  describe('extractKeywords', () => {
    it('should extract relevant keywords and filter common words', () => {
      const text = "This is a sample function for user authentication with a class.";
      vi.mocked(preprocessText).mockReturnValue("this is a sample function for user authentication with a class."); // Mock includes period
      const keywords = extractKeywords(text);
      // Adjusted expectation to include 'class.' as preprocessText mock doesn't remove it, and extractKeywords would keep it.
      expect(keywords).toEqual(expect.arrayContaining(['sample', 'function', 'user', 'authentication', 'class.']));
      expect(keywords).not.toContain('this');
      expect(keywords).not.toContain('for');
    });

    it('should return unique keywords', () => {
      const text = "test test keyword keyword";
      vi.mocked(preprocessText).mockReturnValue("test test keyword keyword");
      const keywords = extractKeywords(text);
      expect(keywords).toEqual(['test', 'keyword']); // Order might vary depending on Set behavior
    });
  });

  describe('broadenQuery', () => {
    it('should remove specific terms and file extensions', () => {
      const query = "exact specific search for login.ts only";
      const broadened = broadenQuery(query);
      expect(broadened).not.toContain('exact');
      expect(broadened).not.toContain('specific');
      expect(broadened).not.toContain('only');
      expect(broadened).not.toContain('.ts');
      expect(broadened).toContain('search for login');
    });

    it('should add generic terms if query becomes too short', () => {
      const query = "fix.ts";
      const broadened = broadenQuery(query); // Becomes "fix" then "fix implementation code"
      expect(broadened).toBe('fix implementation code');
    });
  });

  describe('focusQueryBasedOnResults', () => {
    it('should add keywords from top results to the query', async () => {
      const originalQuery = "find user";
      const results = [
        { payload: { content: "function processUser(user: UserType)" } },
        { payload: { content: "class UserProfile extends BaseProfile" } },
      ] as DetailedQdrantSearchResult[];
      vi.mocked(preprocessText).mockImplementation(t => t); // Simple pass-through for this test
      
      // Dynamically import the module to spy on its exports
      const actualQueryRefinementModule = await import('../query-refinement');
      const extractKeywordsSpy = vi.spyOn(actualQueryRefinementModule, 'extractKeywords')
                                   .mockReturnValue(['processuser', 'userprofile', 'usertype']);

      const focused = focusQueryBasedOnResults(originalQuery, results);
      expect(focused).toBe("find user processuser userprofile");
      extractKeywordsSpy.mockRestore();
    });
  });

  describe('tweakQuery', () => {
    it('should add file type if not present in query', () => {
      const query = "search login function";
      const results = [{ payload: { filepath: "src/auth/login.ts" } }] as DetailedQdrantSearchResult[];
      const tweaked = tweakQuery(query, results);
      expect(tweaked).toBe("search login function ts");
    });

    it('should add directory if file type present but directory not', () => {
      const query = "search login.ts function";
      const results = [{ payload: { filepath: "src/auth/login.ts" } }] as DetailedQdrantSearchResult[];
      const tweaked = tweakQuery(query, results);
      expect(tweaked).toBe("search login.ts function in src");
    });
    
    it('should not change query if context already present or no context to add', () => {
        const query = "search login.ts function in src";
        const results = [{ payload: { filepath: "src/auth/login.ts" } }] as DetailedQdrantSearchResult[];
        let tweaked = tweakQuery(query, results);
        expect(tweaked).toBe(query);

        const resultsNoPath = [{ payload: { content: "some content" } }] as DetailedQdrantSearchResult[];
        tweaked = tweakQuery("some query", resultsNoPath);
        expect(tweaked).toBe("some query");
    });
  });
  
  describe('refineQuery (main dispatcher)', () => {
    // This tests the logic within refineQuery itself, assuming its helper functions work as tested above.
    // We need to mock the helpers or ensure their behavior is predictable.
    // For simplicity, let's test the branching based on currentRelevance.

    it('should call broadenQuery for very low relevance (<0.3)', () => {
        // To test this, we need to spy on broadenQuery.
        const actualQueryRefinementModule = await import('../query-refinement');
        const broadenSpy = vi.spyOn(actualQueryRefinementModule, 'broadenQuery').mockReturnValue('broadened');

        refineQuery("original", [], 0.1); // relevance 0.1
        expect(broadenSpy).toHaveBeenCalledWith("original");
        broadenSpy.mockRestore();
    });

    it('should call focusQueryBasedOnResults for mediocre relevance (0.3 <= relevance < 0.7)', async () => {
        const actualQueryRefinementModule = await import('../query-refinement');
        const focusSpy = vi.spyOn(actualQueryRefinementModule, 'focusQueryBasedOnResults').mockReturnValue('focused');
        const mockResults = [{payload: {content: 'some'}} as DetailedQdrantSearchResult];

        refineQuery("original", mockResults, 0.5); // relevance 0.5
        expect(focusSpy).toHaveBeenCalledWith("original", mockResults);
        focusSpy.mockRestore();
    });

    it('should call tweakQuery for decent relevance (>=0.7)', async () => {
        // Note: searchWithRefinement loop breaks if relevance >= threshold (default 0.7).
        // So, refineQuery is typically called when relevance < threshold.
        // If we test refineQuery directly with relevance >= 0.7, it should call tweakQuery.
        const actualQueryRefinementModule = await import('../query-refinement');
        const tweakSpy = vi.spyOn(actualQueryRefinementModule, 'tweakQuery').mockReturnValue('tweaked');
        const mockResults = [{payload: {content: 'some'}} as DetailedQdrantSearchResult];
        
        refineQuery("original", mockResults, 0.7); // relevance 0.7
        expect(tweakSpy).toHaveBeenCalledWith("original", mockResults);
        tweakSpy.mockRestore();
    });
  });

});
