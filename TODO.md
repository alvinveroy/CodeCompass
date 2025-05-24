# CodeCompass Context Improvement TODO List

This document outlines the tasks required to enhance CodeCompass's ability to provide comprehensive context to its AI agent, especially when dealing with large and complex git repositories.
# CodeCompass TODO List

This document outlines the tasks required to enhance CodeCompass.

## Server Startup and Port Conflict Handling

### Phase 1: Refactor `startServer` Error Handling (Completed)
- **Goal**: Decouple `startServer` from `process.exit`. `startServer` should report startup success by resolving its promise, or failure by throwing a custom `ServerStartupError` (which includes an `exitCode` property). This allows the caller (e.g., `src/index.ts`) to decide the ultimate action.
- **Status**: Completed. `startServer` now throws `ServerStartupError`, and `src/index.ts` handles process exit.

## Port Configuration Enhancements

### Phase 3: Port Configuration Enhancements (Completed)
- **Goal**: Provide flexible and prioritized ways for users to configure the HTTP port.
- **Tasks**:
    - **`ConfigService` Update**: (Completed) `HTTP_PORT` is now loaded from environment variables (`HTTP_PORT`) with a fallback to a default value. It is *not* loaded from or persisted to `model-config.json`.
    - **CLI Port Argument**: (Completed) Added a CLI argument (`--port <number>`) in `src/index.ts` for specifying the HTTP port. This argument takes the highest precedence.

## Client Mode Functionality

### Phase 2: Enhance CLI for Client Mode (In Progress)
- **Goal**: If the CodeCompass CLI is invoked with a command intended for client-side execution (e.g., `codecompass agent_query "..."`) and an existing CodeCompass server is detected, the CLI should execute the command as an MCP client against the existing server.
- **Tasks for `src/index.ts`**:
    - **Argument Parsing for Client Mode**: (Completed) Implemented logic in `src/index.ts` to parse CLI arguments and distinguish "client execution" commands (based on `KNOWN_TOOLS`) from "start server" commands.
    - **Initial Client Command Execution (`executeClientCommand`)**: (Completed)
        - Implemented server ping (`/api/ping`) to check for a running CodeCompass instance.
        - Implemented dynamic import of `configService` and MCP SDK client components.
        - Implemented MCP client setup (`Client`, `StreamableHTTPClientTransport`).
        - Implemented `client.callTool()` to execute the specified tool with parsed JSON parameters.
        - Implemented improved error reporting and output formatting for tool results and connection/tool call failures.
    - **Session ID Management for Client Calls**: (Considered/Supported) The current mechanism allows users to pass `sessionId` within the JSON parameters for tools that support it. Help text updated to reflect this. No further client-side generation or automatic management of session IDs is planned for this phase.
    - **Further Enhancements (Future)**:
        - **Add comprehensive unit/integration tests for the client mode functionality.** (In Progress - Initial tests added, will need significant updates after yargs refactor)
        - **Refactor CLI to use `yargs` library**: (Completed) `src/index.ts` refactored to use `yargs` for argument parsing, command handling, and help generation. This addresses the evaluation of needing a dedicated CLI library.
        - Explore more advanced output formatting options if needed for specific tools.
