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
        - **Add comprehensive unit/integration tests for the client mode functionality.** (In Progress - Initial tests added, significant updates and fixes applied during yargs refactor and subsequent build/test cycles. Ongoing refinement needed.)
        - **Refactor CLI to use `yargs` library**: (Completed) `src/index.ts` refactored to use `yargs` for argument parsing, command handling, and help generation. This addresses the evaluation of needing a dedicated CLI library.
        - Explore more advanced output formatting options if needed for specific tools.

## Phase 4: MCP Client Bridge on Port Conflict (Completed - Core Logic)
- **Goal**: If CodeCompass CLI attempts to start a server on a port already occupied by another CodeCompass instance, instead of just exiting, the new instance should start a lightweight proxy server on a *different*, free port. This proxy will forward MCP requests and key API calls (like `/api/ping`, `/api/indexing-status`) to the original, running CodeCompass server.
- **Status**: Core logic implemented as of commit `a51a8f8` and refined in subsequent commits (e.g., `5ffc89c`).
- **Tasks Completed**:
    - **`src/lib/server.ts` Modifications**:
        - **`ServerStartupError` Enhancement**: (Completed) Updated `ServerStartupError` to include `originalError`, `existingServerStatus`, `requestedPort`, and `detectedServerPort`.
        - **Populate Enhanced `ServerStartupError`**: (Completed) In `startServer`, when an `EADDRINUSE` error occurs and an existing CodeCompass instance is detected, the new fields in `ServerStartupError` are populated (with `exitCode: 0`).
        - **`findFreePort` Utility**: (Completed) Added helper function `async findFreePort(startPort: number): Promise<number>`.
        - **`startProxyServer` Function**: (Completed) Implemented `async function startProxyServer(requestedPort: number, targetServerPort: number, existingServerVersion?: string): Promise<void>`.
    - **`src/index.ts` Modifications**:
        - **Update `startServerHandler`**: (Completed) In the `catch` block for `ServerStartupError`, if `error.exitCode === 0`, `startProxyServer` is called.
- **Pending Tasks for Phase 4**:
    - **Testing**: Add comprehensive unit/integration tests for `findFreePort` and the proxying behavior of `startProxyServer`. Test the main CLI flow for entering proxy mode more thoroughly.
    - **Documentation**: Update `README.md` and CLI help text to explain the proxy mode behavior if a port conflict with another CodeCompass instance occurs.

## Next Steps (Immediate Focus)
- **Resolve Remaining ESLint Issues**: Address all errors and warnings from `npm run lint -- --fix`.
- **Fix Build and Test Failures**: Ensure `npm run build` and `npm test` pass cleanly after recent refactoring and ESLint fixes. This includes addressing:
    - `esbuild` errors (e.g., "The symbol ... has already been declared" in test files).
    - `tsc` compilation errors.
    - Any remaining unit test failures.
- **Update Documentation**:
    - Update `CHANGELOG.md` and `RETROSPECTION.md` with the latest commit ID (`5ffc89c` or subsequent) once the current batch of fixes is stable.
    - Review and update `README.md` for CLI usage, proxy mode, and configuration.
