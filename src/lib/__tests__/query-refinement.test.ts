import { describe, it, expect, vi, beforeEach, afterEach, beforeAll, type Mock, type MockedFunction, afterAll } from 'vitest';
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
  // SUTs will be dynamically imported within describe blocks after mocks are set.
  // let ActualQueryRefinementModule: typeof import('../query-refinement.js'); 
  // let searchWithRefinementSUT: typeof ActualQueryRefinementModule.searchWithRefinement;
  // let refineQuerySUT_for_direct_testing: typeof ActualQueryRefinementModule.refineQuery; 

  beforeAll(async () => {
    // No top-level import of ActualQueryRefinementModule here.
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

    // SUTs will be imported in specific describe blocks
  });

  afterEach(() => { 
    vi.restoreAllMocks(); // Restores original implementations, including spies
    vi.resetModules(); // Crucial to ensure mocks don't leak between tests/describes
  });

  describe('searchWithRefinement', () => {
    let searchWithRefinementSUT_local: (typeof import('../query-refinement.js'))['searchWithRefinement'];
    let mockRefineQuery_for_searchTest: Mock<[string, DetailedQdrantSearchResult[], number], string>;

    beforeEach(async () => {
      vi.resetModules(); // Ensure clean state for vi.doMock

      mockRefineQuery_for_searchTest = vi.fn((query, _results, relevance) => {
        if (relevance < 0.3) return `${query} broadened by mockRefineQuery`;
        if (relevance < 0.7) return `${query} focused by mockRefineQuery`;
        return `${query} tweaked by mockRefineQuery`;
      });

      vi.doMock('../query-refinement.js', async (importOriginal) => {
        const originalModule = await importOriginal<typeof import('../query-refinement.js')>();
        return {
          ...originalModule,
          refineQuery: mockRefineQuery_for_searchTest, // searchWithRefinement will use this
        };
      });

      // Import SUT *after* doMock is set up
      const SUTModule = await import('../query-refinement.js');
      searchWithRefinementSUT_local = SUTModule.searchWithRefinement;
    });

    afterEach(() => {
      vi.doUnmock('../query-refinement.js');
    });
    
    it('should return results without refinement if relevance threshold is met initially', async () => {
      const mockResults = [{ id: '1', score: 0.8, payload: { content: 'highly relevant' } }];
      vi.mocked(mockQdrantClientInstance.search).mockResolvedValue(mockResults as any);
      
      const { results, refinedQuery: actualRefinedQuery, relevanceScore } = await searchWithRefinementSUT_local(
        mockQdrantClientInstance, 'initial query', [], undefined, 2, 0.75 // maxRefinements = 2
      );
      
      expect(mockQdrantClientInstance.search).toHaveBeenCalledTimes(1);
      expect(results).toEqual(mockResults);
      expect(actualRefinedQuery).toBe('initial query'); // Query should not change if threshold met
      expect(relevanceScore).toBe(0.8);
      expect(mockRefineQuery_for_searchTest).not.toHaveBeenCalled(); 
    });

    it('should refine query up to maxRefinements if threshold not met, calling spied refineQuery', async () => {
      mockRefineQuery_for_searchTest.mockClear();

      // Mock search results for multiple iterations
      vi.mocked(mockQdrantClientInstance.search) // This is the Qdrant search
        .mockResolvedValueOnce([{ id: 'r1', score: 0.2, payload: { content: 'low relevance' } }] as any) // Initial search
        .mockResolvedValueOnce([{ id: 'r2', score: 0.5, payload: { content: 'medium relevance' } }] as any) // Search after 1st refinement
        .mockResolvedValueOnce([{ id: 'r3', score: 0.8, payload: { content: 'high relevance' } }] as any); // Search after 2nd refinement

      const { results, relevanceScore, refinedQuery: actualRefinedQueryOutput } = await searchWithRefinementSUT_local(
        mockQdrantClientInstance, 'original query', [], undefined, 2, 0.75 // maxRefinements = 2, threshold 0.75
      );

      expect(mockQdrantClientInstance.search).toHaveBeenCalledTimes(3); 
      expect(results[0].id).toBe('r3'); // Final results
      expect(relevanceScore).toBe(0.8); // Final relevance

      expect(mockRefineQuery_for_searchTest).toHaveBeenCalledTimes(2); 
      expect(mockRefineQuery_for_searchTest).toHaveBeenNthCalledWith(1, 
        'original query', 
        [{ id: 'r1', score: 0.2, payload: { content: 'low relevance' } }], 
        0.2 
      );
      expect(mockRefineQuery_for_searchTest).toHaveBeenNthCalledWith(2, 
        'original query broadened by mockRefineQuery', 
        [{ id: 'r2', score: 0.5, payload: { content: 'medium relevance' } }], 
        0.5 
      );

      // Check the final refined query string
      expect(actualRefinedQueryOutput).toBe('original query broadened by mockRefineQuery focused by mockRefineQuery');
    });
    
    it('should use customLimit if provided', async () => {
      vi.mocked(mockQdrantClientInstance.search).mockResolvedValue([{ id: '1', score: 0.9, payload: {} }] as any); // Ensure high score to avoid refinement loop
      await searchWithRefinementSUT_local(mockQdrantClientInstance, 'query', [], 15, 2, 0.75); 
      expect(mockQdrantClientInstance.search).toHaveBeenCalledWith(
        configService.COLLECTION_NAME,
        expect.objectContaining({ limit: 15 })
      );
    });
    
    it('should apply file filter if files array is provided', async () => {
        vi.mocked(mockQdrantClientInstance.search).mockResolvedValue([{ id: '1', score: 0.9, payload: {} }] as any);
        const filesToFilter = ['src/file1.ts', 'src/file2.ts'];
        await searchWithRefinementSUT_local(mockQdrantClientInstance, 'query', filesToFilter, undefined, 2, 0.75); 
        expect(mockQdrantClientInstance.search).toHaveBeenCalledWith(
            configService.COLLECTION_NAME,
            expect.objectContaining({
                filter: { must: [{ key: "filepath", match: { any: filesToFilter } }] }
            })
        );
    });

    it('should handle empty search results gracefully during refinement', async () => {
        mockRefineQuery_for_searchTest.mockClear();

        vi.mocked(mockQdrantClientInstance.search)
            .mockResolvedValueOnce([]) 
            .mockResolvedValueOnce([]) 
            .mockResolvedValueOnce([]); 

        const { results, relevanceScore } = await searchWithRefinementSUT_local( 
            mockQdrantClientInstance, 'query for no results', [], undefined, 2, 0.7 // maxRefinements = 2
        );
        expect(mockQdrantClientInstance.search).toHaveBeenCalledTimes(3); // Initial + 2 refinements
        expect(results).toEqual([]);
        expect(relevanceScore).toBe(0);
        expect(logger.info).toHaveBeenCalledWith(expect.stringContaining(`Completed search with 2 refinements`));
        expect(mockRefineQuery_for_searchTest).toHaveBeenCalledTimes(2);
    });
  });

  describe('refineQuery (main dispatcher - testing original logic)', () => {
    let refineQuerySUT_local: (typeof import('../query-refinement.js'))['refineQuery'];
    let mockBroadenQuery_local: Mock<[string], string>;
    let mockFocusQuery_local: Mock<[string, DetailedQdrantSearchResult[]], string>;
    let mockTweakQuery_local: Mock<[string, DetailedQdrantSearchResult[]], string>;

    beforeEach(async () => {
      vi.resetModules(); // Ensure clean state for vi.doMock

      mockBroadenQuery_local = vi.fn().mockReturnValue('mock_broadened_by_local_mock');
      mockFocusQuery_local = vi.fn().mockReturnValue('mock_focused_by_local_mock');
      mockTweakQuery_local = vi.fn().mockReturnValue('mock_tweaked_by_local_mock');

      vi.doMock('../query-refinement.js', async (importOriginal) => {
        const originalModule = await importOriginal<typeof import('../query-refinement.js')>();
        return {
          ...originalModule,
          // IMPORTANT: We are testing refineQuery itself, so we DON'T mock it here.
          // We mock the functions IT calls.
          broadenQuery: mockBroadenQuery_local,
          focusQueryBasedOnResults: mockFocusQuery_local,
          tweakQuery: mockTweakQuery_local,
        };
      });

      // Import the SUT *after* doMock is set up to get the version with mocked internals
      const SUTModule = await import('../query-refinement.js');
      refineQuerySUT_local = SUTModule.refineQuery;
    });

    afterEach(() => {
      vi.doUnmock('../query-refinement.js');
    });
    
    it('should call broadenQuery (mocked) and return its result for very low relevance (<0.3)', async () => {
      const result = refineQuerySUT_local("original", [], 0.1); 
      expect(mockBroadenQuery_local).toHaveBeenCalledWith("original"); 
      expect(result).toBe('mock_broadened_by_local_mock');
      expect(mockFocusQuery_local).not.toHaveBeenCalled();
      expect(mockTweakQuery_local).not.toHaveBeenCalled();
    });

    it('should call focusQueryBasedOnResults (mocked) for mediocre relevance (0.3 <= relevance < 0.7)', async () => {
      const mockResults = [{payload: {content: 'some'}} as DetailedQdrantSearchResult];
      const result = refineQuerySUT_local("original", mockResults, 0.5);
      expect(mockFocusQuery_local).toHaveBeenCalledWith("original", mockResults);
      expect(result).toBe('mock_focused_by_local_mock');
      expect(mockBroadenQuery_local).not.toHaveBeenCalled();
      expect(mockTweakQuery_local).not.toHaveBeenCalled();
    });

    it('should call tweakQuery (mocked) for decent relevance (>=0.7)', async () => {
      const mockResults = [{payload: {content: 'some'}} as DetailedQdrantSearchResult];
      const result = refineQuerySUT_local("original", mockResults, 0.7);
      expect(mockTweakQuery_local).toHaveBeenCalledWith("original", mockResults);
      expect(result).toBe('mock_tweaked_by_local_mock');
      expect(mockBroadenQuery_local).not.toHaveBeenCalled();
      expect(mockFocusQuery_local).not.toHaveBeenCalled();
    });
  });
});
