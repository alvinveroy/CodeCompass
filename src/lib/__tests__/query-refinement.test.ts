import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { QdrantClient } from '@qdrant/js-client-rest';

// Import functions to be tested directly (originals)
// These imports happen BEFORE vi.mock is hoisted and processed.
import { 
  extractKeywords as actualExtractKeywords,
  broadenQuery as actualBroadenQuery,
  focusQueryBasedOnResults as actualFocusQueryBasedOnResults,
  tweakQuery as actualTweakQuery,
  searchWithRefinement as actualSearchWithRefinement
  // refineQuery will be imported from the mocked module for dispatcher tests
} from '../query-refinement';

// Mock the entire query-refinement module
// The factory will provide the SUT (refineQuery) as original, and helpers as spies.
vi.mock('../query-refinement', async (importOriginal) => {
  const originalModule = await importOriginal<typeof import('../query-refinement')>();
  return {
    // Provide ALL original exports by default
    ...originalModule, 
    // Override specific functions with spies for dispatcher tests
    broadenQuery: vi.fn().mockReturnValue('mocked_broaden_for_dispatch'),
    focusQueryBasedOnResults: vi.fn().mockReturnValue('mocked_focused_for_dispatch'),
    tweakQuery: vi.fn().mockReturnValue('mocked_tweaked_for_dispatch'),
    // refineQuery itself will be the original one from originalModule due to the spread.
    // searchWithRefinement, extractKeywords will also be original.
  };
});

