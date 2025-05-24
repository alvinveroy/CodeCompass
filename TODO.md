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

## Phase 1: Core Architecture Shift to `stdio`-first MCP
- **Goal**: Transition CodeCompass to use `stdio` as the primary transport for MCP communication, enhancing privacy and suitability for on-premise local LLM usage. The HTTP server will be simplified to handle utility functions like repository sync triggers and status checks.
- **Tasks**:
    - **`src/lib/server.ts` - `stdio` MCP Server Implementation**:
        - Modify `startServer` to initialize the `McpServer` instance to use a `StdioServerTransport` (or equivalent from the MCP SDK) for handling MCP requests over `stdio`.
        - Ensure `configureMcpServerInstance` correctly sets up resources, tools, and prompts for the `stdio`-based `McpServer`.
    - **`src/lib/server.ts` - Utility HTTP Server Refinement**:
        - Refactor the Express.js app setup within `startServer`.
        - The HTTP server should *only* expose essential utility endpoints:
            - `/api/ping` (for health checks)
            - `/api/indexing-status` (for checking sync status)
            - `/api/repository/notify-update` (for git commit hooks to trigger re-indexing)
        - Remove the `/mcp` HTTP endpoint. All MCP communication will be via `stdio`.
    - **`src/index.ts` - Adapt Server Startup**:
        - Ensure `startServerHandler` correctly launches the `stdio`-first server.
        - Logging and console output should clearly indicate that MCP is available via `stdio` and utility HTTP endpoints are on the configured port.
    - **Port Conflict Handling for Utility HTTP Server**:
        - If the utility HTTP server (on `HTTP_PORT`) encounters an `EADDRINUSE` error:
            - If another CodeCompass utility server is detected, log its presence and exit gracefully (similar to current behavior but without proxying).
            - If a non-CodeCompass service is on the port, log an error and exit.
            - The `findFreePort` utility might still be useful if the decision is to try an alternative port for the *utility* HTTP server, but this is secondary to `stdio` MCP.
    - **Documentation**:
        - Update `README.md` to reflect `stdio` as the primary MCP interface.
        - Document how clients (e.g., editor extensions) should connect via `stdio`.
        - Document the available utility HTTP endpoints and their purpose.

## Client Mode Functionality
### Phase 2: Enhance CLI for Client Mode (Adaptation for `stdio`)
- **Goal**: If the CodeCompass CLI is invoked with a command intended for client-side execution (e.g., `codecompass agent_query "..."`), it should execute the command as an MCP client against a running CodeCompass instance, primarily using `stdio`.
- **Tasks for `src/index.ts`**:
    - **Argument Parsing for Client Mode**: (Completed) Implemented logic in `src/index.ts` to parse CLI arguments and distinguish "client execution" commands (based on `KNOWN_TOOLS`) from "start server" commands.
    - **Adapt `executeClientCommand` for `stdio` MCP**:
        - **Primary Communication via `stdio`**: Modify `executeClientCommand` to attempt MCP communication via `stdio` first. This will involve:
            - Using an MCP SDK `StdioClientTransport` (or equivalent).
            - Directly launching a CodeCompass server process if one isn't running and piping `stdio` for communication. (This needs careful design: does the CLI *become* the server temporarily, or does it spawn a separate server process and connect via `stdio`?)
            - Alternatively, if a CodeCompass server process is already running and configured for `stdio` MCP, the CLI client needs a mechanism to connect to its `stdio` streams. This is non-trivial for arbitrary existing processes and might imply the CLI always spawns its own dedicated server instance for the command.
        - **Fallback/Utility Server Check**: The `/api/ping` check on the utility HTTP port can still be used to see if *any* CodeCompass instance (and its utility HTTP server) is running, which might inform the CLI's behavior (e.g., not trying to start a new full server if one is already handling sync).
        - Update MCP client setup to use the appropriate `stdio`-based transport.
        - Ensure `client.callTool()` works correctly over `stdio`.
    - **Session ID Management for Client Calls**: (Considered/Supported) The current mechanism allows users to pass `sessionId` within the JSON parameters for tools that support it. Help text updated to reflect this. No further client-side generation or automatic management of session IDs is planned for this phase.
    - **Further Enhancements (Future)**:
        - **Add comprehensive unit/integration tests for the `stdio`-based client mode functionality.**
        - **Refactor CLI to use `yargs` library**: (Completed) `src/index.ts` refactored to use `yargs` for argument parsing, command handling, and help generation. This addresses the evaluation of needing a dedicated CLI library.
        - Explore more advanced output formatting options if needed for specific tools.

## Phase 3: Utility HTTP Server Port Conflict Handling (Replaces previous Phase 4)
- **Goal**: Define behavior when the utility HTTP server (responsible for sync, status) encounters a port conflict.
- **Status**: Design and implementation pending.
- **Tasks**:
    - **Decision on Conflict Resolution**:
        - Option A: Exit gracefully if another CodeCompass utility HTTP server is detected (similar to current `ServerStartupError` with `exitCode: 0` but without starting a proxy).
        - Option B: Attempt to find a new free port for the utility HTTP server using `findFreePort` and start it there.
        - Option C: Other (e.g., disable utility HTTP server if port is taken).
    - **Implementation**: Implement the chosen conflict resolution strategy in `src/lib/server.ts` and `src/index.ts`.
    - **Testing**: Add unit tests for the chosen utility HTTP port conflict handling.
    - **Documentation**: Update `README.md` and CLI help text regarding utility HTTP port conflicts.

## Deprioritized / Replaced Features
### HTTP-to-HTTP MCP Proxy (Previously Phase 4)
- **Original Goal**: If CodeCompass CLI attempts to start a server on a port already occupied by another CodeCompass instance, start a lightweight HTTP proxy on a different port to forward MCP requests.
- **Status**: Core logic was implemented. However, with the shift to `stdio`-first MCP, this HTTP-to-HTTP proxy for MCP calls is no longer the primary strategy.
- **Completed Sub-Tasks (Historical)**:
    - `ServerStartupError` enhancement.
    - `findFreePort` utility.
    - `startProxyServer` function (HTTP-to-HTTP proxy).
    - `startServerHandler` logic to call `startProxyServer`.
- **Reason for Deprioritization**: The primary MCP interface will be `stdio`. The utility HTTP server port conflict will be handled differently (see Phase 3 above). Tests for `findFreePort` might still be relevant for the utility server. Tests for `startProxyServer` (HTTP-to-HTTP MCP proxy) are no longer a priority.

## Next Steps (Immediate Focus)
- **Implement Phase 1: Core Architecture Shift to `stdio`-first MCP**:
    - Focus on `src/lib/server.ts` modifications for `stdio` MCP transport and utility-only HTTP server.
    - Adapt `src/index.ts` for starting this new server mode.
- **Adapt Phase 2: Enhance CLI for Client Mode for `stdio`**:
    - Design and implement `stdio`-based client communication in `executeClientCommand`.
- **Design and Implement Phase 3: Utility HTTP Server Port Conflict Handling**.
- **Update Documentation**: Reflect the new `stdio`-first architecture in `README.md` and other relevant documents.
- **Testing**: Develop comprehensive tests for the new `stdio` server and client interactions.
