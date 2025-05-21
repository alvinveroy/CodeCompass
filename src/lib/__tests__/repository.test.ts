import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'; // Added afterEach
import git from 'isomorphic-git';
import fsPromises from 'fs/promises'; // Explicitly use fsPromises for clarity
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
vi.mock('child_process', () => ({
  exec: vi.fn(),
  // Add other exports like spawn if they were used and need mocking
}));
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

  // ... validateGitRepository tests ...
  // ... indexRepository tests ...

  describe('getRepositoryDiff', () => {
    const repoPath = '/test/diff/repo';

    const setupValidRepoAndCommitsMocks = () => {
        vi.mocked(fsPromises.access).mockResolvedValue(undefined as unknown as void);
        vi.mocked(git.resolveRef).mockResolvedValue('refs/heads/main');
        vi.mocked(git.log).mockResolvedValue([
          { oid: 'commit2_oid', commit: { message: 'Second', author: {} as any, committer: {} as any, parent: ['commit1_oid'], tree: 'tree2' } },
          { oid: 'commit1_oid', commit: { message: 'First', author: {} as any, committer: {} as any, parent: [], tree: 'tree1' } }
        ] as any);
    };
    
    const setupInvalidRepoAccessDeniedMocks = () => {
        vi.mocked(fsPromises.access).mockRejectedValue(new Error('Permission denied'));
    };
    const setupInvalidRepoNoHeadMocks = () => {
        vi.mocked(fsPromises.access).mockResolvedValue(undefined as unknown as void);
        vi.mocked(git.resolveRef).mockRejectedValue(new Error('No HEAD'));
    };

    beforeEach(() => {
      // This beforeEach is scoped to 'getRepositoryDiff'
      // It will run after the outer beforeEach
      setupValidRepoAndCommitsMocks(); // Default setup for these tests
    });

    it('should return "No Git repository found" if .git access is denied', async () => {
        setupInvalidRepoAccessDeniedMocks(); // Override
        const result = await getRepositoryDiff(repoPath);
        expect(result).toBe("No Git repository found");
        // The logger message in validateGitRepository includes the error message
        expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining(`Failed to validate Git repository at ${repoPath}: Permission denied`));
    });
    
    it('should return "No Git repository found" if HEAD cannot be resolved', async () => {
        setupInvalidRepoNoHeadMocks(); // Override
        const result = await getRepositoryDiff(repoPath);
        expect(result).toBe("No Git repository found");
        expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining(`Failed to validate Git repository at ${repoPath}: No HEAD`));
    });

    it('should return "No previous commits to compare" if less than 2 commits', async () => {
      // setupValidRepoAndCommitsMocks(); // Already called by beforeEach of describe('getRepositoryDiff')
      vi.mocked(git.log).mockResolvedValue([{ oid: 'commit1', commit: { message: 'Initial', author: {} as any, committer: {} as any, parent: [], tree: 'tree1' } }] as any);

      // Clear logger mocks specifically for this test.
      // validateGitRepository (called by getRepositoryDiff) might log.
      // We only care about the log from getRepositoryDiff itself in this test.
      logger.info.mockClear(); 
      logger.warn.mockClear();
      logger.error.mockClear();
      // Note: setupValidRepoAndCommitsMocks might also cause logs if it calls validateGitRepository or similar.
      // For this test, we assume validateGitRepository passes silently or its logs are not what we are testing here.

      const result = await getRepositoryDiff(repoPath);
      expect(result).toBe("No previous commits to compare");
      // This is the specific log message from getRepositoryDiff when there are not enough commits.
      expect(logger.info).toHaveBeenCalledWith("Not enough commits to generate a diff.");
    });

    it('should call git diff command and return stdout', async () => {
      // Ensure mocks from setupValidRepoAndCommitsMocks are active
      vi.mocked(exec).mockImplementationOnce((command, options, callback) => {
        // This mock is for the specific call in this test.
        // Assumes options are always passed by promisify.
        if (command === 'git diff commit1_oid commit2_oid') {
          process.nextTick(() => callback(null, 'diff_content_stdout', ''));
        } else {
          process.nextTick(() => callback(new Error(`Test mock: Unexpected exec command: ${command}`), '', ''));
        }
        return { on: vi.fn((event, cb) => { if (event === 'close') cb(0); }), stdout: { on: vi.fn() }, stderr: { on: vi.fn() } } as any; 
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
      const longDiff = 'a'.repeat(10001); // MAX_DIFF_LENGTH is 10000 in repository.ts
      vi.mocked(exec).mockImplementationOnce((command, options, callback) => {
        if (command === 'git diff commit1_oid commit2_oid') {
            process.nextTick(() => callback(null, longDiff, ''));
        } else {
            process.nextTick(() => callback(new Error(`Test mock: Unexpected exec command for truncate: ${command}`), '', ''));
        }
        return { on: vi.fn((event, cb) => { if (event === 'close') cb(0); }), stdout: { on: vi.fn() }, stderr: { on: vi.fn() } } as any;
      });
      const result = await getRepositoryDiff(repoPath);
      expect(result).toContain('... (diff truncated)');
      expect(result.length).toBeLessThanOrEqual(10000 + "\n... (diff truncated)".length);
    });

    it('should handle errors from git diff command', async () => {
      const mockError = new Error('Git command failed') as ExecException;
      (mockError as any).code = 128; // Simulate a git error code
      // stderr is not explicitly set on mockError here, but execAsync passes it if callback provides it.
      // The important part is that the callback receives an error object.

      vi.mocked(exec).mockImplementationOnce((command, options, callback) => {
        if (command === 'git diff commit1_oid commit2_oid') {
            process.nextTick(() => callback(mockError, '', 'error_stderr_content_from_callback'));
        } else {
            process.nextTick(() => callback(new Error(`Test mock: Unexpected exec command for error handling: ${command}`), '', ''));
        }
        return { 
            on: vi.fn((event, cb) => { 
                if (event === 'close' && mockError.code) cb(mockError.code); 
                else if (event === 'close') cb(1);
            }),
            stdout: { on: vi.fn() }, 
            stderr: { on: vi.fn() }, 
        } as any;
      });
      
      // Clear logger before the call, as validateGitRepository might log
      logger.error.mockClear();
      logger.warn.mockClear(); // Also clear warn as validateGitRepository might warn

      const result = await getRepositoryDiff(repoPath);
      
      expect(result).toBe(`Failed to retrieve diff for ${repoPath}: Git command failed`);
      // The actual error object passed to logger.error will be the one from execAsync,
      // which promisify(exec) enhances with stdout and stderr if they were part of the callback.
      expect(logger.error).toHaveBeenCalledWith(
        `Error retrieving git diff for ${repoPath}: Git command failed`, 
        expect.objectContaining({ // Check for properties added by promisify(exec)
            message: 'Git command failed',
            // stderr should be what the callback provided
            stderr: 'error_stderr_content_from_callback', 
            code: 128
        })
      );
    });
  });
  
  // ... getCommitHistoryWithChanges tests ...

  afterEach(() => { 
    vi.restoreAllMocks();
  });
});
/*
// This SEARCH block is intentionally left almost empty to replace the rest of the file
// with the user's provided content for the getCommitHistoryWithChanges tests and the
// new afterEach block. The previous REPLACE block handled the getRepositoryDiff changes.
// The following content is from the user's provided `src/lib/__tests__/repository.test.ts`
// starting from the `getCommitHistoryWithChanges` describe block.

  describe('getCommitHistoryWithChanges', () => {
    const repoPath = '/test/history/repo';

    it('should retrieve commit history with changed files', async () => {
        // Ensure validateGitRepository returns true for this test (though not directly called by getCommitHistoryWithChanges, good practice for consistency if it were)
        vi.mocked(fsPromises.access).mockResolvedValue(undefined as unknown as void);
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

  // This afterEach was missing in the original file provided in the chat for this test file.
  // It's being added as per the user's corrected code.
  afterEach(() => { 
    vi.restoreAllMocks();
  });
});
*/
