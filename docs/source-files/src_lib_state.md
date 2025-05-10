# `src/lib/state.ts`

## Overview

The `src/lib/state.ts` module manages in-memory session state for CodeCompass. It allows the server to maintain context across multiple interactions with a user or client, such as storing query history, suggestions, feedback, and agent execution steps. Each session is identified by a unique ID.

## Key Data Structures

### `SessionState` Interface

-   **Purpose**: Defines the structure for storing all information related to a single user session.
-   **Properties**:
    -   `id: string`: A unique identifier for the session.
    -   `queries: Array`: An array of objects, each representing a query made during the session.
        -   `timestamp: number`: Timestamp of when the query was made.
        -   `query: string`: The text of the query.
        -   `results: unknown[]`: The results returned for the query (structure can vary).
        -   `relevanceScore: number`: An overall relevance score for the query results.
    -   `suggestions: Array`: An array of objects, each representing a suggestion generated during the session.
        -   `timestamp: number`: Timestamp of when the suggestion was made.
        -   `prompt: string`: The prompt used to generate the suggestion.
        -   `suggestion: string`: The text of the suggestion.
        -   `feedback?: object` (optional): User feedback on the suggestion.
            -   `score: number`: A numerical score (e.g., out of 10).
            -   `comments: string`: Textual comments.
    -   `context: object`: Stores contextual information about the repository being worked on.
        -   `repoPath: string`: The file system path to the repository.
        -   `lastFiles: string[]`: A list of files (e.g., from `git ls-files`).
        -   `lastDiff: string`: The output of a recent `git diff`.
    -   `agentSteps?: Array` (optional): An array of objects, each representing a full agent execution flow.
        -   `timestamp: number`: Timestamp of when the agent interaction occurred.
        -   `query: string`: The initial user query that triggered the agent.
        -   `steps: Array`: An array of individual steps taken by the agent.
            -   `tool: string`: The name of the tool used.
            -   `input: unknown`: The parameters passed to the tool.
            -   `output: unknown`: The result returned by the tool.
            -   `reasoning: string`: The agent's reasoning for choosing the tool or its interpretation of the output.
        -   `finalResponse: string`: The final response synthesized by the agent.
    -   `createdAt: number`: Timestamp of when the session was created.
    -   `lastUpdated: number`: Timestamp of when the session was last updated.

## In-Memory Storage

-   `sessions: Map<string, SessionState>`: A `Map` object that stores all active `SessionState` objects, keyed by their `id`. This data is volatile and will be lost if the server restarts.

## Key Functions

### `createSession(repoPath: string): SessionState`

-   **Purpose**: Creates a new session with a unique ID and initializes its state.
-   **Parameters**:
    -   `repoPath: string`: The path to the repository for this session.
-   **Returns**: The newly created `SessionState` object.
-   **Details**: Generates a session ID, sets creation/update timestamps, and stores the session in the `sessions` map.

### `getOrCreateSession(sessionId?: string, repoPath?: string): SessionState`

-   **Purpose**: Retrieves an existing session by ID or creates a new one if the ID is not found or not provided.
-   **Parameters**:
    -   `sessionId?: string` (optional): The ID of the session to retrieve.
    -   `repoPath?: string` (optional): The repository path, required if a new session needs to be created.
-   **Returns**: The existing or newly created `SessionState` object.
-   **Details**: If `sessionId` is provided and exists, updates its `lastUpdated` timestamp. If not, calls `createSession()`. Throws an error if `repoPath` is missing when a new session creation is attempted.

### `addQuery(sessionId: string, query: string, results: unknown[] = [], relevanceScore = 0): SessionState`

-   **Purpose**: Adds a new query and its results to the specified session.
-   **Parameters**:
    -   `sessionId: string`: The ID of the session.
    -   `query: string`: The text of the query.
    -   `results: unknown[]` (optional): The results obtained for the query. Defaults to an empty array.
    -   `relevanceScore: number` (optional): The relevance score for the results. Defaults to `0`.
-   **Returns**: The updated `SessionState` object.

