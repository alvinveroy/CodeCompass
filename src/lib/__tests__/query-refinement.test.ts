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

// let broadenQuerySpy: any;
// let focusQueryBasedOnResultsSpy: any;
// let tweakQuerySpy: any;

describe('Query Refinement Tests', () => {
  let ActualQueryRefinementModule: typeof import('../query-refinement.js');
  let searchWithRefinementSUT: typeof ActualQueryRefinementModule.searchWithRefinement;
  let refineQuerySUT_for_direct_testing: typeof ActualQueryRefinementModule.refineQuery; // Renamed for clarity

  beforeAll(async () => {
    // Import the actual module once
    vi.resetModules(); // Ensure we get a fresh module if other tests modified it
    ActualQueryRefinementModule = await import('../query-refinement.js');
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

    // Assign SUTs from the pre-imported actual module
    searchWithRefinementSUT = ActualQueryRefinementModule.searchWithRefinement;
    refineQuerySUT_for_direct_testing = ActualQueryRefinementModule.refineQuery;
  });

  afterEach(() => { 
    vi.restoreAllMocks(); // Restores original implementations, including spies
  });

  describe('searchWithRefinement', () => {
    // We will NOT mock refineQuery here. searchWithRefinement will call the actual refineQuery.
    // We will mock the functions CALLED BY refineQuery (broaden, focus, tweak)
    // to control refineQuery's behavior for these specific tests.
    let mockBroadenQueryForSearchTest: Mock<[string], string>;
    let mockFocusQueryForSearchTest: Mock<[string, DetailedQdrantSearchResult[]], string>;
    let mockTweakQueryForSearchTest: Mock<[string, DetailedQdrantSearchResult[]], string>;

    beforeEach(async () => {
      // These mocks will be called by the *actual* refineQuery, which is called by searchWithRefinementSUT
      mockBroadenQueryForSearchTest = vi.spyOn(ActualQueryRefinementModule, 'broadenQuery').mockReturnValue('broadened_by_search_test_spy');
      mockFocusQueryForSearchTest = vi.spyOn(ActualQueryRefinementModule, 'focusQueryBasedOnResults').mockReturnValue('focused_by_search_test_spy');
      mockTweakQueryForSearchTest = vi.spyOn(ActualQueryRefinementModule, 'tweakQuery').mockReturnValue('tweaked_by_search_test_spy');
    });

    afterEach(() => {
      // vi.restoreAllMocks() in the outer afterEach will handle restoring the spy.
    });
    
    it('should return results without refinement if relevance threshold is met initially', async () => {
      const mockResults = [{ id: '1', score: 0.8, payload: { content: 'highly relevant' } }];
      vi.mocked(mockQdrantClientInstance.search).mockResolvedValue(mockResults as any);
      
      const { results, refinedQuery: actualRefinedQuery, relevanceScore } = await searchWithRefinementSUT(
        mockQdrantClientInstance, 'initial query', [], undefined, undefined, 0.75
      );
      
      expect(mockQdrantClientInstance.search).toHaveBeenCalledTimes(1);
      expect(results).toEqual(mockResults);
      expect(actualRefinedQuery).toBe('initial query'); // Query should not change if threshold met
      expect(relevanceScore).toBe(0.8);
      // Since refineQuery is not mocked, its internal dependencies should not have been called either
      expect(mockBroadenQueryForSearchTest).not.toHaveBeenCalled();
      expect(mockFocusQueryForSearchTest).not.toHaveBeenCalled();
      // tweakQuery *would* be called by the actual refineQuery if relevance is >= 0.7
      // For this test, the initial relevance is 0.8, so refineQuery will call tweakQuery.
      expect(mockTweakQueryForSearchTest).toHaveBeenCalledWith('initial query', mockResults);
    });

    it('should refine query up to maxRefinements if threshold not met, calling spied refineQuery', async () => {
      // Reset spies for this specific test's logic
      mockBroadenQueryForSearchTest.mockClear();
      mockFocusQueryForSearchTest.mockClear();
      mockTweakQueryForSearchTest.mockClear();

      // Mock search results for multiple iterations
      vi.mocked(mockQdrantClientInstance.search) // This is the Qdrant search
        .mockResolvedValueOnce([{ id: 'r1', score: 0.2, payload: { content: 'low relevance' } }] as any) // Initial search
        .mockResolvedValueOnce([{ id: 'r2', score: 0.5, payload: { content: 'medium relevance' } }] as any) // Search after 1st refinement
        .mockResolvedValueOnce([{ id: 'r3', score: 0.8, payload: { content: 'high relevance' } }] as any); // Search after 2nd refinement

      const { results, relevanceScore, refinedQuery: actualRefinedQueryOutput } = await searchWithRefinementSUT(
        mockQdrantClientInstance, 'original query', [], undefined, undefined, 0.75 // maxRefinements defaults to config (2), threshold 0.75
      );

      expect(mockQdrantClientInstance.search).toHaveBeenCalledTimes(3); 
      expect(results[0].id).toBe('r3'); // Final results
      expect(relevanceScore).toBe(0.8); // Final relevance

      // The actual refineQuery will be called twice.
      // 1st call to refineQuery (relevance 0.2): will call broadenQuery
      // 2nd call to refineQuery (relevance 0.5): will call focusQueryBasedOnResults
      // The final search (relevance 0.8) meets threshold, so refineQuery is not called a 3rd time by searchWithRefinement's loop.
      // However, the *actual* refineQuery (when called with 0.8) would call tweakQuery.
      // Let's verify the calls to the spies on broaden, focus, and tweak.

      expect(mockBroadenQueryForSearchTest).toHaveBeenCalledTimes(1);
      expect(mockBroadenQueryForSearchTest).toHaveBeenCalledWith('original query');

      expect(mockFocusQueryForSearchTest).toHaveBeenCalledTimes(1);
      // The input to focus will be the output of broadenQuery
      expect(mockFocusQueryForSearchTest).toHaveBeenCalledWith('broadened_by_search_test_spy', [{ id: 'r2', score: 0.5, payload: { content: 'medium relevance' } }]);

      // Tweak query is called by refineQuery when relevance is >= 0.7.
      // The last call to refineQuery (implicitly, because searchWithRefinement's loop ends)
      // would have been with relevance 0.8. So, the actual refineQuery would call tweakQuery.
      // However, searchWithRefinement's loop itself stops *before* making that third explicit call to refineQuery.
      // The final query is determined by the last successful refinement.
      // The tweakQuery spy should NOT be called as part of the refinement *loop* logic of searchWithRefinement.
      // It might be called if the *first* result was >= 0.7 (as seen in the first test case).
      expect(mockTweakQueryForSearchTest).not.toHaveBeenCalled();

      // Check the final refined query string
      expect(actualRefinedQueryOutput).toBe('focused_by_search_test_spy'); // Output of the last refinement step
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
        // Reset spies for this specific test's logic
        mockBroadenQueryForSearchTest.mockClear();
        mockFocusQueryForSearchTest.mockClear();
        mockTweakQueryForSearchTest.mockClear();

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
        // refineQuery (actual) would have been called MAX_REFINEMENT_ITERATIONS times.
        // Each time, with empty results and relevance 0, it would call broadenQuery.
        expect(mockBroadenQueryForSearchTest).toHaveBeenCalledTimes(configService.MAX_REFINEMENT_ITERATIONS);
        expect(mockFocusQueryForSearchTest).not.toHaveBeenCalled();
        expect(mockTweakQueryForSearchTest).not.toHaveBeenCalled();
    });
  });

  describe('refineQuery (main dispatcher - testing original logic)', () => {
    // let ActualQRModuleForThisDescribe: typeof import('../query-refinement.js'); // Not strictly needed if SUTRefineQuery is used
    // SUTRefineQuery_for_direct_testing is already ActualQueryRefinementModule.refineQuery
    
    let mockBroadenQuery: Mock<[string], string>;
    let mockFocusQuery: Mock<[string, DetailedQdrantSearchResult[]], string>;
    let mockTweakQuery: Mock<[string, DetailedQdrantSearchResult[]], string>;

    // beforeAll removed as module is imported fresh in beforeEach after vi.doMock

    beforeEach(async () => {
      // Spy on the internal functions called by refineQuerySUT_for_direct_testing
      mockBroadenQuery = vi.spyOn(ActualQueryRefinementModule, 'broadenQuery')
        .mockReturnValue('mock_broadened_by_doMock_local'); // Keep "doMock" in string for less churn
      mockFocusQuery = vi.spyOn(ActualQueryRefinementModule, 'focusQueryBasedOnResults')
        .mockReturnValue('mock_focused_by_doMock_local');
      mockTweakQuery = vi.spyOn(ActualQueryRefinementModule, 'tweakQuery')
        .mockReturnValue('mock_tweaked_by_doMock_local');
    });

    afterEach(() => {
      // vi.restoreAllMocks() in the outer afterEach will handle restoring these spies.
    });
    
    it('should call broadenQuery (mocked) and return its result for very low relevance (<0.3)', async () => {
      const result = refineQuerySUT_for_direct_testing("original", [], 0.1); 
      expect(mockBroadenQuery).toHaveBeenCalledWith("original"); 
      expect(result).toBe('mock_broadened_by_doMock_local');
      expect(mockFocusQuery).not.toHaveBeenCalled();
      expect(mockTweakQuery).not.toHaveBeenCalled();
    });

    it('should call focusQueryBasedOnResults (mocked) for mediocre relevance (0.3 <= relevance < 0.7)', async () => {
      const mockResults = [{payload: {content: 'some'}} as DetailedQdrantSearchResult];
      const result = refineQuerySUT_for_direct_testing("original", mockResults, 0.5);
      expect(mockFocusQuery).toHaveBeenCalledWith("original", mockResults);
      expect(result).toBe('mock_focused_by_doMock_local');
      expect(mockBroadenQuery).not.toHaveBeenCalled();
      expect(mockTweakQuery).not.toHaveBeenCalled();
    });

    it('should call tweakQuery (mocked) for decent relevance (>=0.7)', async () => {
      const mockResults = [{payload: {content: 'some'}} as DetailedQdrantSearchResult];
      const result = refineQuerySUT_for_direct_testing("original", mockResults, 0.7);
      expect(mockTweakQuery).toHaveBeenCalledWith("original", mockResults);
      expect(result).toBe('mock_tweaked_by_doMock_local');
      expect(mockBroadenQuery).not.toHaveBeenCalled();
      expect(mockFocusQuery).not.toHaveBeenCalled();
    });
  });
});
