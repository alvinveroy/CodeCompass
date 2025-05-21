import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { QdrantClient } from '@qdrant/js-client-rest';

// Mock dependencies of the functions being tested in THIS file
vi.mock('../config-service', () => ({
  configService: {
    COLLECTION_NAME: 'test_refine_collection',
    QDRANT_SEARCH_LIMIT_DEFAULT: 5,
    MAX_REFINEMENT_ITERATIONS: 2, // For testing loop limits in searchWithRefinement
  },
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('../ollama'); // For generateEmbedding used by searchWithRefinement
// preprocessText is not directly used by refineQuery or searchWithRefinement, but by extractKeywords (tested elsewhere)
// vi.mock('../../utils/text-utils'); 

// Mock the query-refinement module itself for spying on internal helpers
// const mockBroadenQueryFn = vi.fn(); // Removed
// const mockFocusQueryFn = vi.fn(); // Removed
// const mockTweakQueryFn = vi.fn(); // Removed
// const mockRefineQueryFn = vi.fn(); // Mock for refineQuery // Removed

vi.mock('../query-refinement', async (importOriginal) => {
  const originalModule = await importOriginal<typeof import('../query-refinement')>();
  // Create vi.fn() instances inside the factory
  const internalMockBroadenQueryFn = vi.fn();
  const internalMockFocusQueryFn = vi.fn();
  const internalMockTweakQueryFn = vi.fn();
  const internalMockRefineQueryFn = vi.fn();
  return {
    // Keep original searchWithRefinement for its describe block
    searchWithRefinement: originalModule.searchWithRefinement,
    // Mock refineQuery for testing searchWithRefinement
    refineQuery: internalMockRefineQueryFn, // Export the internally created mock
    // Keep original extractKeywords (or mock if needed for refineQuery tests)
    extractKeywords: originalModule.extractKeywords,
    // Provide mocks for helpers, to be used when testing refineQuery directly
    broadenQuery: internalMockBroadenQueryFn, // Export the internally created mock
    focusQueryBasedOnResults: internalMockFocusQueryFn, // Export the internally created mock
    tweakQuery: internalMockTweakQueryFn, // Export the internally created mock
  };
});

// Import mocked versions of dependencies
import { generateEmbedding } from '../ollama';
// import { preprocessText } from '../../utils/text-utils'; // Not needed here
import { configService, logger } from '../config-service';
import { DetailedQdrantSearchResult } from '../types';
// Import functions from query-refinement; some will be original, some will be mocks from the factory
import {
  searchWithRefinement,
  refineQuery, // This is mockRefineQueryFn
  broadenQuery, // This is mockBroadenQueryFn
  focusQueryBasedOnResults, // This is mockFocusQueryFn
  tweakQuery // This is mockTweakQueryFn
  // extractKeywords // This would be original unless also mocked in the factory
} from '../query-refinement';


// Define a reusable mock Qdrant client
const mockQdrantClientInstance = {
  search: vi.fn(),
} as unknown as QdrantClient;

describe('Query Refinement Dispatchers and Search', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Default mock for generateEmbedding (used by searchWithRefinement)
    vi.mocked(generateEmbedding).mockResolvedValue([0.1, 0.2, 0.3]);
    
    // Reset spies for refineQuery's internal calls
    // broadenQuery, focusQueryBasedOnResults, and tweakQuery are now vi.fn() from the mock factory
    // Use vi.mocked() to set their behavior.
    vi.mocked(broadenQuery).mockReturnValue('spy_broadened_return_val');
    vi.mocked(focusQueryBasedOnResults).mockReturnValue('spy_focused_return_val');
    vi.mocked(tweakQuery).mockReturnValue('spy_tweaked_return_val');
    
    // Setup mock for refineQuery (which is mockRefineQueryFn from the factory)
    vi.mocked(refineQuery).mockImplementation((currentQuery, _results, relevance) => {
      if (relevance < 0.3) return 'mock_refined_broadened_query';
      if (relevance < 0.7) return 'mock_refined_focused_query';
      return 'mock_refined_tweaked_query';
    });
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('searchWithRefinement', () => {
    // searchWithRefinement internally calls the (now mocked) refineQuery.
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
      expect(refinedQuery).toBe('initial query'); // No refinement should occur
      expect(relevanceScore).toBe(0.8);
      expect(logger.info).toHaveBeenCalledWith(expect.stringContaining('Completed search with 0 refinements'));
      // Ensure refineQuery (the mock) was not called
      expect(refineQuery).not.toHaveBeenCalled();
    });

    it('should refine query up to maxRefinements if threshold not met, calling appropriate refinement helpers', async () => {
      vi.mocked(mockQdrantClientInstance.search)
        .mockResolvedValueOnce([{ id: 'r1', score: 0.2, payload: { content: 'low relevance' } }] as any)  // Initial search, low relevance
        .mockResolvedValueOnce([{ id: 'r2', score: 0.5, payload: { content: 'medium relevance' } }] as any) // After 1st refinement
        .mockResolvedValueOnce([{ id: 'r3', score: 0.8, payload: { content: 'high relevance' } }] as any); // After 2nd refinement

      // refineQuery (mockRefineQueryFn) will be called by searchWithRefinement.
      // Its mockImplementation will return:
      // 1. 'mock_refined_broadened_query' for relevance 0.2
      // 2. 'mock_refined_focused_query' for relevance 0.5
      // Loop breaks after 2nd refinement due to relevance 0.8 meeting threshold.

      const { results, relevanceScore, refinedQuery } = await searchWithRefinement(
        mockQdrantClientInstance,
        'original query',
        [],
        undefined,
        undefined, // Uses configService.MAX_REFINEMENT_ITERATIONS = 2
        0.75 // relevanceThreshold
      );
      
      expect(mockQdrantClientInstance.search).toHaveBeenCalledTimes(3); // Initial + 2 refinements
      expect(results[0].id).toBe('r3');
      expect(relevanceScore).toBe(0.8);
      // The refinedQuery will be the one that led to the best results, which is the output of the second refineQuery call
      expect(refinedQuery).toBe('mock_refined_focused_query'); 
      expect(logger.info).toHaveBeenCalledWith(expect.stringContaining('Completed search with 2 refinements'));

      // Check that refineQuery (the mock) was called as expected
      expect(refineQuery).toHaveBeenCalledTimes(2);
      expect(refineQuery).toHaveBeenNthCalledWith(1, 'original query', 
        [{ id: 'r1', score: 0.2, payload: { content: 'low relevance' } }], 0.2);
      expect(refineQuery).toHaveBeenNthCalledWith(2, 'mock_refined_broadened_query', 
        [{ id: 'r2', score: 0.5, payload: { content: 'medium relevance' } }], 0.5);
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
            .mockResolvedValueOnce([]) // Iteration 1 - still no results (after broaden)
            .mockResolvedValueOnce([]); // Iteration 2 - still no results (after broaden again)

        const { results, relevanceScore } = await searchWithRefinement(
            mockQdrantClientInstance, 'query for no results', [], undefined, undefined, 0.7
        );
        expect(mockQdrantClientInstance.search).toHaveBeenCalledTimes(3); 
        expect(results).toEqual([]);
        expect(relevanceScore).toBe(0);
        expect(logger.info).toHaveBeenCalledWith(expect.stringContaining('Completed search with 2 refinements'));
        // refineQuery (the mock) should be called each time
        expect(refineQuery).toHaveBeenCalledTimes(2); 
    });
  });
  
  describe('refineQuery (main dispatcher)', () => {
    // These tests directly invoke the *original* refineQuery SUT.
    // The helper functions (broadenQuery, focusQueryBasedOnResults, tweakQuery)
    // will be the mocked versions (mockBroadenQueryFn, etc.) from the top-level vi.mock factory.
    // Spies (mockBroadenQueryFn etc.) are reset in the top-level beforeEach.
    
    let actualRefineQuery: typeof import('../query-refinement').refineQuery;
    beforeAll(async () => {
      const actualModule = await vi.importActual<typeof import('../query-refinement')>('../query-refinement');
      actualRefineQuery = actualModule.refineQuery;
    });
        
    it('should call broadenQuery and return its result for very low relevance (<0.3)', () => {
      const result = actualRefineQuery("original", [], 0.1);
      expect(broadenQuery).toHaveBeenCalledWith("original"); // broadenQuery is mockBroadenQueryFn
      expect(result).toBe('spy_broadened_return_val');
      expect(focusQueryBasedOnResults).not.toHaveBeenCalled();
      expect(tweakQuery).not.toHaveBeenCalled();
    });
    
    it('should call focusQueryBasedOnResults and return its result for mediocre relevance (0.3 <= relevance < 0.7)', () => {
      const mockResults = [{payload: {content: 'some'}} as DetailedQdrantSearchResult];
      const result = actualRefineQuery("original", mockResults, 0.5);
      expect(focusQueryBasedOnResults).toHaveBeenCalledWith("original", mockResults); // focusQueryBasedOnResults is mockFocusQueryFn
      expect(result).toBe('spy_focused_return_val');
      expect(broadenQuery).not.toHaveBeenCalled();
      expect(tweakQuery).not.toHaveBeenCalled();
    });

    it('should call tweakQuery and return its result for decent relevance (>=0.7)', () => {
      const mockResults = [{payload: {content: 'some'}} as DetailedQdrantSearchResult];
      const result = actualRefineQuery("original", mockResults, 0.7);
      expect(tweakQuery).toHaveBeenCalledWith("original", mockResults); // tweakQuery is mockTweakQueryFn
      expect(result).toBe('spy_tweaked_return_val');
      expect(broadenQuery).not.toHaveBeenCalled();
      expect(focusQueryBasedOnResults).not.toHaveBeenCalled();
    });
  });

});
