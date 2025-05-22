# `src/lib/agent_capabilities.ts`

## Overview

The `src/lib/agent_capabilities.ts` module defines a suite of internal functions, referred to as "capabilities," that the CodeCompass agent orchestrator (in `src/lib/agent.ts`) can call upon to gather information and perform specific tasks related to a codebase. Each capability is designed to be a focused, atomic operation.

## `CapabilityContext` Interface

All capability functions receive a `CapabilityContext` object as their first parameter. This context provides access to shared resources and configurations:

-   `qdrantClient: QdrantClient`: An initialized Qdrant client instance for vector database interactions.
-   `repoPath: string`: The file system path to the current Git repository.
-   `suggestionModelAvailable: boolean`: A flag indicating if an LLM suggestion model is available, which some capabilities might use for summarization or other LLM-dependent tasks.

## Defined Capabilities

Below are the capabilities defined in this module, along with their parameters and purpose. Parameter types are typically defined as Zod schemas in `src/lib/agent.ts` (e.g., `CapabilitySearchCodeSnippetsParams`).

### `capability_searchCodeSnippets(context: CapabilityContext, params: CapabilitySearchCodeSnippetsParams): Promise<FormattedSearchResult[]>`
-   **Purpose**: Searches for code snippets in the repository based on a query string.
-   **Parameters (`CapabilitySearchCodeSnippetsParams`)**:
    -   `query: string`: The search query string.
-   **Returns**: `Promise<FormattedSearchResult[]>` - An array of formatted search results. Each result includes:
    -   `filepath`: Path to the file (or a display string for non-file results like commits).
    -   `snippet`: The code snippet or content, potentially summarized by `processSnippet` if long and an LLM is available.
    -   `last_modified?: string`: Last modification date (for file chunks).
    -   `relevance?: number`: Relevance score from Qdrant.
    -   `is_chunked?: boolean`: True if the snippet is from a file chunk.
    -   `original_filepath?: string`: Original filepath if `filepath` is a chunk display.
    -   `chunk_index?: number`: Index of the chunk.
    -   `total_chunks?: number`: Total chunks for the file.
-   **Details**:
    -   Uses `searchWithRefinement` (from `src/lib/query-refinement.ts`) to perform the search.
    -   Processes each search result using `processSnippet` (from `src/lib/agent.ts`) to summarize long snippets if `suggestionModelAvailable` is true.
    -   Formats results into the `FormattedSearchResult` structure.

### `capability_getRepositoryOverview(context: CapabilityContext, params: CapabilityGetRepositoryOverviewParams): Promise<{ refinedQuery: string; diffSummary: string; searchResults: FormattedSearchResult[] }>`
-   **Purpose**: Provides an overview of the repository, including recent changes (diff summary) and relevant code snippets for a given query.
-   **Parameters (`CapabilityGetRepositoryOverviewParams`)**:
    -   `query: string`: The query string to find relevant context and snippets.
-   **Returns**: `Promise<object>` containing:
    -   `refinedQuery: string`: The query after potential refinement.
    -   `diffSummary: string`: A summary of recent repository changes (from `getAgentProcessedDiff`).
    -   `searchResults: FormattedSearchResult[]`: An array of formatted search results relevant to the query.
-   **Details**:
    -   Calls `getAgentProcessedDiff` (from `src/lib/agent.ts`) to get a summary of recent changes.
    -   Uses `searchWithRefinement` to find relevant Qdrant points (file chunks, commit info, diff chunks).
    -   Formats these points into `FormattedSearchResult` objects, using `processSnippet` for content summarization.

### `capability_getChangelog(context: CapabilityContext, _params: CapabilityGetChangelogParams): Promise<{ changelog: string; error?: string }>`
-   **Purpose**: Retrieves the content of the `CHANGELOG.md` file from the root of the repository.
-   **Parameters (`CapabilityGetChangelogParams`)**: None.
-   **Returns**: `Promise<object>` containing:
    -   `changelog: string`: The content of the changelog file (truncated if very long, based on `configService.MAX_FILE_CONTENT_LENGTH_FOR_CAPABILITY`).
    -   `error?: string`: An error message if reading the changelog fails (e.g., file not found).
-   **Details**: Reads `CHANGELOG.md` from the `repoPath`.

### `capability_fetchMoreSearchResults(context: CapabilityContext, params: CapabilityFetchMoreSearchResultsParams): Promise<FormattedSearchResult[]>`
-   **Purpose**: Fetches additional search results for a given query, typically used if initial results were insufficient.
-   **Parameters (`CapabilityFetchMoreSearchResultsParams`)**:
    -   `query: string`: The original or refined query string.
-   **Returns**: `Promise<FormattedSearchResult[]>` - An array of formatted search results.
-   **Details**:
    -   Similar to `capability_searchCodeSnippets` but uses `configService.REQUEST_ADDITIONAL_CONTEXT_MAX_SEARCH_RESULTS` to limit the number of results.

### `capability_getFullFileContent(context: CapabilityContext, params: CapabilityGetFullFileContentParams): Promise<{ filepath: string; content: string }>`
-   **Purpose**: Retrieves the full content of a specified file. If the content is very long and an LLM is available, it may return a summary instead.
-   **Parameters (`CapabilityGetFullFileContentParams`)**:
    -   `filepath: string`: The path to the file within the repository.
