import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import git from 'isomorphic-git';
import fs from 'fs/promises'; // For mocking fs.readFile, fs.stat
import nodeFs from 'fs'; // For isomorphic-git's fs parameter
import path from 'path';
import { exec, type ExecException } from 'child_process'; // For mocking exec
import { QdrantClient } from '@qdrant/js-client-rest';

// Import functions to test
import {
    validateGitRepository,
    indexRepository,
    getRepositoryDiff,
    getCommitHistoryWithChanges
} from '../repository';

// Mock dependencies
vi.mock('isomorphic-git', () => ({
  default: { // Assuming 'git' is the default export object from 'isomorphic-git'
    resolveRef: vi.fn(),
    listFiles: vi.fn(),
    log: vi.fn(),
    readCommit: vi.fn(),
    diffTrees: vi.fn(),
    walk: vi.fn(),
    TREE: vi.fn((args: any) => ({ _id: args?.oid || 'mock_tree_id_default', ...args })), // Mock for git.TREE
    // Add any other functions from isomorphic-git that are used by repository.ts
  }
}));
vi.mock('fs/promises');
vi.mock('fs', async (importOriginal) => { // Mock standard 'fs' for isomorphic-git
    const actualFs = await importOriginal<typeof nodeFs>();
    return {
        ...actualFs, // Spread actual fs to keep non-mocked parts if any
        default: { // if isomorphic-git expects default export
            ...actualFs,
        },
    };
});
vi.mock('child_process');
vi.mock('../config-service', () => ({
  configService: {
    COLLECTION_NAME: 'test_collection',
    FILE_INDEXING_CHUNK_SIZE_CHARS: 100, // Small for testing chunking
    FILE_INDEXING_CHUNK_OVERLAP_CHARS: 20,
    // Add any other config values used by repository.ts
  },
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('../ollama'); // For generateEmbedding

// Import mocked versions
import { generateEmbedding } from '../ollama';
import { configService, logger } from '../config-service';

// Define a reusable mock Qdrant client
const mockQdrantClientInstance = {
  upsert: vi.fn(),
  scroll: vi.fn(),
  delete: vi.fn(),
} as unknown as QdrantClient;

describe('Repository Utilities', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('validateGitRepository', () => {
    it('should return true for a valid git repository', async () => {
      vi.mocked(fs.access).mockResolvedValue(undefined);
      vi.mocked(git.resolveRef).mockResolvedValue('refs/heads/main');
      const result = await validateGitRepository('/valid/repo');
      expect(result).toBe(true);
      expect(logger.info).toHaveBeenCalledWith('Valid Git repository at: /valid/repo');
    });

    it('should return false if .git directory is not accessible', async () => {
      vi.mocked(fs.access).mockRejectedValue(new Error('Permission denied'));
      const result = await validateGitRepository('/invalid/repo');
      expect(result).toBe(false);
      expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('Failed to validate Git repository'));
    });

    it('should return false if HEAD cannot be resolved', async () => {
      vi.mocked(fs.access).mockResolvedValue(undefined);
      vi.mocked(git.resolveRef).mockRejectedValue(new Error('No HEAD'));
      const result = await validateGitRepository('/invalid/repo');
      expect(result).toBe(false);
    });
  });

  describe('indexRepository', () => {
    const repoPath = '/test/repo';

    beforeEach(() => {
      // Default scroll mock for indexRepository tests to prevent stale check errors
      // unless a specific test overrides it.
      vi.mocked(mockQdrantClientInstance.scroll).mockResolvedValue({ points: [], next_page_offset: undefined });
    });

    it('should skip indexing if not a valid git repository', async () => {
      // Ensure validateGitRepository (called by indexRepository) returns false
      vi.mocked(fs.access).mockResolvedValue(undefined); // .git dir might exist
      vi.mocked(git.resolveRef).mockRejectedValue(new Error('No HEAD')); // But HEAD is invalid

      await indexRepository(mockQdrantClientInstance, repoPath);
      expect(logger.warn).toHaveBeenCalledWith(`Skipping repository indexing: ${repoPath} is not a valid Git repository`);
      expect(mockQdrantClientInstance.upsert).not.toHaveBeenCalled();
    });
    
    it('should skip indexing if valid git repository but no files to index', async () => {
        // Ensure validateGitRepository (called by indexRepository) returns true
        vi.mocked(fs.access).mockResolvedValue(undefined);
        vi.mocked(git.resolveRef).mockResolvedValue('refs/heads/main');
        vi.mocked(git.listFiles).mockResolvedValue([]); // No files

        await indexRepository(mockQdrantClientInstance, repoPath);
        expect(logger.warn).toHaveBeenCalledWith('No files to index in repository.');
        expect(mockQdrantClientInstance.upsert).not.toHaveBeenCalled();
    });
    
    it('should correctly filter files and skip empty ones', async () => {
        // Ensure validateGitRepository (called by indexRepository) returns true
        vi.mocked(fs.access).mockResolvedValue(undefined);
        vi.mocked(git.resolveRef).mockResolvedValue('refs/heads/main');

        vi.mocked(git.listFiles).mockResolvedValue(['file.ts', 'image.png', 'empty.js', 'node_modules/lib.js']);
        vi.mocked(fs.readFile).mockImplementation(async (fp) => {
            if (fp.toString().endsWith('empty.js')) return '';
            return 'some content';
        });
        vi.mocked(fs.stat).mockResolvedValue({ mtime: new Date() } as any);
        vi.mocked(generateEmbedding).mockResolvedValue([0.1, 0.2]);

        await indexRepository(mockQdrantClientInstance, repoPath);
        expect(logger.info).toHaveBeenCalledWith(expect.stringContaining('Filtered to 2 code files for indexing')); // file.ts and empty.js
        expect(logger.info).toHaveBeenCalledWith(expect.stringContaining('Skipping empty.js: empty file')); // Path is relative in log
        expect(mockQdrantClientInstance.upsert).toHaveBeenCalledTimes(1); // Only for file.ts
        expect(mockQdrantClientInstance.upsert).toHaveBeenCalledWith(configService.COLLECTION_NAME, expect.objectContaining({
            points: [expect.objectContaining({ payload: expect.objectContaining({ filepath: 'file.ts' }) })]
        }));
    });

    it('should index a small file as a single point', async () => {
      // Ensure validateGitRepository (called by indexRepository) returns true
      vi.mocked(fs.access).mockResolvedValue(undefined);
      vi.mocked(git.resolveRef).mockResolvedValue('refs/heads/main');

      vi.mocked(git.listFiles).mockResolvedValue(['small.ts']);
      vi.mocked(fs.readFile).mockResolvedValue('short content'); // Length < CHUNK_SIZE (100)
      vi.mocked(fs.stat).mockResolvedValue({ mtime: new Date() } as any);
      vi.mocked(generateEmbedding).mockResolvedValue([0.1, 0.2, 0.3]);

      await indexRepository(mockQdrantClientInstance, repoPath);
      expect(mockQdrantClientInstance.upsert).toHaveBeenCalledTimes(1);
      expect(mockQdrantClientInstance.upsert).toHaveBeenCalledWith(configService.COLLECTION_NAME, expect.objectContaining({
        points: [expect.objectContaining({
          payload: expect.objectContaining({
            filepath: 'small.ts',
            content: 'short content',
            is_chunked: false,
          }),
        })],
      }));
    });

    it('should index a large file in multiple chunks', async () => {
      // Ensure validateGitRepository (called by indexRepository) returns true
      vi.mocked(fs.access).mockResolvedValue(undefined);
      vi.mocked(git.resolveRef).mockResolvedValue('refs/heads/main');

      vi.mocked(git.listFiles).mockResolvedValue(['large.ts']);
      const longContent = 'a'.repeat(150); // CHUNK_SIZE=100, CHUNK_OVERLAP=20. Chunks: 0-100, 80-180 (actual 80-150)
      vi.mocked(fs.readFile).mockResolvedValue(longContent);
      vi.mocked(fs.stat).mockResolvedValue({ mtime: new Date() } as any);
      vi.mocked(generateEmbedding).mockResolvedValue([0.4, 0.5]);

      await indexRepository(mockQdrantClientInstance, repoPath);
      expect(mockQdrantClientInstance.upsert).toHaveBeenCalledTimes(2); // 2 chunks
      // Chunk 1
      expect(mockQdrantClientInstance.upsert).toHaveBeenCalledWith(configService.COLLECTION_NAME, expect.objectContaining({
        points: [expect.objectContaining({
          payload: expect.objectContaining({
            filepath: 'large.ts',
            content: longContent.substring(0, 100),
            is_chunked: true,
            chunk_index: 0,
            total_chunks: 2,
          }),
        })],
      }));
      // Chunk 2
      expect(mockQdrantClientInstance.upsert).toHaveBeenCalledWith(configService.COLLECTION_NAME, expect.objectContaining({
        points: [expect.objectContaining({
          payload: expect.objectContaining({
            filepath: 'large.ts',
            content: longContent.substring(80, 180), // substring(80, 150+20)
            is_chunked: true,
            chunk_index: 1,
            total_chunks: 2,
          }),
        })],
      }));
    });

    it('should clean up stale entries from Qdrant', async () => {
      // Ensure validateGitRepository (called by indexRepository) returns true
      vi.mocked(fs.access).mockResolvedValue(undefined);
      vi.mocked(git.resolveRef).mockResolvedValue('refs/heads/main');

      vi.mocked(git.listFiles).mockResolvedValue(['current.ts']); // Only current.ts is in the repo
      vi.mocked(fs.readFile).mockResolvedValue('current content');
      vi.mocked(fs.stat).mockResolvedValue({ mtime: new Date() } as any);
      vi.mocked(generateEmbedding).mockResolvedValue([0.1]);

      // Mock Qdrant scroll to simulate existing points
      vi.mocked(mockQdrantClientInstance.scroll)
        .mockResolvedValueOnce({ 
          points: [
            { id: 'stale_id_1', payload: { filepath: 'stale.ts' } }, 
            { id: 'current_id_1', payload: { filepath: 'current.ts' } }
          ], 
          next_page_offset: 'offset1' 
        })
        .mockResolvedValueOnce({ points: [], next_page_offset: undefined }); // End of scroll

      await indexRepository(mockQdrantClientInstance, repoPath);
      
      expect(mockQdrantClientInstance.delete).toHaveBeenCalledWith(configService.COLLECTION_NAME, {
        points: ['stale_id_1'] 
      });
      expect(mockQdrantClientInstance.upsert).toHaveBeenCalledTimes(1); // For current.ts
    });
    
    it('should log error and continue if a single file indexing fails', async () => {
        // Ensure validateGitRepository (called by indexRepository) returns true
        vi.mocked(fs.access).mockResolvedValue(undefined);
        vi.mocked(git.resolveRef).mockResolvedValue('refs/heads/main');

        vi.mocked(git.listFiles).mockResolvedValue(['good.ts', 'bad.ts']);
        vi.mocked(fs.readFile).mockImplementation(async (fp) => {
            if (fp.toString().endsWith('bad.ts')) throw new Error('Read failed for bad.ts');
            return 'content';
        });
        vi.mocked(fs.stat).mockResolvedValue({ mtime: new Date() } as any);
        vi.mocked(generateEmbedding).mockResolvedValue([0.1]);
        
        // Mock Qdrant scroll to prevent errors during stale check for this specific test
        // Ensure it's reset or consistently mocked if multiple scrolls are expected in other tests.
        vi.mocked(mockQdrantClientInstance.scroll).mockResolvedValue({ points: [], next_page_offset: undefined });


        await indexRepository(mockQdrantClientInstance, repoPath);
        expect(logger.error).toHaveBeenCalledWith('Failed to index bad.ts', { message: 'Read failed for bad.ts' }); // Path is relative in logger message
        expect(mockQdrantClientInstance.upsert).toHaveBeenCalledTimes(1); // Only for good.ts
    });
  });

  // getRepositoryDiff tests will now be correctly part of the main describe block
  describe('getRepositoryDiff', () => {
    const repoPath = '/test/diff/repo';
    // const mockExec = exec as vi.MockedFunction<typeof exec>; // Not strictly needed if using vi.mocked(exec)

    // Helper to set up mocks for validateGitRepository to return true and git.log to return commits
    const setupValidRepoAndCommitsMocks = () => {
        vi.mocked(fs.access).mockResolvedValue(undefined as unknown as void); // Allow validate to pass
        vi.mocked(git.resolveRef).mockResolvedValue('refs/heads/main'); // Allow validate to pass
        vi.mocked(git.log).mockResolvedValue([ // Ensure at least two commits
          { oid: 'commit2_oid', commit: { message: 'Second', author: {} as any, committer: {} as any, parent: ['commit1_oid'], tree: 'tree2' } },
          { oid: 'commit1_oid', commit: { message: 'First', author: {} as any, committer: {} as any, parent: [], tree: 'tree1' } }
        ] as any);
    };
    
    // Helper to set up mocks for validateGitRepository to return false (e.g., .git access denied)
    const setupInvalidRepoAccessDeniedMocks = () => {
        vi.mocked(fs.access).mockRejectedValue(new Error('Permission denied'));
        // git.resolveRef and git.log might not be called if fs.access fails first
    };
    // Helper to set up mocks for validateGitRepository to return false (e.g., no HEAD)
    const setupInvalidRepoNoHeadMocks = () => {
        vi.mocked(fs.access).mockResolvedValue(undefined as unknown as void); // .git dir exists
        vi.mocked(git.resolveRef).mockRejectedValue(new Error('No HEAD')); // But HEAD is invalid
        // git.log might not be called if resolveRef fails
    };

    beforeEach(() => {
      // Clear all mocks to ensure clean state for each test in this describe block
      vi.clearAllMocks();
      // Default setup for tests that need a valid repo and commits for diffing
      // Specific tests for invalid repo states will call their own setup helpers.
      setupValidRepoAndCommitsMocks();
    });

    it('should return "No Git repository found" if .git access is denied', async () => {
        setupInvalidRepoAccessDeniedMocks(); // Override beforeEach setup
        const result = await getRepositoryDiff(repoPath);
        expect(result).toBe("No Git repository found");
        expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining(`Failed to validate Git repository at ${repoPath}: Permission denied`));
    });
    
    it('should return "No Git repository found" if HEAD cannot be resolved', async () => {
        setupInvalidRepoNoHeadMocks(); // Override beforeEach setup
        const result = await getRepositoryDiff(repoPath);
        expect(result).toBe("No Git repository found");
        expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining(`Failed to validate Git repository at ${repoPath}: No HEAD`));
    });

    it('should return "No previous commits to compare" if less than 2 commits', async () => {
      // setupValidRepoAndCommitsMocks(); // Already called in beforeEach, but this test needs a different git.log mock
      vi.mocked(fs.access).mockResolvedValue(undefined as unknown as void); // Ensure validateGitRepository can pass
      vi.mocked(git.resolveRef).mockResolvedValue('refs/heads/main');
      vi.mocked(git.log).mockResolvedValue([{ oid: 'commit1', commit: { message: 'Initial', author: {} as any, committer: {} as any, parent: [], tree: 'tree1' } }] as any); // Only one commit
      const result = await getRepositoryDiff(repoPath);
      expect(result).toBe("No previous commits to compare");
    });

    it('should call git diff command and return stdout', async () => {
      // setupValidRepoAndCommitsMocks(); // Called in beforeEach

      vi.mocked(exec).mockImplementation((command, optionsOrCallback, callbackOrUndefined) => {
        const callback = typeof optionsOrCallback === 'function' ? optionsOrCallback : callbackOrUndefined;
        if (callback) {
          if (command === 'git diff commit1_oid commit2_oid') {
            process.nextTick(() => callback(null, 'diff_content_stdout', ''));
          } else {
            process.nextTick(() => callback(new Error(`Unexpected exec command: ${command}`) as ExecException, '', ''));
          }
        }
        // Return a mock ChildProcess object
        return {
          stdout: { on: vi.fn(), pipe: vi.fn() },
          stderr: { on: vi.fn(), pipe: vi.fn() },
          on: vi.fn((event, cbListener) => { if (event === 'close') cbListener(0); }), // Simulate successful exit
        } as any;
      });
      const result = await getRepositoryDiff(repoPath);
      expect(vi.mocked(exec)).toHaveBeenCalledWith(
        'git diff commit1_oid commit2_oid', 
        expect.objectContaining({ cwd: repoPath }),
        expect.any(Function)
      );
      expect(result).toBe('diff_content_stdout');
    });

    it('should truncate long diff output', async () => {
      // setupValidRepoAndCommitsMocks(); // Called in beforeEach
      const longDiff = 'a'.repeat(10001); // MAX_DIFF_LENGTH is 10000
      vi.mocked(exec).mockImplementation((command, optionsOrCallback, callbackOrUndefined) => {
        const callback = typeof optionsOrCallback === 'function' ? optionsOrCallback : callbackOrUndefined;
        if (callback) {
          process.nextTick(() => callback(null, longDiff, ''));
        }
        return {
          stdout: { on: vi.fn(), pipe: vi.fn() },
          stderr: { on: vi.fn(), pipe: vi.fn() },
          on: vi.fn((event, cbListener) => { if (event === 'close') cbListener(0); }),
        } as any;
      });
      const result = await getRepositoryDiff(repoPath);
      expect(result).toContain('... (diff truncated)');
      expect(result.length).toBeLessThanOrEqual(10000 + "\n... (diff truncated)".length);
    });

    it('should handle errors from git diff command', async () => {
      // setupValidRepoAndCommitsMocks(); // Called in beforeEach
      const mockError = new Error('Git command failed') as ExecException;
      (mockError as any).stderr = 'error_stderr'; 

      vi.mocked(exec).mockImplementation((command, optionsOrCallback, callbackOrUndefined) => {
        const callback = typeof optionsOrCallback === 'function' ? optionsOrCallback : callbackOrUndefined;
        if (callback) {
          process.nextTick(() => callback(mockError, '', 'error_stderr'));
        }
        return {
          stdout: { on: vi.fn(), pipe: vi.fn() },
          stderr: { on: vi.fn(), pipe: vi.fn() },
          on: vi.fn((event, cbListener) => { if (event === 'close') cbListener(1); }), // Simulate error exit code
        } as any;
      });
      const result = await getRepositoryDiff(repoPath);
      expect(result).toContain('Failed to retrieve diff: Git command failed');
      expect(logger.error).toHaveBeenCalledWith("Error retrieving git diff", expect.anything());
    });
  });
  
  describe('getCommitHistoryWithChanges', () => {
    const repoPath = '/test/history/repo';

    it('should retrieve commit history with changed files', async () => {
        // Ensure validateGitRepository returns true for this test (though not directly called by getCommitHistoryWithChanges, good practice for consistency if it were)
        vi.mocked(fs.access).mockResolvedValue(undefined);
        vi.mocked(git.resolveRef).mockResolvedValue('refs/heads/main');

        const mockCommits = [
            { oid: 'commit2', commit: { message: 'Feat: new feature', author: { name: 'Test Author', email: 'test@example.com', timestamp: 1672531200, timezoneOffset: 0 }, committer: { name: 'Test Committer', email: 'test@example.com', timestamp: 1672531200, timezoneOffset: 0 }, tree: 'tree2_oid', parent: ['commit1_oid'] } },
            { oid: 'commit1', commit: { message: 'Initial commit', author: { name: 'Test Author', email: 'test@example.com', timestamp: 1672444800, timezoneOffset: 0 }, committer: { name: 'Test Committer', email: 'test@example.com', timestamp: 1672444800, timezoneOffset: 0 }, tree: 'tree1_oid', parent: [] } },
        ];
        vi.mocked(git.log).mockResolvedValue(mockCommits as any); 
        
        vi.mocked(git.readCommit).mockImplementation(async ({ oid }: { oid: string }) => {
            if (oid === 'commit2') return { oid: 'commit2', commit: { tree: 'tree2_oid', parent: ['commit1_oid'], author: mockCommits[0].commit.author, committer: mockCommits[0].commit.committer, message: mockCommits[0].commit.message } } as any;
            if (oid === 'commit1') return { oid: 'commit1', commit: { tree: 'tree1_oid', parent: [], author: mockCommits[1].commit.author, committer: mockCommits[1].commit.committer, message: mockCommits[1].commit.message } } as any;
            // Fallback for parent commit lookup if not explicitly mocked (e.g. during diffTrees for parent)
            if (oid === 'commit1_oid') return { oid: 'commit1_oid', commit: { tree: 'tree1_oid', parent: [], author: mockCommits[1].commit.author, committer: mockCommits[1].commit.committer, message: mockCommits[1].commit.message } } as any; // Ensure parent has a tree
            return { oid: 'unknown', commit: { tree: 'unknown_tree', parent: [], author: {}, committer: {}, message: 'Unknown' } } as any;
        });
        
        vi.mocked(git.diffTrees).mockImplementation(async (args: { fs: any, dir: string, gitdir: string, ref1: string, ref2: string }) => {
            if (args.ref1 === 'tree1_oid' && args.ref2 === 'tree2_oid') { // Diff between commit1 and commit2
                 return [['file.ts', 'modify', 'blob_before', 'blob_after', 'mode_before', 'mode_after']] as any; 
            }
            return [] as any;
        });
        
        vi.mocked(git.walk).mockImplementation(async ({ fs: nodeFs, dir, gitdir, trees, map }) => {
            // Simulate one file 'initial.ts' in the initial commit (tree1_oid)
            const treeOidToWalk = trees[0]._id; // Assuming TREE mock returns {_id: oid}
            if (treeOidToWalk === 'tree1_oid') { 
                 await map('initial.ts', [{ type: async () => 'blob', oid: async () => 'blob_oid_initial' }] as any);
            }
            return [];
        });

        const history = await getCommitHistoryWithChanges(repoPath, { count: 2 });
        expect(history).toHaveLength(2);
        expect(history[0].oid).toBe('commit2');
        expect(history[0].changedFiles).toEqual([{ path: 'file.ts', type: 'modify' }]);
        expect(history[1].oid).toBe('commit1'); // Initial commit
        expect(history[1].changedFiles).toEqual([{ path: 'initial.ts', type: 'add' }]);
    });

    it('should handle errors from git.log', async () => {
        vi.mocked(git.log).mockRejectedValue(new Error('Log failed'));
        await expect(getCommitHistoryWithChanges(repoPath)).rejects.toThrow('Log failed');
    });
  });

});
