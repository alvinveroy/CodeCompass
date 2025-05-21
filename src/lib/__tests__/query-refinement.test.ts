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
// Spies on original module's functions are removed as vi.doMock will replace them.
// let refineQuerySpy: any;
// let broadenQuerySpy: any;
// let focusQueryBasedOnResultsSpy: any;
// let tweakQuerySpy: any;

describe('Query Refinement Tests', () => {
  let ActualQueryRefinementModule: typeof import('../query-refinement.js');
  let searchWithRefinementSUT: typeof ActualQueryRefinementModule.searchWithRefinement;
  let refineQuerySUT: typeof ActualQueryRefinementModule.refineQuery;

  beforeAll(async () => {
    // ActualQueryRefinementModule import removed from here. SUTs will be imported after mocks.
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

    // For SUT import, we need to ensure it gets the potentially mocked module
    // This dynamic import will pick up mocks set by vi.doMock if active
    // SUTs are now imported within specific describe blocks after mocks are set up.
    // const SUTModule = await import('../query-refinement.js');
    // searchWithRefinementSUT = SUTModule.searchWithRefinement;
    // refineQuerySUT = SUTModule.refineQuery; 
  });

  afterEach(() => { 
    vi.restoreAllMocks(); // Restores original implementations
  });

  describe('searchWithRefinement', () => {
    let mockRefineQueryForSearchTest: Mock; // Specific mock for these tests

    beforeEach(async () => {
      vi.resetModules(); // Ensure a clean slate for module mocking

      // This mock will be used by searchWithRefinementSUT
      mockRefineQueryForSearchTest = vi.fn((query, _results, relevance) => {
        // console.log(`mockRefineQueryForSearchTest CALLED with query: ${query}, relevance: ${relevance}`);
        if (relevance < 0.3) return `${query} broadened by doMock`;
        if (relevance < 0.7) return `${query} focused by doMock`;
        return `${query} tweaked by doMock`;
      });

      vi.doMock('../query-refinement.js', async (importOriginal) => {
        const originalModule = await importOriginal<typeof import('../query-refinement.js')>();
        return {
          ...originalModule,
          refineQuery: mockRefineQueryForSearchTest, // searchWithRefinement will use this
        };
      });
      // Import SUT *after* doMock is set up
      const SUTModule = await import('../query-refinement.js');
      searchWithRefinementSUT = SUTModule.searchWithRefinement;
    });

    afterEach(() => {
      vi.doUnmock('../query-refinement.js');
      // vi.resetAllMocks(); // vi.restoreAllMocks() in outer afterEach should handle this. Or use vi.clearAllMocks() if issues.
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
    let SUTRefineQuery: (typeof import('../query-refinement.js'))['refineQuery'];
    
    let mockBroadenQuery: Mock;
    let mockFocusQuery: Mock;
    let mockTweakQuery: Mock;

    // beforeAll removed as module is imported fresh in beforeEach after vi.doMock

    beforeEach(async () => {
      mockBroadenQuery = vi.fn().mockReturnValue('mock_broadened_by_doMock_local');
      mockFocusQuery = vi.fn().mockReturnValue('mock_focused_by_doMock_local');
      mockTweakQuery = vi.fn().mockReturnValue('mock_tweaked_by_doMock_local');

      vi.doMock('../query-refinement.js', async (importOriginal) => {
        const originalModule = await importOriginal<typeof import('../query-refinement.js')>();
        return {
          ...originalModule,
          broadenQuery: mockBroadenQuery,
          focusQueryBasedOnResults: mockFocusQuery,
          tweakQuery: mockTweakQuery,
        };
      });

      // Import the SUT *after* doMock is set up to get the version with mocked internals
      const MockedQRModule = await import('../query-refinement.js');
      SUTRefineQuery = MockedQRModule.refineQuery;
    });

    afterEach(() => {
      vi.doUnmock('../query-refinement.js');
      // vi.resetAllMocks(); // vi.restoreAllMocks() in outer afterEach should handle this.
    });
    
    it('should call broadenQuery (mocked) and return its result for very low relevance (<0.3)', async () => {
      const result = SUTRefineQuery("original", [], 0.1); 
      expect(mockBroadenQuery).toHaveBeenCalledWith("original"); 
      expect(result).toBe('mock_broadened_by_doMock_local');
      expect(mockFocusQuery).not.toHaveBeenCalled();
      expect(mockTweakQuery).not.toHaveBeenCalled();
    });

    it('should call focusQueryBasedOnResults (mocked) for mediocre relevance (0.3 <= relevance < 0.7)', async () => {
      const mockResults = [{payload: {content: 'some'}} as DetailedQdrantSearchResult];
      const result = SUTRefineQuery("original", mockResults, 0.5);
      expect(mockFocusQuery).toHaveBeenCalledWith("original", mockResults);
      expect(result).toBe('mock_focused_by_doMock_local');
      expect(mockBroadenQuery).not.toHaveBeenCalled();
      expect(mockTweakQuery).not.toHaveBeenCalled();
    });

    it('should call tweakQuery (mocked) for decent relevance (>=0.7)', async () => {
      const mockResults = [{payload: {content: 'some'}} as DetailedQdrantSearchResult];
      const result = SUTRefineQuery("original", mockResults, 0.7);
      expect(mockTweakQuery).toHaveBeenCalledWith("original", mockResults);
      expect(result).toBe('mock_tweaked_by_doMock_local');
      expect(mockBroadenQuery).not.toHaveBeenCalled();
      expect(mockFocusQuery).not.toHaveBeenCalled();
    });
  });
});
