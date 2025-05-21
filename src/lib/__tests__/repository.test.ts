import { describe, it, expect, vi, beforeEach, afterEach, type Mock, type MockedFunction } from 'vitest';
import { type ExecException } from 'child_process'; // For type annotation

// 1. Mock 'child_process' and replace 'exec' with a vi.fn() created IN THE FACTORY.
vi.mock('child_process', async (importOriginal) => {
  const actualCp = await importOriginal<typeof import('child_process')>();
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
vi.mock('isomorphic-git', async (importOriginal) => {
  const actual = await importOriginal<typeof import('isomorphic-git')>();
  return {
    ...actual, // Spread actual to keep other exports, then override
    resolveRef: vi.fn(),
    listFiles: vi.fn(),
    log: vi.fn(),
    readCommit: vi.fn(),
    default: vi.fn(),   // Mock the default export, assuming it's diffTrees
    walk: vi.fn(),
    TREE: vi.fn((args: any) => ({ _id: args?.oid || 'mock_tree_id_default', ...args })),
  };
});

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
const importedMockExecAsyncFn = (globalThis as any).__test__mockedPromisifiedExec as Mock;

// Import named mocks from isomorphic-git
import {
  resolveRef as mockedResolveRef,
  listFiles as mockedGitListFiles, // Corresponds to gitListFiles in SUT
  log as mockedGitLog,             // Corresponds to gitLog in SUT
  readCommit as mockedReadCommit,
  // diffTrees as mockedDiffTrees, // Remove named import for diffTrees
  walk as mockedGitWalk,           // Corresponds to gitWalk in SUT
  TREE as MockedGIT_TREE_Func      // Corresponds to GIT_TREE in SUT
} from 'isomorphic-git';
import mockedDiffTrees from 'isomorphic-git'; // Import default for diffTrees
import path from 'path';
import { QdrantClient } from '@qdrant/js-client-rest';


describe('Repository Utilities', () => {
  const repoPath = '/test/diff/repo';
  // Use the imported actualChildProcessExecMock as the execMock reference
  const execMock = actualChildProcessExecMockInstance as MockedFunction<typeof actualChildProcessExecMockInstance>; 
  
  // Renamed for clarity, used in the inner beforeEach
  const setupGitLogWithTwoCommits = () => {
    vi.mocked(mockedGitLog).mockResolvedValue([ // Use mockedGitLog
      { oid: 'commit2_oid', commit: { message: 'Second', author: {} as any, committer: {} as any, parent: ['commit1_oid'], tree: 'tree2' } },
      { oid: 'commit1_oid', commit: { message: 'First', author: {} as any, committer: {} as any, parent: [], tree: 'tree1' } }
    ] as any);
  };
  
  // Renamed for clarity
  const setupGitLogWithSingleCommit = () => {
    vi.mocked(mockedGitLog).mockResolvedValue([ // Use mockedGitLog
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
    

    // Reset all isomorphic-git mocks using named imports
    vi.mocked(mockedResolveRef).mockReset();
    vi.mocked(mockedGitListFiles).mockReset();
    vi.mocked(mockedGitLog).mockReset();
    vi.mocked(mockedReadCommit).mockReset();
    (mockedDiffTrees as Mock).mockReset(); // Reset the default import mock
    vi.mocked(mockedGitWalk).mockReset();
    if (MockedGIT_TREE_Func && typeof (MockedGIT_TREE_Func as Mock).mockClear === 'function') {
        (MockedGIT_TREE_Func as Mock).mockClear();
    }


    (logger.info as Mock).mockClear();
    (logger.warn as Mock).mockClear();
    (logger.error as Mock).mockClear();
    (logger.debug as Mock).mockClear();
  });

  afterEach(() => { vi.restoreAllMocks(); });

  describe('validateGitRepository (direct tests)', () => {
    // These tests use the original implementation of validateGitRepository
    it('should return true for a valid repository', async () => {
      // Configure the specific mock function directly
      vi.mocked(mockedFsAccessImported).mockResolvedValue(undefined as unknown as void);
      vi.mocked(mockedResolveRef).mockResolvedValue('refs/heads/main'); // Use mockedResolveRef
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
      vi.mocked(mockedResolveRef).mockRejectedValueOnce(new Error('No HEAD')); // mockedResolveRef fails
      const result = await repositoryFunctions.validateGitRepository(repoPath);
      expect(result).toBe(false);
    });
  });

  describe('getRepositoryDiff', () => {
    let mockInjectedValidator: Mock< (input: string) => Promise<boolean> >;

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
        expect(vi.mocked(mockedGitLog)).not.toHaveBeenCalled(); // Use mockedGitLog
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
        vi.mocked(mockedGitLog).mockResolvedValue(mockCommits as any); // Use mockedGitLog

        vi.mocked(mockedReadCommit).mockImplementation(async ({ oid }: { oid: string }) => { // Use mockedReadCommit
            if (oid === 'commit2') return { oid: 'commit2', commit: { tree: 'tree2_oid', parent: ['commit1_oid'], author: mockCommits[0].commit.author, committer: mockCommits[0].commit.committer, message: mockCommits[0].commit.message } } as any;
            if (oid === 'commit1') return { oid: 'commit1', commit: { tree: 'tree1_oid', parent: [], author: mockCommits[1].commit.author, committer: mockCommits[1].commit.committer, message: mockCommits[1].commit.message } } as any;
            if (oid === 'commit1_oid') return { oid: 'commit1_oid', commit: { tree: 'tree1_oid', parent: [], author: mockCommits[1].commit.author, committer: mockCommits[1].commit.committer, message: mockCommits[1].commit.message } } as any;
            return { oid: 'unknown', commit: { tree: 'unknown_tree', parent: [], author: {}, committer: {}, message: 'Unknown' } } as any;
        });

        (mockedDiffTrees as Mock).mockImplementation(async (args: { fs: any, dir: string, gitdir: string, ref1: string, ref2: string }) => {
            if (args.ref1 === 'tree1_oid' && args.ref2 === 'tree2_oid') {
                 return [['file.ts', 'modify', 'blob_before', 'blob_after', 'mode_before', 'mode_after']] as any;
            }
            return [] as any;
        });

        vi.mocked(mockedGitWalk).mockImplementation(async ({ fs: nodeFsAlias, dir, gitdir, trees, map }) => { // Use mockedGitWalk
            const treeOidFromMockWalker = (trees[0] as any)._id; // Cast to any to access mock's property
            // For the initial commit, the SUT calls GIT_TREE() which our mock (MockedGIT_TREE_Func) returns as { _id: 'mock_tree_id_default' }
            // The SUT's logic for initial commit uses gitWalk with GIT_TREE()
            // We need to identify if this 'walk' call is for the initial commit.
            // The `trees` arg to walk will be `[{ _id: 'mock_tree_id_default' }]` if SUT calls `GIT_TREE()`.
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
        // However, it does use gitLog, which is what we're testing for failure here.
        vi.mocked(mockedGitLog).mockRejectedValue(new Error('Log failed')); // Use mockedGitLog
        await expect(repositoryFunctions.getCommitHistoryWithChanges(repoPath)).rejects.toThrow('Log failed');
    });
  });
});
