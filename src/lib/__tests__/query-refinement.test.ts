import { describe, it, expect, vi, beforeEach, afterEach, beforeAll, afterAll } from 'vitest';
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

// REMOVE any top-level const MOCK_REFINE_QUERY_FN = vi.fn(); etc.

vi.mock('../query-refinement', async (importOriginal) => {
  const originalModule = await importOriginal<typeof import('../query-refinement')>();
  // Define mocks INSIDE the factory
  const factoryMockRefineQuery = vi.fn();
  const factoryMockBroadenQuery = vi.fn();
  const factoryMockFocusQuery = vi.fn();
  const factoryMockTweakQuery = vi.fn();
  return {
    ...originalModule, // Keep searchWithRefinement, extractKeywords as original
    // refineQuery (when called by searchWithRefinement) will be factoryMockRefineQuery
    refineQuery: factoryMockRefineQuery,
    // broadenQuery, focusQueryBasedOnResults, tweakQuery (when called by actual refineQuery)
    // will be these factory mocks.
    broadenQuery: factoryMockBroadenQuery,
    focusQueryBasedOnResults: factoryMockFocusQuery,
    tweakQuery: factoryMockTweakQuery,
  };
});

// Import mocked versions of dependencies
import { generateEmbedding } from '../ollama';
// import { preprocessText } from '../../utils/text-utils'; // Not needed here
import { configService, logger } from '../config-service';
import { DetailedQdrantSearchResult } from '../types';

// These imports will get the versions from the mock factory where specified
import { 
  searchWithRefinement, 
  refineQuery, // This is factoryMockRefineQuery
  broadenQuery, // This is factoryMockBroadenQuery
  focusQueryBasedOnResults, // This is factoryMockFocusQuery
  tweakQuery // This is factoryMockTweakQuery
} from '../query-refinement';


// Define a reusable mock Qdrant client
const mockQdrantClientInstance = {
  search: vi.fn(),
} as unknown as QdrantClient;

describe('Query Refinement Tests', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(generateEmbedding).mockResolvedValue([0.1, 0.2, 0.3]);

    // Setup behavior for the imported mocks (which are from the factory)
    (refineQuery as vi.Mock).mockImplementation((_query, _results, relevance) => {
      if (relevance < 0.3) return 'mock_refined_broadened_query_for_search';
      if (relevance < 0.7) return 'mock_refined_focused_query_for_search';
      return 'mock_refined_tweaked_query_for_search';
    });
    (broadenQuery as vi.Mock).mockReturnValue('spy_broadened_return_val');
    (focusQueryBasedOnResults as vi.Mock).mockReturnValue('spy_focused_return_val');
    (tweakQuery as vi.Mock).mockReturnValue('spy_tweaked_return_val');
    
    vi.mocked(mockQdrantClientInstance.search).mockClear(); // Clear Qdrant search mock
  });

  afterEach(() => {
    vi.restoreAllMocks(); 
  });

  // --- Test searchWithRefinement ---
  describe('searchWithRefinement', () => {
    it('should return results without refinement if relevance threshold is met initially', async () => {
      const mockResults = [{ id: '1', score: 0.8, payload: { content: 'highly relevant' } }];
      vi.mocked(mockQdrantClientInstance.search).mockResolvedValue(mockResults as any);

      const { results, refinedQuery: actualRefinedQuery, relevanceScore } = await searchWithRefinement(
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
      expect(refineQuery).not.toHaveBeenCalled(); // refineQuery is the mock from the factory
    });

    it('should refine query up to maxRefinements if threshold not met, calling mocked refineQuery', async () => {
      vi.mocked(mockQdrantClientInstance.search)
        .mockResolvedValueOnce([{ id: 'r1', score: 0.2, payload: { content: 'low relevance' } }] as any)
        .mockResolvedValueOnce([{ id: 'r2', score: 0.5, payload: { content: 'medium relevance' } }] as any)
        .mockResolvedValueOnce([{ id: 'r3', score: 0.8, payload: { content: 'high relevance' } }] as any);

      const { results, relevanceScore, refinedQuery: actualRefinedQueryOutput } = await searchWithRefinement(
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
      expect(actualRefinedQueryOutput).toBe('mock_refined_focused_query_for_search'); 
      expect(logger.info).toHaveBeenCalledWith(expect.stringContaining('Completed search with 2 refinements'));
      expect(refineQuery).toHaveBeenCalledTimes(2); // refineQuery is the mock from the factory
      expect(refineQuery).toHaveBeenNthCalledWith(1, 'original query', 
        [{ id: 'r1', score: 0.2, payload: { content: 'low relevance' } }], 0.2);
      expect(refineQuery).toHaveBeenNthCalledWith(2, 'mock_refined_broadened_query_for_search', 
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
            .mockResolvedValueOnce([]) 
            .mockResolvedValueOnce([]) 
            .mockResolvedValueOnce([]);

        const { results, relevanceScore } = await searchWithRefinement(
            mockQdrantClientInstance, 'query for no results', [], undefined, undefined, 0.7
        );
        expect(mockQdrantClientInstance.search).toHaveBeenCalledTimes(3); 
        expect(results).toEqual([]);
        expect(relevanceScore).toBe(0);
        expect(logger.info).toHaveBeenCalledWith(expect.stringContaining('Completed search with 2 refinements'));
        expect(refineQuery).toHaveBeenCalledTimes(2); // refineQuery is the mock from the factory
    });
  });
  
  describe('refineQuery (main dispatcher)', () => {
    let actualRefineQueryInstance: typeof import('../query-refinement').refineQuery;
    
    beforeAll(async () => {
      // Import the *actual* refineQuery for testing its internal logic
      const actualModule = await vi.importActual<typeof import('../query-refinement')>('../query-refinement');
      actualRefineQueryInstance = actualModule.refineQuery; // This is the original refineQuery
    });
        
    it('should call broadenQuery and return its result for very low relevance (<0.3)', () => {
      // actualRefineQueryInstance calls broadenQuery, which IS the factoryMockBroadenQuery
      const result = actualRefineQueryInstance("original", [], 0.1);
      expect(broadenQuery).toHaveBeenCalledWith("original"); // Assert on the imported mock
      expect(result).toBe('spy_broadened_return_val');
      expect(focusQueryBasedOnResults).not.toHaveBeenCalled(); 
      expect(tweakQuery).not.toHaveBeenCalled(); 
    });
    
    it('should call focusQueryBasedOnResults and return its result for mediocre relevance (0.3 <= relevance < 0.7)', () => {
      const mockResults = [{payload: {content: 'some'}} as DetailedQdrantSearchResult];
      const result = actualRefineQueryInstance("original", mockResults, 0.5);
      expect(focusQueryBasedOnResults).toHaveBeenCalledWith("original", mockResults); // Assert on the imported mock
      expect(result).toBe('spy_focused_return_val');
      expect(broadenQuery).not.toHaveBeenCalled(); 
      expect(tweakQuery).not.toHaveBeenCalled(); 
    });

    it('should call tweakQuery and return its result for decent relevance (>=0.7)', () => {
      const mockResults = [{payload: {content: 'some'}} as DetailedQdrantSearchResult];
      const result = actualRefineQueryInstance("original", mockResults, 0.7);
      expect(tweakQuery).toHaveBeenCalledWith("original", mockResults); // Assert on the imported mock
      expect(result).toBe('spy_tweaked_return_val');
      expect(broadenQuery).not.toHaveBeenCalled(); 
      expect(focusQueryBasedOnResults).not.toHaveBeenCalled(); 
    });
  });
});
