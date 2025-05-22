# `src/lib/query-refinement.ts`

## Overview

The `src/lib/query-refinement.ts` module provides functionality for enhancing search queries through an iterative refinement process. It aims to improve the relevance of search results obtained from a Qdrant vector database by automatically adjusting the query based on initial search outcomes. The main exported function is `searchWithRefinement`, supported by several exported helper functions for query manipulation.

## Key Functions and Types

### `searchWithRefinement(client: QdrantClient, query: string, files?: string[], customLimit?: number, maxRefinements?: number, relevanceThreshold?: number, refineQueryFunc?: RefineQueryFunc): Promise<{ results: DetailedQdrantSearchResult[], refinedQuery: string, relevanceScore: number }>`

-   **Purpose**: Performs an iterative search against a Qdrant collection. It starts with an initial query, retrieves results, and if the relevance is below a threshold, it refines the query and searches again. This process repeats up to a maximum number of refinements.
-   **Parameters**:
    -   `client: QdrantClient`: An initialized Qdrant client instance.
    -   `query: string`: The initial search query.
    -   `files: string[]` (optional): An array of file paths to filter the search. Defaults to an empty array (no file filtering).
    -   `customLimit?: number` (optional): Custom limit for the number of search results from Qdrant. Defaults to `configService.QDRANT_SEARCH_LIMIT_DEFAULT`.
    -   `maxRefinements?: number` (optional): The maximum number of refinement iterations. Defaults to `configService.MAX_REFINEMENT_ITERATIONS`.
    -   `relevanceThreshold: number` (optional): The minimum average relevance score to stop refinement. Defaults to `0.7`.
    -   `refineQueryFunc?: RefineQueryFunc` (optional): A function to use for refining the query. Defaults to the internal `actualRefineQuery` (exported as `refineQuery`).
-   **Returns**: `Promise<{ results: DetailedQdrantSearchResult[], refinedQuery: string, relevanceScore: number }>`
    -   `results`: An array of the best search results found during the process.
    -   `refinedQuery`: The final version of the query (which might be the original or a refined one).
    -   `relevanceScore`: The average relevance score of the `results`.
-   **Process**:
    1.  Logs the start of the iterative search.
    2.  Determines effective `maxRefinements` and `searchLimit` using provided parameters or defaults from `configService`.
    3.  Enters a loop that runs up to `effectiveMaxRefinements + 1` times (initial search + refinements).
    4.  **Generate Embedding**: Creates a vector embedding for the `currentQuery` using `generateEmbedding` (from `src/lib/ollama.ts`).
    5.  **Search Qdrant**: Performs a search in the Qdrant collection specified by `configService.COLLECTION_NAME` using the generated embedding and `searchLimit`. The search can be filtered by `files` if provided.
    6.  **Calculate Relevance**: Computes the average relevance score of the search results.
    7.  Logs the results of the current refinement iteration.
    8.  **Update Best Results**: If the current `avgRelevance` is better than `bestRelevanceScore` found so far, updates `bestResults` and `bestRelevanceScore`.
    9.  **Check Termination Conditions**:
        -   If `avgRelevance` meets or exceeds `relevanceThreshold`, or
        -   If the maximum number of refinements (`i === effectiveMaxRefinements`) has been reached, or
        -   If the refined query suggestion does not change and results were found.
        -   The loop breaks.
    10. **Refine Query**: If the loop continues, calls the `refineQueryFunc` (defaulting to `refineQuery`) to generate a new `currentQuery` based on the current results and relevance.
    11. Logs completion of the search and returns the best results, the final query, and the best relevance score.

### `RefineQueryFunc` (Type Alias)
-   **Definition**: `type RefineQueryFunc = (originalQuery: string, results: DetailedQdrantSearchResult[], currentRelevance: number) => string;`
-   **Purpose**: Defines the signature for functions that can be used to refine a query.

### `refineQuery(originalQuery: string, results: DetailedQdrantSearchResult[], currentRelevance: number, helpers?: RefineQueryHelpers): string` (Exported alias for `actualRefineQuery`)

-   **Purpose**: Modifies the search query based on the current search results and their relevance. This is the default implementation for `RefineQueryFunc`.
-   **Parameters**:
    -   `originalQuery: string`: The query used to obtain the current `results`.
    -   `results: DetailedQdrantSearchResult[]`: The search results from the current iteration.
    -   `currentRelevance: number`: The average relevance score of the `results`.
    -   `helpers?: RefineQueryHelpers` (optional): An object containing `broaden`, `focus`, and `tweak` functions. Defaults to the module's own `broadenQuery`, `focusQueryBasedOnResults`, and `tweakQuery`.
