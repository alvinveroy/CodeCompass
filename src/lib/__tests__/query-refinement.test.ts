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

// These will hold the mock function instances created by the factory
let QR_TEST_MOCK_REFINE_QUERY: vi.Mock;
let QR_TEST_MOCK_BROADEN_QUERY: vi.Mock;
let QR_TEST_MOCK_FOCUS_QUERY: vi.Mock;
let QR_TEST_MOCK_TWEAK_QUERY: vi.Mock;
// No need for QR_TEST_MOCK_EXTRACT_KEYWORDS if extractKeywords is tested via query-refinement.helpers.test.ts

vi.mock('../query-refinement', async (importOriginal) => {
  const originalModule = await importOriginal<typeof import('../query-refinement')>();
  // Create mocks INSIDE the factory
  const refineMock = vi.fn();
  const broadenMock = vi.fn();
  const focusMock = vi.fn();
  const tweakMock = vi.fn();
  // extractKeywords is also part of originalModule, keep it unless specifically mocked here

  // Assign factory-created mocks to module-scoped variables
  QR_TEST_MOCK_REFINE_QUERY = refineMock;
  QR_TEST_MOCK_BROADEN_QUERY = broadenMock;
  QR_TEST_MOCK_FOCUS_QUERY = focusMock;
  QR_TEST_MOCK_TWEAK_QUERY = tweakMock;
  
  return {
    ...originalModule, // Spread original module to keep non-mocked exports (like searchWithRefinement, extractKeywords)
    // Overwrite specific functions with mocks
    refineQuery: refineMock,
    broadenQuery: broadenMock,
    focusQueryBasedOnResults: focusMock,
    tweakQuery: tweakMock,
    // extractKeywords will remain the original implementation from originalModule
  };
});

// Import SUT (searchWithRefinement) and functions to be tested directly (originals via namespace)
import { searchWithRefinement } from '../query-refinement';
import * as actualQueryRefinement from '../query-refinement'; 

// Import mocked dependencies
import { generateEmbedding } from '../ollama';
import { configService, logger } from '../config-service';
import { DetailedQdrantSearchResult } from '../types'; // Ensure this is imported

// Define a reusable mock Qdrant client
const mockQdrantClientInstance = { search: vi.fn() } as unknown as QdrantClient;


