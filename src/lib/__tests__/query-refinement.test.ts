import { describe, it, expect, vi, beforeEach, afterEach, beforeAll, afterAll } from 'vitest'; // Ensure all hooks
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

// Define a reusable mock Qdrant client
const mockQdrantClientInstance = {
  search: vi.fn(),
} as unknown as QdrantClient;

// 1. Define mock functions at the top level.
const MOCK_FACTORY_REFINE_QUERY = vi.fn();
const MOCK_FACTORY_BROADEN_QUERY = vi.fn();
const MOCK_FACTORY_FOCUS_QUERY = vi.fn();
const MOCK_FACTORY_TWEAK_QUERY = vi.fn();

// 2. Mock the module, referring to the top-level mocks.
vi.mock('../query-refinement', async (importOriginal) => {
  const originalModule = await importOriginal<typeof import('../query-refinement')>();
  return {
    ...originalModule,
    refineQuery: MOCK_FACTORY_REFINE_QUERY,
    broadenQuery: MOCK_FACTORY_BROADEN_QUERY,
    focusQueryBasedOnResults: MOCK_FACTORY_FOCUS_QUERY,
    tweakQuery: MOCK_FACTORY_TWEAK_QUERY,
  };
});

// 3. Import functions. These will be a mix of original and the mocks from above.
import { 
  searchWithRefinement,       // Original (from ...originalModule)
  refineQuery,              // Mock (MOCK_FACTORY_REFINE_QUERY)
  broadenQuery,             // Mock (MOCK_FACTORY_BROADEN_QUERY)
  focusQueryBasedOnResults, // Mock (MOCK_FACTORY_FOCUS_QUERY)
  tweakQuery                // Mock (MOCK_FACTORY_TWEAK_QUERY)
  // extractKeywords is original and will be imported if needed by actual refineQuery
} from '../query-refinement';


