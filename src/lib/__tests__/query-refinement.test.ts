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

// Import the original module to spy on its methods.
// This alias is used to access original implementations when needed.
import * as ActualQueryRefinementModuleForOriginalTests from '../query-refinement';

// DECLARE spies first.
let refineQuerySpyForSearchWithRefinement: ReturnType<typeof vi.spyOn>;
let broadenQuerySpyForRefineQuery: ReturnType<typeof vi.spyOn>;
let focusQueryBasedOnResultsSpyForRefineQuery: ReturnType<typeof vi.spyOn>;
let tweakQuerySpyForRefineQuery: ReturnType<typeof vi.spyOn>;


vi.mock('../query-refinement', async (importOriginal) => {
  const originalModule = await importOriginal<typeof import('../query-refinement')>();
  // INITIALIZE spies here, on the original module.
  refineQuerySpyForSearchWithRefinement = vi.spyOn(originalModule, 'refineQuery');
  broadenQuerySpyForRefineQuery = vi.spyOn(originalModule, 'broadenQuery');
  focusQueryBasedOnResultsSpyForRefineQuery = vi.spyOn(originalModule, 'focusQueryBasedOnResults');
  tweakQuerySpyForRefineQuery = vi.spyOn(originalModule, 'tweakQuery');

  return {
    ...originalModule, // By default, use original implementations
    // For tests of searchWithRefinement, its call to refineQuery should be this spy.
    refineQuery: refineQuerySpyForSearchWithRefinement,
    // For tests of refineQuery (original), its calls to helpers should be these spies.
    broadenQuery: broadenQuerySpyForRefineQuery,
    focusQueryBasedOnResults: focusQueryBasedOnResultsSpyForRefineQuery,
    tweakQuery: tweakQuerySpyForRefineQuery,
    // searchWithRefinement and extractKeywords themselves should remain original for their tests.
  };
});

// 4. Import functions AFTER all vi.mock calls.
// searchWithRefinement will be original. refineQuery, broadenQuery etc. will be the spies from the factory.
import {
  searchWithRefinement, // Original
  refineQuery,          // refineQuerySpyForSearchWithRefinement
  broadenQuery,         // broadenQuerySpyForRefineQuery
  focusQueryBasedOnResults, // focusQueryBasedOnResultsSpyForRefineQuery
  tweakQuery,           // tweakQuerySpyForRefineQuery
  extractKeywords       // Original
} from '../query-refinement';

// Import mocked dependencies
import { generateEmbedding } from '../ollama';
import { configService, logger } from '../config-service';
import { preprocessText } from '../../utils/text-utils'; // Import the mocked preprocessText
import { DetailedQdrantSearchResult } from '../types'; 

// Define a reusable mock Qdrant client
const mockQdrantClientInstance = { search: vi.fn() } as unknown as QdrantClient;


describe('Query Refinement Tests', () => {
  // Spies are defined above and injected via the mock factory.

  beforeEach(() => {
    vi.clearAllMocks(); 

    // Reset spies and set default implementations for each test
    refineQuerySpyForSearchWithRefinement.mockReset().mockImplementation((_query, _results, relevance) => {
      if (relevance < 0.3) return 'mock_refined_broadened_for_search';
      if (relevance < 0.7) return 'mock_refined_focused_for_search';
      return 'mock_refined_tweaked_for_search';
    });
    broadenQuerySpyForRefineQuery.mockReset().mockReturnValue('spy_broadened_return_val');
    focusQueryBasedOnResultsSpyForRefineQuery.mockReset().mockReturnValue('spy_focused_return_val');
    tweakQuerySpyForRefineQuery.mockReset().mockReturnValue('spy_tweaked_return_val');

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
      expect(refineQuerySpyForSearchWithRefinement).not.toHaveBeenCalled();
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
      expect(refineQuerySpyForSearchWithRefinement).toHaveBeenCalledTimes(2); // Assert on the spy
      expect(refineQuerySpyForSearchWithRefinement).toHaveBeenNthCalledWith(1, 'original query',
        [{ id: 'r1', score: 0.2, payload: { content: 'low relevance' } }], 0.2);
      expect(refineQuerySpyForSearchWithRefinement).toHaveBeenNthCalledWith(2, 'mock_refined_broadened_for_search', // Output of 1st spy call
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
        expect(refineQuerySpyForSearchWithRefinement).toHaveBeenCalledTimes(configService.MAX_REFINEMENT_ITERATIONS); // Assert on the spy
    });
  });

  describe('refineQuery (main dispatcher - testing original logic)', () => {
    // Here we test the original refineQuery function. Its internal calls to broadenQuery etc.
    // should hit the spies injected by the vi.mock factory (broadenQuerySpyForRefineQuery etc.)

    it('should call broadenQuery (mocked) and return its result for very low relevance (<0.3)', () => {
      const result = ActualQueryRefinementModuleForOriginalTests.refineQuery("original", [], 0.1);
      expect(broadenQuerySpyForRefineQuery).toHaveBeenCalledWith("original");
      expect(result).toBe('spy_broadened_return_val');
      expect(focusQueryBasedOnResultsSpyForRefineQuery).not.toHaveBeenCalled();
      expect(tweakQuerySpyForRefineQuery).not.toHaveBeenCalled();
    });

    it('should call focusQueryBasedOnResults (mocked) for mediocre relevance (0.3 <= relevance < 0.7)', () => {
      const mockResults = [{payload: {content: 'some'}} as DetailedQdrantSearchResult];
      const result = ActualQueryRefinementModuleForOriginalTests.refineQuery("original", mockResults, 0.5);
      expect(focusQueryBasedOnResultsSpyForRefineQuery).toHaveBeenCalledWith("original", mockResults);
      expect(result).toBe('spy_focused_return_val');
      expect(broadenQuerySpyForRefineQuery).not.toHaveBeenCalled();
      expect(tweakQuerySpyForRefineQuery).not.toHaveBeenCalled();
    });

    it('should call tweakQuery (mocked) for decent relevance (>=0.7)', () => {
      const mockResults = [{payload: {content: 'some'}} as DetailedQdrantSearchResult];
      const result = ActualQueryRefinementModuleForOriginalTests.refineQuery("original", mockResults, 0.7);
      expect(tweakQuerySpyForRefineQuery).toHaveBeenCalledWith("original", mockResults);
      expect(result).toBe('spy_tweaked_return_val');
      expect(broadenQuerySpyForRefineQuery).not.toHaveBeenCalled();
      expect(focusQueryBasedOnResultsSpyForRefineQuery).not.toHaveBeenCalled();
    });
  });
});
