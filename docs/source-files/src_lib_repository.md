# `src/lib/repository.ts`

## Overview

The `src/lib/repository.ts` module is responsible for interacting with Git repositories. Its primary functions include validating Git repositories, indexing repository files into a Qdrant vector database, and retrieving differences between commits. This module plays a crucial role in preparing codebase data for analysis and search.

## Key Functions

### `validateGitRepository(repoPath: string): Promise<boolean>`

-   **Purpose**: Checks if the provided `repoPath` points to a valid Git repository.
-   **Parameters**:
    -   `repoPath: string`: The file system path to the repository.
-   **Returns**: `Promise<boolean>` - Resolves to `true` if the path is a valid Git repository (contains a `.git` directory and has a resolvable `HEAD` reference), `false` otherwise.
-   **Details**: It attempts to access the `.git` directory and resolve the `HEAD` reference using `isomorphic-git`. Logs success or failure.

### `indexRepository(qdrantClient: QdrantClient, repoPath: string): Promise<void>`

-   **Purpose**: Indexes code files from the specified Git repository into the Qdrant vector database.
-   **Parameters**:
    -   `qdrantClient: QdrantClient`: An initialized Qdrant client instance used for database operations.
    -   `repoPath: string`: The file system path to the Git repository to be indexed.
-   **Returns**: `Promise<void>` - Resolves when the indexing process is complete or if an initial validation fails.
-   **Process**:
    1.  **Validation**: Calls `validateGitRepository` to ensure `repoPath` is valid. Skips indexing if not.
    2.  **File Listing**: Uses `isomorphic-git` to list all files tracked in the `HEAD` of the repository.
    3.  **Filtering**: Filters the listed files to include only common code file extensions (e.g., `.ts`, `.js`, `.py`, `.md`). Excludes files in `node_modules/` or `dist/` directories.
    4.  **Stale Entry Cleanup**:
        -   Retrieves all currently indexed file paths from the Qdrant collection specified by `configService.COLLECTION_NAME`.
        -   Compares this list with the current files in the repository.
        -   Deletes any points from Qdrant whose `filepath` payload no longer exists in the repository. This ensures the index remains synchronized with the repository state.
    5.  **File Indexing Loop**: For each filtered file:
        -   Reads the file content.
        -   Skips indexing if the file is empty or exceeds a maximum size threshold (`configService.MAX_SNIPPET_LENGTH * 10`).
        -   Generates a vector embedding for the file content using `ollama.generateEmbedding`.
        -   Generates a unique ID (`uuidv4`) for the Qdrant point.
        -   Upserts the point to Qdrant, including the embedding, `filepath`, `content`, and `last_modified` timestamp.
    6.  **Logging**: Logs progress, successes, and errors throughout the process. Reports a summary of successfully indexed files and any errors encountered.

### `getRepositoryDiff(repoPath: string): Promise<string>`

-   **Purpose**: Retrieves a textual summary of changes (added, removed, modified files) between the latest commit and the previous commit in the repository.
-   **Parameters**:
    -   `repoPath: string`: The file system path to the Git repository.
-   **Returns**: `Promise<string>` - Resolves to a string detailing the changes. Returns specific messages if no Git repository is found, if there are fewer than two commits, or if no changes are detected. Returns "Failed to retrieve diff" on error.
-   **Details**:
    1.  Validates the repository using `validateGitRepository`.
    2.  Fetches the last two commit objects using `isomorphic-git`.
    3.  Uses `git.walk` to compare the trees of these two commits and identify changes.
    4.  Formats the changes into a human-readable string.

## Dependencies

-   `isomorphic-git`: For Git operations like listing files, resolving refs, and diffing.
-   `fs/promises`: For asynchronous file system operations (reading files, checking stats).
-   `path`: For path manipulation.
-   `uuid`: For generating unique IDs for Qdrant points.
-   `@qdrant/js-client-rest`: The Qdrant client library for database interactions.
-   `./config-service`: Provides configuration values like Qdrant collection name and logging.
-   `./ollama`: Provides the `generateEmbedding` function for creating vector embeddings from text.
