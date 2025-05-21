import { describe, it, expect, vi, beforeEach, afterEach, beforeAll, afterAll } from 'vitest';
import { QdrantClient } from '@qdrant/js-client-rest';

// 2. Mock external dependencies FIRST
vi.mock('../config-service', () => ({
  configService: {
    COLLECTION_NAME: 'test_refine_collection',
    QDRANT_SEARCH_LIMIT_DEFAULT: 5,
    MAX_REFINEMENT_ITERATIONS: 2, // This will be used by searchWithRefinement if maxRefinements param is undefined
  },
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('../ollama'); // For generateEmbedding
// Provide a mock implementation for preprocessText
vi.mock('../../utils/text-utils', () => ({
  preprocessText: vi.fn((text: string) => text), // Default mock returns the input text
}));

// 3. THEN mock the SUT module ('../query-refinement').
// We will spy on individual functions from the original module later, so just import it.
// The vi.mock call here is primarily to ensure that when query-refinement.ts
// imports its own functions (which it doesn't directly, but if it did for some reason,
// or for consistency with other test files), it would get originals unless spied.
vi.mock('../query-refinement', async (importOriginal) => {
  return await importOriginal<typeof import('../query-refinement')>();
});

// 4. Import functions AFTER all vi.mock calls.
// These will be the original functions. We will use vi.spyOn to mock them for specific tests.
import {
  searchWithRefinement,
  refineQuery, // Original, will be spied on
  broadenQuery, // Original, will be spied on
  focusQueryBasedOnResults, // Original, will be spied on
  tweakQuery // Original, will be spied on
} from '../query-refinement';
// Import the SUT module again using import * as ... to access original implementations for direct testing
// and for attaching spies.
import * as actualQueryRefinementFunctionsOriginal from '../query-refinement';

// Import mocked dependencies
import { generateEmbedding } from '../ollama';
import { configService, logger } from '../config-service';
import { preprocessText } from '../../utils/text-utils'; // Import the mocked preprocessText
import { DetailedQdrantSearchResult } from '../types'; 

// Define a reusable mock Qdrant client
const mockQdrantClientInstance = { search: vi.fn() } as unknown as QdrantClient;


describe('Query Refinement Tests', () => {
  let refineQuerySpy: vi.SpyInstance;
  let broadenQuerySpy: vi.SpyInstance;
  let focusQueryBasedOnResultsSpy: vi.SpyInstance;
  let tweakQuerySpy: vi.SpyInstance;

  beforeEach(() => {
    vi.clearAllMocks();

    // Spy on the original functions from the actual module
    refineQuerySpy = vi.spyOn(actualQueryRefinementFunctionsOriginal, 'refineQuery').mockImplementation((_query, _results, relevance) => {
      if (relevance < 0.3) return 'mock_refined_broadened_for_search';
      if (relevance < 0.7) return 'mock_refined_focused_for_search';
      return 'mock_refined_tweaked_for_search';
    });
    broadenQuerySpy = vi.spyOn(actualQueryRefinementFunctionsOriginal, 'broadenQuery').mockReturnValue('spy_broadened_return_val');
    focusQueryBasedOnResultsSpy = vi.spyOn(actualQueryRefinementFunctionsOriginal, 'focusQueryBasedOnResults').mockReturnValue('spy_focused_return_val');
    tweakQuerySpy = vi.spyOn(actualQueryRefinementFunctionsOriginal, 'tweakQuery').mockReturnValue('spy_tweaked_return_val');

    vi.mocked(generateEmbedding).mockResolvedValue([0.1,0.2,0.3]);
    vi.mocked(mockQdrantClientInstance.search).mockClear();
    vi.mocked(preprocessText).mockClear().mockImplementation((text: string) => text); // Ensure it's reset and has a default behavior
  });

  afterEach(() => { vi.restoreAllMocks(); });

  describe('searchWithRefinement', () => {
    // searchWithRefinement (original) will call refineQuery (which is QR_MOCK_REFINE_QUERY_FN)

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
      expect(refineQuerySpy).not.toHaveBeenCalled();
    });

    it('should refine query up to maxRefinements if threshold not met, calling mocked refineQuery', async () => {
      vi.mocked(mockQdrantClientInstance.search)
        .mockResolvedValueOnce([{ id: 'r1', score: 0.2, payload: { content: 'low relevance' } }] as any)
        .mockResolvedValueOnce([{ id: 'r2', score: 0.5, payload: { content: 'medium relevance' } }] as any)
        .mockResolvedValueOnce([{ id: 'r3', score: 0.8, payload: { content: 'high relevance' } }] as any);

      // searchWithRefinement will use configService.MAX_REFINEMENT_ITERATIONS (mocked to 2)
      // if its maxRefinements parameter is undefined.
      const { results, relevanceScore, refinedQuery: actualRefinedQueryOutput } = await searchWithRefinement(
        mockQdrantClientInstance, 'original query', [], undefined, undefined, 0.75 
      );
      
      expect(mockQdrantClientInstance.search).toHaveBeenCalledTimes(3); // Initial + 2 refinements
      expect(results[0].id).toBe('r3');
      expect(relevanceScore).toBe(0.8);
      expect(actualRefinedQueryOutput).toBe('mock_refined_focused_for_search'); // From the spied refineQuery
      expect(logger.info).toHaveBeenCalledWith(expect.stringContaining('Completed search with 2 refinements'));
      expect(refineQuerySpy).toHaveBeenCalledTimes(2); // Assert on the spy
      expect(refineQuerySpy).toHaveBeenNthCalledWith(1, 'original query',
        [{ id: 'r1', score: 0.2, payload: { content: 'low relevance' } }], 0.2);
      expect(refineQuerySpy).toHaveBeenNthCalledWith(2, 'mock_refined_broadened_for_search', // Output of 1st spy call
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

        // Will use configService.MAX_REFINEMENT_ITERATIONS (mocked to 2)
        const { results, relevanceScore } = await searchWithRefinement( 
            mockQdrantClientInstance, 'query for no results', [], undefined, undefined, 0.7
        );
        expect(mockQdrantClientInstance.search).toHaveBeenCalledTimes(configService.MAX_REFINEMENT_ITERATIONS + 1); // 3 calls
        expect(results).toEqual([]);
        expect(relevanceScore).toBe(0);
        expect(logger.info).toHaveBeenCalledWith(expect.stringContaining(`Completed search with ${configService.MAX_REFINEMENT_ITERATIONS} refinements`));
        expect(refineQuerySpy).toHaveBeenCalledTimes(configService.MAX_REFINEMENT_ITERATIONS); // Assert on the spy
    });
  });

  describe('refineQuery (main dispatcher - testing original logic)', () => {
    // actualQueryRefinementFunctionsOriginal.refineQuery is the original function.
    // broadenQuerySpy, focusQueryBasedOnResultsSpy, tweakQuerySpy are spies on original functions.

    it('should call broadenQuery (mocked) and return its result for very low relevance (<0.3)', () => {
      const result = actualQueryRefinementFunctionsOriginal.refineQuery("original", [], 0.1);
      expect(broadenQuerySpy).toHaveBeenCalledWith("original"); // Assert on the spy
      expect(result).toBe('spy_broadened_return_val');
      expect(focusQueryBasedOnResultsSpy).not.toHaveBeenCalled(); // Assert on the spy
      expect(tweakQuerySpy).not.toHaveBeenCalled(); // Assert on the spy
    });

    it('should call focusQueryBasedOnResults (mocked) for mediocre relevance (0.3 <= relevance < 0.7)', () => {
      const mockResults = [{payload: {content: 'some'}} as DetailedQdrantSearchResult];
      const result = actualQueryRefinementFunctionsOriginal.refineQuery("original", mockResults, 0.5);
      expect(focusQueryBasedOnResultsSpy).toHaveBeenCalledWith("original", mockResults); // Assert on the spy
      expect(result).toBe('spy_focused_return_val');
      expect(broadenQuerySpy).not.toHaveBeenCalled(); // Assert on the spy
      expect(tweakQuerySpy).not.toHaveBeenCalled(); // Assert on the spy
    });

    it('should call tweakQuery (mocked) for decent relevance (>=0.7)', () => {
      const mockResults = [{payload: {content: 'some'}} as DetailedQdrantSearchResult];
      const result = actualQueryRefinementFunctionsOriginal.refineQuery("original", mockResults, 0.7);
      expect(tweakQuerySpy).toHaveBeenCalledWith("original", mockResults); // Assert on the spy
      expect(result).toBe('spy_tweaked_return_val');
      expect(broadenQuerySpy).not.toHaveBeenCalled(); // Assert on the spy
      expect(focusQueryBasedOnResultsSpy).not.toHaveBeenCalled(); // Assert on the spy
    });
  });
});
