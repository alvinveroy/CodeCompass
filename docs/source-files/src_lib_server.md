# `src/lib/server.ts`

## Overview

The `src/lib/server.ts` module is the core of the CodeCompass MCP (Model-Context-Protocol) server. It initializes and manages the server, registers various resources and tools, and handles communication with clients. The server provides functionalities for code search, repository context retrieval, code suggestion generation, and agent-based query processing.

## Key Functions

### `normalizeToolParams(params: unknown): Record<string, unknown>`

-   **Purpose**: Standardizes the format of parameters passed to MCP tools. It ensures that tool parameters are always a `Record<string, unknown>`.
-   **Details**:
    -   If `params` is already an object, it's returned as `{ ...params }` to ensure a standard prototype.
    -   If `params` is a string that can be parsed as JSON, the parsed object is returned. Otherwise, the string is returned as `{ query: params }`.
    -   If `params` is `null` or `undefined`, it returns `{ query: "" }`.
    -   For other primitive types (number, boolean, bigint, symbol), it returns `{ query: String(params) }` (or `params.toString()` for symbols).

### `startServer(repoPath: string): Promise<void>`

-   **Purpose**: Initializes and starts the CodeCompass MCP server.
-   **Parameters**:
    -   `repoPath: string`: The file system path to the Git repository that the server will operate on. If invalid or empty, it defaults to the current working directory.
-   **Process**:
    1.  **Global Error Handling**: Sets up `process.on('uncaughtException', ...)` and `process.on('unhandledRejection', ...)` to log critical errors and exit.
    2.  **Configuration**: Reloads configurations using `configService.reloadConfigsFromFile(true)`.
    3.  **Repository Validation**: Validates the `repoPath`.
    4.  **LLM & Model Availability**:
        -   Initializes the LLM provider using `getLLMProvider()`.
        -   Checks the connection to the LLM provider.
        -   Verifies the availability of configured suggestion and embedding models (e.g., via `checkOllamaModel` for Ollama).
    4.  **Qdrant Initialization**: Initializes the Qdrant client using `initializeQdrant()`.
    5.  **Repository Indexing**: Indexes the repository using `indexRepository()`.
    6.  **MCP Server Setup**:
        -   Creates an `McpServer` instance with defined capabilities (name, version, resources, tools).
        -   The list of available tools (e.g., `search_code`, `generate_suggestion`) can be dynamically adjusted based on `suggestionModelAvailable`.
    7.  **Resource Registration**: Registers several resources using `server.resource()`:
        -   `repo://health`: Provides health status of Ollama, Qdrant, and the repository.
        -   `repo://version`: Provides the server version.
        -   `repo://structure`: Lists files in the Git repository.
        -   `repo://files/{filepath}`: Allows reading content of specific files. Handles `filepath` provided as a string or the first element of an array. Includes security checks to prevent path traversal outside the repository and resolves symbolic links safely within the repository.
    8.  **Tool Registration**: Calls `registerTools()` to set up all available MCP tools.
    9.  **Prompt Registration**: Calls `registerPrompts()` to define standard prompts.
    10. **Switch Model Tool**: Registers a specific tool `switch_suggestion_model` to allow dynamic changing of the LLM model and provider for suggestions.
    11. **Transport**: Sets up `StdioServerTransport` for communication.
    12. **Logging & Startup**: Logs server startup information and connects the server to the transport.
    13. **Signal Handling**: Handles `SIGINT` for graceful shutdown.

### `registerPrompts(server: McpServer): Promise<void>`

-   **Purpose**: Registers predefined prompts with the MCP server.
-   **Parameters**:
    -   `server: McpServer`: The MCP server instance.
-   **Registered Prompts**:
    -   `repository-context`: "Get context about your repository."
    -   `code-suggestion`: "Generate code suggestions."
    -   `code-analysis`: "Analyze code problems."
-   **Details**: Each prompt is defined with a name, description, Zod schema for parameters (typically `{ query: z.string() }`), and a function that constructs the LLM message payload.

### `registerTools(server: McpServer, qdrantClient: QdrantClient, repoPath: string, suggestionModelAvailable: boolean): Promise<void>`

