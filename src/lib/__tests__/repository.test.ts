import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { type ExecException } from 'child_process'; // For type annotation

// 1. Define ALL mock functions at the top level.
const MOCKED_CP_EXEC_FN = vi.fn();
vi.mock('child_process', () => ({
  exec: MOCKED_CP_EXEC_FN,
}));

const MOCK_FS_PROMISES_READFILE_FN = vi.fn();
const MOCK_FS_PROMISES_READDIR_FN = vi.fn();
const MOCK_FS_PROMISES_ACCESS_FN = vi.fn();
const MOCK_FS_PROMISES_STAT_FN = vi.fn();
vi.mock('fs/promises', () => ({
  readFile: MOCK_FS_PROMISES_READFILE_FN,
  readdir: MOCK_FS_PROMISES_READDIR_FN,
  access: MOCK_FS_PROMISES_ACCESS_FN,
  stat: MOCK_FS_PROMISES_STAT_FN,
}));

const MOCK_GIT_RESOLVE_REF_FN = vi.fn();
const MOCK_GIT_LIST_FILES_FN = vi.fn();
const MOCK_GIT_LOG_FN = vi.fn();
const MOCK_GIT_READ_COMMIT_FN = vi.fn();
const MOCK_GIT_DIFF_TREES_FN = vi.fn();
const MOCK_GIT_WALK_FN = vi.fn();
const MOCK_GIT_TREE_FN = vi.fn((args: any) => ({ _id: args?.oid || 'mock_tree_id_default', ...args }));
vi.mock('isomorphic-git', () => ({
  default: { 
    resolveRef: MOCK_GIT_RESOLVE_REF_FN,
    listFiles: MOCK_GIT_LIST_FILES_FN,
    log: MOCK_GIT_LOG_FN,
    readCommit: MOCK_GIT_READ_COMMIT_FN,
    diffTrees: MOCK_GIT_DIFF_TREES_FN,
    walk: MOCK_GIT_WALK_FN,
    TREE: MOCK_GIT_TREE_FN,
  }
}));

// Mock other external dependencies
vi.mock('../config-service', () => {
    const loggerInstance = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
    return {
        __esModule: true,
        configService: {
          COLLECTION_NAME: 'test_collection',
          FILE_INDEXING_CHUNK_SIZE_CHARS: 100,
          FILE_INDEXING_CHUNK_OVERLAP_CHARS: 20,
        },
        logger: loggerInstance,
    };
});
vi.mock('../ollama'); 

// Import SUT and other necessary modules AFTER all vi.mock calls
import { getRepositoryDiff, validateGitRepository, getCommitHistoryWithChanges, indexRepository } from '../repository';
import { logger, configService } from '../config-service';
// Import the top-level mock functions for fs/promises and git to use in vi.mocked() if needed,
// or directly use MOCK_FS_PROMISES_ACCESS_FN etc.
// For consistency with vi.mocked, we can import the mocked modules.
import { promises as fsPromises } from 'fs';
import git from 'isomorphic-git';
import path from 'path';
import { QdrantClient } from '@qdrant/js-client-rest';


