import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { type ExecException } from 'child_process'; // For type annotation
// ... other imports for SUT, fsPromises, git, path, configService, logger ...

// 1. Mock 'child_process' and specifically its 'exec' export
const MOCKED_EXEC_FUNCTION = vi.fn(); // This is the vi.fn() we will control
vi.mock('child_process', async (importOriginal) => {
  const actualCp = await importOriginal<typeof import('child_process')>();
  return {
    ...actualCp, // Keep other child_process exports (like spawn, fork, etc.)
    exec: MOCKED_EXEC_FUNCTION, // Replace 'exec' with our mock function
  };
});

// REMOVE any vi.mock('util', ...) related to promisify.
// The SUT will import the original 'promisify' from 'util' and apply it to our MOCKED_CP_EXEC_FN.

// Mock other external dependencies
vi.mock('isomorphic-git', () => ({
  default: {
    resolveRef: vi.fn(),
    listFiles: vi.fn(),
    log: vi.fn(),
    readCommit: vi.fn(),
    diffTrees: vi.fn(),
    walk: vi.fn(),
    TREE: vi.fn((args: any) => ({ _id: args?.oid || 'mock_tree_id_default', ...args })),
  }
}));
vi.mock('fs/promises', () => ({
  readFile: vi.fn(),
  readdir: vi.fn(),
  access: vi.fn(),
  stat: vi.fn()
}));
vi.mock('../config-service', () => { // Re-add the mock for config-service if it was removed
    const loggerInstance = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
    return {
        __esModule: true, // Important for modules with default exports if ConfigService is one
        configService: {
          COLLECTION_NAME: 'test_collection',
          FILE_INDEXING_CHUNK_SIZE_CHARS: 100,
          FILE_INDEXING_CHUNK_OVERLAP_CHARS: 20,
          // Add any other config values DIRECTLY used by repository.ts
        },
        logger: loggerInstance,
    };
});
vi.mock('../ollama'); // If generateEmbedding is used by repository.ts (it's not directly)

// Import SUT and other necessary modules AFTER all vi.mock calls
import { getRepositoryDiff, validateGitRepository, getCommitHistoryWithChanges, indexRepository } from '../repository';
import { logger, configService } from '../config-service'; // Import configService as well
import { promises as fsPromises } from 'fs'; // For vi.mocked(fsPromises.access)
import git from 'isomorphic-git'; // For vi.mocked(git.log)
import path from 'path';
import { QdrantClient } from '@qdrant/js-client-rest'; // If used by other tests in this file


