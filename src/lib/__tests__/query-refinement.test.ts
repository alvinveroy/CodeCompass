import { describe, it, expect, vi, beforeEach, afterEach, beforeAll, afterAll } from 'vitest';

// Define a holder for mocks that will be used by the factory
const queryRefinementInternalMocks = {
  refineQuery: vi.fn(),
  broadenQuery: vi.fn(),
  focusQueryBasedOnResults: vi.fn(),
  tweakQuery: vi.fn(),
};

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

vi.mock('../query-refinement', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../query-refinement')>();
  return {
    ...actual, // Export all actual functions by default
    // Override specific internal functions with mocks from our holder
    refineQuery: queryRefinementInternalMocks.refineQuery,
    broadenQuery: queryRefinementInternalMocks.broadenQuery,
    focusQueryBasedOnResults: queryRefinementInternalMocks.focusQueryBasedOnResults,
    tweakQuery: queryRefinementInternalMocks.tweakQuery,
  };
});

// Import SUT
import { searchWithRefinement } from '../query-refinement'; 
// Import mocked dependencies
import { generateEmbedding } from '../ollama';
import { configService, logger } from '../config-service';
import { preprocessText } from '../../utils/text-utils'; // Import the mocked preprocessText
import { DetailedQdrantSearchResult } from '../types'; 

// Define a reusable mock Qdrant client
const mockQdrantClientInstance = { search: vi.fn() } as unknown as QdrantClient;
// For testing original refineQuery, broadenQuery etc.
let ActualQueryRefinementModule: typeof import('../lib/query-refinement');

beforeAll(async () => {
  ActualQueryRefinementModule = await vi.importActual('../query-refinement'); // Corrected path
});

describe('Query Refinement Tests', () => {

  beforeEach(async () => {
    vi.clearAllMocks();

    vi.mocked(generateEmbedding).mockResolvedValue([0.1,0.2,0.3]);
    vi.mocked(mockQdrantClientInstance.search).mockClear();
    vi.mocked(preprocessText).mockClear().mockImplementation((text: string) => text); // Ensure it's reset and has a default behavior

    // Reset mocks from the holder
    queryRefinementInternalMocks.refineQuery.mockReset();
    queryRefinementInternalMocks.broadenQuery.mockReset();
    queryRefinementInternalMocks.focusQueryBasedOnResults.mockReset();
    queryRefinementInternalMocks.tweakQuery.mockReset();

    // Clear logger mocks (assuming logger is imported from config-service which is mocked)
    const { logger: queryRefinementLogger } = await vi.importActual<typeof import('../config-service')>('../config-service');
     if (queryRefinementLogger && typeof (queryRefinementLogger.info as vi.Mock).mockClear === 'function') {
      (Object.values(queryRefinementLogger) as vi.Mock[]).forEach(mockFn => mockFn.mockClear?.());
    }
  });

  afterEach(() => { 
    vi.restoreAllMocks(); 
  });

  describe('searchWithRefinement', () => {
    beforeEach(() => { 
        // Configure the refineQuery mock from our holder for these tests
        queryRefinementInternalMocks.refineQuery.mockImplementation((query, _results, relevance) => {
            if (relevance < 0.3) return `${query} broadened by mock`;
            if (relevance < 0.7) return `${query} focused by mock`;
            return `${query} tweaked by mock`;
        });
    });

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
      expect(queryRefinementInternalMocks.refineQuery).not.toHaveBeenCalled();
    });

    it('should refine query up to maxRefinements if threshold not met, calling spied refineQuery', async () => {
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
      // Iteration 1: query='original query', relevance=0.2. queryRefinementInternalMocks.refineQuery returns 'original query broadened by mock'
      // Iteration 2: query='original query broadened by mock', relevance=0.5. queryRefinementInternalMocks.refineQuery returns 'original query broadened by mock focused by mock'
      // Iteration 3: query='original query broadened by mock focused by mock', relevance=0.8. Loop breaks.
      // The refinedQuery returned is the one that led to the successful search.
      expect(actualRefinedQueryOutput).toBe('original query broadened by mock focused by mock'); 
      expect(logger.info).toHaveBeenCalledWith(expect.stringContaining('Completed search with 2 refinements'));
      expect(queryRefinementInternalMocks.refineQuery).toHaveBeenCalledTimes(2); 
      expect(queryRefinementInternalMocks.refineQuery).toHaveBeenNthCalledWith(1, 'original query',
        [{ id: 'r1', score: 0.2, payload: { content: 'low relevance' } }], 0.2);
      expect(queryRefinementInternalMocks.refineQuery).toHaveBeenNthCalledWith(2, 'original query broadened by mock', 
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
        expect(queryRefinementInternalMocks.refineQuery).toHaveBeenCalledTimes(configService.MAX_REFINEMENT_ITERATIONS); 
    });
  });

  describe('refineQuery (main dispatcher - testing original logic)', () => {
    // In this block, we are testing the *original* refineQuery function,
    // so we call it via ActualQueryRefinementModule.refineQuery.
    // Its internal calls will hit the mocks from queryRefinementInternalMocks.

    beforeEach(() => { 
        queryRefinementInternalMocks.broadenQuery.mockReturnValue('mock_broadened_return_val');
        queryRefinementInternalMocks.focusQueryBasedOnResults.mockReturnValue('mock_focused_return_val');
        queryRefinementInternalMocks.tweakQuery.mockReturnValue('mock_tweaked_return_val');
    });

    afterEach(() => { 
        // Mocks are reset in the main beforeEach
    });

    it('should call broadenQuery (mocked) and return its result for very low relevance (<0.3)', async () => {
      const result = ActualQueryRefinementModule.refineQuery("original", [], 0.1); // Calling original refineQuery
      expect(queryRefinementInternalMocks.broadenQuery).toHaveBeenCalledWith("original"); 
      expect(result).toBe('mock_broadened_return_val');
      expect(queryRefinementInternalMocks.focusQueryBasedOnResults).not.toHaveBeenCalled();
      expect(queryRefinementInternalMocks.tweakQuery).not.toHaveBeenCalled();
    });

    it('should call focusQueryBasedOnResults (mocked) for mediocre relevance (0.3 <= relevance < 0.7)', async () => {
      const mockResults = [{payload: {content: 'some'}} as DetailedQdrantSearchResult];
      const result = ActualQueryRefinementModule.refineQuery("original", mockResults, 0.5);
      expect(queryRefinementInternalMocks.focusQueryBasedOnResults).toHaveBeenCalledWith("original", mockResults);
      expect(result).toBe('mock_focused_return_val');
      expect(queryRefinementInternalMocks.broadenQuery).not.toHaveBeenCalled();
      expect(queryRefinementInternalMocks.tweakQuery).not.toHaveBeenCalled();
    });

    it('should call tweakQuery (mocked) for decent relevance (>=0.7)', async () => {
      const mockResults = [{payload: {content: 'some'}} as DetailedQdrantSearchResult];
      const result = ActualQueryRefinementModule.refineQuery("original", mockResults, 0.7);
      expect(queryRefinementInternalMocks.tweakQuery).toHaveBeenCalledWith("original", mockResults);
      expect(result).toBe('mock_tweaked_return_val');
      expect(queryRefinementInternalMocks.broadenQuery).not.toHaveBeenCalled();
      expect(queryRefinementInternalMocks.focusQueryBasedOnResults).not.toHaveBeenCalled();
    });
  });
});
