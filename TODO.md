# CodeCompass TODO List

This document outlines the tasks required to enhance CodeCompass.

## Phase 0: Foundational Refactoring (Completed)
### Server Startup and Port Conflict Handling
#### Phase 1: Refactor `startServer` Error Handling (Completed)
- **Goal**: Decouple `startServer` from `process.exit`. `startServer` should report startup success by resolving its promise, or failure by throwing a custom `ServerStartupError` (which includes an `exitCode` property). This allows the caller (e.g., `src/index.ts`) to decide the ultimate action.
- **Status**: Completed. `startServer` now throws `ServerStartupError`, and `src/index.ts` handles process exit.

### Port Configuration Enhancements
#### Phase 3: Port Configuration Enhancements (Completed)
- **Goal**: Provide flexible and prioritized ways for users to configure the HTTP port.
- **Tasks**:
    - **`ConfigService` Update**: (Completed) `HTTP_PORT` is now loaded from environment variables (`HTTP_PORT`) with a fallback to a default value. It is *not* loaded from or persisted to `model-config.json`.
    - **CLI Port Argument**: (Completed) Added a CLI argument (`--port <number>`) in `src/index.ts` for specifying the HTTP port. This argument takes the highest precedence.

## Phase 1: Core Architecture Shift to `stdio`-first MCP (Completed)
- **Goal**: Transition CodeCompass to use `stdio` as the primary transport for MCP communication, enhancing privacy and suitability for on-premise local LLM usage. The HTTP server will be simplified to handle utility functions like repository sync triggers and status checks.
- **Status**: Completed.
- **Tasks**:
    - **`src/lib/server.ts` - `stdio` MCP Server Implementation**: (Completed)
        - Modified `startServer` to initialize the `McpServer` instance to use a `StdioServerTransport`.
        - `configureMcpServerInstance` correctly sets up resources, tools, and prompts for the `stdio`-based `McpServer`.
    - **`src/lib/server.ts` - Utility HTTP Server Refinement**: (Completed)
        - Refactored the Express.js app setup.
        - HTTP server *only* exposes `/api/ping`, `/api/indexing-status`, `/api/repository/notify-update`.
        - Removed the `/mcp` HTTP endpoint.
    - **`src/index.ts` - Adapt Server Startup**: (Completed)
        - `startServerHandler` correctly launches the `stdio`-first server and handles new error/resolution logic from `startServer`.
        - Logging indicates `stdio` MCP and utility HTTP endpoints, including relay mode.
    - **Port Conflict Handling for Utility HTTP Server**: (Completed as part of Phase 3 implementation)
        - Logic implemented as part of Phase 3.
    - **Documentation**: (Completed)
        - `README.md` updated for `stdio` MCP and utility HTTP endpoints, including port conflict behavior.

## Client Mode Functionality
### Phase 2: Enhance CLI for Client Mode (Adaptation for `stdio`)
- **Goal**: If the CodeCompass CLI is invoked with a command intended for client-side execution (e.g., `codecompass agent_query "..."`), it should execute the command as an MCP client, primarily using `stdio`.
- **Tasks for `src/index.ts`**:
    - **Argument Parsing for Client Mode**: (Completed) Implemented logic in `src/index.ts` to parse CLI arguments and distinguish "client execution" commands (based on `KNOWN_TOOLS`) from "start server" commands.
    - **Adapt `executeClientCommand` for `stdio` MCP**: (Completed)
        - **Primary Communication via `stdio`**: (Completed) `executeClientCommand` now spawns a dedicated CodeCompass server process and communicates with it over `stdio` using `StdioClientTransport`.
            - The CLI always spawns its own dedicated server instance for the command.
        - **Fallback/Utility Server Check**: (Removed) The HTTP server ping logic was removed from `executeClientCommand` in favor of always spawning a server for `stdio` communication for client tool calls.
        - MCP client setup uses `StdioClientTransport`. (Completed)
        - `client.callTool()` works over `stdio`. (Completed)
    - **Session ID Management for Client Calls**: (Considered/Supported) The current mechanism allows users to pass `sessionId` within the JSON parameters for tools that support it. Help text updated to reflect this. No further client-side generation or automatic management of session IDs is planned for this phase.
    - **Further Enhancements (Future)**:
        - **Add comprehensive unit/integration tests for the `stdio`-based client mode functionality.**
        - **Refactor CLI to use `yargs` library**: (Completed) `src/index.ts` refactored to use `yargs` for argument parsing, command handling, and help generation. This addresses the evaluation of needing a dedicated CLI library.
        - Explore more advanced output formatting options if needed for specific tools.

