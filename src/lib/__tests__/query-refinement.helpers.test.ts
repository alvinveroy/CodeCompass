import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
// Import ONLY the functions to be tested directly and their dependencies
import { 
  extractKeywords,
  broadenQuery,
  focusQueryBasedOnResults,
  tweakQuery
} from '../query-refinement'; // Direct import of originals
import { preprocessText } from '../../utils/text-utils';
import { DetailedQdrantSearchResult } from '../types'; 

vi.mock('../../utils/text-utils'); // Mock dependencies of helpers
// Mock configService and logger if they are DIRECTLY used by these helpers
// If they are only used by searchWithRefinement or refineQuery (dispatcher),
// then this mock might not be needed here.
// For now, assuming helpers might use logger for debug/info.
vi.mock('../config-service', () => ({
    configService: {
      // Add any config values DIRECTLY used by extractKeywords, broadenQuery, etc.
      // If none, this can be simpler or removed if logger isn't used by helpers.
    },
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));


describe('Query Refinement Helper Utilities', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(preprocessText).mockImplementation(text => text.trim().replace(/\s+/g, ' '));
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('extractKeywords', () => {
    it('should extract relevant keywords and filter common words', () => {
      const text = "This is a sample function for user authentication with a class.";
      // preprocessText is mocked in beforeEach to return a simplified version
      // For this specific test, let's ensure it does what we expect for keyword extraction
      vi.mocked(preprocessText).mockReturnValueOnce(text.toLowerCase().replace(/[.,;:!?(){}[\]"']/g, " "));
      const keywords = extractKeywords(text); 
      expect(keywords).toEqual(expect.arrayContaining(['sample', 'function', 'user', 'authentication', 'class']));
      expect(keywords).not.toContain('this');
      expect(keywords).not.toContain('for');
    });

    it('should return unique keywords', () => {
      const text = "test test keyword keyword";
      vi.mocked(preprocessText).mockReturnValueOnce(text.toLowerCase().replace(/[.,;:!?(){}[\]"']/g, " "));
      const keywords = extractKeywords(text);
      // Using toHaveSameMembers because Set iteration order is not guaranteed for toEqual
      expect(keywords).toEqual(expect.arrayContaining(['test', 'keyword']));
      expect(keywords.length).toBe(2); // Ensure uniqueness
    });

    it('should handle empty or common-word-only strings', () => {
        expect(extractKeywords("the is of and")).toEqual([]);
        expect(extractKeywords("")).toEqual([]);
        expect(extractKeywords("   ")).toEqual([]);
    });
  });

  describe('broadenQuery (direct test)', () => {
    it('should remove specific terms and file extensions', () => {
      const query = "exact specific search for login.ts only";
      const result = broadenQuery(query); 
      expect(result).toBeDefined();
      expect(typeof result).toBe('string');
      expect(result).not.toContain('exact');
      expect(result).not.toContain('specific');
      expect(result).not.toContain('only');
      expect(result).not.toContain('.ts');
      expect(result).toContain('search for login');
    });

    it('should add generic terms if query becomes too short', () => {
      const query = "fix.ts";
      const result = broadenQuery(query);
      expect(result).toBe('fix implementation code');
    });

    it('should handle empty string input', () => {
        const result = broadenQuery("");
        expect(result).toBe(' implementation code'); // As per current logic
    });
  });

  describe('focusQueryBasedOnResults (direct test)', () => {
    it('should add keywords from top results to the query', async () => {
      const originalQuery = "find user";
      const results = [
        { payload: { content: "function processUser(user: UserType)" } },
        { payload: { content: "class UserProfile extends BaseProfile" } },
      ] as DetailedQdrantSearchResult[];
      // preprocessText is mocked in beforeEach
      // extractKeywords will be called internally by focusQueryBasedOnResults
      const focused = focusQueryBasedOnResults(originalQuery, results);
      expect(focused).toBeDefined();
      expect(typeof focused).toBe('string');
      // Based on the simple preprocessText mock and extractKeywords logic:
      // "function processuser user usertype" -> keywords: ["function", "processuser", "user", "usertype"] (approx)
      // "class userprofile extends baseprofile" -> keywords: ["class", "userprofile", "extends", "baseprofile"] (approx)
      // Top 2 might be "function", "processuser" or similar.
      // The exact output depends on the keyword extraction logic and order.
      // Let's check for inclusion of original query and some new keywords.
      expect(focused).toContain("find user");
      expect(focused).toMatch(/function|processuser|class|userprofile/); 
    });

    it('should not change query if no content in results', () => {
        const originalQuery = "find user";
        const results = [
            { payload: { content: "" } },
            { payload: {} } // No content property
        ] as DetailedQdrantSearchResult[];
        const focused = focusQueryBasedOnResults(originalQuery, results);
        expect(focused).toBe(originalQuery);
    });

    it('should handle empty results array', () => {
        const originalQuery = "find user";
        const results: DetailedQdrantSearchResult[] = [];
        const focused = focusQueryBasedOnResults(originalQuery, results);
        expect(focused).toBe(originalQuery); // Should return original query if no results
    });
  });

  describe('tweakQuery (direct test)', () => {
    it('should add file type if not present in query', () => {
      const query = "search login function";
      const results = [{ payload: { filepath: "src/auth/login.ts" } }] as DetailedQdrantSearchResult[];
      const tweaked = tweakQuery(query, results);
      expect(tweaked).toBeDefined();
      expect(typeof tweaked).toBe('string');
      expect(tweaked).toBe("search login function ts");
    });

    it('should add directory if file type present but directory not', () => {
      const query = "search login.ts function";
      const results = [{ payload: { filepath: "src/auth/login.ts" } }] as DetailedQdrantSearchResult[];
      const tweaked = tweakQuery(query, results);
      expect(tweaked).toBeDefined();
      expect(typeof tweaked).toBe('string');
      expect(tweaked).toBe("search login.ts function in src");
    });
    
    it('should not change query if context already present or no context to add', () => {
        const query = "search login.ts function in src";
        const results = [{ payload: { filepath: "src/auth/login.ts" } }] as DetailedQdrantSearchResult[];
        let tweaked = tweakQuery(query, results);
        expect(tweaked).toBeDefined();
        expect(typeof tweaked).toBe('string');
        expect(tweaked).toBe(query);

        const resultsNoPath = [{ payload: { content: "some content" } }] as DetailedQdrantSearchResult[];
        tweaked = tweakQuery("some query", resultsNoPath);
        expect(tweaked).toBeDefined();
        expect(typeof tweaked).toBe('string');
        expect(tweaked).toBe("some query");
    });

    it('should handle empty results array', () => {
        const query = "some query";
        const results: DetailedQdrantSearchResult[] = [];
        const tweaked = tweakQuery(query, results);
        expect(tweaked).toBe(query);
    });

    it('should handle result with no filepath', () => {
        const query = "some query";
        const results = [{ payload: { content: "content without filepath" } }] as DetailedQdrantSearchResult[];
        const tweaked = tweakQuery(query, results);
        expect(tweaked).toBe(query);
    });
  });
});
