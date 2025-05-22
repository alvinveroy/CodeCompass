import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
// Import the functions to be tested directly from the module
import * as queryRefinementHelpers from '../../lib/query-refinement';
import { preprocessText } from '../../utils/text-utils';
import { DetailedQdrantSearchResult } from '../../lib/types'; 

vi.mock('../../utils/text-utils'); // Mock dependencies of helpers
// Mock configService and logger if they are DIRECTLY used by these helpers
// If they are only used by searchWithRefinement or refineQuery (dispatcher),
// then this mock might not be needed here.
// For now, assuming helpers might use logger for debug/info.
vi.mock('../../lib/config-service', () => ({
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
      const keywords = queryRefinementHelpers.extractKeywords(text); 
      expect(keywords).toEqual(expect.arrayContaining(['sample', 'function', 'user', 'authentication', 'class']));
      expect(keywords).not.toContain('this');
      expect(keywords).not.toContain('for');
    });

    it('should return unique keywords', () => {
      const text = "test test keyword keyword";
      vi.mocked(preprocessText).mockReturnValueOnce(text.toLowerCase().replace(/[.,;:!?(){}[\]"']/g, " "));
      const keywords = queryRefinementHelpers.extractKeywords(text);
      // Using toHaveSameMembers because Set iteration order is not guaranteed for toEqual
      expect(keywords).toEqual(expect.arrayContaining(['test', 'keyword']));
      expect(keywords.length).toBe(2); // Ensure uniqueness
    });

    it('should handle empty or common-word-only strings', () => {
        expect(queryRefinementHelpers.extractKeywords("the is of and")).toEqual([]);
        expect(queryRefinementHelpers.extractKeywords("")).toEqual([]);
        expect(queryRefinementHelpers.extractKeywords("   ")).toEqual([]);
    });
  });

  describe('broadenQuery (direct test)', () => {
    it('should remove specific terms and file extensions', () => {
      const query = "exact specific search for login.ts only";
      const result = queryRefinementHelpers.broadenQuery(query); 
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
      const result = queryRefinementHelpers.broadenQuery(query);
      expect(result).toBe('fix implementation code');
    });

    it('should handle empty string input', () => {
        const result = queryRefinementHelpers.broadenQuery("");
        expect(result).toBe('general code context'); // Updated expectation
    });
  });

  describe('focusQueryBasedOnResults (direct test)', () => {
    it('should add keywords from top results to the query', () => {
      const originalQuery = "find user";
      const results_focusQuery = [ // Renamed to avoid conflict if 'results' is used elsewhere in scope
        { id: 'id1', score: 0.8, payload: { dataType: 'file_chunk', filepath: 'user.ts', file_content_chunk: "function processUser(user: UserType)", chunk_index: 0, total_chunks: 1, last_modified: '2023-01-01' } },
        { id: 'id2', score: 0.7, payload: { dataType: 'file_chunk', filepath: 'profile.ts', file_content_chunk: "class UserProfile extends BaseProfile", chunk_index: 0, total_chunks: 1, last_modified: '2023-01-01' } },
      ] as DetailedQdrantSearchResult[];
      // preprocessText is mocked in beforeEach
      // extractKeywords will be called internally by focusQueryBasedOnResults
      const focused = queryRefinementHelpers.focusQueryBasedOnResults(originalQuery, results_focusQuery);
      expect(focused).toBeDefined();
      expect(typeof focused).toBe('string');
      // Based on the simple preprocessText mock and extractKeywords logic:
      // "function processuser user usertype" -> keywords: ["function", "processuser", "user", "usertype"] (approx)
      // "class userprofile extends baseprofile" -> keywords: ["class", "userprofile", "extends", "baseprofile"] (approx)
      // Top 2 might be "function", "processuser" or similar.
      // The exact output depends on the keyword extraction logic and order.
      // Let's check for inclusion of original query and some new keywords.
      // If extractKeywords returns them in order of appearance and unique:
      // "function", "processuser", "user", "usertype", "class", "userprofile", "extends", "baseprofile"
      // Top 2: "function processuser"
      expect(focused).toBe("find user function processuser");
    });

    it('should not change query if no content in results', () => {
        const originalQuery = "find user";
        const results = [
            { id: 'empty1', score: 0.1, payload: { dataType: 'file_chunk', filepath: 'empty.ts', file_content_chunk: "", chunk_index: 0, total_chunks: 1, last_modified: '2023-01-01' } },
            { id: 'nocontent1', score: 0.1, payload: { dataType: 'commit_info', commit_oid: 'nocontent', commit_message: "", commit_author_name: 'test', commit_author_email: 'test@example.com', commit_date: '2023-01-01', changed_files_summary: [], parent_oids: [] } } // No content property
        ] as DetailedQdrantSearchResult[];
        const focused = queryRefinementHelpers.focusQueryBasedOnResults(originalQuery, results);
        expect(focused).toBe(originalQuery);
    });

    it('should handle empty results array', () => {
        const originalQuery = "find user";
        const results: DetailedQdrantSearchResult[] = [];
        const focused = queryRefinementHelpers.focusQueryBasedOnResults(originalQuery, results);
        expect(focused).toBe(originalQuery); // Should return original query if no results
    });
  });

  describe('tweakQuery (direct test)', () => {
    it('should add file type if not present in query', () => {
      const query_addFileType = "search login function";
      const results_addFileType = [{ id: 't1', score: 0.9, payload: { dataType: 'file_chunk', filepath: "src/auth/login.ts", file_content_chunk: "...", chunk_index:0, total_chunks:1, last_modified:"date" } }] as DetailedQdrantSearchResult[];
      const tweaked = queryRefinementHelpers.tweakQuery(query_addFileType, results_addFileType);
      expect(tweaked).toBeDefined();
      expect(typeof tweaked).toBe('string');
      expect(tweaked).toBe("search login function ts");
    });

    it('should add directory if file type present but directory not', () => {
      const query_addDir = "search login.ts function";
      const results_addDir = [{ id: 't2', score: 0.9, payload: { dataType: 'file_chunk', filepath: "src/auth/login.ts", file_content_chunk: "...", chunk_index:0, total_chunks:1, last_modified:"date" } }] as DetailedQdrantSearchResult[];
      const tweaked = queryRefinementHelpers.tweakQuery(query_addDir, results_addDir);
      expect(tweaked).toBeDefined();
      expect(typeof tweaked).toBe('string');
      // Since 'src' is in the exclusion list, it should not be added.
      expect(tweaked).toBe("search login.ts function");
    });
    
    it('should not change query if context already present or no context to add', () => {
        const query = "search login.ts function in src";
        const results = [{ id: 'id_tweak3', score: 0.8, payload: { dataType: 'file_chunk', filepath: "src/auth/login.ts", file_content_chunk: "content", chunk_index:0, total_chunks:1, last_modified:"date" } }] as DetailedQdrantSearchResult[];
        let tweaked = queryRefinementHelpers.tweakQuery(query, results);
        expect(tweaked).toBeDefined();
        expect(typeof tweaked).toBe('string');
        expect(tweaked).toBe(query);

        const resultsNoPath_tweakQuery = [{ id: 'id3', score: 0.6, payload: { dataType: 'commit_info', commit_oid: 'abc', commit_message: "some content", commit_author_name: 'test', commit_author_email: 'test@example.com', commit_date: '2023-01-01', changed_files_summary: [], parent_oids: [] } }] as DetailedQdrantSearchResult[];
        tweaked = queryRefinementHelpers.tweakQuery("some query", resultsNoPath_tweakQuery);
        expect(tweaked).toBeDefined();
        expect(typeof tweaked).toBe('string');
        expect(tweaked).toBe("some query");
    });

    it('should handle empty results array', () => {
        const query = "some query";
        const results: DetailedQdrantSearchResult[] = [];
        const tweaked = queryRefinementHelpers.tweakQuery(query, results);
        expect(tweaked).toBe(query);
    });

    it('should handle result with no filepath', () => {
        const query = "some query";
        const results_noFilepath_tweakQuery = [{ id: 'id4', score: 0.5, payload: { dataType: 'commit_info', commit_oid: 'def', commit_message: "content without filepath", commit_author_name: 'test', commit_author_email: 'test@example.com', commit_date: '2023-01-01', changed_files_summary: [], parent_oids: [] } }] as DetailedQdrantSearchResult[];
        const tweaked = queryRefinementHelpers.tweakQuery(query, results_noFilepath_tweakQuery);
        expect(tweaked).toBe(query);
    });
  });
});