## Phase 3: Utility HTTP Server Port Conflict Handling (Completed)
- **Goal**: Define behavior when the utility HTTP server (responsible for sync, status) encounters a port conflict.
- **Status**: Option C selected and implemented.
- **Tasks**:
    - **Decision on Conflict Resolution**: (Completed)
        - **Option C selected and implemented**: If the configured utility HTTP port is in use by another CodeCompass utility server, the current instance **will not start its own utility HTTP server**. Instead, its `stdio`-based MCP server will handle relevant MCP tool requests (e.g., for indexing status or triggering updates) by making HTTP client calls to the *existing* utility HTTP server on the original `HTTP_PORT`. If the port is used by a non-CodeCompass service, this instance will log an error and exit.
    - **Implementation**: (Completed)
        - Modified `startServer` in `src/lib/server.ts`:
            - On `EADDRINUSE`, pings the port.
            - If a CodeCompass server responds: Utility HTTP server for the current instance is not started. `configService.IS_UTILITY_SERVER_DISABLED` and `configService.RELAY_TARGET_UTILITY_PORT` are set. `startServer` resolves successfully for `stdio` MCP.
            - If a non-CodeCompass service responds or ping fails: Throws a `ServerStartupError` to cause the instance to exit.
        - Modified MCP tool `get_indexing_status` and added `trigger_repository_update` tool in `src/lib/server.ts` to relay requests via `axios` if `IS_UTILITY_SERVER_DISABLED` is true.
    - **Testing**: (Completed) Unit tests added for utility HTTP port conflict handling and MCP tool relaying in `src/tests/server.test.ts`. Unit tests for `src/index.ts` updated to reflect new server startup behavior.
    - **Documentation**: (Completed)
        - `README.md` updated regarding utility HTTP port conflicts and relay behavior.
        - CLI help text (via `KNOWN_TOOLS` in `src/index.ts`) implicitly updated by adding `trigger_repository_update`.

## Deprioritized / Replaced Features
### HTTP-to-HTTP MCP Proxy (Previously Phase 4)
- **Original Goal**: If CodeCompass CLI attempts to start a server on a port already occupied by another CodeCompass instance, start a lightweight HTTP proxy on a different port to forward MCP requests.
- **Status**: Core logic was implemented. However, with the shift to `stdio`-first MCP, this HTTP-to-HTTP proxy for MCP calls is no longer the primary strategy.
- **Completed Sub-Tasks (Historical)**:
    - `ServerStartupError` enhancement.
    - `findFreePort` utility.
    - `startProxyServer` function (HTTP-to-HTTP proxy).
    - `startServerHandler` logic to call `startProxyServer`.
-- **Reason for Deprioritization**: The primary MCP interface will be `stdio`. The utility HTTP server port conflict will be handled differently (see Phase 3 above, Option C does not use `findFreePort` for the utility server). Tests for `findFreePort` are primarily relevant to the deprioritized HTTP-to-HTTP proxy. Tests for `startProxyServer` (HTTP-to-HTTP MCP proxy) are no longer a priority.

## Next Steps (Immediate Focus)
- **Implement Phase 1 & 3**: (Completed) Core architecture shifted to `stdio`-first MCP, and utility HTTP server port conflict handling (Option C) implemented. Unit tests updated/added.
- **Adapt Phase 2: Enhance CLI for Client Mode for `stdio`**: (Implementation Completed)
    - `stdio`-based client communication in `executeClientCommand` implemented (spawns server process).
- **Update Documentation**: (Completed for Phase 1, 2 & 3) `README.md`, `TODO.md`, `CHANGELOG.md`, `RETROSPECTION.md` updated.
- **Testing**:
    - (Completed) Unit tests for utility HTTP port conflict handling and MCP tool relaying in `src/tests/server.test.ts`.
    - (Completed) Unit tests for `src/index.ts` CLI behavior (including stdio client mode) updated.
    - (In Progress) Develop comprehensive integration tests for `stdio` server and client interactions.
        - Initial test file structure and basic connection test created. (a52448e)
        - Mocks for Qdrant, Ollama, and LLMProvider set up. (a52448e)
        - Added integration tests for indexing, search_code, and agent_query. (212f0ff)
        - Unmocked `indexRepository` and `getGlobalIndexingStatus` in integration tests for more realistic testing. (230f232)
        - Added integration tests for `get_changelog` and `trigger_repository_update`. (230f232)
        - Enhanced Qdrant client mock in integration tests to support `scroll` and `delete` methods for stale entry cleanup. (230f232)
        - Added integration tests for `switch_suggestion_model`, `get_session_history`, `generate_suggestion`, and `get_repository_context`.
