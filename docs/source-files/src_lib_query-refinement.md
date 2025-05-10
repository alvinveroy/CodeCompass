# `src/lib/query-refinement.ts`

## Overview

The `src/lib/query-refinement.ts` module provides functionality for enhancing search queries through an iterative refinement process. It aims to improve the relevance of search results obtained from a Qdrant vector database by automatically adjusting the query based on initial search outcomes.

## Key Functions

### `searchWithRefinement(client: QdrantClient, query: string, files: string[] = [], maxRefinements = 2, relevanceThreshold = 0.7): Promise<{ results: DetailedQdrantSearchResult[], refinedQuery: string, relevanceScore: number }>`

-   **Purpose**: Performs an iterative search against a Qdrant collection. It starts with an initial query, retrieves results, and if the relevance is below a threshold, it refines the query and searches again. This process repeats up to a maximum number of refinements.
-   **Parameters**:
    -   `client: QdrantClient`: An initialized Qdrant client instance.
    -   `query: string`: The initial search query.
    -   `files: string[]` (optional): An array of file paths to filter the search. Defaults to an empty array (no file filtering).
    -   `maxRefinements: number` (optional): The maximum number of refinement iterations. Defaults to `2`.
    -   `relevanceThreshold: number` (optional): The minimum average relevance score to stop refinement. Defaults to `0.7`.
-   **Returns**: `Promise<{ results: DetailedQdrantSearchResult[], refinedQuery: string, relevanceScore: number }>`
    -   `results`: An array of the best search results found during the process.
    -   `refinedQuery`: The final version of the query (which might be the original or a refined one).
    -   `relevanceScore`: The average relevance score of the `results`.
-   **Process**:
    1.  Logs the start of the iterative search.
    2.  Enters a loop that runs up to `maxRefinements + 1` times (initial search + refinements).
    3.  **Generate Embedding**: Creates a vector embedding for the `currentQuery` using `ollama.generateEmbedding`.
    4.  **Search Qdrant**: Performs a search in the Qdrant collection specified by `configService.COLLECTION_NAME` using the generated embedding. The search can be filtered by `files` if provided.
    5.  **Calculate Relevance**: Computes the average relevance score of the search results.
    6.  Logs the results of the current refinement iteration.
    7.  **Update Best Results**: If the current `avgRelevance` is better than `bestRelevanceScore` found so far, updates `bestResults` and `bestRelevanceScore`.
    8.  **Check Termination Conditions**:
        -   If `avgRelevance` meets or exceeds `relevanceThreshold`, or
        -   If the maximum number of refinements (`i === maxRefinements`) has been reached,
        -   The loop breaks.
    9.  **Refine Query**: If the loop continues, calls `refineQuery()` to generate a new `currentQuery` based on the current results and relevance.
    10. Logs completion of the search and returns the best results, the final query, and the best relevance score.

### `refineQuery(originalQuery: string, results: DetailedQdrantSearchResult[], currentRelevance: number): Promise<string>` (Internal)

-   **Purpose**: Modifies the search query based on the current search results and their relevance.
-   **Parameters**:
    -   `originalQuery: string`: The query used to obtain the current `results`.
    -   `results: DetailedQdrantSearchResult[]`: The search results from the current iteration.
    -   `currentRelevance: number`: The average relevance score of the `results`.
-   **Returns**: `Promise<string>` - The refined query.
-   **Logic**:
    -   If `results` are empty or `currentRelevance` is very low (< 0.3), calls `broadenQuery()`.
    -   If `currentRelevance` is mediocre (< 0.7), calls `focusQueryBasedOnResults()`.
    -   Otherwise (decent results but not meeting the threshold), calls `tweakQuery()`.

### `broadenQuery(query: string): string` (Internal)

-   **Purpose**: Makes a query less specific, typically when it yields few or no relevant results.
-   **Parameters**:
    -   `query: string`: The query to broaden.
-   **Returns**: `string` - The broadened query.
-   **Modifications**:
    -   Removes specific keywords like "exact", "specific", "only", "must".
    -   Removes common file extensions (e.g., `.ts`, `.js`).
    -   Removes special characters like quotes and brackets.
    -   If the query becomes too short after broadening, appends generic terms like "implementation code".

### `focusQueryBasedOnResults(query: string, results: DetailedQdrantSearchResult[]): string` (Internal)

-   **Purpose**: Narrows down a query by incorporating key terms from the current search results.
-   **Parameters**:
    -   `query: string`: The query to focus.
    -   `results: DetailedQdrantSearchResult[]`: The current search results.
-   **Returns**: `string` - The focused query.
-   **Modifications**:
    -   Extracts content samples from the top few results.
    -   Calls `extractKeywords()` on these samples.
    -   Appends the top 1-2 extracted keywords to the original query.

### `tweakQuery(query: string, results: DetailedQdrantSearchResult[]): string` (Internal)

-   **Purpose**: Makes minor adjustments to a query, often by adding contextual information from the top result.
-   **Parameters**:
    -   `query: string`: The query to tweak.
    -   `results: DetailedQdrantSearchResult[]`: The current search results.
-   **Returns**: `string` - The tweaked query.
-   **Modifications**:
    -   Examines the `filepath` of the top search result.
    -   If the file type (extension) or the top-level directory from the path is not already in the query, it appends it (e.g., adds "ts" or "in src").

### `extractKeywords(text: string): string[]` (Internal)

-   **Purpose**: Extracts potential keywords from a given block of text.
-   **Parameters**:
    -   `text: string`: The text to extract keywords from.
-   **Returns**: `string[]` - An array of unique keywords.
-   **Process**:
    1.  Preprocesses the text using `preprocessText` (from `../utils/text-utils`).
    2.  Splits the text into words.
    3.  Filters out common stop words (e.g., "the", "and") and words shorter than 4 characters.
    4.  Returns a list of unique remaining words.

## Dependencies

-   `@qdrant/js-client-rest`: The Qdrant client library.
-   `./config-service`: Provides configuration values (e.g., `COLLECTION_NAME`) and the logger.
-   `../utils/text-utils`: For `preprocessText`.
-   `./ollama`: For `generateEmbedding`.
-   `./types`: For `DetailedQdrantSearchResult`.
