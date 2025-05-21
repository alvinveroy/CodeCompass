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
vi.mock('../../utils/text-utils');

// No need for QR_TEST_MOCK_EXTRACT_KEYWORDS if extractKeywords is tested via query-refinement.helpers.test.ts
// extractKeywords is tested directly via query-refinement.helpers.test.ts, so no mock needed here for it.

// Mock the SUT module, creating mocks INSIDE the factory
vi.mock('../query-refinement', async (importOriginal) => {
  const originalModule = await importOriginal<typeof import('../query-refinement')>();
  return {
    ...originalModule, // Originals for searchWithRefinement, extractKeywords etc.
    refineQuery: vi.fn(),
    broadenQuery: vi.fn(),
    focusQueryBasedOnResults: vi.fn(),
    tweakQuery: vi.fn(),
  };
});

// Import after mocks. refineQuery, broadenQuery etc. here ARE the mocks from the factory.
import {
  searchWithRefinement,
  refineQuery, // This is the mock from the factory
  broadenQuery, // This is the mock from the factory
  focusQueryBasedOnResults, // This is the mock from the factory
  tweakQuery // This is the mock from the factory
} from '../query-refinement';
// Import the SUT module again using import * as ... to access original implementations for direct testing.
// Note: actualQueryRefinementFunctions.refineQuery etc. will be THE MOCKS due to the factory.
// Use vi.importActual for true original functions.
import * as actualQueryRefinementFunctionsOriginalFallback from '../query-refinement'; // Renamed to avoid confusion, will use importActual

// Import mocked dependencies
import { generateEmbedding } from '../ollama';
import { configService, logger } from '../config-service';
import { DetailedQdrantSearchResult } from '../types'; // Ensure this is imported

// Define a reusable mock Qdrant client
const mockQdrantClientInstance = { search: vi.fn() } as unknown as QdrantClient;


