import { describe, it, expect, vi, beforeEach, afterEach, beforeAll, afterAll } from 'vitest'; // Ensure all hooks
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

// Import mocked versions of dependencies
import { generateEmbedding } from '../ollama';
// import { preprocessText } from '../../utils/text-utils'; // Not needed here
import { configService, logger } from '../config-service';
import { DetailedQdrantSearchResult } from '../types';

// Define a reusable mock Qdrant client
const mockQdrantClientInstance = {
  search: vi.fn(),
} as unknown as QdrantClient;

// REMOVE: vi.mock('../query-refinement', ...);
// REMOVE: top-level let QR_MOCK_... variables

// Mock external dependencies of query-refinement.ts
// config-service is already mocked at the top of the file
// ollama is already mocked at the top of the file
// text-utils is already mocked at the top of the file

// Import ALL functions from query-refinement.ts (originals)
import * as queryRefinement from '../query-refinement';
// Import mocked dependencies
// generateEmbedding is already imported
// preprocessText is already imported
// configService, logger are already imported
// DetailedQdrantSearchResult is already imported


describe('Query Refinement Tests', () => {
  let refineQuerySpy: vi.SpyInstance;
  let broadenQuerySpy: vi.SpyInstance;
  let focusQuerySpy: vi.SpyInstance;
  let tweakQuerySpy: vi.SpyInstance;

  beforeEach(() => {
    vi.clearAllMocks(); // Clears call history and mock implementations set by mockXyzOnce

    // Spy on functions within the queryRefinement module
    refineQuerySpy = vi.spyOn(queryRefinement, 'refineQuery');
    broadenQuerySpy = vi.spyOn(queryRefinement, 'broadenQuery');
    focusQuerySpy = vi.spyOn(queryRefinement, 'focusQueryBasedOnResults');
    tweakQuerySpy = vi.spyOn(queryRefinement, 'tweakQuery');

    // Setup default behaviors for spies or external mocks
    vi.mocked(generateEmbedding).mockResolvedValue([0.1,0.2,0.3]);
    vi.mocked(mockQdrantClientInstance.search).mockClear();
        
    // Default behavior for spied functions (can be overridden in tests)
    refineQuerySpy.mockImplementation((currentQuery, _results, relevance) => {
      if (relevance < 0.3) return 'mock_refined_broadened_for_search';
      if (relevance < 0.7) return 'mock_refined_focused_for_search';
      // Return currentQuery for relevance >= 0.7 to match the original mock's "tweaked" behavior,
      // or a specific "mock_refined_tweaked_for_search" if that's preferred.
      // The original mock returned 'mock_refined_tweaked_for_search'. Let's stick to that.
      return 'mock_refined_tweaked_for_search'; 
    });
    broadenQuerySpy.mockReturnValue('spy_broadened_return_val');
    focusQuerySpy.mockReturnValue('spy_focused_return_val');
    tweakQuerySpy.mockReturnValue('spy_tweaked_return_val');
  });

  afterEach(() => { vi.restoreAllMocks(); });

  // --- Test searchWithRefinement ---
  describe('searchWithRefinement', () => {
    // searchWithRefinement will call queryRefinement.refineQuery (which is spied on)

    it('should return results without refinement if relevance threshold is met initially', async () => {
      const mockResults = [{ id: '1', score: 0.8, payload: { content: 'highly relevant' } }];
      vi.mocked(mockQdrantClientInstance.search).mockResolvedValue(mockResults as any);

      const { results, refinedQuery: actualRefinedQuery, relevanceScore } = await queryRefinement.searchWithRefinement(
        mockQdrantClientInstance,
        'initial query',
        [], // files
        undefined, // customLimit
        undefined, // maxRefinements (uses configService.MAX_REFINEMENT_ITERATIONS = 2)
        0.75 // relevanceThreshold
      );
      
      expect(mockQdrantClientInstance.search).toHaveBeenCalledTimes(1);
      expect(results).toEqual(mockResults);
      expect(actualRefinedQuery).toBe('initial query'); // No refinement should occur
      expect(relevanceScore).toBe(0.8);
      expect(logger.info).toHaveBeenCalledWith(expect.stringContaining('Completed search with 0 refinements'));
      expect(refineQuerySpy).not.toHaveBeenCalled(); 
    });

    it('should refine query up to maxRefinements if threshold not met, calling spied refineQuery', async () => {
      vi.mocked(mockQdrantClientInstance.search)
        .mockResolvedValueOnce([{ id: 'r1', score: 0.2, payload: { content: 'low relevance' } }] as any)
        .mockResolvedValueOnce([{ id: 'r2', score: 0.5, payload: { content: 'medium relevance' } }] as any)
        .mockResolvedValueOnce([{ id: 'r3', score: 0.8, payload: { content: 'high relevance' } }] as any);

      const { results, relevanceScore, refinedQuery: actualRefinedQueryOutput } = await queryRefinement.searchWithRefinement(
        mockQdrantClientInstance,
        'original query',
        [],
        undefined,
        undefined, 
        0.75
      );
      
      expect(mockQdrantClientInstance.search).toHaveBeenCalledTimes(3);
      expect(results[0].id).toBe('r3');
      expect(relevanceScore).toBe(0.8);
      // The actualRefinedQueryOutput will be the result of the last call to the spied refineQuery
      // refineQuerySpy is mocked to return 'mock_refined_focused_for_search' for relevance 0.5
      expect(actualRefinedQueryOutput).toBe('mock_refined_focused_for_search'); 
      expect(logger.info).toHaveBeenCalledWith(expect.stringContaining('Completed search with 2 refinements'));
      expect(refineQuerySpy).toHaveBeenCalledTimes(2); 
      expect(refineQuerySpy).toHaveBeenNthCalledWith(1, 'original query', 
        [{ id: 'r1', score: 0.2, payload: { content: 'low relevance' } }], 0.2);
      // The second call to refineQuerySpy will use the output of the first call as its input query
      expect(refineQuerySpy).toHaveBeenNthCalledWith(2, 'mock_refined_broadened_for_search', 
        [{ id: 'r2', score: 0.5, payload: { content: 'medium relevance' } }], 0.5);
    });

    it('should use customLimit if provided', async () => {
      vi.mocked(mockQdrantClientInstance.search).mockResolvedValue([{ id: '1', score: 0.9, payload: {} }] as any);
      await queryRefinement.searchWithRefinement(mockQdrantClientInstance, 'query', [], 15);
      expect(mockQdrantClientInstance.search).toHaveBeenCalledWith(
        configService.COLLECTION_NAME,
        expect.objectContaining({ limit: 15 })
      );
    });
    
    it('should apply file filter if files array is provided', async () => {
        vi.mocked(mockQdrantClientInstance.search).mockResolvedValue([{ id: '1', score: 0.9, payload: {} }] as any);
        const filesToFilter = ['src/file1.ts', 'src/file2.ts'];
        await queryRefinement.searchWithRefinement(mockQdrantClientInstance, 'query', filesToFilter);
        expect(mockQdrantClientInstance.search).toHaveBeenCalledWith(
            configService.COLLECTION_NAME,
            expect.objectContaining({
                filter: { must: [{ key: "filepath", match: { any: filesToFilter } }] }
            })
        );
    });

    it('should handle empty search results gracefully during refinement', async () => {
        vi.mocked(mockQdrantClientInstance.search)
            .mockResolvedValueOnce([]) 
            .mockResolvedValueOnce([]) 
            .mockResolvedValueOnce([]); // Assuming MAX_REFINEMENT_ITERATIONS = 2

        const { results, relevanceScore } = await queryRefinement.searchWithRefinement(
            mockQdrantClientInstance, 'query for no results', [], undefined, undefined, 0.7
        );
        expect(mockQdrantClientInstance.search).toHaveBeenCalledTimes(configService.MAX_REFINEMENT_ITERATIONS + 1);
        expect(results).toEqual([]);
        expect(relevanceScore).toBe(0);
        expect(logger.info).toHaveBeenCalledWith(expect.stringContaining(`Completed search with ${configService.MAX_REFINEMENT_ITERATIONS} refinements`));
        expect(refineQuerySpy).toHaveBeenCalledTimes(configService.MAX_REFINEMENT_ITERATIONS); 
    });
  });
  
  describe('refineQuery (main dispatcher)', () => {
    // Now testing queryRefinement.refineQuery (original, but its internal calls are spied)
        
    it('should call broadenQuery and return its result for very low relevance (<0.3)', async () => {
      const result = queryRefinement.refineQuery("original", [], 0.1);
      expect(broadenQuerySpy).toHaveBeenCalledWith("original"); 
      expect(result).toBe('spy_broadened_return_val'); // From broadenQuerySpy's mockReturnValue
      expect(focusQuerySpy).not.toHaveBeenCalled(); 
      expect(tweakQuerySpy).not.toHaveBeenCalled(); 
    });
    
    it('should call focusQueryBasedOnResults and return its result for mediocre relevance (0.3 <= relevance < 0.7)', async () => {
      const mockResults = [{payload: {content: 'some'}} as DetailedQdrantSearchResult];
      const result = queryRefinement.refineQuery("original", mockResults, 0.5);
      expect(focusQuerySpy).toHaveBeenCalledWith("original", mockResults); 
      expect(result).toBe('spy_focused_return_val'); // From focusQuerySpy's mockReturnValue
      expect(broadenQuerySpy).not.toHaveBeenCalled(); 
      expect(tweakQuerySpy).not.toHaveBeenCalled(); 
    });

    it('should call tweakQuery and return its result for decent relevance (>=0.7)', async () => {
      const mockResults = [{payload: {content: 'some'}} as DetailedQdrantSearchResult];
      const result = queryRefinement.refineQuery("original", mockResults, 0.7);
      expect(tweakQuerySpy).toHaveBeenCalledWith("original", mockResults); 
      expect(result).toBe('spy_tweaked_return_val'); // From tweakQuerySpy's mockReturnValue
      expect(broadenQuerySpy).not.toHaveBeenCalled(); 
      expect(focusQuerySpy).not.toHaveBeenCalled(); 
    });
  });
});
