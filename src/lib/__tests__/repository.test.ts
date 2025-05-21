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

vi.mock('fs/promises', () => {
  const accessMock = vi.fn();
  const readFileMock = vi.fn();
  const readdirMock = vi.fn();
  const statMock = vi.fn();
  return {
    __esModule: true,
    default: { 
      access: accessMock,
      readFile: readFileMock,
      readdir: readdirMock,
      stat: statMock
    },
    access: accessMock,
    readFile: readFileMock,
    readdir: readdirMock,
    stat: statMock,
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

// No top-level const mockExecAsyncFn = vi.fn(); anymore

vi.mock('util', async (importOriginal) => {
  const actualUtil = await importOriginal<typeof import('util')>();
  // This is the actual mock function that will be used for the promisified exec
  const internalMockedPromisifiedExec = vi.fn(); 
  
  // Store it on a temporary global to retrieve it in the test file after imports.
  (globalThis as any).__test__mockedPromisifiedExec = internalMockedPromisifiedExec;

  return {
    __esModule: true,
    ...actualUtil,
    promisify: (fnToPromisify: any) => {
      if (fnToPromisify && (fnToPromisify.name === 'exec' || fnToPromisify === actualChildProcessExecMockInstance)) {
        return internalMockedPromisifiedExec;
      }
      return actualUtil.promisify(fnToPromisify);
    },
  };
});

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

// Import exec AFTER mocking child_process. This 'exec' will be the vi.fn() from the factory.
// We need a reference to this instance for the util.promisify mock.
import { exec as actualChildProcessExecMockInstance } from 'child_process';

// Import SUT and other necessary modules AFTER all vi.mock calls
import * as repositoryFunctions from '../repository'; // Import all exports as a namespace
import { logger } from '../config-service'; // configService is mocked, only logger needed here
// Import specific fs/promises methods directly
// We will import the mocked versions of these functions
import { access as mockedFsAccessImported, readFile as mockedFsReadFileImported, readdir as mockedFsReadDirImported, stat as mockedFsStatImported } from 'fs/promises';

// Retrieve the mock function via the globalThis workaround
const importedMockExecAsyncFn = (globalThis as any).__test__mockedPromisifiedExec as vi.Mock;


import * as git from 'isomorphic-git'; // Import as namespace
import path from 'path';
import { QdrantClient } from '@qdrant/js-client-rest';


describe('Repository Utilities', () => {
  const repoPath = '/test/diff/repo';
  // Use the imported actualChildProcessExecMock as the execMock reference
  const execMock = actualChildProcessExecMockInstance as vi.MockedFunction<typeof actualChildProcessExecMockInstance>; 
  
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
    
    // Reset the imported mock functions
    vi.mocked(mockedFsAccessImported).mockReset();
    vi.mocked(mockedFsReadFileImported).mockReset();
    vi.mocked(mockedFsReadDirImported).mockReset();
    vi.mocked(mockedFsStatImported).mockReset();
    

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
      // Configure the specific mock function directly
      vi.mocked(mockedFsAccessImported).mockResolvedValue(undefined as unknown as void);
      vi.mocked(git.resolveRef).mockResolvedValue('refs/heads/main');
      const result = await repositoryFunctions.validateGitRepository(repoPath);
      expect(result).toBe(true);
    });
    it('should return false if .git access is denied', async () => {
      // Configure the specific mock function directly
      vi.mocked(mockedFsAccessImported).mockRejectedValueOnce(new Error('Permission denied'));
      const result = await repositoryFunctions.validateGitRepository(repoPath);
      expect(result).toBe(false);
    });
    it('should return false if HEAD cannot be resolved', async () => {
      // Configure the specific mock function directly
      vi.mocked(mockedFsAccessImported).mockResolvedValue(undefined as unknown as void); // fs.access passes
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
        vi.mocked(importedMockExecAsyncFn).mockReset(); // Reset our new async mock for execAsync
        mockInjectedValidator.mockResolvedValue(true); // Default to valid
        setupGitLogWithTwoCommits();
    });

    it('should call git diff command and return stdout', async () => {
      // Remove: execMock.mockImplementationOnce(...) as importedMockExecAsyncFn handles the async behavior now.
      vi.mocked(importedMockExecAsyncFn).mockResolvedValueOnce({ stdout: 'diff_content_stdout_explicit', stderr: '' });

      const result = await repositoryFunctions.getRepositoryDiff(repoPath, mockInjectedValidator);
      expect(mockInjectedValidator).toHaveBeenCalledWith(repoPath);
      expect(importedMockExecAsyncFn).toHaveBeenCalledWith('git diff commit1_oid commit2_oid', { cwd: repoPath, maxBuffer: 1024 * 1024 * 5 });
      expect(result).toBe('diff_content_stdout_explicit');
    });

    it('should truncate long diff output', async () => {
      const MAX_DIFF_LENGTH_FROM_SUT = 10000;
      const longDiff = 'a'.repeat(MAX_DIFF_LENGTH_FROM_SUT + 1);
      // Remove: execMock.mockImplementationOnce(...)
      vi.mocked(importedMockExecAsyncFn).mockResolvedValueOnce({ stdout: longDiff, stderr: '' });
      const result = await repositoryFunctions.getRepositoryDiff(repoPath, mockInjectedValidator);
      expect(mockInjectedValidator).toHaveBeenCalledWith(repoPath);
      // Add assertion for importedMockExecAsyncFn call
      expect(importedMockExecAsyncFn).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ cwd: repoPath }));
      expect(result).toBe('a'.repeat(MAX_DIFF_LENGTH_FROM_SUT) + "\n... (diff truncated)");
      expect(result).toContain('... (diff truncated)');
    });

    it('should handle errors from git diff command', async () => {
      const mockError = new Error('Git command failed') as ExecException;
      const stderrText = 'stderr from exec callback';
      mockError.code = 128;
      mockError.stderr = stderrText; 

      // Remove: execMock.mockImplementationOnce(...)
      vi.mocked(importedMockExecAsyncFn).mockRejectedValueOnce(mockError); 
      const result = await repositoryFunctions.getRepositoryDiff(repoPath, mockInjectedValidator);
      expect(mockInjectedValidator).toHaveBeenCalledWith(repoPath);
      // Add assertion for importedMockExecAsyncFn call
      expect(importedMockExecAsyncFn).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ cwd: repoPath }));
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
        expect(importedMockExecAsyncFn).not.toHaveBeenCalled(); // Check the async mock
        expect(vi.mocked(git.log)).not.toHaveBeenCalled();
    });

    it('should return "No previous commits to compare" if less than 2 commits (single commit)', async () => {
      // mockInjectedValidator is set to resolve true in beforeEach
      setupGitLogWithSingleCommit();
      const result = await repositoryFunctions.getRepositoryDiff(repoPath, mockInjectedValidator);
      expect(mockInjectedValidator).toHaveBeenCalledWith(repoPath);
      expect(result).toBe("No previous commits to compare");
      expect(importedMockExecAsyncFn).not.toHaveBeenCalled(); // Check the async mock
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
            const treeOidFromMockWalker = (trees[0] as any)._id; // Cast to any to access mock's property
            // For the initial commit, the SUT calls git.TREE() which our mock returns as { _id: 'mock_tree_id_default' }
            // The SUT's logic for initial commit uses git.walk with git.TREE()
            // We need to identify if this 'walk' call is for the initial commit.
            // The `trees` arg to walk will be `[{ _id: 'mock_tree_id_default' }]` if SUT calls `git.TREE()`.
            // Let's assume if map is present and treeOid is the default mock one, it's the initial commit walk.
            if (map && treeOidFromMockWalker === 'mock_tree_id_default') { // Check against the mock's default _id
                 if (map) { // Guard the call to map
                     await map('initial.ts', [{ type: async () => 'blob', oid: async () => 'blob_oid_initial' }] as any);
                 }
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
