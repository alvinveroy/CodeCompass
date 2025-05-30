# `src/lib/agent.ts`

## Overview

The `src/lib/agent.ts` module implements an AI agent capable of understanding user queries, selecting appropriate tools to gather information from a codebase, and synthesizing a response. It manages a loop of reasoning, tool execution, and context accumulation to address complex developer questions.

## Key Interfaces and Data Structures

### `Tool` Interface

-   **Purpose**: Defines the structure for tools available to the agent.
-   **Properties**:
    -   `name: string`: The unique name of the tool.
    -   `description: string`: A description of what the tool does, used by the LLM to decide when to use it.
    -   `parameters: Record<string, unknown>`: A description of the parameters the tool accepts (e.g., `{ query: "string - The search query" }`).
    -   `requiresModel: boolean`: Indicates if the tool requires an LLM suggestion model to be available.

### `toolRegistry: Tool[]`

-   **Purpose**: An array of `Tool` objects, acting as a central registry of all tools the agent can use.
-   **Registered Tools (Examples)**:
    -   `search_code`: Searches for code snippets.
    -   `get_repository_context`: Gathers overall context about the repository.
    -   `generate_suggestion`: Generates code suggestions (requires LLM model).
    -   `get_changelog`: Retrieves the project's changelog.
    -   `analyze_code_problem`: Performs in-depth analysis of a code issue (requires LLM model).

### `AgentState` Interface (from `src/lib/types.ts`)

-   **Purpose**: Represents the state of an agent's interaction.
-   **Properties**:
    -   `sessionId: string`: Unique identifier for the session.
    -   `query: string`: The initial user query.
    -   `steps: AgentStep[]`: An array of steps taken by the agent (tool calls, outputs, reasoning).
    -   `context: unknown[]`: Accumulated information from tool outputs.
    -   `planText?: string`: Raw plan generated by the LLM.
    -   `finalResponse?: string`: The final answer generated by the agent.
    -   `isComplete: boolean`: Flag indicating if the agent has finished processing.

## Key Functions

### `createAgentState(sessionId: string, query: string): AgentState`

-   **Purpose**: Initializes a new `AgentState` object.

### `generateAgentSystemPrompt(availableTools: Tool[]): string`

-   **Purpose**: Creates the system prompt for the LLM. This prompt instructs the LLM on how to act as the "CodeCompass Agent", lists available tools with their descriptions and parameters, and provides examples of how to format tool calls (`TOOL_CALL: {"tool": "tool_name", "parameters": {...}}`).

### `parseToolCalls(output: string): { tool: string; parameters: unknown }[]`

-   **Purpose**: Parses the LLM's output string to extract `TOOL_CALL` directives.
-   **Returns**: An array of objects, each representing a tool to be called, including its name and parameters.

### `executeToolCall(toolCall: { tool: string; parameters: unknown }, qdrantClient: QdrantClient, repoPath: string, suggestionModelAvailable: boolean): Promise<unknown>`

-   **Purpose**: Executes a specific tool based on the parsed `toolCall`.
-   **Process**:
    1.  Validates the tool name against `toolRegistry`.
    2.  Checks if a required suggestion model is available.
    3.  Switches on the `tool` name to call the appropriate logic:
        -   **`search_code`**:
            -   Uses `searchWithRefinement` to find relevant code.
            -   Formats results (filepath, snippet, relevance).
            -   Updates session state.
        -   **`get_repository_context`**:
            -   Uses `searchWithRefinement` for context.
            -   Includes repository diff and recent queries.
            -   Updates session state.
        -   **`generate_suggestion`**:
            -   Gathers context (search results, diff, recent queries).
            -   Constructs a detailed prompt for the LLM provider.
            -   Calls `llmProvider.generateText()` to get the suggestion.
            -   Updates session state.
        -   **`get_changelog`**:
            -   Reads `CHANGELOG.md` from the repository.
        -   **`analyze_code_problem`**:
            -   Gathers context using `searchWithRefinement`.
            -   Constructs a detailed analysis prompt for the LLM.
            -   Calls `llmProvider.generateText()` for the analysis.
            -   Updates session state.
-   **Returns**: The output from the executed tool.

### `runAgentLoop(query: string, sessionId: string | undefined, qdrantClient: QdrantClient, repoPath: string, suggestionModelAvailable: boolean, maxSteps = 5): Promise<string>`

-   **Purpose**: Manages the main interaction loop for the agent.
-   **Process**:
    1.  Initializes session and agent state.
    2.  Filters `toolRegistry` based on `suggestionModelAvailable`.
    3.  Generates the initial system prompt.
    4.  **Loop (up to `maxSteps`)**:
        a.  Constructs the current prompt for the LLM, including the system prompt, user query, and context from previous steps.
        b.  Calls `llmProvider.generateText()` to get the agent's reasoning and potential tool calls (with timeout).
        c.  Parses tool calls using `parseToolCalls()`.
        d.  If no tool calls, the agent's output is considered the final response, and the loop breaks.
        e.  For each `toolCall`:
            i.  Executes the tool using `executeToolCall()` (with timeout).
            ii. Records the step (tool, input, output, reasoning) in `agentState`.
            iii. Appends tool output to the context for the next LLM prompt.
        f.  If `maxSteps` is reached, generates a final response based on accumulated information.
    5.  If no final response was generated during the loop, explicitly generates one.
    6.  Stores the final response in the session.
    7.  Formats and returns the final response to the user.
-   **Error Handling**: Includes timeouts for LLM generation and tool execution, with fallback mechanisms.
-   **Provider Refresh**: Includes logic to clear LLM provider cache and re-fetch the provider to ensure up-to-date settings, particularly for model and provider configurations.

## Dependencies

-   `./config-service`: For logging and configuration (e.g., `SUGGESTION_PROVIDER`, `SUGGESTION_MODEL`).
-   `./llm-provider`: To get the LLM provider instance (`getLLMProvider`, `clearProviderCache`).
-   `./state`: For session management (`getOrCreateSession`, `addQuery`, `addSuggestion`, etc.).
-   `@qdrant/js-client-rest`: Qdrant client for vector search.
-   `./types`: For `AgentState`, `AgentStep`, `DetailedQdrantSearchResult`.
-   `./query-refinement`: For `searchWithRefinement`.
-   `./repository`: For Git operations (`validateGitRepository`, `getRepositoryDiff`, listing files).
-   `isomorphic-git`, `fs/promises`, `path`: For file system and Git interactions.
