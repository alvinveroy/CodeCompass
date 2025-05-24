# CodeCompass Context Improvement TODO List

This document outlines the tasks required to enhance CodeCompass's ability to provide comprehensive context to its AI agent, especially when dealing with large and complex git repositories.
# CodeCompass TODO List

This document outlines the tasks required to enhance CodeCompass.

## Server Startup and Port Conflict Handling

### Phase 1: Refactor `startServer` Error Handling (Completed)
- **Goal**: Decouple `startServer` from `process.exit`. `startServer` should report startup success by resolving its promise, or failure by throwing a custom `ServerStartupError` (which includes an `exitCode` property). This allows the caller (e.g., `src/index.ts`) to decide the ultimate action.
- **Status**: Completed. `startServer` now throws `ServerStartupError`, and `src/index.ts` handles process exit.

## Port Configuration Enhancements

### Phase 3: Port Configuration Enhancements (In Progress)
- **Goal**: Provide flexible and prioritized ways for users to configure the HTTP port.
- **Tasks**:
    - **`ConfigService` Update**: (Completed) `HTTP_PORT` is now loaded from environment variables (`HTTP_PORT`) with a fallback to a default value. It is *not* loaded from or persisted to `model-config.json`.
    - **CLI Port Argument**: (Next) Add a CLI argument (e.g., `--port <number>`) in `src/index.ts` for specifying the HTTP port. This argument should take the highest precedence by setting `process.env.HTTP_PORT` before `ConfigService` is initialized.

## Client Mode Functionality

### Phase 2: Enhance CLI for Client Mode (Future Task)
- **Goal**: If the CodeCompass CLI is invoked with a command intended for client-side execution (e.g., `codecompass agent_query "..."`) and an existing CodeCompass server is detected, the CLI should execute the command as an MCP client against the existing server.
- **Tasks for `src/index.ts`**:
    - Implement logic to parse CLI arguments to distinguish between "start server" commands and "client execution" commands.
    - If a "client execution" command is identified:
        - Attempt to connect to the CodeCompass server on the configured port.
        - If a server is running and responsive, use MCP client logic to send the command.
        - If no server is running, inform the user and suggest starting it.
    - If a "start server" command is identified, proceed with `startServer` as currently implemented.
