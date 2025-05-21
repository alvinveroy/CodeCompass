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

// Import mocked versions of dependencies
import { generateEmbedding } from '../ollama';
// import { preprocessText } from '../../utils/text-utils'; // Not needed here
import { configService, logger } from '../config-service';
import { DetailedQdrantSearchResult } from '../types';
import * as queryRefinementModule from '../query-refinement';

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
    vi.spyOn(queryRefinementModule, 'broadenQuery')
      .mockReturnValue('spy_broadened_return_val');
    vi.spyOn(queryRefinementModule, 'focusQueryBasedOnResults')
      .mockReturnValue('spy_focused_return_val');
    vi.spyOn(queryRefinementModule, 'tweakQuery')
      .mockReturnValue('spy_tweaked_return_val');
  });
  afterEach(() => {
    vi.restoreAllMocks(); 
  });

  describe('searchWithRefinement', () => {
    // searchWithRefinement internally calls the original refineQuery, 
    // which in turn calls the spied broadenQuery, focusQueryBasedOnResults, tweakQuery.
    it('should return results without refinement if relevance threshold is met initially', async () => {
      const mockResults = [{ id: '1', score: 0.8, payload: { content: 'highly relevant' } }];
      vi.mocked(mockQdrantClientInstance.search).mockResolvedValue(mockResults as any);

      const { results, refinedQuery, relevanceScore } = await queryRefinementModule.searchWithRefinement(
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
      // Ensure no refinement helper spies were called
      expect(queryRefinementModule.broadenQuery).not.toHaveBeenCalled();
      expect(queryRefinementModule.focusQueryBasedOnResults).not.toHaveBeenCalled();
      expect(queryRefinementModule.tweakQuery).not.toHaveBeenCalled();
    });

    it('should refine query up to maxRefinements if threshold not met, calling appropriate refinement helpers', async () => {
      vi.mocked(mockQdrantClientInstance.search)
        .mockResolvedValueOnce([{ id: 'r1', score: 0.2, payload: { content: 'low relevance' } }] as any)  // Initial search, low relevance
        .mockResolvedValueOnce([{ id: 'r2', score: 0.5, payload: { content: 'medium relevance' } }] as any) // After 1st refinement (broaden)
        .mockResolvedValueOnce([{ id: 'r3', score: 0.8, payload: { content: 'high relevance' } }] as any); // After 2nd refinement (focus)

      // refineQuery will be called by searchWithRefinement.
      // 1. Query: "original query", Results: r1 (score 0.2) -> broadenQuery spy should be called
      // 2. Query: "spy_broadened_return_val", Results: r2 (score 0.5) -> focusQueryBasedOnResults spy should be called
      // 3. Query: "spy_focused_return_val", Results: r3 (score 0.8) -> threshold met, loop breaks.

      const { results, relevanceScore, refinedQuery } = await queryRefinementModule.searchWithRefinement(
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
      expect(refinedQuery).toBe('spy_focused_return_val'); // The query that led to the best results
      expect(logger.info).toHaveBeenCalledWith(expect.stringContaining('Completed search with 2 refinements'));

      // Check that spies were called as expected by refineQuery
      expect(queryRefinementModule.broadenQuery).toHaveBeenCalledTimes(1);
      expect(queryRefinementModule.broadenQuery).toHaveBeenCalledWith('original query');
      
      expect(queryRefinementModule.focusQueryBasedOnResults).toHaveBeenCalledTimes(1);
      // The input to focus will be the output of broadenQuery
      expect(queryRefinementModule.focusQueryBasedOnResults).toHaveBeenCalledWith('spy_broadened_return_val', [{ id: 'r2', score: 0.5, payload: { content: 'medium relevance' } }]);
      
      expect(queryRefinementModule.tweakQuery).not.toHaveBeenCalled(); // Because relevance 0.8 >= 0.7 threshold
    });

    it('should use customLimit if provided', async () => {
      vi.mocked(mockQdrantClientInstance.search).mockResolvedValue([{ id: '1', score: 0.9, payload: {} }] as any);
      await queryRefinementModule.searchWithRefinement(mockQdrantClientInstance, 'query', [], 15);
      expect(mockQdrantClientInstance.search).toHaveBeenCalledWith(
        configService.COLLECTION_NAME,
        expect.objectContaining({ limit: 15 })
      );
    });
    
    it('should apply file filter if files array is provided', async () => {
        vi.mocked(mockQdrantClientInstance.search).mockResolvedValue([{ id: '1', score: 0.9, payload: {} }] as any);
        const filesToFilter = ['src/file1.ts', 'src/file2.ts'];
        await queryRefinementModule.searchWithRefinement(mockQdrantClientInstance, 'query', filesToFilter);
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

        const { results, relevanceScore } = await queryRefinementModule.searchWithRefinement(
            mockQdrantClientInstance, 'query for no results', [], undefined, undefined, 0.7
        );
        expect(mockQdrantClientInstance.search).toHaveBeenCalledTimes(3); 
        expect(results).toEqual([]);
        expect(relevanceScore).toBe(0);
        expect(logger.info).toHaveBeenCalledWith(expect.stringContaining('Completed search with 2 refinements'));
        // broadenQuery should be called each time refineQuery is invoked with no/low results
        expect(queryRefinementModule.broadenQuery).toHaveBeenCalledTimes(2); 
    });
  });
  
  describe('refineQuery (main dispatcher)', () => {
    // These tests directly invoke refineQuery (the original SUT).
    // refineQuery will then call the spied versions of broadenQuery, focusQueryBasedOnResults, and tweakQuery.
    // Spies are reset in the top-level beforeEach.
        
    it('should call broadenQuery and return its result for very low relevance (<0.3)', () => {
      const result = queryRefinementModule.refineQuery("original", [], 0.1); 
      expect(queryRefinementModule.broadenQuery).toHaveBeenCalledWith("original"); 
      expect(result).toBe('spy_broadened_return_val'); 
      expect(queryRefinementModule.focusQueryBasedOnResults).not.toHaveBeenCalled();
      expect(queryRefinementModule.tweakQuery).not.toHaveBeenCalled();
    });
    
    it('should call focusQueryBasedOnResults and return its result for mediocre relevance (0.3 <= relevance < 0.7)', () => {
      const mockResults = [{payload: {content: 'some'}} as DetailedQdrantSearchResult];
      const result = queryRefinementModule.refineQuery("original", mockResults, 0.5); 
      expect(queryRefinementModule.focusQueryBasedOnResults).toHaveBeenCalledWith("original", mockResults); 
      expect(result).toBe('spy_focused_return_val'); 
      expect(queryRefinementModule.broadenQuery).not.toHaveBeenCalled();
      expect(queryRefinementModule.tweakQuery).not.toHaveBeenCalled();
    });

    it('should call tweakQuery and return its result for decent relevance (>=0.7)', () => {
      const mockResults = [{payload: {content: 'some'}} as DetailedQdrantSearchResult];
      const result = queryRefinementModule.refineQuery("original", mockResults, 0.7); 
      expect(queryRefinementModule.tweakQuery).toHaveBeenCalledWith("original", mockResults); 
      expect(result).toBe('spy_tweaked_return_val'); 
      expect(queryRefinementModule.broadenQuery).not.toHaveBeenCalled();
      expect(queryRefinementModule.focusQueryBasedOnResults).not.toHaveBeenCalled();
    });
  });

});
