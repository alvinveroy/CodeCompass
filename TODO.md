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
            - **If another CodeCompass utility server is detected:**
                - This new instance **does not start its own utility HTTP server.** Log this decision.
                - The `stdio` MCP server of this new instance will handle relevant MCP tool requests (e.g., for indexing status, triggering updates) by making HTTP client calls to the *existing* utility HTTP server on the original `HTTP_PORT`.
                - This effectively makes the `stdio` MCP server a relay for utility functions to the primary running instance.
            - **If a non-CodeCompass service is on the port:** Log an error and exit (as utility functions cannot be provided by this instance, and relaying is not possible).
            - The `findFreePort` utility is **not used** by this instance to find an alternative port for its own utility HTTP server in this conflict scenario.
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
- **Status**: Option C selected. Implementation pending.
- **Tasks**:
    - **Decision on Conflict Resolution**:
        - **Option C selected**: If the configured utility HTTP port is in use by another CodeCompass utility server, the current instance **will not start its own utility HTTP server**. Instead, its `stdio`-based MCP server will handle relevant MCP tool requests (e.g., for indexing status or triggering updates) by making HTTP client calls to the *existing* utility HTTP server on the original `HTTP_PORT`. If the port is used by a non-CodeCompass service, this instance will log an error and exit.
    - **Implementation**: Implement the chosen conflict resolution strategy in `src/lib/server.ts` and `src/index.ts`.
        - Modify `startServer` in `src/lib/server.ts` to implement this logic:
            - On `EADDRINUSE` for the utility HTTP port, ping the port.
            - If a CodeCompass server responds:
                - Do not start the Express app for utility HTTP endpoints in the current instance.
                - Log that utility HTTP server is disabled for this instance and requests will be relayed via `stdio` MCP to the existing server on `HTTP_PORT`.
                - The `stdio` MCP server (initialized in `startServer`) must be aware of the `HTTP_PORT` of the existing utility server (e.g., from `configService`).
            - If a non-CodeCompass service responds or ping fails (indicating the port is blocked by something else):
                - Throw a `ServerStartupError` to cause the instance to exit, as utility functions cannot be provided or relayed.
        - Modify/Ensure MCP tool handlers in `src/lib/server.ts` (e.g., for `get_indexing_status`, and a potential new `trigger_repository_update` tool):
            - These handlers, when executed in an instance where the local utility HTTP server is disabled due to conflict, should use an HTTP client (e.g., `axios`) to make requests to the *existing* (other instance's) utility server's API endpoints (e.g., `http://localhost:<HTTP_PORT>/api/indexing-status`, `http://localhost:<HTTP_PORT>/api/repository/notify-update`).
    - **Testing**: Add unit tests for the chosen utility HTTP port conflict handling.
        - Test the scenario where the utility HTTP port is taken by another CodeCompass instance:
            - Verify that the utility HTTP server for the new instance is not started.
            - Verify that MCP tools (like `get_indexing_status`) on the new instance's `stdio` interface correctly relay requests to (and responses from) the mocked existing utility HTTP server.
        - Test the scenario where the port is taken by a non-CodeCompass service (new instance should exit with an error).
    - **Documentation**: Update `README.md` and CLI help text regarding utility HTTP port conflicts.
        - Explain that if the utility HTTP port is taken by another CodeCompass instance, the new instance runs in `stdio`-MCP-only mode for core queries. Its utility-related MCP tools will communicate with the existing instance's HTTP utility endpoints.
        - Clarify that Git hooks should generally target the primary running instance's HTTP port.

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
- **Implement Phase 1: Core Architecture Shift to `stdio`-first MCP**:
    - Focus on `src/lib/server.ts` modifications for `stdio` MCP transport and utility-only HTTP server.
    - Adapt `src/index.ts` for starting this new server mode.
- **Adapt Phase 2: Enhance CLI for Client Mode for `stdio`**:
    - Design and implement `stdio`-based client communication in `executeClientCommand`.
- **Design and Implement Phase 3: Utility HTTP Server Port Conflict Handling**.
- **Update Documentation**: Reflect the new `stdio`-first architecture in `README.md` and other relevant documents.
- **Testing**: Develop comprehensive tests for the new `stdio` server and client interactions.
