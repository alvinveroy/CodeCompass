import { describe, it, expect, vi, beforeEach, afterEach, beforeAll, afterAll } from 'vitest';
import { QdrantClient } from '@qdrant/js-client-rest';

// Mock external dependencies first
vi.mock('../config-service', () => ({
  configService: {
    COLLECTION_NAME: 'test_refine_collection',
    QDRANT_SEARCH_LIMIT_DEFAULT: 5,
    MAX_REFINEMENT_ITERATIONS: 2,
  },
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('../ollama'); // For generateEmbedding

// No need for QR_TEST_MOCK_EXTRACT_KEYWORDS if extractKeywords is tested via query-refinement.helpers.test.ts

vi.mock('../query-refinement', async (importOriginal) => {
  const originalModule = await importOriginal<typeof import('../query-refinement')>();
  return {
    ...originalModule, // Spread original module to keep non-mocked exports (like searchWithRefinement, extractKeywords)
    // Overwrite specific functions with mocks created directly in the factory
    refineQuery: vi.fn(),
    broadenQuery: vi.fn(),
    focusQueryBasedOnResults: vi.fn(),
    tweakQuery: vi.fn(),
    // extractKeywords will remain the original implementation from originalModule
    // unless it's also added here as vi.fn()
  };
});

// Import SUT (searchWithRefinement) and functions to be tested directly (originals via namespace)
// searchWithRefinement is the original. refineQuery, broadenQuery, etc. are mocks from the factory.
import { 
    searchWithRefinement,
    refineQuery,
    broadenQuery,
    focusQueryBasedOnResults,
    tweakQuery
} from '../query-refinement';
import * as actualQueryRefinementFunctions from '../query-refinement'; 

// Import mocked dependencies
import { generateEmbedding } from '../ollama';
import { configService, logger } from '../config-service';
import { DetailedQdrantSearchResult } from '../types'; // Ensure this is imported

// Define a reusable mock Qdrant client
const mockQdrantClientInstance = { search: vi.fn() } as unknown as QdrantClient;


describe('Query Refinement Tests', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    
    // Reset and setup default behaviors for the imported mocks
    (refineQuery as vi.Mock).mockReset().mockImplementation(
      (_currentQuery, _results, relevance) => {
        if (relevance < 0.3) return 'mock_refined_broadened_for_search';
        if (relevance < 0.7) return 'mock_refined_focused_for_search';
        return 'mock_refined_tweaked_for_search';
      }
    );
    (broadenQuery as vi.Mock).mockReset().mockReturnValue('spy_broadened_return_val');
    (focusQueryBasedOnResults as vi.Mock).mockReset().mockReturnValue('spy_focused_return_val');
    (tweakQuery as vi.Mock).mockReset().mockReturnValue('spy_tweaked_return_val');
    
    vi.mocked(generateEmbedding).mockResolvedValue([0.1,0.2,0.3]);
    vi.mocked(mockQdrantClientInstance.search).mockClear();
  });

  afterEach(() => { vi.restoreAllMocks(); });

  describe('searchWithRefinement', () => {
    // searchWithRefinement will call the mocked refineQuery (QR_TEST_MOCK_REFINE_QUERY)

    it('should return results without refinement if relevance threshold is met initially', async () => {
      const mockResults = [{ id: '1', score: 0.8, payload: { content: 'highly relevant' } }];
      vi.mocked(mockQdrantClientInstance.search).mockResolvedValue(mockResults as any);

      const { results, refinedQuery: actualRefinedQuery, relevanceScore } = await searchWithRefinement(
        mockQdrantClientInstance, 'initial query', [], undefined, undefined, 0.75
      );
      
      expect(mockQdrantClientInstance.search).toHaveBeenCalledTimes(1);
      expect(results).toEqual(mockResults);
      expect(actualRefinedQuery).toBe('initial query');
      expect(relevanceScore).toBe(0.8);
      expect(logger.info).toHaveBeenCalledWith(expect.stringContaining('Completed search with 0 refinements'));
      expect(refineQuery).not.toHaveBeenCalled(); 
    });

    it('should refine query up to maxRefinements if threshold not met, calling mocked refineQuery', async () => {
      vi.mocked(mockQdrantClientInstance.search)
        .mockResolvedValueOnce([{ id: 'r1', score: 0.2, payload: { content: 'low relevance' } }] as any)
        .mockResolvedValueOnce([{ id: 'r2', score: 0.5, payload: { content: 'medium relevance' } }] as any)
        .mockResolvedValueOnce([{ id: 'r3', score: 0.8, payload: { content: 'high relevance' } }] as any);

      const { results, relevanceScore, refinedQuery: actualRefinedQueryOutput } = await searchWithRefinement(
        mockQdrantClientInstance, 'original query', [], undefined, undefined, 0.75
      );
      
      expect(mockQdrantClientInstance.search).toHaveBeenCalledTimes(3);
      expect(results[0].id).toBe('r3');
      expect(relevanceScore).toBe(0.8);
      // actualRefinedQueryOutput is the result of the last call to the refineQuery mock
      expect(actualRefinedQueryOutput).toBe('mock_refined_focused_for_search'); 
      expect(logger.info).toHaveBeenCalledWith(expect.stringContaining('Completed search with 2 refinements'));
      expect(refineQuery).toHaveBeenCalledTimes(2); 
      expect(refineQuery).toHaveBeenNthCalledWith(1, 'original query', 
        [{ id: 'r1', score: 0.2, payload: { content: 'low relevance' } }], 0.2);
      expect(refineQuery).toHaveBeenNthCalledWith(2, 'mock_refined_broadened_for_search', 
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
        expect(mockQdrantClientInstance.search).toHaveBeenCalledTimes(configService.MAX_REFINEMENT_ITERATIONS + 1);
        expect(results).toEqual([]);
        expect(relevanceScore).toBe(0);
        expect(logger.info).toHaveBeenCalledWith(expect.stringContaining(`Completed search with ${configService.MAX_REFINEMENT_ITERATIONS} refinements`));
        expect(refineQuery).toHaveBeenCalledTimes(configService.MAX_REFINEMENT_ITERATIONS); 
    });
  });
  
  describe('refineQuery (main dispatcher - testing original logic)', () => {
    // Testing actualQueryRefinementFunctions.refineQuery (original)
    // Its internal calls to broadenQuery, focusQueryBasedOnResults, tweakQuery are the imported mocks.
        
    it('should call broadenQuery (mocked) and return its result for very low relevance (<0.3)', () => {
      const result = actualQueryRefinementFunctions.refineQuery("original", [], 0.1);
      expect(broadenQuery).toHaveBeenCalledWith("original"); 
      expect(result).toBe('spy_broadened_return_val');
      expect(focusQueryBasedOnResults).not.toHaveBeenCalled(); 
      expect(tweakQuery).not.toHaveBeenCalled(); 
    });
    
    it('should call focusQueryBasedOnResults (mocked) for mediocre relevance (0.3 <= relevance < 0.7)', () => {
      const mockResults = [{payload: {content: 'some'}} as DetailedQdrantSearchResult];
      const result = actualQueryRefinementFunctions.refineQuery("original", mockResults, 0.5);
      expect(focusQueryBasedOnResults).toHaveBeenCalledWith("original", mockResults); 
      expect(result).toBe('spy_focused_return_val');
      expect(broadenQuery).not.toHaveBeenCalled(); 
      expect(tweakQuery).not.toHaveBeenCalled(); 
    });

    it('should call tweakQuery (mocked) for decent relevance (>=0.7)', () => {
      const mockResults = [{payload: {content: 'some'}} as DetailedQdrantSearchResult];
      const result = actualQueryRefinementFunctions.refineQuery("original", mockResults, 0.7);
      expect(tweakQuery).toHaveBeenCalledWith("original", mockResults); 
      expect(result).toBe('spy_tweaked_return_val');
      expect(broadenQuery).not.toHaveBeenCalled(); 
      expect(focusQueryBasedOnResults).not.toHaveBeenCalled(); 
    });
  });
});
