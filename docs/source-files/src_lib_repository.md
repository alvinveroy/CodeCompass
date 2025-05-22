# `src/lib/repository.ts`

## Overview

The `src/lib/repository.ts` module is responsible for interacting with Git repositories. Its primary functions include validating Git repositories, indexing repository files, commits, and diffs into a Qdrant vector database, retrieving differences between commits, and providing detailed commit history. This module plays a crucial role in preparing codebase data for analysis and search by CodeCompass. It also provides functionality to monitor the indexing process.

## Key Data Structures

### `IndexingStatusReport` Interface
-   **Purpose**: Defines the structure for reporting the current status and progress of repository indexing.
-   **Key Fields**: `status` (e.g., 'idle', 'indexing_file_content', 'completed', 'error'), `message`, `overallProgress`, `totalFilesToIndex`, `filesIndexed`, `currentFile`, `errorDetails`, `lastUpdatedAt`.

### `CommitDetail` Interface
-   **Purpose**: Represents detailed information about a single commit.
-   **Key Fields**: `oid`, `message`, `author`, `committer`, `parents`, `changedFiles` (array of `CommitChange`).

### `CommitChange` Interface
-   **Purpose**: Describes a single file change within a commit.
-   **Key Fields**: `path`, `type` (e.g., 'add', 'modify'), `oldOid`, `newOid`, `diffText`.

## Key Functions

### `getGlobalIndexingStatus(): IndexingStatusReport`
-   **Purpose**: Retrieves the current status and progress of any ongoing or completed repository indexing process.
-   **Returns**: An `IndexingStatusReport` object.

### `validateGitRepository(repoPath: string): Promise<boolean>`
-   **Purpose**: Checks if the provided `repoPath` points to a valid Git repository.
-   **Parameters**:
    -   `repoPath: string`: The file system path to the repository.
-   **Returns**: `Promise<boolean>` - Resolves to `true` if the path is a valid Git repository, `false` otherwise.
-   **Details**: It attempts to access the `.git` directory and resolve the `HEAD` reference using `isomorphic-git`.

### `indexRepository(qdrantClient: QdrantClient, repoPath: string, llmProvider: LLMProvider): Promise<void>`
-   **Purpose**: Indexes code files, commit history, and diffs from the specified Git repository into the Qdrant vector database. Updates the global indexing status throughout the process.
-   **Parameters**:
    -   `qdrantClient: QdrantClient`: An initialized Qdrant client instance.
    -   `repoPath: string`: The file system path to the Git repository.
    -   `llmProvider: LLMProvider`: An LLM provider instance for generating embeddings.
-   **Returns**: `Promise<void>` - Resolves when the indexing process is complete or if an initial validation fails.
-   **Process**:
    1.  **Initialization & Validation**: Sets indexing status to 'initializing'. Calls `validateGitRepository`. If invalid, sets status to 'error' and exits.
    2.  **File Listing & Filtering**: Lists all files using `isomorphic-git`. Filters for common code extensions, excluding `node_modules/` and `dist/`. Updates status.
    3.  **Stale Entry Cleanup**:
        -   Scrolls through the Qdrant collection to find existing `file_chunk` points.
        -   Compares indexed file paths with current repository files.
        -   Deletes points from Qdrant for files that no longer exist. Updates status.
    4.  **File Content Indexing**: For each filtered file:
        -   Reads file content and last modification date.
        -   Skips empty files.
        -   Preprocesses and chunks file content using `chunkText` (from `src/utils/text-utils.ts`) based on `configService.FILE_INDEXING_CHUNK_SIZE_CHARS` and `configService.FILE_INDEXING_CHUNK_OVERLAP_CHARS`.
        -   For each chunk:
            -   Generates a vector embedding using `llmProvider.generateEmbedding()`.
            -   Creates a `FileChunkPayload` containing `dataType: 'file_chunk'`, `filepath`, `file_content_chunk`, `chunk_index`, `total_chunks`, `last_modified`, and `repositoryPath`.
            -   Upserts the point (with a UUID ID) to Qdrant using `batchUpsertVectors`.
        -   Updates `filesIndexed` and `overallProgress` in the global status.
    5.  **Commit and Diff Indexing**:
        -   Sets indexing status to 'indexing_commits_diffs'.
        -   Calls `indexCommitsAndDiffs(qdrantClient, repoPath, llmProvider)` to handle this phase.
    6.  **Completion/Error**: Updates global status to 'completed' or 'error' with a final message.