-   **Purpose**: Registers various tools that the MCP server can execute.
-   **Parameters**:
    -   `server: McpServer`: The MCP server instance.
    -   `qdrantClient: QdrantClient`: The initialized Qdrant client.
    -   `repoPath: string`: Path to the repository.
    -   `suggestionModelAvailable: boolean`: Flag indicating if an LLM suggestion model is available.
-   **Registered Tools**:
    -   **`agent_query`**:
        -   **Description**: Provides a detailed plan and summary for complex codebase questions in a single pass.
        -   **Process**: The user's `query` is first used with `searchWithRefinement` to gather initial code context. This context, along with the original query, forms an augmented prompt for `SuggestionPlanner.initiateAgentQuery()`.
    -   **`search_code`**:
        -   **Description**: Performs semantic search for code snippets.
        -   **Process**: Uses `searchWithRefinement()` to find relevant code. If `suggestionModelAvailable`, it also generates summaries for each result using the LLM provider. Manages session state for context.
        -   Updates session state with the query and results using `addQuery()`.
    -   **`get_changelog`**:
        -   **Description**: Retrieves the content of `CHANGELOG.md`.
    -   **`get_session_history`**:
        -   **Description**: Retrieves interaction history for a given session ID.
    -   **`generate_suggestion`** (if `suggestionModelAvailable`):
        -   **Description**: Generates code suggestions or implementation ideas.
        -   **Process**: Augments the user query with context from `searchWithRefinement()`, repository diff, and session history. Uses the LLM provider to generate the suggestion.
        -   Updates session state using `addSuggestion()`.
    -   **`get_repository_context`** (if `suggestionModelAvailable`):
        -   **Description**: Provides a high-level summary of repository structure and conventions relevant to a query.
        -   **Process**: Similar to `generate_suggestion`, it gathers context and uses the LLM provider to synthesize a summary.
        -   Updates session state using `addQuery()`.

## Dependencies

-   `@modelcontextprotocol/sdk/server/mcp.js`: For MCP server functionality.
-   `@modelcontextprotocol/sdk/server/stdio.js`: For Stdio transport.
-   `fs/promises`, `path`: For file system and path operations.
-   `isomorphic-git`: For Git operations.
-   `@qdrant/js-client-rest`: Qdrant client.
-   `zod`: For schema validation of tool parameters.
-   Local Modules:
    -   `./config-service`: For configuration management and logging.
    -   `./ollama`: For Ollama specific checks (`checkOllama`, `checkOllamaModel`).
    -   `./qdrant`: For Qdrant initialization (`initializeQdrant`).
    -   `./query-refinement`: For `searchWithRefinement`.
    -   `./repository`: For repository operations (`validateGitRepository`, `indexRepository`, `getRepositoryDiff`).
    -   `./llm-provider`: For LLM interactions (`getLLMProvider`, `switchSuggestionModel`).
    -   `./suggestion-service`: For `SuggestionPlanner`.
    -   `./types`: For shared type definitions.
    -   `./version`: For server version information.
    -   `./state`: For session state management (`getOrCreateSession`, `addQuery`, etc.).

## Key Data Structures and Concepts

-   **MCP Server (`McpServer`)**: The central object managing resources, tools, and client communication.
-   **Tools**: Functions registered with the server that perform specific actions (e.g., searching code, generating suggestions). Each tool has a name, description, Zod schema for input parameters, and an asynchronous handler function.
-   **Resources**: Data endpoints exposed by the server (e.g., file content, repository structure).
-   **Prompts**: Predefined templates for interacting with LLMs, registered with the server.
-   **Session Management (`./state.ts`)**: The server maintains session state to provide context across multiple tool invocations (e.g., `search_code` followed by `generate_suggestion`).
-   **Configuration (`./config-service.ts`)**: Centralized configuration management for API keys, model names, hosts, etc.
-   **LLM Abstraction (`./llm-provider.ts`)**: Provides a consistent interface for interacting with different LLM providers (Ollama, DeepSeek, etc.).
-   **Vector Search (`./qdrant.ts`, `./query-refinement.ts`)**: Uses Qdrant for semantic search and refines queries for better results.
-   **Normalization (`normalizeToolParams`)**: Ensures tool inputs are consistently structured.
