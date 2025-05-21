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
    let mockRefineQueryForSearchTest: Mock<any[], string>; // Typed spy

    beforeEach(async () => {
      // Spy on 'refineQuery' from the ActualQueryRefinementModule
      // searchWithRefinementSUT (which is ActualQueryRefinementModule.searchWithRefinement)
      // will call this spied version.
      mockRefineQueryForSearchTest = vi.spyOn(ActualQueryRefinementModule, 'refineQuery').mockImplementation((query, _results, relevance) => {
        if (relevance < 0.3) return `${query} broadened by doMock`; // Keep "doMock" in string for less churn if needed
        if (relevance < 0.7) return `${query} focused by doMock`;
        return `${query} tweaked by doMock`;
      });
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
      // expect(logger.info).toHaveBeenCalledWith(expect.stringContaining('Completed search with 0 refinements')); // Logger might be tricky with mocks
      expect(mockRefineQueryForSearchTest).not.toHaveBeenCalled();
    });

    it('should refine query up to maxRefinements if threshold not met, calling spied refineQuery', async () => {
      vi.mocked(mockQdrantClientInstance.search)
        .mockResolvedValueOnce([{ id: 'r1', score: 0.2, payload: { content: 'low relevance' } }] as any) // Initial search
        .mockResolvedValueOnce([{ id: 'r2', score: 0.5, payload: { content: 'medium relevance' } }] as any) // Search after 1st refinement
        .mockResolvedValueOnce([{ id: 'r3', score: 0.8, payload: { content: 'high relevance' } }] as any); // Search after 2nd refinement

      const { results, relevanceScore, refinedQuery: actualRefinedQueryOutput } = await searchWithRefinementSUT(
        mockQdrantClientInstance, 'original query', [], undefined, undefined, 0.75 // maxRefinements defaults to config (2), threshold 0.75
      );
      
      expect(mockQdrantClientInstance.search).toHaveBeenCalledTimes(3); 
      expect(results[0].id).toBe('r3'); // Final results
      expect(relevanceScore).toBe(0.8); // Final relevance
      // Check if the mock was called the correct number of times
      expect(mockRefineQueryForSearchTest).toHaveBeenCalledTimes(2); 
      
      // Check the arguments of each call to the mock
      expect(mockRefineQueryForSearchTest).toHaveBeenNthCalledWith(1, 
        'original query', // query fed to 1st refineQuery call
        [{ id: 'r1', score: 0.2, payload: { content: 'low relevance' } }], // results from 1st search
        0.2 // avgScore from 1st search
      );
      expect(mockRefineQueryForSearchTest).toHaveBeenNthCalledWith(2, 
        'original query broadened by doMock', // query fed to 2nd refineQuery call (output of 1st mock call)
        [{ id: 'r2', score: 0.5, payload: { content: 'medium relevance' } }], // results from 2nd search
        0.5 // avgScore from 2nd search
      );

      // Check the final refined query string
      expect(actualRefinedQueryOutput).toBe('original query broadened by doMock focused by doMock');
      // expect(logger.info).toHaveBeenCalledWith(expect.stringContaining('Completed search with 2 refinements'));
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
        expect(mockRefineQueryForSearchTest).toHaveBeenCalledTimes(configService.MAX_REFINEMENT_ITERATIONS);
    });
  });

  describe('refineQuery (main dispatcher - testing original logic)', () => {
    // let ActualQRModuleForThisDescribe: typeof import('../query-refinement.js'); // Not strictly needed if SUTRefineQuery is used
    // SUTRefineQuery_for_direct_testing is already ActualQueryRefinementModule.refineQuery
    
    let mockBroadenQuery: Mock<any[], string>;
    let mockFocusQuery: Mock<any[], string>;
    let mockTweakQuery: Mock<any[], string>;

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