### `indexCommitsAndDiffs(qdrantClient: QdrantClient, repoPath: string, llmProvider: LLMProvider): Promise<void>` (Internal, called by `indexRepository`)
-   **Purpose**: Indexes commit history and textual diffs for changes within those commits.
-   **Process**:
    1.  Retrieves commit history using `getCommitHistoryWithChanges()`, limited by `configService.COMMIT_HISTORY_MAX_COUNT_FOR_INDEXING`. Updates status.
    2.  For each `CommitDetail` object:
        -   **Commit Info Indexing**:
            -   Constructs text from commit metadata (OID, author, date, message, parent OIDs, changed files summary).
            -   Generates an embedding for this text using `llmProvider.generateEmbedding()`.
            -   Creates a `CommitInfoPayload` with `dataType: 'commit_info'` and relevant commit details.
            -   Adds the point to a batch for upserting to Qdrant.
        -   **Diff Chunk Indexing**: For each `CommitChange` with `diffText`:
            -   Preprocesses and chunks the `diffText` using `chunkText` based on `configService.DIFF_CHUNK_SIZE_CHARS` and `configService.DIFF_CHUNK_OVERLAP_CHARS`.
            -   For each diff chunk:
                -   Constructs contextual text (e.g., "Diff for file X in commit Y: chunk_content").
                -   Generates an embedding using `llmProvider.generateEmbedding()`.
                -   Creates a `DiffChunkPayload` with `dataType: 'diff_chunk'`, commit OID, filepath, diff chunk content, chunk index, total chunks, change type, and `repositoryPath`.
                -   Adds the point to the batch.
        -   Periodically upserts batches to Qdrant using `batchUpsertVectors`.
    3.  Updates `commitsIndexed` and `overallProgress` in the global status.

### `getRepositoryDiff(repoPath: string, validatorFunc?: (p: string) => Promise<boolean>): Promise<string>`
-   **Purpose**: Retrieves a textual summary of changes between the latest commit and the previous commit.
-   **Parameters**:
    -   `repoPath: string`: Path to the repository.
    -   `validatorFunc` (optional): A function to validate the git repository, primarily for testing.
-   **Returns**: `Promise<string>` - A string detailing the changes, or specific messages for errors/no changes.
-   **Details**:
    1.  Validates the repository.
    2.  Fetches the last two commit OIDs using `isomorphic-git log`.
    3.  Executes `git diff <prev_oid> <latest_oid>` using `child_process.exec` to get the textual diff.
    4.  Truncates long diffs based on `MAX_DIFF_LENGTH`.

### `getCommitHistoryWithChanges(repoPath: string, options?: { since?: Date; count?: number; ref?: string }): Promise<CommitDetail[]>`
-   **Purpose**: Retrieves detailed commit history, including a list of changed files and their textual diffs for each commit.
-   **Parameters**:
    -   `repoPath: string`: Path to the repository.
    -   `options` (optional):
        -   `since?: Date`: Retrieve commits after this date.
        -   `count?: number`: Limit the number of commits.
        -   `ref?: string`: Specific branch, tag, or commit to start from.
-   **Returns**: `Promise<CommitDetail[]>` - An array of `CommitDetail` objects.
-   **Details**:
    -   Uses `isomorphic-git log` to get commit entries.
    -   For each commit, it reads commit data (`isomorphic-git readCommit`).
    -   Compares the commit's tree with its parent's tree using `isomorphic-git walk` to identify changed files (`CommitChange` objects: path, type, OIDs).
    -   For added, modified, or deleted files, it reads blob contents (`isomorphic-git readBlob`) and generates textual diffs using `Diff.createPatch` from the `diff` library, with context lines configured by `configService.DIFF_LINES_OF_CONTEXT`.

## Dependencies

-   `isomorphic-git`: For most Git operations.
-   `fs/promises`, `fs` (nodeFs): For asynchronous and synchronous file system operations.
-   `path`: For path manipulation.
-   `child_process`: For executing `git diff` command in `getRepositoryDiff`.
-   `util`: For `promisify`.
-   `@qdrant/js-client-rest`: The Qdrant client library.
-   `uuid`: For generating unique IDs for Qdrant points.
-   `diff`: For generating textual diffs.
-   `./llm-provider`: For the `LLMProvider` interface.
-   `./types`: For `QdrantPoint`, `FileChunkPayload`, `CommitInfoPayload`, `DiffChunkPayload`.
-   `../utils/text-utils`: For `preprocessText` and `chunkText`.
-   `./config-service`: Provides configuration values and logging.
-   `./qdrant`: For `batchUpsertVectors`.
