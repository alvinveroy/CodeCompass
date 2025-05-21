import { describe, it, expect, vi, beforeEach, afterEach, beforeAll, afterAll, type Mock } from 'vitest';
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

// SUT functions will be called via ActualQueryRefinementModule

// Import mocked dependencies
import { generateEmbedding } from '../ollama';
import { configService, logger } from '../config-service';
import { preprocessText } from '../../utils/text-utils'; // Import the mocked preprocessText
import { DetailedQdrantSearchResult } from '../types'; 

// Define a reusable mock Qdrant client
const mockQdrantClientInstance = { search: vi.fn() } as unknown as QdrantClient;

// Define spies outside describe blocks if they are used across multiple describes,
// or inside if specific to one.
let refineQuerySpy: Mock;
let broadenQuerySpy: Mock;
let focusQueryBasedOnResultsSpy: Mock;
let tweakQuerySpy: Mock;

describe('Query Refinement Tests', () => {
  let ActualQueryRefinementModule: typeof import('../query-refinement');
  let searchWithRefinementSUT: typeof ActualQueryRefinementModule.searchWithRefinement;
  let refineQuerySUT: typeof ActualQueryRefinementModule.refineQuery;

  beforeAll(async () => {
    // Import actual implementations once
    ActualQueryRefinementModule = await vi.importActual('../query-refinement');
  });

  beforeEach(async () => {
    vi.clearAllMocks();
    vi.mocked(generateEmbedding).mockResolvedValue([0.1,0.2,0.3]);
    vi.mocked(mockQdrantClientInstance.search).mockClear();
    vi.mocked(preprocessText).mockClear().mockImplementation((text: string) => text);
    
    // Reset logger mocks
    const { logger: queryRefinementLogger } = await vi.importActual<typeof import('../config-service')>('../config-service');
    if (queryRefinementLogger && typeof (queryRefinementLogger.info as Mock).mockClear === 'function') {
      (Object.values(queryRefinementLogger) as Mock[]).forEach(mockFn => mockFn.mockClear?.());
    }

    // Setup spies on the *actual* module's functions. These will be called by SUT.
    // We will then use vi.doMock to replace these with our spies for specific tests.
    refineQuerySpy = vi.spyOn(ActualQueryRefinementModule, 'refineQuery');
    broadenQuerySpy = vi.spyOn(ActualQueryRefinementModule, 'broadenQuery');
    focusQueryBasedOnResultsSpy = vi.spyOn(ActualQueryRefinementModule, 'focusQueryBasedOnResults');
    tweakQuerySpy = vi.spyOn(ActualQueryRefinementModule, 'tweakQuery');

    // Default mock implementations for spies (can be overridden in tests)
    refineQuerySpy.mockImplementation((query, _results, relevance) => {
        if (relevance < 0.3) return `${query} broadened by actual spy`;
        if (relevance < 0.7) return `${query} focused by actual spy`;
        return `${query} tweaked by actual spy`;
    });
    broadenQuerySpy.mockReturnValue('mock_broadened_by_actual_spy');
    focusQueryBasedOnResultsSpy.mockReturnValue('mock_focused_by_actual_spy');
    tweakQuerySpy.mockReturnValue('mock_tweaked_by_actual_spy');

    // For SUT import, we need to ensure it gets the potentially mocked module
    // This dynamic import will pick up mocks set by vi.doMock if active
    const SUTModule = await import('../query-refinement');
    searchWithRefinementSUT = SUTModule.searchWithRefinement;
    refineQuerySUT = SUTModule.refineQuery; // This will be the spied/mocked version if vi.doMock is used
  });

  afterEach(() => { 
    vi.restoreAllMocks(); // Restores original implementations
    vi.doUnmock('../query-refinement'); // Important to unmock for other test files/suites
  });

  describe('searchWithRefinement', () => {
    // refineQuerySpy is already set up on ActualQueryRefinementModule.
    // searchWithRefinementSUT will call the spied ActualQueryRefinementModule.refineQuery
    
    it('should return results without refinement if relevance threshold is met initially', async () => {
      const mockResults = [{ id: '1', score: 0.8, payload: { content: 'highly relevant' } }];
      vi.mocked(mockQdrantClientInstance.search).mockResolvedValue(mockResults as any);
      // refineQuerySpy should not have been called
      const { results, refinedQuery: actualRefinedQuery, relevanceScore } = await searchWithRefinementSUT(
        mockQdrantClientInstance, 'initial query', [], undefined, undefined, 0.75
      );
      
      expect(mockQdrantClientInstance.search).toHaveBeenCalledTimes(1);
      expect(results).toEqual(mockResults);
      expect(actualRefinedQuery).toBe('initial query');
      expect(relevanceScore).toBe(0.8);
      expect(logger.info).toHaveBeenCalledWith(expect.stringContaining('Completed search with 0 refinements'));
      expect(refineQuerySpy).not.toHaveBeenCalled();
    });

    it('should refine query up to maxRefinements if threshold not met, calling spied refineQuery', async () => {
      vi.mocked(mockQdrantClientInstance.search)
        .mockResolvedValueOnce([{ id: 'r1', score: 0.2, payload: { content: 'low relevance' } }] as any)
        .mockResolvedValueOnce([{ id: 'r2', score: 0.5, payload: { content: 'medium relevance' } }] as any)
        .mockResolvedValueOnce([{ id: 'r3', score: 0.8, payload: { content: 'high relevance' } }] as any);

      // searchWithRefinement will use configService.MAX_REFINEMENT_ITERATIONS (mocked to 2)
      // if its maxRefinements parameter is undefined.
      const { results, relevanceScore, refinedQuery: actualRefinedQueryOutput } = await searchWithRefinementSUT(
        mockQdrantClientInstance, 'original query', [], undefined, undefined, 0.75 
      );
      
      expect(mockQdrantClientInstance.search).toHaveBeenCalledTimes(3); // Initial + 2 refinements
      expect(results[0].id).toBe('r3');
      expect(relevanceScore).toBe(0.8);
      // Iteration 1: query='original query', relevance=0.2. refineQuerySpy returns 'original query broadened by mock'
      // Iteration 2: query='original query broadened by mock', relevance=0.5. refineQuerySpy returns 'original query broadened by mock focused by mock'
      // Iteration 3: query='original query broadened by mock focused by mock', relevance=0.8. Loop breaks.
      // The refinedQuery returned is the one that led to the successful search.
      // refineQuerySpy is on ActualQueryRefinementModule.refineQuery.
      // The mockImplementation for refineQuerySpy will produce the "broadened by mock", etc. strings.
      expect(actualRefinedQueryOutput).toBe('original query broadened by actual spy focused by actual spy');
      expect(logger.info).toHaveBeenCalledWith(expect.stringContaining('Completed search with 2 refinements'));
      expect(refineQuerySpy).toHaveBeenCalledTimes(2); 
      expect(refineQuerySpy).toHaveBeenNthCalledWith(1, 'original query',
        [{ id: 'r1', score: 0.2, payload: { content: 'low relevance' } }], 0.2);
      expect(refineQuerySpy).toHaveBeenNthCalledWith(2, 'original query broadened by actual spy', 
        [{ id: 'r2', score: 0.5, payload: { content: 'medium relevance' } }], 0.5);
    });
    
    it('should use customLimit if provided', async () => {
      vi.mocked(mockQdrantClientInstance.search).mockResolvedValue([{ id: '1', score: 0.9, payload: {} }] as any);
      await searchWithRefinementSUT(mockQdrantClientInstance, 'query', [], 15); 
      expect(mockQdrantClientInstance.search).toHaveBeenCalledWith(
        configService.COLLECTION_NAME,
        expect.objectContaining({ limit: 15 })
      );
    });
    
    it('should apply file filter if files array is provided', async () => {
        vi.mocked(mockQdrantClientInstance.search).mockResolvedValue([{ id: '1', score: 0.9, payload: {} }] as any);
        const filesToFilter = ['src/file1.ts', 'src/file2.ts'];
        await searchWithRefinementSUT(mockQdrantClientInstance, 'query', filesToFilter); 
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

        const { results, relevanceScore } = await searchWithRefinementSUT( 
            mockQdrantClientInstance, 'query for no results', [], undefined, undefined, 0.7
        );
        expect(mockQdrantClientInstance.search).toHaveBeenCalledTimes(configService.MAX_REFINEMENT_ITERATIONS + 1); 
        expect(results).toEqual([]);
        expect(relevanceScore).toBe(0);
        expect(logger.info).toHaveBeenCalledWith(expect.stringContaining(`Completed search with ${configService.MAX_REFINEMENT_ITERATIONS} refinements`));
        expect(refineQuerySpy).toHaveBeenCalledTimes(configService.MAX_REFINEMENT_ITERATIONS);
    });
  });

  describe('refineQuery (main dispatcher - testing original logic)', () => {
    // Here, we test refineQuerySUT (which is ActualQueryRefinementModule.refineQuery due to import)
    // Its internal calls to broadenQuery, etc., will hit the spies we set up on ActualQueryRefinementModule.
    
    it('should call broadenQuery (mocked) and return its result for very low relevance (<0.3)', async () => {
      const result = refineQuerySUT("original", [], 0.1); 
      expect(broadenQuerySpy).toHaveBeenCalledWith("original"); 
      expect(result).toBe('mock_broadened_by_actual_spy');
      expect(focusQueryBasedOnResultsSpy).not.toHaveBeenCalled();
      expect(tweakQuerySpy).not.toHaveBeenCalled();
    });

    it('should call focusQueryBasedOnResults (mocked) for mediocre relevance (0.3 <= relevance < 0.7)', async () => {
      const mockResults = [{payload: {content: 'some'}} as DetailedQdrantSearchResult];
      const result = refineQuerySUT("original", mockResults, 0.5);
      expect(focusQueryBasedOnResultsSpy).toHaveBeenCalledWith("original", mockResults);
      expect(result).toBe('mock_focused_by_actual_spy');
      expect(broadenQuerySpy).not.toHaveBeenCalled();
      expect(tweakQuerySpy).not.toHaveBeenCalled();
    });

    it('should call tweakQuery (mocked) for decent relevance (>=0.7)', async () => {
      const mockResults = [{payload: {content: 'some'}} as DetailedQdrantSearchResult];
      const result = refineQuerySUT("original", mockResults, 0.7);
      expect(tweakQuerySpy).toHaveBeenCalledWith("original", mockResults);
      expect(result).toBe('mock_tweaked_by_actual_spy');
      expect(broadenQuerySpy).not.toHaveBeenCalled();
      expect(focusQueryBasedOnResultsSpy).not.toHaveBeenCalled();
    });
  });
});