describe('Query Refinement Tests', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    
    // Reset and setup default behaviors for the factory-created mocks
    if(QR_TEST_MOCK_REFINE_QUERY) QR_TEST_MOCK_REFINE_QUERY.mockReset().mockImplementation(
      (_currentQuery, _results, relevance) => { // Matched original spy logic
        if (relevance < 0.3) return 'mock_refined_broadened_for_search';
        if (relevance < 0.7) return 'mock_refined_focused_for_search';
        return 'mock_refined_tweaked_for_search';
      }
    );
    if(QR_TEST_MOCK_BROADEN_QUERY) QR_TEST_MOCK_BROADEN_QUERY.mockReset().mockReturnValue('spy_broadened_return_val');
    if(QR_TEST_MOCK_FOCUS_QUERY) QR_TEST_MOCK_FOCUS_QUERY.mockReset().mockReturnValue('spy_focused_return_val');
    if(QR_TEST_MOCK_TWEAK_QUERY) QR_TEST_MOCK_TWEAK_QUERY.mockReset().mockReturnValue('spy_tweaked_return_val');
    
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
      if (!QR_TEST_MOCK_REFINE_QUERY) throw new Error("Refine query mock not init for no-refinement test");
      expect(QR_TEST_MOCK_REFINE_QUERY).not.toHaveBeenCalled(); 
    });

    it('should refine query up to maxRefinements if threshold not met, calling mocked refineQuery', async () => {
      if (!QR_TEST_MOCK_REFINE_QUERY) throw new Error("Refine query mock not init for searchWithRefinement test");
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
      // actualRefinedQueryOutput is the result of the last call to QR_TEST_MOCK_REFINE_QUERY
      expect(actualRefinedQueryOutput).toBe('mock_refined_focused_for_search'); 
      expect(logger.info).toHaveBeenCalledWith(expect.stringContaining('Completed search with 2 refinements'));
      expect(QR_TEST_MOCK_REFINE_QUERY).toHaveBeenCalledTimes(2); 
      expect(QR_TEST_MOCK_REFINE_QUERY).toHaveBeenNthCalledWith(1, 'original query', 
        [{ id: 'r1', score: 0.2, payload: { content: 'low relevance' } }], 0.2);
      expect(QR_TEST_MOCK_REFINE_QUERY).toHaveBeenNthCalledWith(2, 'mock_refined_broadened_for_search', 
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
        if (!QR_TEST_MOCK_REFINE_QUERY) throw new Error("Refine query mock not init for empty results test");
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
        expect(QR_TEST_MOCK_REFINE_QUERY).toHaveBeenCalledTimes(configService.MAX_REFINEMENT_ITERATIONS); 
    });
  });
  
  describe('refineQuery (main dispatcher - testing original logic)', () => {
    // Testing actualQueryRefinement.refineQuery (original)
    // Its internal calls to broadenQuery, focusQueryBasedOnResults, tweakQuery are mocked by QR_TEST_MOCK_...
        
    it('should call broadenQuery (mocked) and return its result for very low relevance (<0.3)', () => {
      if (!QR_TEST_MOCK_BROADEN_QUERY || !QR_TEST_MOCK_FOCUS_QUERY || !QR_TEST_MOCK_TWEAK_QUERY) throw new Error("Helper mocks not init for refineQuery test");
      const result = actualQueryRefinement.refineQuery("original", [], 0.1);
      expect(QR_TEST_MOCK_BROADEN_QUERY).toHaveBeenCalledWith("original"); 
      expect(result).toBe('spy_broadened_return_val');
      expect(QR_TEST_MOCK_FOCUS_QUERY).not.toHaveBeenCalled(); 
      expect(QR_TEST_MOCK_TWEAK_QUERY).not.toHaveBeenCalled(); 
    });
    
    it('should call focusQueryBasedOnResults (mocked) for mediocre relevance (0.3 <= relevance < 0.7)', () => {
      if (!QR_TEST_MOCK_BROADEN_QUERY || !QR_TEST_MOCK_FOCUS_QUERY || !QR_TEST_MOCK_TWEAK_QUERY) throw new Error("Helper mocks not init for refineQuery test");
      const mockResults = [{payload: {content: 'some'}} as DetailedQdrantSearchResult];
      const result = actualQueryRefinement.refineQuery("original", mockResults, 0.5);
      expect(QR_TEST_MOCK_FOCUS_QUERY).toHaveBeenCalledWith("original", mockResults); 
      expect(result).toBe('spy_focused_return_val');
      expect(QR_TEST_MOCK_BROADEN_QUERY).not.toHaveBeenCalled(); 
      expect(QR_TEST_MOCK_TWEAK_QUERY).not.toHaveBeenCalled(); 
    });

    it('should call tweakQuery (mocked) for decent relevance (>=0.7)', () => {
      if (!QR_TEST_MOCK_BROADEN_QUERY || !QR_TEST_MOCK_FOCUS_QUERY || !QR_TEST_MOCK_TWEAK_QUERY) throw new Error("Helper mocks not init for refineQuery test");
      const mockResults = [{payload: {content: 'some'}} as DetailedQdrantSearchResult];
      const result = actualQueryRefinement.refineQuery("original", mockResults, 0.7);
      expect(QR_TEST_MOCK_TWEAK_QUERY).toHaveBeenCalledWith("original", mockResults); 
      expect(result).toBe('spy_tweaked_return_val');
      expect(QR_TEST_MOCK_BROADEN_QUERY).not.toHaveBeenCalled(); 
      expect(QR_TEST_MOCK_FOCUS_QUERY).not.toHaveBeenCalled(); 
    });
  });
});