-   **Returns**: `string` - The refined query.
-   **Logic**:
    -   If `results` are empty or `currentRelevance` is very low (< 0.3), calls `helpers.broaden()`.
    -   If `currentRelevance` is mediocre (< 0.7), calls `helpers.focus()`.
    -   Otherwise (decent results but not meeting the threshold), calls `helpers.tweak()`.

### `RefineQueryHelpers` (Interface - internal to `actualRefineQuery` but relevant for understanding)
-   **Purpose**: Defines the structure for the `helpers` object passed to `actualRefineQuery`.
-   **Fields**: `broaden`, `focus`, `tweak` (functions matching `broadenQuery`, `focusQueryBasedOnResults`, `tweakQuery` signatures).


## Helper Functions (Exported)

The following helper functions are used by `refineQuery` and are also exported for direct use or testing:

### `broadenQuery(query: string): string`

-   **Purpose**: Makes a query less specific, typically when it yields few or no relevant results.
-   **Parameters**:
    -   `query: string`: The query to broaden.
-   **Returns**: `string` - The broadened query.
-   **Modifications**:
    -   Removes specific keywords like "exact", "specific", "only", "must".
    -   Removes common file extensions (e.g., `.ts`, `.js`).
    -   Removes special characters like quotes and brackets.
    -   If the query becomes too short after broadening, appends generic terms like "implementation code". If the query is empty, it defaults to "general code context".

### `focusQueryBasedOnResults(query: string, results: DetailedQdrantSearchResult[]): string`

-   **Purpose**: Narrows down a query by incorporating key terms from the current search results.
-   **Parameters**:
    -   `query: string`: The query to focus.
    -   `results: DetailedQdrantSearchResult[]`: The current search results.
-   **Returns**: `string` - The focused query.
-   **Modifications**:
    -   Extracts content samples from the top few results (up to 3).
    -   For each result, it selects text based on `payload.dataType`:
        -   `file_chunk`: Uses `payload.file_content_chunk`.
        -   `diff_chunk`: Uses `payload.diff_content_chunk`.
        -   `commit_info`: Uses `payload.commit_message`.
    -   Calls `extractKeywords()` on the combined content samples.
    -   Appends the top 1-2 extracted keywords to the original query.

### `tweakQuery(query: string, results: DetailedQdrantSearchResult[]): string`

-   **Purpose**: Makes minor adjustments to a query, often by adding contextual information from the top result.
-   **Parameters**:
    -   `query: string`: The query to tweak.
    -   `results: DetailedQdrantSearchResult[]`: The current search results.
-   **Returns**: `string` - The tweaked query.
-   **Modifications**:
    -   Examines the `payload` of the top search result.
    -   If the `dataType` is `file_chunk` or `diff_chunk`, it extracts the `filepath`.
    -   If a `filepath` is found, it may append the file type (extension) or the top-level directory from the path to the query if not already present. Directory addition has heuristics to avoid common, less specific directory names like 'src' or 'lib' unless they are more unique.

### `extractKeywords(text: string): string[]`

-   **Purpose**: Extracts potential keywords from a given block of text.
-   **Parameters**:
    -   `text: string`: The text to extract keywords from.
-   **Returns**: `string[]` - An array of unique keywords.
-   **Process**:
    1.  Preprocesses the text using `preprocessText` (from `src/utils/text-utils.ts`).
    2.  Converts to lowercase and removes common punctuation.
    3.  Splits the text into words.
    4.  Filters out common stop words (e.g., "the", "and"), words shorter than 3 characters, and purely numeric words.
    5.  Cleans trailing characters like `():<>` from words.
    6.  Returns a list of unique remaining keywords.

## Dependencies

-   `@qdrant/js-client-rest`: The Qdrant client library.
-   `./config-service`: Provides configuration values (e.g., `COLLECTION_NAME`, `MAX_REFINEMENT_ITERATIONS`, `QDRANT_SEARCH_LIMIT_DEFAULT`) and the `logger`.
-   `../utils/text-utils`: For `preprocessText`.
-   `./ollama`: For `generateEmbedding`. (Note: `src/lib/query-refinement.ts` directly imports and uses `generateEmbedding` from `ollama.ts`).
-   `./types`: For `DetailedQdrantSearchResult` and Qdrant payload types (`FileChunkPayload`, `CommitInfoPayload`, `DiffChunkPayload` used implicitly via `DetailedQdrantSearchResult`).