describe('Query Refinement Tests', () => {
  // Spies are removed, we will use the imported mocks directly
  // let refineQuerySpy: vi.SpyInstance<Parameters<typeof queryRefinement.refineQuery>, ReturnType<typeof queryRefinement.refineQuery>>;
  // let broadenQuerySpy: vi.SpyInstance<Parameters<typeof queryRefinement.broadenQuery>, ReturnType<typeof queryRefinement.broadenQuery>>;
  // let focusQuerySpy: vi.SpyInstance<Parameters<typeof queryRefinement.focusQueryBasedOnResults>, ReturnType<typeof queryRefinement.focusQueryBasedOnResults>>;
  // let tweakQuerySpy: vi.SpyInstance<Parameters<typeof queryRefinement.tweakQuery>, ReturnType<typeof queryRefinement.tweakQuery>>;

  beforeEach(() => {
    vi.clearAllMocks();

    // Reset and set default behavior for the imported mocks
    (refineQuery as vi.Mock).mockReset().mockImplementation((_query, _results, relevance) => {
      if (relevance < 0.3) return 'mock_refined_broadened_for_search';
      if (relevance < 0.7) return 'mock_refined_focused_for_search';
      return 'mock_refined_tweaked_for_search';
    });
    (broadenQuery as vi.Mock).mockReset().mockReturnValue('spy_broadened_return_val');
    (focusQueryBasedOnResults as vi.Mock).mockReset().mockReturnValue('spy_focused_return_val');
    (tweakQuery as vi.Mock).mockReset().mockReturnValue('spy_tweaked_return_val');

    vi.mocked(generateEmbedding).mockResolvedValue([0.1,0.2,0.3]);
    vi.mocked(mockQdrantClientInstance.search).mockClear();
  });

  afterEach(() => { vi.restoreAllMocks(); });

  describe('searchWithRefinement', () => {
    // searchWithRefinement (original) will call refineQuery (the mock)

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
      expect(refineQuery).not.toHaveBeenCalled(); // Assert on the imported mock
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
      expect(refineQuery).toHaveBeenCalledTimes(2); // Assert on the imported mock
      expect(refineQuery).toHaveBeenNthCalledWith(1, 'original query',
        [{ id: 'r1', score: 0.2, payload: { content: 'low relevance' } }], 0.2);
      expect(refineQuery).toHaveBeenNthCalledWith(2, 'mock_refined_broadened_for_search',
        [{ id: 'r2', score: 0.5, payload: { content: 'medium relevance' } }], 0.5);
    });

    it('should use customLimit if provided', async () => {
      vi.mocked(mockQdrantClientInstance.search).mockResolvedValue([{ id: '1', score: 0.9, payload: {} }] as any);
      await searchWithRefinement(mockQdrantClientInstance, 'query', [], 15); // searchWithRefinement is original
      expect(mockQdrantClientInstance.search).toHaveBeenCalledWith(
        configService.COLLECTION_NAME,
        expect.objectContaining({ limit: 15 })
      );
    });
    
    it('should apply file filter if files array is provided', async () => {
        vi.mocked(mockQdrantClientInstance.search).mockResolvedValue([{ id: '1', score: 0.9, payload: {} }] as any);
        const filesToFilter = ['src/file1.ts', 'src/file2.ts'];
        await searchWithRefinement(mockQdrantClientInstance, 'query', filesToFilter); // searchWithRefinement is original
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

        const { results, relevanceScore } = await searchWithRefinement( // searchWithRefinement is original
            mockQdrantClientInstance, 'query for no results', [], undefined, undefined, 0.7
        );
        expect(mockQdrantClientInstance.search).toHaveBeenCalledTimes(configService.MAX_REFINEMENT_ITERATIONS + 1);
        expect(results).toEqual([]);
        expect(relevanceScore).toBe(0);
        expect(logger.info).toHaveBeenCalledWith(expect.stringContaining(`Completed search with ${configService.MAX_REFINEMENT_ITERATIONS} refinements`));
        expect(refineQuery).toHaveBeenCalledTimes(configService.MAX_REFINEMENT_ITERATIONS); // Assert on the imported mock
    });
  });
  
  describe('refineQuery (main dispatcher - testing original logic)', () => {
    // Testing the original refineQuery function.
    // Its internal calls to broadenQuery, focusQueryBasedOnResults, tweakQuery should be to the *mocked* versions
    // because those are what the module exports due to the vi.mock factory.
    let actualRefineQueryFn: typeof actualQueryRefinementFunctionsOriginalFallback.refineQuery;
    
    beforeAll(async () => {
        const actualModule = await vi.importActual<typeof import('../query-refinement')>('../query-refinement');
        actualRefineQueryFn = actualModule.refineQuery;
    });
        
    it('should call broadenQuery (mocked) and return its result for very low relevance (<0.3)', () => {
      const result = actualRefineQueryFn("original", [], 0.1); // Use the actual (original) refineQuery
      expect(broadenQuery).toHaveBeenCalledWith("original"); // broadenQuery is the imported mock
      expect(result).toBe('spy_broadened_return_val'); // This comes from broadenQuery mockReturnValue
      expect(focusQueryBasedOnResults).not.toHaveBeenCalled(); // Assert on the imported mock
      expect(tweakQuery).not.toHaveBeenCalled(); // Assert on the imported mock
    });
    
    it('should call focusQueryBasedOnResults (mocked) for mediocre relevance (0.3 <= relevance < 0.7)', () => {
      const mockResults = [{payload: {content: 'some'}} as DetailedQdrantSearchResult];
      const result = actualRefineQueryFn("original", mockResults, 0.5); // Use the actual (original) refineQuery
      expect(focusQueryBasedOnResults).toHaveBeenCalledWith("original", mockResults); // Assert on the imported mock
      expect(result).toBe('spy_focused_return_val'); // This comes from focusQueryBasedOnResults mockReturnValue
      expect(broadenQuery).not.toHaveBeenCalled(); // Assert on the imported mock
      expect(tweakQuery).not.toHaveBeenCalled(); // Assert on the imported mock
    });

    it('should call tweakQuery (mocked) for decent relevance (>=0.7)', () => {
      const mockResults = [{payload: {content: 'some'}} as DetailedQdrantSearchResult];
      const result = actualRefineQueryFn("original", mockResults, 0.7); // Use the actual (original) refineQuery
      expect(tweakQuery).toHaveBeenCalledWith("original", mockResults); // Assert on the imported mock
      expect(result).toBe('spy_tweaked_return_val'); // This comes from tweakQuery mockReturnValue
      expect(broadenQuery).not.toHaveBeenCalled(); // Assert on the imported mock
      expect(focusQueryBasedOnResults).not.toHaveBeenCalled(); // Assert on the imported mock
    });
  });
});