describe('Query Refinement Tests', () => {
  beforeEach(() => {
    vi.clearAllMocks(); // Clears call history and mock implementations set by mockXyzOnce

    // Reset the top-level mocks
    MOCK_FACTORY_REFINE_QUERY.mockReset().mockImplementation(
      (_query, _results, relevance) => {
        if (relevance < 0.3) return 'mock_refined_broadened_for_search';
        if (relevance < 0.7) return 'mock_refined_focused_for_search';
        return 'mock_refined_tweaked_for_search';
      }
    );
    MOCK_FACTORY_BROADEN_QUERY.mockReset().mockReturnValue('spy_broadened_return_val');
    MOCK_FACTORY_FOCUS_QUERY.mockReset().mockReturnValue('spy_focused_return_val');
    MOCK_FACTORY_TWEAK_QUERY.mockReset().mockReturnValue('spy_tweaked_return_val');

    vi.mocked(generateEmbedding).mockResolvedValue([0.1,0.2,0.3]);
    vi.mocked(mockQdrantClientInstance.search).mockClear();
  });

  afterEach(() => { vi.restoreAllMocks(); });

  // --- Test searchWithRefinement ---
  describe('searchWithRefinement', () => {
    // searchWithRefinement is the original implementation.
    // It will call the mocked refineQuery (imported from the factory).

    it('should return results without refinement if relevance threshold is met initially', async () => {
      const mockResults = [{ id: '1', score: 0.8, payload: { content: 'highly relevant' } }];
      vi.mocked(mockQdrantClientInstance.search).mockResolvedValue(mockResults as any);

      const { results, refinedQuery: actualRefinedQuery, relevanceScore } = await searchWithRefinement(
        mockQdrantClientInstance,
        'initial query',
        [], // files
        undefined, // customLimit
        undefined, // maxRefinements (uses configService.MAX_REFINEMENT_ITERATIONS = 2)
        0.75 // relevanceThreshold
      );
      
      expect(mockQdrantClientInstance.search).toHaveBeenCalledTimes(1);
      expect(results).toEqual(mockResults);
      expect(actualRefinedQuery).toBe('initial query'); // No refinement should occur
      expect(relevanceScore).toBe(0.8);
      expect(logger.info).toHaveBeenCalledWith(expect.stringContaining('Completed search with 0 refinements'));
      expect(MOCK_FACTORY_REFINE_QUERY).not.toHaveBeenCalled(); // Assert on the top-level mock
    });

    it('should refine query up to maxRefinements if threshold not met, calling mocked refineQuery', async () => {
      vi.mocked(mockQdrantClientInstance.search)
        .mockResolvedValueOnce([{ id: 'r1', score: 0.2, payload: { content: 'low relevance' } }] as any)
        .mockResolvedValueOnce([{ id: 'r2', score: 0.5, payload: { content: 'medium relevance' } }] as any)
        .mockResolvedValueOnce([{ id: 'r3', score: 0.8, payload: { content: 'high relevance' } }] as any);

      const { results, relevanceScore, refinedQuery: actualRefinedQueryOutput } = await searchWithRefinement(
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
      expect(actualRefinedQueryOutput).toBe('mock_refined_focused_for_search'); 
      expect(logger.info).toHaveBeenCalledWith(expect.stringContaining('Completed search with 2 refinements'));
      expect(MOCK_FACTORY_REFINE_QUERY).toHaveBeenCalledTimes(2); // Assert on the top-level mock
      expect(MOCK_FACTORY_REFINE_QUERY).toHaveBeenNthCalledWith(1, 'original query', // Assert on the top-level mock
        [{ id: 'r1', score: 0.2, payload: { content: 'low relevance' } }], 0.2);
      expect(MOCK_FACTORY_REFINE_QUERY).toHaveBeenNthCalledWith(2, 'mock_refined_broadened_for_search', // Assert on the top-level mock
        [{ id: 'r2', score: 0.5, payload: { content: 'medium relevance' } }], 0.5);
    });

    it('should use customLimit if provided', async () => {
      // const { searchWithRefinement } = await import('../query-refinement'); // Already imported
      vi.mocked(mockQdrantClientInstance.search).mockResolvedValue([{ id: '1', score: 0.9, payload: {} }] as any);
      await searchWithRefinement(mockQdrantClientInstance, 'query', [], 15);
      expect(mockQdrantClientInstance.search).toHaveBeenCalledWith(
        configService.COLLECTION_NAME,
        expect.objectContaining({ limit: 15 })
      );
    });
    
    it('should apply file filter if files array is provided', async () => {
        // const { searchWithRefinement } = await import('../query-refinement'); // Already imported
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
        // const { searchWithRefinement } = await import('../query-refinement'); // Already imported
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
        expect(MOCK_FACTORY_REFINE_QUERY).toHaveBeenCalledTimes(configService.MAX_REFINEMENT_ITERATIONS); // Assert on the top-level mock
    });
  });
  
  describe('refineQuery (main dispatcher)', () => {
    let actualRefineQueryInstance: typeof import('../query-refinement').refineQuery;
    
    beforeAll(async () => {
      const actualModule = await vi.importActual<typeof import('../query-refinement')>('../query-refinement');
      actualRefineQueryInstance = actualModule.refineQuery; // This is the ORIGINAL refineQuery
    });

    // actualRefineQueryInstance will call broadenQuery, focusQueryBasedOnResults, tweakQuery.
    // These names, when used inside actualRefineQueryInstance, should resolve to the
    // imported mocks (MOCK_FACTORY_BROADEN_QUERY, MOCK_FACTORY_FOCUS_QUERY, MOCK_FACTORY_TWEAK_QUERY).
        
    it('should call broadenQuery and return its result for very low relevance (<0.3)', async () => {
      const result = actualRefineQueryInstance("original", [], 0.1);
      expect(MOCK_FACTORY_BROADEN_QUERY).toHaveBeenCalledWith("original"); // Assert on the top-level mock
      expect(result).toBe('spy_broadened_return_val');
      expect(MOCK_FACTORY_FOCUS_QUERY).not.toHaveBeenCalled(); // Assert on the top-level mock
      expect(MOCK_FACTORY_TWEAK_QUERY).not.toHaveBeenCalled(); // Assert on the top-level mock
    });
    
    it('should call focusQueryBasedOnResults and return its result for mediocre relevance (0.3 <= relevance < 0.7)', async () => {
      const mockResults = [{payload: {content: 'some'}} as DetailedQdrantSearchResult];
      const result = actualRefineQueryInstance("original", mockResults, 0.5);
      expect(MOCK_FACTORY_FOCUS_QUERY).toHaveBeenCalledWith("original", mockResults); // Assert on the top-level mock
      expect(result).toBe('spy_focused_return_val');
      expect(MOCK_FACTORY_BROADEN_QUERY).not.toHaveBeenCalled(); // Assert on the top-level mock
      expect(MOCK_FACTORY_TWEAK_QUERY).not.toHaveBeenCalled(); // Assert on the top-level mock
    });

    it('should call tweakQuery and return its result for decent relevance (>=0.7)', async () => {
      const mockResults = [{payload: {content: 'some'}} as DetailedQdrantSearchResult];
      const result = actualRefineQueryInstance("original", mockResults, 0.7);
      expect(MOCK_FACTORY_TWEAK_QUERY).toHaveBeenCalledWith("original", mockResults); // Assert on the top-level mock
      expect(result).toBe('spy_tweaked_return_val');
      expect(MOCK_FACTORY_BROADEN_QUERY).not.toHaveBeenCalled(); // Assert on the top-level mock
      expect(MOCK_FACTORY_FOCUS_QUERY).not.toHaveBeenCalled(); // Assert on the top-level mock
    });
  });
});