### `addSuggestion(sessionId: string, prompt: string, suggestion: string): SessionState`

-   **Purpose**: Adds a new suggestion to the specified session.
-   **Parameters**:
    -   `sessionId: string`: The ID of the session.
    -   `prompt: string`: The prompt that led to the suggestion.
    -   `suggestion: string`: The generated suggestion.
-   **Returns**: The updated `SessionState` object.

### `addFeedback(sessionId: string, score: number, comments: string): SessionState`

-   **Purpose**: Adds feedback to the most recent suggestion in the specified session.
-   **Parameters**:
    -   `sessionId: string`: The ID of the session.
    -   `score: number`: The feedback score.
    -   `comments: string`: Textual feedback comments.
-   **Returns**: The updated `SessionState` object.
-   **Throws**: Error if the session has no suggestions to add feedback to.

### `updateContext(sessionId: string, repoPath?: string, lastFiles?: string[], lastDiff?: string): SessionState`

-   **Purpose**: Updates the repository context (path, file list, diff) for the specified session.
-   **Parameters**:
    -   `sessionId: string`: The ID of the session.
    -   `repoPath?: string` (optional): The new repository path.
    -   `lastFiles?: string[]` (optional): The new list of files.
    -   `lastDiff?: string` (optional): The new git diff.
-   **Returns**: The updated `SessionState` object.

### `getSessionHistory(sessionId: string): SessionState`

-   **Purpose**: Retrieves the complete state of a specified session.
-   **Parameters**:
    -   `sessionId: string`: The ID of the session.
-   **Returns**: The `SessionState` object.
-   **Throws**: Error if the session is not found.

### `clearSession(sessionId: string): void`

-   **Purpose**: Removes a session from the in-memory storage.
-   **Parameters**:
    -   `sessionId: string`: The ID of the session to clear.

### `generateSessionId(): string` (Internal)

-   **Purpose**: Generates a unique session ID string.
-   **Format**: `session_<timestamp>_<random_string>`

### `getRecentQueries(sessionId: string, limit = 5): string[]`

-   **Purpose**: Retrieves the text of the most recent queries from a session.
-   **Parameters**:
    -   `sessionId: string`: The ID of the session.
    -   `limit: number` (optional): The maximum number of recent queries to return. Defaults to `5`.
-   **Returns**: An array of query strings.

### `getRelevantResults(sessionId: string, limit = 3): unknown[]`

-   **Purpose**: Retrieves the most relevant results from previous queries in a session, sorted by `relevanceScore`.
-   **Parameters**:
    -   `sessionId: string`: The ID of the session.
    -   `limit: number` (optional): The maximum number of query objects (each containing multiple results) to consider. Defaults to `3`.
-   **Returns**: An array of results (flattened from the top queries).

### `getAverageRelevanceScore(sessionId: string): number`

-   **Purpose**: Calculates the average relevance score across all queries in a session.
-   **Parameters**:
    -   `sessionId: string`: The ID of the session.
-   **Returns**: The average relevance score, or `0` if no queries exist.

### `addAgentSteps(sessionId: string, query: string, steps: Array, finalResponse: string): SessionState`

-   **Purpose**: Adds a record of an agent's execution (initial query, steps taken, final response) to the session.
-   **Parameters**:
    -   `sessionId: string`: The ID of the session.
    -   `query: string`: The initial user query that the agent processed.
    -   `steps: Array`: An array of objects detailing each step the agent took (tool, input, output, reasoning).
    -   `finalResponse: string`: The final response generated by the agent.
-   **Returns**: The updated `SessionState` object.

### `getRecentAgentSteps(sessionId: string, limit = 3): unknown[]`

-   **Purpose**: Retrieves a summary of the most recent agent interactions in a session.
-   **Parameters**:
    -   `sessionId: string`: The ID of the session.
    -   `limit: number` (optional): The maximum number of recent agent interactions to return. Defaults to `3`.
-   **Returns**: An array of objects, each summarizing an agent interaction (query, tools used, timestamp). Returns an empty array if no agent steps are recorded.

## Dependencies

-   `./config-service`: For the `logger`.
