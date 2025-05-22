import { describe, it, expect, vi, beforeEach, afterEach, type Mock, type MockedFunction } from 'vitest';
import { type ExecException } from 'child_process'; // For type annotation

// 1. Mock 'child_process' and replace 'exec' with a vi.fn() created IN THE FACTORY.
vi.mock('child_process', async (importOriginal) => {
  const _actualCp = await importOriginal<typeof import('child_process')>(); 
  return {
    ..._actualCp,
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
  const _actual = await importOriginal<typeof import('isomorphic-git')>(); 
  return {
    // ..._actual, // Spread actual to keep other exports // This was causing issues with TREE mock
    resolveRef: vi.fn(),
    listFiles: vi.fn(),
    log: vi.fn(),
    readCommit: vi.fn(),
    // diffTrees: vi.fn(), // No longer directly called by SUT's getCommitHistoryWithChanges
    walk: vi.fn(),
    TREE: vi.fn((args?: { ref?: string; oid?: string }) => ({
      // Simulate Walker object structure expected by SUT's git.TREE({ ref: treeOid })
      // The mock TREE needs to return something that walk's `trees` parameter can use.
      // The important part for the mock is that `trees[0]._id` or similar can be accessed if the test relies on it.
      // If `args.ref` is passed (as in the new SUT code), use it for identification.
      _id: args?.ref || args?.oid || 'mock_tree_id_default',
      ...args
    })),
  };
});


vi.mock('util', async (importOriginal) => {
  const actualUtil = await importOriginal<typeof import('util')>();
  // This is the actual mock function that will be used for the promisified exec
  const internalMockedPromisifiedExec = vi.fn(); 
  
  // Store it on a temporary global to retrieve it in the test file after imports.
  // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
  (globalThis as any).__test__mockedPromisifiedExec = internalMockedPromisifiedExec;

  return {
    __esModule: true,
    ...actualUtil,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    promisify: (fnToPromisify: (...args: any[]) => any) => {
      if (fnToPromisify && (typeof fnToPromisify.name === 'string' && fnToPromisify.name === 'exec' || fnToPromisify === actualChildProcessExecMockInstance)) {
        return internalMockedPromisifiedExec;
      }
      return actualUtil.promisify(fnToPromisify as (...args: never[]) => unknown);
    },
  };
});

// Mock other external dependencies
vi.mock('../../lib/config-service', () => {
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
vi.mock('../../lib/ollama'); 

// Import exec AFTER mocking child_process. This 'exec' will be the vi.fn() from the factory.
// We need a reference to this instance for the util.promisify mock.
import { exec as actualChildProcessExecMockInstance } from 'child_process';

// Import SUT and other necessary modules AFTER all vi.mock calls
import * as repositoryFunctions from '../../lib/repository'; // Import all exports as a namespace
import { logger } from '../../lib/config-service'; // configService is mocked, only logger needed here
// Import specific fs/promises methods directly
// We will import the mocked versions of these functions
import { access as mockedFsAccessImported, readFile as mockedFsReadFileImported, readdir as mockedFsReadDirImported, stat as mockedFsStatImported } from 'fs/promises';

// Retrieve the mock function via the globalThis workaround
// eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-member-access
const importedMockExecAsyncFn = (globalThis as any).__test__mockedPromisifiedExec as Mock; 

// Import named mocks from isomorphic-git
import * as git from 'isomorphic-git'; // Import as namespace
// import { QdrantClient } from '@qdrant/js-client-rest'; // _QdrantClient if used


describe('Repository Utilities', () => {
  const repoPath = '/test/diff/repo';
  // Use the imported actualChildProcessExecMock as the execMock reference
  const _execMock = actualChildProcessExecMockInstance as MockedFunction<typeof actualChildProcessExecMockInstance>; 
  
  // Renamed for clarity, used in the inner beforeEach
  const setupGitLogWithTwoCommits = () => {
    const mockAuthor = { name: 'Test', email: 'test@example.com', timestamp: Date.now() / 1000, timezoneOffset: 0 };
    vi.mocked(git.log).mockResolvedValue([
       
      { oid: 'commit2_oid', commit: { message: 'Second', author: mockAuthor, committer: mockAuthor, parent: ['commit1_oid'], tree: 'tree2' } },
       
      { oid: 'commit1_oid', commit: { message: 'First', author: mockAuthor, committer: mockAuthor, parent: [], tree: 'tree1' } }
    ] as unknown as import('isomorphic-git').ReadCommitResult[]);
  };
  
  // Renamed for clarity
  const setupGitLogWithSingleCommit = () => {
    const mockAuthor = { name: 'Test', email: 'test@example.com', timestamp: Date.now() / 1000, timezoneOffset: 0 };
    vi.mocked(git.log).mockResolvedValue([
       
      { oid: 'commit1_oid', commit: { message: 'First', author: mockAuthor, committer: mockAuthor, parent: [], tree: 'tree1' } }
    ] as unknown as import('isomorphic-git').ReadCommitResult[]);
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
    vi.mocked(git.resolveRef).mockReset();
    vi.mocked(git.listFiles).mockReset();
    vi.mocked(git.log).mockReset();
    vi.mocked(git.readCommit).mockReset();
    // vi.mocked(git.diffTrees)?.mockReset(); // diffTrees is no longer directly called by the SUT function being tested here
    vi.mocked(git.walk).mockReset();
    if (git.TREE && typeof (git.TREE as Mock).mockClear === 'function') {
        (git.TREE as Mock).mockClear();
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
      vi.mocked(git.resolveRef).mockResolvedValue('refs/heads/main'); // Use mockedResolveRef
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
      vi.mocked(git.resolveRef).mockRejectedValueOnce(new Error('No HEAD')); // mockedResolveRef fails
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
        // eslint-disable-next-line @typescript-eslint/require-await -- Linter false positive: mockResolvedValue is correct for async mock
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
      vi.mocked(importedMockExecAsyncFn).mockResolvedValueOnce({ stdout: longDiff, stderr: '' } as { stdout: string; stderr: string });
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
        expect(vi.mocked(git.log)).not.toHaveBeenCalled(); // Use mockedGitLog
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

        // Define a more specific type for mock commit objects
        type MockCommitAuthor = { name: string; email: string; timestamp: number; timezoneOffset: number };
        type MockCommitData = {
          message: string;
          author: MockCommitAuthor;
          committer: MockCommitAuthor;
          tree: string;
          parent: string[];
        };
        type MockReadCommitResult = { oid: string; commit: MockCommitData };

        const mockCommits: MockReadCommitResult[] = [
            { oid: 'commit2', commit: { message: 'Feat: new feature', author: { name: 'Test Author', email: 'test@example.com', timestamp: 1672531200, timezoneOffset: 0 }, committer: { name: 'Test Committer', email: 'test@example.com', timestamp: 1672531200, timezoneOffset: 0 }, tree: 'tree2_oid', parent: ['commit1_oid'] } },
            { oid: 'commit1', commit: { message: 'Initial commit', author: { name: 'Test Author', email: 'test@example.com', timestamp: 1672444800, timezoneOffset: 0 }, committer: { name: 'Test Committer', email: 'test@example.com', timestamp: 1672444800, timezoneOffset: 0 }, tree: 'tree1_oid', parent: [] } },
        ];
        vi.mocked(git.log).mockResolvedValue(mockCommits as unknown as import('isomorphic-git').ReadCommitResult[]); 

        vi.mocked(git.readCommit).mockImplementation(({ oid }: { oid: string }) => {
            // Find the commit in our typed mockCommits array
            const foundCommit = mockCommits.find(c => c.oid === oid || (oid.endsWith('_oid') && c.commit.tree === oid)); // Handle tree oids if passed
            if (foundCommit) {
                return Promise.resolve({
                    oid: foundCommit.oid,
                    commit: { // Ensure all fields expected by ReadCommitResult are present
                        ...foundCommit.commit, // Spread the well-typed commit data
                    }
                } as unknown as import('isomorphic-git').ReadCommitResult);
            }
            // Fallback for 'commit1_oid' if it's a parent OID not directly in mockCommits list by that OID
            if (oid === 'commit1_oid' && mockCommits[1]) { // Assuming commit1_oid refers to mockCommits[1]'s OID conceptually
                 return Promise.resolve({ oid: mockCommits[1].oid, commit: { ...mockCommits[1].commit } } as unknown as import('isomorphic-git').ReadCommitResult);
            }
            // Provide minimal valid structure for author/committer to avoid 'any'
            return Promise.resolve({ oid: 'unknown', commit: { tree: 'unknown_tree', parent: [], author: { name: 'Unknown' }, committer: { name: 'Unknown' }, message: 'Unknown' } } as unknown as import('isomorphic-git').ReadCommitResult);
        });

        // vi.mocked(git.diffTrees) no longer needed here as SUT uses git.walk for diffing.

         
        vi.mocked(git.walk).mockImplementation(async ({ fs: _nodeFsAlias, dir: _dir, gitdir: _gitdir, trees, map }) => {
            // The `trees` argument will be an array of mocked Walker-like objects from our `git.TREE` mock.
            // We can inspect `trees[0]._id` and `trees[1]._id` if needed to simulate specific diffs.
            // trees[0] corresponds to parentCommitData.commit.tree
            // trees[1] corresponds to commitData.commit.tree
            interface MockTree { _id: string; /* other properties */ }
            if (map && trees.length === 1 && (trees[0] as unknown as MockTree)._id === 'mock_tree_id_default') { 
                // Simulate initial commit walk: one file added
                // The SUT's initial commit logic uses `trees: [git.TREE()]`. Our `git.TREE` mock without args gives `_id: 'mock_tree_id_default'`.
                const mockEntry = { type: () => 'blob', oid: () => 'blob_oid_initial', mode: () => 0o100644 } as unknown as import('isomorphic-git').WalkerEntry;
                await map('initial.ts', [mockEntry]); 
            } else if (map && trees.length === 2) {
                // Simulate two-tree walk for diffing (e.g., between tree1_oid and tree2_oid)
                // This part needs to align with how the SUT calls git.TREE({ ref: treeOid })
                // Our TREE mock sets _id to args.ref. So trees[0]._id will be 'tree1_oid', trees[1]._id will be 'tree2_oid'.
                interface MockTree { _id: string; /* other properties */ } // Already defined in previous block, but repetition in search is ok if it matches
                if ((trees[0] as unknown as MockTree)._id === 'tree1_oid' && (trees[1] as unknown as MockTree)._id === 'tree2_oid') { 
                    // Simulate one modified file
                    const mockEntryBefore = { type: () => 'blob', oid: () => 'blob_before_oid', mode: () => 0o100644 } as unknown as import('isomorphic-git').WalkerEntry;
                    const mockEntryAfter = { type: () => 'blob', oid: () => 'blob_after_oid', mode: () => 0o100644 } as unknown as import('isomorphic-git').WalkerEntry;
                    await map('file.ts', [mockEntryBefore, mockEntryAfter]); 
                    
                    // Simulate one added file
                    const mockEntryAdded = { type: () => 'blob', oid: () => 'blob_added_oid', mode: () => 0o100644 } as unknown as import('isomorphic-git').WalkerEntry;
                    await map('added_file.ts', [null, mockEntryAdded]); 

                    // Simulate one deleted file
                    const mockEntryDeleted = { type: () => 'blob', oid: () => 'blob_deleted_oid', mode: () => 0o100644 } as unknown as import('isomorphic-git').WalkerEntry;
                    await map('deleted_file.ts', [mockEntryDeleted, null]); 
                }
            }
            return []; // Default return for walk
        });

        const history = await repositoryFunctions.getCommitHistoryWithChanges(repoPath, { count: 2 });
        expect(history).toHaveLength(2);
        // Check commit2 (non-initial commit, uses two-tree walk)
        expect(history[0].oid).toBe('commit2');
        expect(history[0].changedFiles).toEqual(
          expect.arrayContaining([
            { path: 'file.ts', type: 'modify' },
            { path: 'added_file.ts', type: 'add' },
            { path: 'deleted_file.ts', type: 'delete' },
          ])
        );
        expect(history[0].changedFiles.length).toBe(3); // Ensure no extra files

        // Check commit1 (initial commit, uses single-tree walk)
        expect(history[1].oid).toBe('commit1');
        expect(history[1].changedFiles).toEqual([{ path: 'initial.ts', type: 'add' }]);
    });

    it('should handle errors from git.log', async () => {
        // Ensure validateGitRepository conditions are met if it's called by SUT,
        // though getCommitHistoryWithChanges doesn't call validateGitRepository directly.
        // However, it does use gitLog, which is what we're testing for failure here.
        vi.mocked(git.log).mockRejectedValue(new Error('Log failed')); // Use mockedGitLog
        await expect(repositoryFunctions.getCommitHistoryWithChanges(repoPath)).rejects.toThrow('Log failed');
    });
  });
});