-   **Returns**: `Promise<object>` containing:
    -   `filepath: string`: The path of the requested file.
    -   `content: string`: The file content or its summary.
-   **Details**:
    -   Reads the file from `repoPath`.
    -   Performs security checks to ensure the path is within the repository.
    -   If content exceeds `configService.MAX_FILE_CONTENT_LENGTH_FOR_CAPABILITY` and `suggestionModelAvailable` is true, it uses an LLM to summarize the content. Otherwise, it returns truncated content.

### `capability_listDirectory(context: CapabilityContext, params: CapabilityListDirectoryParams): Promise<{ path: string; listing: Array<{ name: string; type: 'directory' | 'file' }>; note?: string }>`
-   **Purpose**: Lists the contents (files and subdirectories) of a specified directory within the repository.
-   **Parameters (`CapabilityListDirectoryParams`)**:
    -   `dirPath: string`: The path to the directory.
-   **Returns**: `Promise<object>` containing:
    -   `path: string`: The path of the listed directory.
    -   `listing: Array<{ name: string; type: 'directory' | 'file' }>`: An array of directory entries.
    -   `note?: string`: A note if the listing was truncated (based on `configService.MAX_DIR_LISTING_ENTRIES_FOR_CAPABILITY`).
-   **Details**: Reads directory contents from `repoPath`. Performs security checks.

### `capability_getAdjacentFileChunks(context: CapabilityContext, params: CapabilityGetAdjacentFileChunksParams): Promise<{ filepath: string; requested_chunk_index: number; retrieved_chunks: AdjacentChunkInfo[] }>`
-   **Purpose**: Retrieves code chunks adjacent (previous and next) to a previously identified chunk of a file.
-   **Parameters (`CapabilityGetAdjacentFileChunksParams`)**:
    -   `filepath: string`: The path to the chunked file.
    -   `currentChunkIndex: number`: The 0-based index of the current chunk.
-   **Returns**: `Promise<object>` containing:
    -   `filepath: string`: The path of the file.
    -   `requested_chunk_index: number`: The index of the chunk for which adjacent chunks were requested.
    -   `retrieved_chunks: AdjacentChunkInfo[]`: An array of `AdjacentChunkInfo` objects (filepath, chunk_index, snippet, optional note).
-   **Details**:
    -   Queries Qdrant for `file_chunk` data type with matching `filepath` and `chunk_index` for `currentChunkIndex - 1` and `currentChunkIndex + 1`.

### `capability_generateSuggestionWithContext(context: CapabilityContext, params: CapabilityGenerateSuggestionWithContextParams): Promise<{ suggestion: string }>`
-   **Purpose**: Generates a code suggestion based on a user's query and extensive provided context (repository name, file summary, diff summary, recent queries, relevant snippets).
-   **Parameters (`CapabilityGenerateSuggestionWithContextParams`)**:
    -   `query: string`: The user's original query or goal.
    -   `repoPathName: string`: The name of the repository.
    -   `filesContextString: string`: A summary of relevant files.
    -   `diffSummary: string`: A summary of recent repository changes.
    -   `recentQueriesStrings: string[]`: A list of recent related queries.
    -   `relevantSnippets: FormattedSearchResult[]`: An array of relevant code snippets.
-   **Returns**: `Promise<{ suggestion: string }>` - The generated suggestion.
-   **Details**:
    -   Requires `suggestionModelAvailable` to be true.
    -   Constructs a detailed prompt for the LLM using all provided context.
    -   Calls `llmProvider.generateText()` to produce the suggestion.

### `capability_analyzeCodeProblemWithContext(context: CapabilityContext, params: CapabilityAnalyzeCodeProblemWithContextParams): Promise<{ analysis: string }>`
-   **Purpose**: Analyzes a code problem described by the user, based on provided relevant code snippets.
-   **Parameters (`CapabilityAnalyzeCodeProblemWithContextParams`)**:
    -   `problemQuery: string`: The user's description of the code problem.
    -   `relevantSnippets: FormattedSearchResult[]`: An array of code snippets relevant to the problem.
-   **Returns**: `Promise<{ analysis: string }>` - The LLM's analysis of the problem.
-   **Details**:
    -   Requires `suggestionModelAvailable` to be true.
    -   Constructs a prompt instructing the LLM to understand the problem, identify root causes, list solutions, and recommend an approach.
    -   Calls `llmProvider.generateText()` to produce the analysis.

## Dependencies
-   `@qdrant/js-client-rest`: For `QdrantClient`.
-   `fs/promises`, `path`: For file system operations.
-   `./config-service`: For configuration values and logging.
-   `./llm-provider`: For `getLLMProvider` (aliased as `getProviderForLLMDependentCaps`).
-   `./agent`: For parameter type definitions (e.g., `CapabilitySearchCodeSnippetsParams`), `FormattedSearchResult`, `processSnippet`, `getAgentProcessedDiff` (helper functions originally in `agent.ts`).
-   `./query-refinement`: For `searchWithRefinement`.
-   `./types`: For `DetailedQdrantSearchResult` and specific Qdrant payload types.