describe('Repository Utilities', () => {
  const repoPath = '/test/diff/repo'; 
  const setupValidRepoAndCommitsMocks = () => {
      MOCK_FS_PROMISES_ACCESS_FN.mockResolvedValue(undefined as unknown as void);
      MOCK_GIT_RESOLVE_REF_FN.mockResolvedValue('refs/heads/main');
      MOCK_GIT_LOG_FN.mockResolvedValue([
        { oid: 'commit2_oid', commit: { message: 'Second', author: {} as any, committer: {} as any, parent: ['commit1_oid'], tree: 'tree2' } },
        { oid: 'commit1_oid', commit: { message: 'First', author: {} as any, committer: {} as any, parent: [], tree: 'tree1' } }
      ] as any);
  };

  beforeEach(() => {
    vi.clearAllMocks(); 
    MOCKED_CP_EXEC_FN.mockReset();
    MOCK_FS_PROMISES_ACCESS_FN.mockReset();
    MOCK_FS_PROMISES_READFILE_FN.mockReset();
    MOCK_FS_PROMISES_READDIR_FN.mockReset();
    MOCK_FS_PROMISES_STAT_FN.mockReset();
    MOCK_GIT_RESOLVE_REF_FN.mockReset();
    MOCK_GIT_LOG_FN.mockReset();
    MOCK_GIT_READ_COMMIT_FN.mockReset();
    MOCK_GIT_DIFF_TREES_FN.mockReset();
    MOCK_GIT_WALK_FN.mockReset();
    MOCK_GIT_TREE_FN.mockClear(); // For constructor-like mocks, .mockClear() is often sufficient

    logger.info.mockClear(); 
    logger.warn.mockClear();
    logger.error.mockClear();
    logger.debug.mockClear();
  });

  afterEach(() => { vi.restoreAllMocks(); });

  describe('getRepositoryDiff', () => {
    beforeEach(() => { 
        setupValidRepoAndCommitsMocks();
    });

    it('should call git diff command and return stdout', async () => {
      setupValidRepoAndCommitsMocks();
      MOCKED_CP_EXEC_FN.mockImplementationOnce((_cmd, _opts, callback) => {
        callback(null, 'diff_content_stdout_explicit', '');
      });
      const result = await getRepositoryDiff(repoPath);
      expect(MOCKED_CP_EXEC_FN).toHaveBeenCalledWith(
        'git diff commit1_oid commit2_oid',
        expect.objectContaining({ cwd: repoPath }),
        expect.any(Function)
      );
      expect(result).toBe('diff_content_stdout_explicit');
    });

    it('should truncate long diff output', async () => {
      setupValidRepoAndCommitsMocks();
      const longDiff = 'a'.repeat(10001);
      MOCKED_CP_EXEC_FN.mockImplementationOnce((_cmd, _opts, callback) => {
        callback(null, longDiff, '');
      });

      const result = await getRepositoryDiff(repoPath);
      expect(result).toContain('... (diff truncated)');
    });

    it('should handle errors from git diff command', async () => {
      setupValidRepoAndCommitsMocks();
      const mockError = new Error('Git command failed') as ExecException;
      (mockError as any).code = 128; 
      const stderrText = 'stderr from exec callback';
      MOCKED_CP_EXEC_FN.mockImplementationOnce((_cmd, _opts, callback) => {
        callback(mockError, '', stderrText);
      });

      const result = await getRepositoryDiff(repoPath);
      
      expect(result).toBe(`Failed to retrieve diff for ${repoPath}: Git command failed`);
      expect(logger.error).toHaveBeenCalledWith(
        `Error retrieving git diff for ${repoPath}: Git command failed`,
        expect.objectContaining({ 
          message: 'Git command failed',
          code: 128,
          stderr: stderrText,
        })
      );
    });
    
    const setupInvalidRepoAccessDeniedMocks = () => {
        MOCK_FS_PROMISES_ACCESS_FN.mockRejectedValue(new Error('Permission denied'));
    };
    const setupInvalidRepoNoHeadMocks = () => {
        MOCK_FS_PROMISES_ACCESS_FN.mockResolvedValue(undefined as unknown as void);
        MOCK_GIT_RESOLVE_REF_FN.mockRejectedValue(new Error('No HEAD'));
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
      MOCK_GIT_LOG_FN.mockResolvedValue([{ oid: 'commit1', commit: { message: 'Initial', author: {} as any, committer: {} as any, parent: [], tree: 'tree1' } }] as any);
      const result = await getRepositoryDiff(repoPath);
      expect(result).toBe("No previous commits to compare");
    });
  });

  describe('getCommitHistoryWithChanges', () => {
    it('should retrieve commit history with changed files', async () => {
        MOCK_FS_PROMISES_ACCESS_FN.mockResolvedValue(undefined as unknown as void);
        MOCK_GIT_RESOLVE_REF_FN.mockResolvedValue('refs/heads/main');

        const mockCommits = [
            { oid: 'commit2', commit: { message: 'Feat: new feature', author: { name: 'Test Author', email: 'test@example.com', timestamp: 1672531200, timezoneOffset: 0 }, committer: { name: 'Test Committer', email: 'test@example.com', timestamp: 1672531200, timezoneOffset: 0 }, tree: 'tree2_oid', parent: ['commit1_oid'] } },
            { oid: 'commit1', commit: { message: 'Initial commit', author: { name: 'Test Author', email: 'test@example.com', timestamp: 1672444800, timezoneOffset: 0 }, committer: { name: 'Test Committer', email: 'test@example.com', timestamp: 1672444800, timezoneOffset: 0 }, tree: 'tree1_oid', parent: [] } },
        ];
        MOCK_GIT_LOG_FN.mockResolvedValue(mockCommits as any); 
        
        MOCK_GIT_READ_COMMIT_FN.mockImplementation(async ({ oid }: { oid: string }) => {
            if (oid === 'commit2') return { oid: 'commit2', commit: { tree: 'tree2_oid', parent: ['commit1_oid'], author: mockCommits[0].commit.author, committer: mockCommits[0].commit.committer, message: mockCommits[0].commit.message } } as any;
            if (oid === 'commit1') return { oid: 'commit1', commit: { tree: 'tree1_oid', parent: [], author: mockCommits[1].commit.author, committer: mockCommits[1].commit.committer, message: mockCommits[1].commit.message } } as any;
            if (oid === 'commit1_oid') return { oid: 'commit1_oid', commit: { tree: 'tree1_oid', parent: [], author: mockCommits[1].commit.author, committer: mockCommits[1].commit.committer, message: mockCommits[1].commit.message } } as any;
            return { oid: 'unknown', commit: { tree: 'unknown_tree', parent: [], author: {}, committer: {}, message: 'Unknown' } } as any;
        });
        
        MOCK_GIT_DIFF_TREES_FN.mockImplementation(async (args: { fs: any, dir: string, gitdir: string, ref1: string, ref2: string }) => {
            if (args.ref1 === 'tree1_oid' && args.ref2 === 'tree2_oid') {
                 return [['file.ts', 'modify', 'blob_before', 'blob_after', 'mode_before', 'mode_after']] as any; 
            }
            return [] as any;
        });
        
        MOCK_GIT_WALK_FN.mockImplementation(async ({ fs: nodeFsAlias, dir, gitdir, trees, map }) => { 
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
        MOCK_GIT_LOG_FN.mockRejectedValue(new Error('Log failed'));
        await expect(getCommitHistoryWithChanges(repoPath)).rejects.toThrow('Log failed');
    });
  });
});
