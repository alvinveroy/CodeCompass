import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { exec as actualChildProcessExec, type ExecException } from 'child_process';
import * as util from 'util'; // Import actual util
import { promises as fsPromises } from 'fs';
import git from 'isomorphic-git';
import path from 'path';
// import nodeFs from 'fs'; // Not needed if fsPromises covers fs needs for git

// This variable will hold the mock function instance. It MUST be `let`.
let MOCK_EXEC_ASYNC_FN_INSTANCE: vi.Mock;

vi.mock('util', async (importOriginal) => {
  const actualUtilModule = await importOriginal<typeof import('util')>();
  // Create the mock function INSIDE the factory.
  const factoryCreatedMock = vi.fn();
  // Assign the factory-scoped mock to the module-scoped variable.
  // This assignment happens when the factory is executed (due to hoisting).
  MOCK_EXEC_ASYNC_FN_INSTANCE = factoryCreatedMock; 
  return {
    ...actualUtilModule,
    promisify: (fnToPromisify: any) => {
      if (fnToPromisify === actualChildProcessExec) { 
        return factoryCreatedMock; // Return the mock created in this factory scope
      }
      return actualUtilModule.promisify(fnToPromisify);
    },
  };
});

// Import SUT and other dependencies AFTER vi.mock
import { getRepositoryDiff } from '../repository'; 
import { logger, configService } from '../config-service'; // Import configService as well
// ... other necessary imports ...
// Import functions to test (ensure all are imported if their tests are present)
import {
    validateGitRepository,
    indexRepository,
    // getRepositoryDiff, // Already imported
    getCommitHistoryWithChanges
} from '../repository';
import { QdrantClient } from '@qdrant/js-client-rest'; // If used by other tests in this file

// Mock dependencies of repository.ts that are not part of the SUT itself
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
// config-service is complex, ensure its mock is comprehensive or use its actual instance carefully
// For repository tests, we mostly care that it provides COLLECTION_NAME.
// The existing mock for config-service in other files might be suitable if adapted.
// For now, assuming the import from '../config-service' gets a working logger and configService.COLLECTION_NAME.
vi.mock('../config-service', () => ({ // Re-add the mock for config-service if it was removed
    configService: {
      COLLECTION_NAME: 'test_collection',
      FILE_INDEXING_CHUNK_SIZE_CHARS: 100,
      FILE_INDEXING_CHUNK_OVERLAP_CHARS: 20,
    },
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('../ollama'); // If generateEmbedding is used by repository.ts (it's not directly)

describe('Repository Utilities', () => {
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
    vi.clearAllMocks();
    if (MOCK_EXEC_ASYNC_FN_INSTANCE) {
        MOCK_EXEC_ASYNC_FN_INSTANCE.mockReset();
    }
    // Reset other mocks
    vi.mocked(fsPromises.access).mockReset();
    vi.mocked(git.resolveRef).mockReset();
    vi.mocked(git.log).mockReset();
    // Clear logger mocks from the imported logger instance
    const loggerInstance = (configService as any).logger || logger; // Access logger correctly
    loggerInstance.info.mockClear(); 
    loggerInstance.warn.mockClear();
    loggerInstance.error.mockClear();
    loggerInstance.debug.mockClear();
  });

  afterEach(() => { vi.restoreAllMocks(); });

  describe('getRepositoryDiff', () => {
    // repoPath is already defined in the outer scope
    beforeEach(() => { // Scoped beforeEach for getRepositoryDiff tests
        setupValidRepoAndCommitsMocks();
    });

    it('should call git diff command and return stdout', async () => {
      if (!MOCK_EXEC_ASYNC_FN_INSTANCE) throw new Error("MOCK_EXEC_ASYNC_FN_INSTANCE not initialized for stdout test");
      MOCK_EXEC_ASYNC_FN_INSTANCE.mockResolvedValueOnce({ stdout: 'diff_content_stdout_explicit', stderr: '' });

      const result = await getRepositoryDiff(repoPath);
      
      expect(MOCK_EXEC_ASYNC_FN_INSTANCE).toHaveBeenCalledWith(
        'git diff commit1_oid commit2_oid', 
        expect.objectContaining({ cwd: repoPath })
      );
      expect(result).toBe('diff_content_stdout_explicit');
    });

    it('should truncate long diff output', async () => {
      if (!MOCK_EXEC_ASYNC_FN_INSTANCE) throw new Error("MOCK_EXEC_ASYNC_FN_INSTANCE not initialized for truncate test");
      const longDiff = 'a'.repeat(10001);
      MOCK_EXEC_ASYNC_FN_INSTANCE.mockResolvedValueOnce({ stdout: longDiff, stderr: '' });

      const result = await getRepositoryDiff(repoPath);
      expect(result).toContain('... (diff truncated)');
    });
    
    it('should handle errors from git diff command', async () => {
      if (!MOCK_EXEC_ASYNC_FN_INSTANCE) throw new Error("MOCK_EXEC_ASYNC_FN_INSTANCE not initialized for error test");
      const mockError = new Error('Git command failed') as ExecException & { stdout?: string; stderr?: string };
      (mockError as any).code = 128;
      mockError.stderr = 'stderr from execAsync rejection'; 
      MOCK_EXEC_ASYNC_FN_INSTANCE.mockRejectedValueOnce(mockError);
      
      const result = await getRepositoryDiff(repoPath);
      
      expect(result).toBe(`Failed to retrieve diff for ${repoPath}: Git command failed`);
      const loggerInstance = (configService as any).logger || logger;
      expect(loggerInstance.error).toHaveBeenCalledWith(
        `Error retrieving git diff for ${repoPath}: Git command failed`,
        expect.objectContaining({
          message: 'Git command failed',
          code: 128,
          stderr: 'stderr from execAsync rejection', 
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
