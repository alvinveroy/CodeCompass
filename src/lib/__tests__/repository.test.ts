import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { type ExecException } from 'child_process'; // For type annotation

// 1. Mock 'child_process' and replace 'exec' with a vi.fn() created IN THE FACTORY.
vi.mock('child_process', async (importOriginal) => {
  const actualCp = await importOriginal<typeof import('child_process')>();
  return {
    ...actualCp,
    exec: vi.fn(), // This vi.fn() is created when the factory runs.
  };
});

// Import exec AFTER mocking child_process. This 'exec' will be the vi.fn() from the factory.
import { exec } from 'child_process';

// Mock 'fs/promises'
vi.mock('fs/promises', async (importOriginal) => {
  const actualFsPromises = await importOriginal<typeof import('fs/promises')>();
  return {
    ...actualFsPromises,
    readFile: vi.fn(),
    readdir: vi.fn(),
    access: vi.fn(),
    stat: vi.fn(),
  };
});

// Mock 'isomorphic-git'
// isomorphic-git exports named functions. We mock them directly.
vi.mock('isomorphic-git', () => ({
  resolveRef: vi.fn(),
  listFiles: vi.fn(),
  log: vi.fn(),
  readCommit: vi.fn(),
  diffTrees: vi.fn(),
  walk: vi.fn(),
  TREE: vi.fn((args: any) => ({ _id: args?.oid || 'mock_tree_id_default', ...args })),
  // Ensure all functions used by the SUT from isomorphic-git are mocked here
  // If any are missing, add them. E.g., if SUT uses `commit`, add `commit: vi.fn(),`
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
import * as repositoryFunctions from '../repository'; // Import all exports as a namespace
import { logger, configService } from '../config-service';
// Import specific fs/promises methods directly
import { access as fsAccess, readFile, readdir, stat } from 'fs/promises'; // Renamed to avoid potential clashes
import * as git from 'isomorphic-git'; // Import as namespace
import path from 'path';
import { QdrantClient } from '@qdrant/js-client-rest';


describe('Repository Utilities', () => {
  const repoPath = '/test/diff/repo';
  // exec is already the mock from the factory. Cast it for type safety.
  const execMock = exec as vi.MockedFunction<typeof exec>; // More precise type
  
  // Renamed for clarity, used in the inner beforeEach
  const setupGitLogWithTwoCommits = () => {
    vi.mocked(git.log).mockResolvedValue([
      { oid: 'commit2_oid', commit: { message: 'Second', author: {} as any, committer: {} as any, parent: ['commit1_oid'], tree: 'tree2' } },
      { oid: 'commit1_oid', commit: { message: 'First', author: {} as any, committer: {} as any, parent: [], tree: 'tree1' } }
    ] as any);
  };
  
  // Renamed for clarity
  const setupGitLogWithSingleCommit = () => {
    vi.mocked(git.log).mockResolvedValue([
      { oid: 'commit1_oid', commit: { message: 'First', author: {} as any, committer: {} as any, parent: [], tree: 'tree1' } }
    ] as any);
  };

  beforeEach(() => {
    vi.clearAllMocks();
    // execMock is vi.fn() from factory, clearAllMocks resets its state (calls, impls)
    
    // Reset all fs/promises mocks to basic spies
    vi.mocked(fsAccess).mockReset();
    vi.mocked(readFile).mockReset();
    vi.mocked(readdir).mockReset();
    vi.mocked(stat).mockReset();


    // Reset all isomorphic-git mocks
    vi.mocked(git.resolveRef).mockReset();
    vi.mocked(git.listFiles).mockReset();
    vi.mocked(git.log).mockReset();
    vi.mocked(git.readCommit).mockReset();
    vi.mocked(git.diffTrees).mockReset();
    vi.mocked(git.walk).mockReset();
    if (git.TREE && typeof (git.TREE as vi.Mock).mockClear === 'function') { // git.TREE is mocked as vi.fn()
        (git.TREE as vi.Mock).mockClear();
    }


    logger.info.mockClear();
    logger.warn.mockClear();
    logger.error.mockClear();
    logger.debug.mockClear();
  });

  afterEach(() => { vi.restoreAllMocks(); });

  describe('validateGitRepository (direct tests)', () => {
    // These tests use the original implementation of validateGitRepository
    it('should return true for a valid repository', async () => {
      vi.mocked(fsAccess).mockResolvedValue(undefined as unknown as void);
      vi.mocked(git.resolveRef).mockResolvedValue('refs/heads/main');
      const result = await repositoryFunctions.validateGitRepository(repoPath);
      expect(result).toBe(true);
    });
    it('should return false if .git access is denied', async () => {
      vi.mocked(fsAccess).mockRejectedValueOnce(new Error('Permission denied'));
      const result = await repositoryFunctions.validateGitRepository(repoPath);
      expect(result).toBe(false);
    });
    it('should return false if HEAD cannot be resolved', async () => {
      vi.mocked(fsAccess).mockResolvedValue(undefined as unknown as void); // fs.access passes
      vi.mocked(git.resolveRef).mockRejectedValueOnce(new Error('No HEAD')); // git.resolveRef fails
      const result = await repositoryFunctions.validateGitRepository(repoPath);
      expect(result).toBe(false);
    });
  });

  describe('getRepositoryDiff', () => {
    let mockInjectedValidator: vi.Mock<[string], Promise<boolean>>;

    // Setup mocks specifically for tests that expect validateGitRepository to pass
    // This beforeEach establishes the common "happy path" for validateGitRepository and git.log
    beforeEach(async () => {
        // This mock will be passed directly to getRepositoryDiff
        mockInjectedValidator = vi.fn();
        mockInjectedValidator.mockResolvedValue(true); // Default to valid
        setupGitLogWithTwoCommits();
    });

    it('should call git diff command and return stdout', async () => {
      execMock.mockImplementationOnce((_cmd, _opts, callback) => {
        callback(null, 'diff_content_stdout_explicit', '');
      });
      const result = await repositoryFunctions.getRepositoryDiff(repoPath, mockInjectedValidator);
      expect(mockInjectedValidator).toHaveBeenCalledWith(repoPath);
      expect(execMock).toHaveBeenCalledWith(
        'git diff commit1_oid commit2_oid', 
        expect.objectContaining({ cwd: repoPath, maxBuffer: 1024 * 1024 * 5 }), // SUT uses 5MB buffer
        expect.any(Function)
      );
      expect(result).toBe('diff_content_stdout_explicit');
    });

    it('should truncate long diff output', async () => {
      const MAX_DIFF_LENGTH_FROM_SUT = 10000;
      const longDiff = 'a'.repeat(MAX_DIFF_LENGTH_FROM_SUT + 1);
      execMock.mockImplementationOnce((_cmd, _opts, callback) => {
        callback(null, longDiff, '');
      });

      const result = await repositoryFunctions.getRepositoryDiff(repoPath, mockInjectedValidator);
      expect(mockInjectedValidator).toHaveBeenCalledWith(repoPath);
      expect(result).toBe('a'.repeat(MAX_DIFF_LENGTH_FROM_SUT) + "\n... (diff truncated)");
      expect(result).toContain('... (diff truncated)');
    });

    it('should handle errors from git diff command', async () => {
      const mockError = new Error('Git command failed') as ExecException;
      const stderrText = 'stderr from exec callback';
      mockError.code = 128;
      mockError.stderr = stderrText; // Ensure the error object has stderr for the assertion

      execMock.mockImplementationOnce((_cmd, _opts, callback) => {
        callback(mockError, '', stderrText);
      });

      const result = await repositoryFunctions.getRepositoryDiff(repoPath, mockInjectedValidator);
      expect(mockInjectedValidator).toHaveBeenCalledWith(repoPath);
      expect(result).toBe(`Failed to retrieve diff for ${repoPath}: Git command failed`);
      expect(logger.error).toHaveBeenCalledWith(
        `Error retrieving git diff for ${repoPath}: Git command failed`,
        expect.objectContaining({
          message: 'Git command failed',
          code: 128,
          stderr: stderrText, // Now this should match
        })
      );
    });
    
    it('should return "No Git repository found" if validateGitRepository returns false', async () => {
        mockInjectedValidator.mockResolvedValue(false); // Control our specific mock
        const result = await repositoryFunctions.getRepositoryDiff(repoPath, mockInjectedValidator);
        expect(mockInjectedValidator).toHaveBeenCalledWith(repoPath);
        expect(result).toBe("No Git repository found");
        expect(execMock).not.toHaveBeenCalled();
        expect(vi.mocked(git.log)).not.toHaveBeenCalled();
    });

    it('should return "No previous commits to compare" if less than 2 commits (single commit)', async () => {
      // mockInjectedValidator is set to resolve true in beforeEach
      setupGitLogWithSingleCommit();
      const result = await repositoryFunctions.getRepositoryDiff(repoPath, mockInjectedValidator);
      expect(mockInjectedValidator).toHaveBeenCalledWith(repoPath);
      expect(result).toBe("No previous commits to compare");
      expect(execMock).not.toHaveBeenCalled();
    });
  });

  describe('getCommitHistoryWithChanges', () => {
    it('should retrieve commit history with changed files', async () => {
        // No need to mock validateGitRepository here as it's not called by getCommitHistoryWithChanges

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

        vi.mocked(git.walk).mockImplementation(async ({ fs: nodeFsAlias, dir, gitdir, trees, map }) => {
            const treeOidToWalk = trees[0]._id;
            if (treeOidToWalk === 'tree1_oid') {
                 await map('initial.ts', [{ type: async () => 'blob', oid: async () => 'blob_oid_initial' }] as any);
            }
            return [];
        });

        const history = await repositoryFunctions.getCommitHistoryWithChanges(repoPath, { count: 2 });
        expect(history).toHaveLength(2);
        expect(history[0].oid).toBe('commit2');
        expect(history[0].changedFiles).toEqual([{ path: 'file.ts', type: 'modify' }]);
        expect(history[1].oid).toBe('commit1');
        expect(history[1].changedFiles).toEqual([{ path: 'initial.ts', type: 'add' }]);
    });

    it('should handle errors from git.log', async () => {
        // Ensure validateGitRepository conditions are met if it's called by SUT,
        // though getCommitHistoryWithChanges doesn't call validateGitRepository directly.
        // However, it does use git.log, which is what we're testing for failure here.
        vi.mocked(git.log).mockRejectedValue(new Error('Log failed'));
        await expect(repositoryFunctions.getCommitHistoryWithChanges(repoPath)).rejects.toThrow('Log failed');
    });
  });
});