describe('Repository Utilities', () => {
  // let execSpy: vi.SpyInstance; // Removed
  const repoPath = '/test/diff/repo'; // Define repoPath here for wider scope if needed
  const setupValidRepoAndCommitsMocks = () => {
      vi.mocked(fsPromises.access).mockResolvedValue(undefined as unknown as void);
      vi.mocked(git.resolveRef).mockResolvedValue('refs/heads/main');
      vi.mocked(git.log).mockResolvedValue([
        { oid: 'commit2_oid', commit: { message: 'Second', author: {} as any, committer: {} as any, parent: ['commit1_oid'], tree: 'tree2' } },
        { oid: 'commit1_oid', commit: { message: 'First', author: {} as any, committer: {} as any, parent: [], tree: 'tree1' } }
      ] as any);
  };

  beforeEach(() => {
    vi.clearAllMocks(); // Clears call history and resets implementations to default (empty fn)
    MOCKED_EXEC_FUNCTION.mockReset(); // Reset our specific exec mock

    // Reset mocks for fs/promises and isomorphic-git correctly
    vi.mocked(fsPromises.access).mockReset();
    vi.mocked(fsPromises.readFile).mockReset();
    vi.mocked(fsPromises.readdir).mockReset();
    vi.mocked(fsPromises.stat).mockReset();

    vi.mocked(git.resolveRef).mockReset();
    vi.mocked(git.log).mockReset();
    vi.mocked(git.readCommit).mockReset();
    vi.mocked(git.diffTrees).mockReset();
    vi.mocked(git.walk).mockReset();
    // No need to reset git.TREE as it's a constructor-like mock
    logger.info.mockClear(); 
    logger.warn.mockClear();
    logger.error.mockClear();
    logger.debug.mockClear();
  });

  afterEach(() => { vi.restoreAllMocks(); });

  describe('getRepositoryDiff', () => {
    // repoPath is already defined in the outer scope
    beforeEach(() => { // Scoped beforeEach for getRepositoryDiff tests
        setupValidRepoAndCommitsMocks();
    });

    it('should call git diff command and return stdout', async () => {
      setupValidRepoAndCommitsMocks();
      MOCKED_EXEC_FUNCTION.mockImplementationOnce((_cmd, _opts, callback) => {
        callback(null, 'diff_content_stdout_explicit', '');
      });
      const result = await getRepositoryDiff(repoPath);
      expect(MOCKED_EXEC_FUNCTION).toHaveBeenCalledWith(
        'git diff commit1_oid commit2_oid',
        expect.objectContaining({ cwd: repoPath }),
        expect.any(Function)
      );
      expect(result).toBe('diff_content_stdout_explicit');
    });

    it('should truncate long diff output', async () => {
      setupValidRepoAndCommitsMocks();
      const longDiff = 'a'.repeat(10001);
      MOCKED_EXEC_FUNCTION.mockImplementationOnce((_cmd, _opts, callback) => {
        callback(null, longDiff, '');
      });

      const result = await getRepositoryDiff(repoPath);
      expect(result).toContain('... (diff truncated)');
    });

    it('should handle errors from git diff command', async () => {
      setupValidRepoAndCommitsMocks();
      const mockError = new Error('Git command failed') as ExecException;
      (mockError as any).code = 128; // Standard for many git errors
      const stderrText = 'stderr from exec callback';
      MOCKED_EXEC_FUNCTION.mockImplementationOnce((_cmd, _opts, callback) => {
        callback(mockError, '', stderrText);
      });

      const result = await getRepositoryDiff(repoPath);
      
      expect(result).toBe(`Failed to retrieve diff for ${repoPath}: Git command failed`);
      expect(logger.error).toHaveBeenCalledWith(
        `Error retrieving git diff for ${repoPath}: Git command failed`,
        expect.objectContaining({ // The error object itself is passed as the second arg to logger.error
          message: 'Git command failed',
          code: 128,
          stderr: stderrText,
        })
      );
    });
    
    // Minimal versions of other getRepositoryDiff tests to ensure they exist
    const setupInvalidRepoAccessDeniedMocks = () => {
        vi.mocked(fsPromises.access).mockRejectedValue(new Error('Permission denied'));
    };
    const setupInvalidRepoNoHeadMocks = () => {
        vi.mocked(fsPromises.access).mockResolvedValue(undefined as unknown as void);
        vi.mocked(git.resolveRef).mockRejectedValue(new Error('No HEAD'));
    };

    it('should return "No Git repository found" if .git access is denied', async () => {
        setupInvalidRepoAccessDeniedMocks();
        const result = await getRepositoryDiff(repoPath);
        expect(result).toBe("No Git repository found");
    });
    
    it('should return "No Git repository found" if HEAD cannot be resolved', async () => {
        setupInvalidRepoNoHeadMocks();
        const result = await getRepositoryDiff(repoPath);
        expect(result).toBe("No Git repository found");
    });

    it('should return "No previous commits to compare" if less than 2 commits', async () => {
      vi.mocked(git.log).mockResolvedValue([{ oid: 'commit1', commit: { message: 'Initial', author: {} as any, committer: {} as any, parent: [], tree: 'tree1' } }] as any);
      const result = await getRepositoryDiff(repoPath);
      expect(result).toBe("No previous commits to compare");
    });
  });
  // ... other describe blocks for indexRepository etc.

  describe('getCommitHistoryWithChanges', () => {
    // const repoPath = '/test/history/repo'; // Use repoPath from outer scope or redefine if specific

    it('should retrieve commit history with changed files', async () => {
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
            if (oid === 'commit1_oid') return { oid: 'commit1_oid', commit: { tree: 'tree1_oid', parent: [], author: mockCommits[1].commit.author, committer: mockCommits[1].commit.committer, message: mockCommits[1].commit.message } } as any;
            return { oid: 'unknown', commit: { tree: 'unknown_tree', parent: [], author: {}, committer: {}, message: 'Unknown' } } as any;
        });
        
        vi.mocked(git.diffTrees).mockImplementation(async (args: { fs: any, dir: string, gitdir: string, ref1: string, ref2: string }) => {
            if (args.ref1 === 'tree1_oid' && args.ref2 === 'tree2_oid') {
                 return [['file.ts', 'modify', 'blob_before', 'blob_after', 'mode_before', 'mode_after']] as any; 
            }
            return [] as any;
        });
        
        vi.mocked(git.walk).mockImplementation(async ({ fs: nodeFsAlias, dir, gitdir, trees, map }) => { // Renamed fs to nodeFsAlias
            const treeOidToWalk = trees[0]._id; 
            if (treeOidToWalk === 'tree1_oid') { 
                 await map('initial.ts', [{ type: async () => 'blob', oid: async () => 'blob_oid_initial' }] as any);
            }
            return [];
        });

        const history = await getCommitHistoryWithChanges(repoPath, { count: 2 });
        expect(history).toHaveLength(2);
        expect(history[0].oid).toBe('commit2');
        expect(history[0].changedFiles).toEqual([{ path: 'file.ts', type: 'modify' }]);
        expect(history[1].oid).toBe('commit1');
        expect(history[1].changedFiles).toEqual([{ path: 'initial.ts', type: 'add' }]);
    });

    it('should handle errors from git.log', async () => {
        vi.mocked(git.log).mockRejectedValue(new Error('Log failed'));
        await expect(getCommitHistoryWithChanges(repoPath)).rejects.toThrow('Log failed');
    });
  });
});