// AFTER vi.mock, import the versions that will be used in tests.
// refineQuery will be original (from ...originalModule).
// broadenQuery, focusQueryBasedOnResults, tweakQuery will be the spies from the factory.
// searchWithRefinement and extractKeywords imported here would also be original
// if not overridden in the mock factory above.
import { 
    refineQuery, 
    broadenQuery, // This is the vi.fn() spy
    focusQueryBasedOnResults, // This is the vi.fn() spy
    tweakQuery, // This is the vi.fn() spy
    searchWithRefinement, // This is original
    extractKeywords // This is original
} from '../query-refinement';


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
    vi.mocked(preprocessText).mockImplementation(text => text.trim().replace(/\s+/g, ' '));
  });
  afterEach(() => {
    vi.restoreAllMocks(); 
  });

  // Tests for searchWithRefinement (as before)

  describe('searchWithRefinement', () => {
    it('should return results without refinement if relevance threshold is met initially', async () => {
      const mockResults = [{ id: '1', score: 0.8, payload: { content: 'highly relevant' } }];
      vi.mocked(mockQdrantClientInstance.search).mockResolvedValue(mockResults as any);

      const { results, refinedQuery, relevanceScore } = await searchWithRefinement( // Uses original searchWithRefinement
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

      const { results, relevanceScore } = await searchWithRefinement( // Uses original searchWithRefinement
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
      await searchWithRefinement(mockQdrantClientInstance, 'query', [], 15); // Uses original searchWithRefinement
      expect(mockQdrantClientInstance.search).toHaveBeenCalledWith(
        configService.COLLECTION_NAME,
        expect.objectContaining({ limit: 15 })
      );
    });
    
    it('should apply file filter if files array is provided', async () => {
        vi.mocked(mockQdrantClientInstance.search).mockResolvedValue([{ id: '1', score: 0.9, payload: {} }] as any);
        const filesToFilter = ['src/file1.ts', 'src/file2.ts'];
        await searchWithRefinement(mockQdrantClientInstance, 'query', filesToFilter); // Uses original searchWithRefinement
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

        const { results, relevanceScore } = await searchWithRefinement( // Uses original searchWithRefinement
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
      // Mock preprocessText specifically for this test if its general mock isn't suitable
      vi.mocked(preprocessText).mockReturnValueOnce(text.toLowerCase().replace(/[.,;:!?(){}[\]"']/g, " "));
      const keywords = actualExtractKeywords(text); // Use actualExtractKeywords import
      expect(keywords).toEqual(expect.arrayContaining(['sample', 'function', 'user', 'authentication', 'class']));
      expect(keywords).not.toContain('this');
      expect(keywords).not.toContain('for');
    });

    it('should return unique keywords', () => {
      const text = "test test keyword keyword";
      vi.mocked(preprocessText).mockReturnValueOnce(text.toLowerCase().replace(/[.,;:!?(){}[\]"']/g, " "));
      const keywords = actualExtractKeywords(text); // Use actualExtractKeywords import
      expect(keywords).toEqual(expect.arrayContaining(['test', 'keyword'])); // Order might vary with Set
    });
  });

  describe('broadenQuery (direct test)', () => { // Renamed describe for clarity
    it('should remove specific terms and file extensions', () => {
      const query = "exact specific search for login.ts only";
      const result = actualBroadenQuery(query); // Use actualBroadenQuery import
      expect(result).toBeDefined();
      expect(typeof result).toBe('string');
      expect(result).not.toContain('exact');
      expect(result).not.toContain('specific');
      expect(result).not.toContain('only');
      expect(result).not.toContain('.ts');
      expect(result).toContain('search for login');
    });

    it('should add generic terms if query becomes too short', () => {
      const query = "fix.ts";
      const result = actualBroadenQuery(query); // Use actualBroadenQuery import
      expect(result).toBe('fix implementation code');
    });
  });

  describe('focusQueryBasedOnResults (direct test)', () => { // Renamed describe for clarity
    it('should add keywords from top results to the query', async () => {
      const originalQuery = "find user";
      const results = [
        { payload: { content: "function processUser(user: UserType)" } },
        { payload: { content: "class UserProfile extends BaseProfile" } },
      ] as DetailedQdrantSearchResult[];
      // preprocessText is mocked in beforeEach
      // actualExtractKeywords will be called internally by actualFocusQueryBasedOnResults
      const focused = actualFocusQueryBasedOnResults(originalQuery, results); // Use actualFocusQueryBasedOnResults import
      expect(focused).toBeDefined();
      expect(typeof focused).toBe('string');
      // Based on the simple preprocessText mock and actualExtractKeywords logic:
      // "function processUser(user: UserType)" -> keywords: ["function", "processuser", "user", "usertype"] (approx)
      // "class UserProfile extends BaseProfile" -> keywords: ["class", "userprofile", "extends", "baseprofile"] (approx)
      // Top 2 might be "function", "processuser" or similar.
      expect(focused).toBe("find user function processuser"); // This expectation might need adjustment based on exact keyword extraction
    });
  });

  describe('tweakQuery (direct test)', () => { // Renamed describe for clarity
    it('should add file type if not present in query', () => {
      const query = "search login function";
      const results = [{ payload: { filepath: "src/auth/login.ts" } }] as DetailedQdrantSearchResult[];
      const tweaked = actualTweakQuery(query, results); // Use actualTweakQuery import
      expect(tweaked).toBeDefined();
      expect(typeof tweaked).toBe('string');
      expect(tweaked).toBe("search login function ts");
    });

    it('should add directory if file type present but directory not', () => {
      const query = "search login.ts function";
      const results = [{ payload: { filepath: "src/auth/login.ts" } }] as DetailedQdrantSearchResult[];
      const tweaked = actualTweakQuery(query, results); // Use actualTweakQuery import
      expect(tweaked).toBeDefined();
      expect(typeof tweaked).toBe('string');
      expect(tweaked).toBe("search login.ts function in src");
    });
    
    it('should not change query if context already present or no context to add', () => {
        const query = "search login.ts function in src";
        const results = [{ payload: { filepath: "src/auth/login.ts" } }] as DetailedQdrantSearchResult[];
        let tweaked = actualTweakQuery(query, results); // Use actualTweakQuery import
        expect(tweaked).toBeDefined();
        expect(typeof tweaked).toBe('string');
        expect(tweaked).toBe(query);

        const resultsNoPath = [{ payload: { content: "some content" } }] as DetailedQdrantSearchResult[];
        tweaked = actualTweakQuery("some query", resultsNoPath); // Use actualTweakQuery import
        expect(tweaked).toBeDefined();
        expect(typeof tweaked).toBe('string');
        expect(tweaked).toBe("some query");
    });
  });
  
  describe('refineQuery (main dispatcher)', () => {
    // For these tests, refineQuery (the SUT) will be the original implementation from the module.
    // It will call the spied versions of broadenQuery, focusQueryBasedOnResults, and tweakQuery
    // that were set up by the vi.mock factory.

    beforeEach(()=> {
        // broadenQuery, focusQueryBasedOnResults, tweakQuery are now the vi.fn() spies from the factory.
        // vi.mocked() is used to access the mock API of these spies.
        vi.mocked(broadenQuery).mockClear().mockReturnValue('spy_broadened_return_val');
        vi.mocked(focusQueryBasedOnResults).mockClear().mockReturnValue('spy_focused_return_val');
        vi.mocked(tweakQuery).mockClear().mockReturnValue('spy_tweaked_return_val');
    });
        
    it('should call broadenQuery and return its result for very low relevance (<0.3)', () => {
      const result = refineQuery("original", [], 0.1); // Calls original refineQuery (SUT)
      expect(broadenQuery).toHaveBeenCalledWith("original"); // Checks the spy
      expect(result).toBe('spy_broadened_return_val'); // Verifies spy's mockReturnValue was used
      expect(focusQueryBasedOnResults).not.toHaveBeenCalled();
      expect(tweakQuery).not.toHaveBeenCalled();
    });
    
    it('should call focusQueryBasedOnResults and return its result for mediocre relevance (0.3 <= relevance < 0.7)', () => {
      const mockResults = [{payload: {content: 'some'}} as DetailedQdrantSearchResult];
      const result = refineQuery("original", mockResults, 0.5); // Calls original refineQuery (SUT)
      expect(focusQueryBasedOnResults).toHaveBeenCalledWith("original", mockResults); // Checks the spy
      expect(result).toBe('spy_focused_return_val'); // Verifies spy's mockReturnValue was used
      expect(broadenQuery).not.toHaveBeenCalled();
      expect(tweakQuery).not.toHaveBeenCalled();
    });

    it('should call tweakQuery and return its result for decent relevance (>=0.7)', () => {
      const mockResults = [{payload: {content: 'some'}} as DetailedQdrantSearchResult];
      const result = refineQuery("original", mockResults, 0.7); // Calls original refineQuery (SUT)
      expect(tweakQuery).toHaveBeenCalledWith("original", mockResults); // Checks the spy
      expect(result).toBe('spy_tweaked_return_val'); // Verifies spy's mockReturnValue was used
      expect(broadenQuery).not.toHaveBeenCalled();
      expect(focusQueryBasedOnResults).not.toHaveBeenCalled();
    });
  });

});
