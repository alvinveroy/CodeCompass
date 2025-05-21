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

// Mock dependencies of the functions being tested in THIS file
vi.mock('../ollama'); // For generateEmbedding used by searchWithRefinement

// Import mocked versions of dependencies
import { generateEmbedding } from '../ollama';
// import { preprocessText } from '../../utils/text-utils'; // Not needed here
import { configService, logger } from '../config-service';
import { DetailedQdrantSearchResult } from '../types';
// Import functions from query-refinement; some will be original, some will be mocks from the factory
// These will be dynamically imported within describe blocks after vi.doMock

// Define a reusable mock Qdrant client
const mockQdrantClientInstance = {
  search: vi.fn(),
} as unknown as QdrantClient;

describe('Query Refinement Tests', () => {
  // General beforeEach for clearing mocks, if needed by both describe blocks
  beforeEach(() => {
    vi.clearAllMocks();
    // Default mock for generateEmbedding (used by searchWithRefinement)
    vi.mocked(generateEmbedding).mockResolvedValue([0.1, 0.2, 0.3]);
  });

  afterEach(() => {
    vi.restoreAllMocks(); // Might be redundant if vi.doUnmock is used, but safe.
  });

  // --- Test searchWithRefinement ---
  describe('searchWithRefinement', () => {
    const mockRefineQueryInternal = vi.fn();

    beforeAll(async () => {
      vi.doMock('../query-refinement', async (importOriginal) => {
        const originalModule = await importOriginal<typeof import('../query-refinement')>();
        return {
          ...originalModule,
          refineQuery: mockRefineQueryInternal,
        };
      });
    });

    let searchWithRefinementInstance: typeof import('../query-refinement').searchWithRefinement;

    beforeEach(async () => { // Make beforeEach async to await import
      // Import searchWithRefinement AFTER vi.doMock has been set up in beforeAll
      // And reset mocks specific to this describe block
      const mod = await import('../query-refinement');
      searchWithRefinementInstance = mod.searchWithRefinement;
      
      mockRefineQueryInternal.mockReset(); // Reset the mock before each test in this block
      mockRefineQueryInternal.mockImplementation((currentQuery, _results, relevance) => {
        if (relevance < 0.3) return 'mock_refined_broadened_query_for_search';
        if (relevance < 0.7) return 'mock_refined_focused_query_for_search';
        return 'mock_refined_tweaked_query_for_search';
      });
      vi.mocked(mockQdrantClientInstance.search).mockClear(); // Clear Qdrant search mock
    });
    
    afterAll(() => { // Changed from afterEach to afterAll for vi.doUnmock
      vi.doUnmock('../query-refinement'); // Clean up the scoped mock
    });

    it('should return results without refinement if relevance threshold is met initially', async () => {
      const mockResults = [{ id: '1', score: 0.8, payload: { content: 'highly relevant' } }];
      vi.mocked(mockQdrantClientInstance.search).mockResolvedValue(mockResults as any);

      const { results, refinedQuery, relevanceScore } = await searchWithRefinementInstance(
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
      expect(mockRefineQueryInternal).not.toHaveBeenCalled();
    });

    it('should refine query up to maxRefinements if threshold not met, calling mocked refineQuery', async () => {
      vi.mocked(mockQdrantClientInstance.search)
        .mockResolvedValueOnce([{ id: 'r1', score: 0.2, payload: { content: 'low relevance' } }] as any)
        .mockResolvedValueOnce([{ id: 'r2', score: 0.5, payload: { content: 'medium relevance' } }] as any)
        .mockResolvedValueOnce([{ id: 'r3', score: 0.8, payload: { content: 'high relevance' } }] as any);

      const { results, relevanceScore, refinedQuery } = await searchWithRefinementInstance(
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
      expect(refinedQuery).toBe('mock_refined_focused_query_for_search'); 
      expect(logger.info).toHaveBeenCalledWith(expect.stringContaining('Completed search with 2 refinements'));
      expect(mockRefineQueryInternal).toHaveBeenCalledTimes(2);
      expect(mockRefineQueryInternal).toHaveBeenNthCalledWith(1, 'original query', 
        [{ id: 'r1', score: 0.2, payload: { content: 'low relevance' } }], 0.2);
      expect(mockRefineQueryInternal).toHaveBeenNthCalledWith(2, 'mock_refined_broadened_query_for_search', 
        [{ id: 'r2', score: 0.5, payload: { content: 'medium relevance' } }], 0.5);
    });

    it('should use customLimit if provided', async () => {
      vi.mocked(mockQdrantClientInstance.search).mockResolvedValue([{ id: '1', score: 0.9, payload: {} }] as any);
      await searchWithRefinementInstance(mockQdrantClientInstance, 'query', [], 15);
      expect(mockQdrantClientInstance.search).toHaveBeenCalledWith(
        configService.COLLECTION_NAME,
        expect.objectContaining({ limit: 15 })
      );
    });
    
    it('should apply file filter if files array is provided', async () => {
        vi.mocked(mockQdrantClientInstance.search).mockResolvedValue([{ id: '1', score: 0.9, payload: {} }] as any);
        const filesToFilter = ['src/file1.ts', 'src/file2.ts'];
        await searchWithRefinementInstance(mockQdrantClientInstance, 'query', filesToFilter);
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

        const { results, relevanceScore } = await searchWithRefinementInstance(
            mockQdrantClientInstance, 'query for no results', [], undefined, undefined, 0.7
        );
        expect(mockQdrantClientInstance.search).toHaveBeenCalledTimes(3); 
        expect(results).toEqual([]);
        expect(relevanceScore).toBe(0);
        expect(logger.info).toHaveBeenCalledWith(expect.stringContaining('Completed search with 2 refinements'));
        expect(mockRefineQueryInternal).toHaveBeenCalledTimes(2); 
    });
  });
  
  describe('refineQuery (main dispatcher)', () => {
    const mockBroadenInternal = vi.fn();
    const mockFocusInternal = vi.fn();
    const mockTweakInternal = vi.fn();

    beforeAll(async () => {
      vi.doMock('../query-refinement', async (importOriginal) => {
        const originalModule = await importOriginal<typeof import('../query-refinement')>();
        return {
          ...originalModule,
          broadenQuery: mockBroadenInternal,
          focusQueryBasedOnResults: mockFocusInternal,
          tweakQuery: mockTweakInternal,
        };
      });
    });
    
    let actualRefineQueryInstance: typeof import('../query-refinement').refineQuery;

    beforeEach(async () => { // Make beforeEach async
      const mod = await import('../query-refinement'); 
      actualRefineQueryInstance = mod.refineQuery; 

      mockBroadenInternal.mockReset().mockReturnValue('spy_broadened_return_val');
      mockFocusInternal.mockReset().mockReturnValue('spy_focused_return_val');
      mockTweakInternal.mockReset().mockReturnValue('spy_tweaked_return_val');
    });
    
    afterAll(() => { // Changed from afterEach to afterAll
      vi.doUnmock('../query-refinement');
    });
        
    it('should call broadenQuery and return its result for very low relevance (<0.3)', () => {
      const result = actualRefineQueryInstance("original", [], 0.1);
      expect(mockBroadenInternal).toHaveBeenCalledWith("original");
      expect(result).toBe('spy_broadened_return_val');
      expect(mockFocusInternal).not.toHaveBeenCalled();
      expect(mockTweakInternal).not.toHaveBeenCalled();
    });
    
    it('should call focusQueryBasedOnResults and return its result for mediocre relevance (0.3 <= relevance < 0.7)', () => {
      const mockResults = [{payload: {content: 'some'}} as DetailedQdrantSearchResult];
      const result = actualRefineQueryInstance("original", mockResults, 0.5);
      expect(mockFocusInternal).toHaveBeenCalledWith("original", mockResults);
      expect(result).toBe('spy_focused_return_val');
      expect(mockBroadenInternal).not.toHaveBeenCalled();
      expect(mockTweakInternal).not.toHaveBeenCalled();
    });

    it('should call tweakQuery and return its result for decent relevance (>=0.7)', () => {
      const mockResults = [{payload: {content: 'some'}} as DetailedQdrantSearchResult];
      const result = actualRefineQueryInstance("original", mockResults, 0.7);
      expect(mockTweakInternal).toHaveBeenCalledWith("original", mockResults);
      expect(result).toBe('spy_tweaked_return_val');
      expect(mockBroadenInternal).not.toHaveBeenCalled();
      expect(mockFocusInternal).not.toHaveBeenCalled();
    });
  });
});
