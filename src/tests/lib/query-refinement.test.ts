/// <reference types="vitest/globals" /> 

import { describe, it, expect, vi, beforeEach, type MockedFunction } from 'vitest'; // Explicitly import MockedFunction
import { QdrantClient, type Schemas } from '@qdrant/js-client-rest';
import type { DetailedQdrantSearchResult } from '../../lib/types';
import type { RefineQueryFunc } from '../../lib/query-refinement';

// Mock external dependencies (these are fine as they are)
vi.mock('../../lib/config-service', () => ({
  configService: {
    COLLECTION_NAME: 'test_refine_collection',
    QDRANT_SEARCH_LIMIT_DEFAULT: 5,
    MAX_REFINEMENT_ITERATIONS: 2,
  },
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('../../lib/ollama', () => ({
  generateEmbedding: vi.fn().mockResolvedValue([0.1, 0.2, 0.3]),
}));
vi.mock('../../../utils/text-utils', () => ({
  preprocessText: vi.fn((text: string) => text),
}));

// Import SUT and its helpers (now exported)
import {
  searchWithRefinement,
  refineQuery as actualRefineQuery,
} from '../../lib/query-refinement';

// Import mocked dependencies
import { generateEmbedding } from '../../lib/ollama';
import { logger } from '../../lib/config-service'; // configService itself is not used directly in tests
// Define mockSearchFn once
const mockSearchFn = vi.fn();
const mockQdrantClientInstance = { search: vi.fn() } as unknown as QdrantClient;

// Remove the VitestMockedFunction utility type if it was causing issues.
// We will use the imported `Mock` type directly.

describe('Query Refinement Tests', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(generateEmbedding).mockResolvedValue([0.1, 0.2, 0.3]);
    mockSearchFn.mockClear(); // Clear the standalone mock
    vi.mocked(logger.info).mockClear();
    vi.mocked(logger.debug).mockClear();
  });

  describe('searchWithRefinement', () => {
    // Use vi.MockedFunction<TheFunctionType>
    let mockRefineQuery_Injected: MockedFunction<RefineQueryFunc>; // Use imported MockedFunction

    beforeEach(() => {
      mockRefineQuery_Injected = vi.fn((query, _results, relevance) => {
        if (relevance < 0.3) return `${query} broadened by INJECTED mockRefineQuery`;
        if (relevance < 0.7) return `${query} focused by INJECTED mockRefineQuery`;
        return `${query} tweaked by INJECTED mockRefineQuery`;
      });
    });

    // Use Schemas['ScoredPoint']
    const dummySearchResults = (score: number, count = 1): Schemas['ScoredPoint'][] =>
      Array(count).fill(null).map((_, i) => ({
        id: `id-${score}-${i}`, version: 1, score,
        payload: { content: `content ${score}`, filepath: `file${i}.ts` }, // This payload is simpler than DetailedQdrantSearchResult
        vector: [0.1 * i, 0.2 * i, 0.3 * i],
      }));

    it('should return results without refinement if threshold met (using injected mock)', async () => {
      mockSearchFn.mockResolvedValue(dummySearchResults(0.8) as unknown as Schemas['ScoredPoint'][]); 
      const { results, refinedQuery, relevanceScore } = await searchWithRefinement(
        mockQdrantClientInstance, 'initial query', [], undefined, 2, 0.75,
        mockRefineQuery_Injected
      );
      expect(mockSearchFn).toHaveBeenCalledTimes(1);
      // Ensure results are cast or match DetailedQdrantSearchResult for this assertion
      expect((results[0] as Schemas['ScoredPoint']).score).toBe(0.8);
      expect(refinedQuery).toBe('initial query');
      expect(relevanceScore).toBe(0.8);
      expect(mockRefineQuery_Injected).not.toHaveBeenCalled();
    });

    it('should refine query up to maxRefinements (using injected mock)', async () => {
      mockSearchFn
        .mockResolvedValueOnce(dummySearchResults(0.2) as unknown as Schemas['ScoredPoint'][]) 
        .mockResolvedValueOnce(dummySearchResults(0.5) as unknown as Schemas['ScoredPoint'][]) 
        .mockResolvedValueOnce(dummySearchResults(0.8) as unknown as Schemas['ScoredPoint'][]); 

      const { results, relevanceScore, refinedQuery } = await searchWithRefinement(
        mockQdrantClientInstance, 'original query', [], undefined, 2, 0.75,
        mockRefineQuery_Injected
      );

      expect(mockSearchFn).toHaveBeenCalledTimes(3);
      expect((results[0] as Schemas['ScoredPoint']).score).toBe(0.8);
      expect(relevanceScore).toBe(0.8);
      expect(refinedQuery).toBe('original query broadened by INJECTED mockRefineQuery focused by INJECTED mockRefineQuery');
       
      expect(mockRefineQuery_Injected).toHaveBeenCalledTimes(2);
      // Ensure the results passed to the mock match DetailedQdrantSearchResult[] if that's what RefineQueryFunc expects
      // The dummySearchResults creates Schemas['ScoredPoint'][], which might be compatible or need casting/adjusting
      // For the mock call assertion, if RefineQueryFunc expects DetailedQdrantSearchResult[], you might need to cast:
      expect(mockRefineQuery_Injected).toHaveBeenNthCalledWith(1, 'original query', expect.any(Array) as unknown as DetailedQdrantSearchResult[], 0.2);
      expect(mockRefineQuery_Injected).toHaveBeenNthCalledWith(2, 'original query broadened by INJECTED mockRefineQuery', expect.any(Array) as unknown as DetailedQdrantSearchResult[], 0.5);
    });
    
    it('should handle empty search results gracefully (using injected mock)', async () => {
        mockSearchFn
            .mockResolvedValueOnce([])
            .mockResolvedValueOnce([])
            .mockResolvedValueOnce([]);

        const { results, relevanceScore, refinedQuery } = await searchWithRefinement(
            mockQdrantClientInstance, 'query for no results', [], undefined, 2, 0.7,
            mockRefineQuery_Injected // Pass the mock
        );
        expect(mockSearchFn).toHaveBeenCalledTimes(3);
        expect(results).toEqual([]);
        expect(relevanceScore).toBe(0);
        expect(refinedQuery).toBe('query for no results broadened by INJECTED mockRefineQuery broadened by INJECTED mockRefineQuery');
         
        expect(logger.info).toHaveBeenCalledWith(expect.stringContaining(`Completed search with 2 refinements`));
         
        expect(mockRefineQuery_Injected).toHaveBeenCalledTimes(2);
    });
  });

  describe('refineQuery (original logic with injected helpers)', () => {
    // Use vi.MockedFunction for these as well
    let mockBroaden_Injected: MockedFunction<(query: string) => string>;
    let mockFocus_Injected: MockedFunction<(query: string, results: DetailedQdrantSearchResult[]) => string>;
    let mockTweak_Injected: MockedFunction<(query: string, results: DetailedQdrantSearchResult[]) => string>;

    beforeEach(() => {
      mockBroaden_Injected = vi.fn().mockReturnValue('mock_broadened_by_INJECTED_helper');
      mockFocus_Injected = vi.fn().mockReturnValue('mock_focused_by_INJECTED_helper');
      mockTweak_Injected = vi.fn().mockReturnValue('mock_tweaked_by_INJECTED_helper');
    });

    const dummyResultsArray = (score: number): DetailedQdrantSearchResult[] => ([
        { id: 'res1', score, payload: { content: 'some content', filepath: 'file.ts', last_modified: '2023-01-01' }, vector: [], version: 0 } // Added last_modified
    ]);

    it('should call broadenQuery (injected) for very low relevance (<0.3)', () => {
      const result = actualRefineQuery("original", [], 0.1, {
        broaden: mockBroaden_Injected, focus: mockFocus_Injected, tweak: mockTweak_Injected
      });
      // eslint-disable-next-line @typescript-eslint/unbound-method -- False positive for standalone vi.fn()
      expect(mockBroaden_Injected).toHaveBeenCalledWith("original");
      expect(result).toBe('mock_broadened_by_INJECTED_helper');
      expect(mockFocus_Injected).not.toHaveBeenCalled();
      expect(mockTweak_Injected).not.toHaveBeenCalled();
    });

    it('should call focusQueryBasedOnResults (injected) for mediocre relevance (0.3 <= relevance < 0.7)', () => {
      const results = dummyResultsArray(0.5);
      const result = actualRefineQuery("original", results, 0.5, {
        broaden: mockBroaden_Injected, focus: mockFocus_Injected, tweak: mockTweak_Injected
      });
      expect(mockFocus_Injected).toHaveBeenCalledWith("original", results);
      expect(result).toBe('mock_focused_by_INJECTED_helper');
      expect(mockBroaden_Injected).not.toHaveBeenCalled();
      expect(mockTweak_Injected).not.toHaveBeenCalled();
    });

    it('should call tweakQuery (injected) for decent relevance (>=0.7)', () => {
      const results = dummyResultsArray(0.75);
      const result = actualRefineQuery("original", results, 0.75, {
        broaden: mockBroaden_Injected, focus: mockFocus_Injected, tweak: mockTweak_Injected
      });
      expect(mockTweak_Injected).toHaveBeenCalledWith("original", results);
      expect(result).toBe('mock_tweaked_by_INJECTED_helper');
      expect(mockBroaden_Injected).not.toHaveBeenCalled();
      expect(mockFocus_Injected).not.toHaveBeenCalled();
    });
  });
});
