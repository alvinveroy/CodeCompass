# CodeCompass Context Improvement TODO List

This document outlines the tasks required to enhance CodeCompass's ability to provide comprehensive context to its AI agent, especially when dealing with large and complex git repositories.

## Intelligent HTTP Port Handling (EADDRINUSE Resolution)

This set of tasks aims to implement robust handling of HTTP port conflicts. If the configured port is in use, the application will check if it's another CodeCompass instance. If so, it will connect and display its status. Otherwise, it will warn the user and exit.

### Phase 1: Core Logic Implementation & Testing

-   **[High Priority] Task 1: Implement Core Port Handling Logic in `src/lib/server.ts`**
    -   [ ] Add an HTTP GET endpoint `/api/ping` to `expressApp`.
        -   This endpoint should return a simple JSON response (e.g., `{ "service": "CodeCompass", "status": "ok", "version": "current_version" }`) to identify it as a CodeCompass server.
    -   [ ] Import `axios` for making HTTP requests.
    -   [ ] Import `IndexingStatusReport` type from `src/lib/repository.ts`.
    -   [ ] Modify the `EADDRINUSE` error handler within `httpServer.on('error', ...)` in the `startServer` function:
        -   [ ] **Attempt to Ping:** When `EADDRINUSE` is caught:
            -   Log that the port is in use and an attempt to ping is being made.
            -   Use `axios.get` to send a GET request to `http://localhost:${httpPort}/api/ping`. Include a short timeout (e.g., 500ms).
        -   [ ] **Handle Ping Success (Another CodeCompass Instance):**
            -   If the ping is successful and the response indicates it's a CodeCompass server (e.g., `response.data.service === "CodeCompass"`):
                -   Log that another CodeCompass instance was detected.
                -   Make an `axios.get` request to `http://localhost:${httpPort}/api/indexing-status` to fetch its status.
                -   If the status request is successful:
                    -   Format and print the received `IndexingStatusReport` to the console (e.g., using `console.info`).
                    -   Log a message indicating that the current instance will exit as another instance is already running.
                    -   Gracefully exit the current instance (e.g., `return;` from `startServer` to prevent it from trying to connect to the MCP transport, or `process.exit(0)` if appropriate after logging).
                -   If the status request fails:
                    -   Log an error detailing the failure to retrieve status from the existing CodeCompass server.
                    -   Exit the current instance with an error code (e.g., `process.exit(1)`).
        -   [ ] **Handle Ping Failure (Non-CodeCompass Service or Other Error):**
            -   If the ping to `/api/ping` fails (e.g., timeout, connection refused, non-CodeCompass response, or any other error):
                -   Log an error message stating that the port is in use by an unknown service or the existing CodeCompass server is unresponsive to pings.
                -   Advise the user to free the port or configure a different one.
                -   Exit the current instance with an error code (e.g., `process.exit(1)`).
    -   [ ] Ensure `axios` is added as a dependency in `package.json` if it's not already there (it was confirmed to be present previously).

-   **[High Priority] Task 2: Add Unit Tests in `src/tests/server.test.ts`**
    -   [ ] Create a new `describe` block for "Server Startup and Port Handling".
    -   [ ] Mock necessary modules:
        -   `http` (specifically `createServer`, `listen`, and the `on('error', ...)` event emitter).
        -   `axios` (to mock `get` requests and responses for `/api/ping` and `/api/indexing-status`).
        -   `process.exit`.
        -   `console.info` and `logger` methods (`error`, `warn`, `info`).
        -   `configService` to control `HTTP_PORT`.
        -   `src/lib/repository` to mock `getGlobalIndexingStatus` if its direct return is used by the ping/status endpoints, or `IndexingStatusReport` type for mock data.
    -   [ ] Test Scenarios:
        -   [ ] **Port is free:** Verify `httpServer.listen` is called and the server proceeds with normal startup (e.g., `server.connect` is called).
        -   [ ] **Port in use by another CodeCompass server (successful ping & status):**
            -   Simulate `EADDRINUSE`.
            -   Mock `axios.get` for `/api/ping` to return a successful CodeCompass signature.
            -   Mock `axios.get` for `/api/indexing-status` to return a mock `IndexingStatusReport`.
            -   Verify `console.info` is called with the status.
            -   Verify `logger.info` (or similar) is called indicating graceful exit.
            -   Verify `process.exit` is NOT called with `1` (or that the `startServer` function returns early).
            -   Verify `server.connect` is NOT called.
        -   [ ] **Port in use by a non-CodeCompass server (ping fails or returns non-CC signature):**
            -   Simulate `EADDRINUSE`.
            -   Mock `axios.get` for `/api/ping` to throw an error or return a non-CodeCompass signature.
            -   Verify `logger.error` is called with the appropriate warning.
            -   Verify `process.exit(1)` is called.
            -   Verify `server.connect` is NOT called.
        -   [ ] **Port in use by CodeCompass, but `/api/ping` fails unexpectedly:**
            -   Simulate `EADDRINUSE`.
            -   Mock `axios.get` for `/api/ping` to throw a network error after initially indicating a CC server (if possible to model, otherwise treat as general ping failure).
            -   Verify `logger.error` is called.
            -   Verify `process.exit(1)` is called.
        -   [ ] **Port in use by CodeCompass, ping ok, but `/api/indexing-status` fails:**
            -   Simulate `EADDRINUSE`.
            -   Mock `axios.get` for `/api/ping` to return success.
            -   Mock `axios.get` for `/api/indexing-status` to throw an error.
            -   Verify `logger.error` is called.
            -   Verify `process.exit(1)` is called.

### Phase 2: Documentation & Verification

-   **[Medium Priority] Task 3: Update Documentation**
    -   [ ] **`CHANGELOG.md`**:
        -   Add a new entry under `[Unreleased]` -> `### Added` or `### Changed` for the "Intelligent HTTP Port Handling" feature.
        -   Describe the new behavior: checks for existing CodeCompass instances, connects to display status if found, otherwise warns and exits.
        -   Include a placeholder for the Git commit ID: `(Git Commit ID: [GIT_COMMIT_ID_PLACEHOLDER])`.
    -   [ ] **`RETROSPECTION.md`**:
        -   Add a new section titled: `# Retrospection for Intelligent HTTP Port Handling (EADDRINUSE) (Git Commit ID: [GIT_COMMIT_ID_PLACEHOLDER])`.
        -   Fill in subsections:
            -   `## What went well?` (e.g., successful implementation of port checking, clear user feedback).
            -   `## What could be improved?` (e.g., alternative port suggestions, more detailed error info from ping).
            -   `## What did we learn?` (e.g., importance of robust startup checks, inter-process communication basics).
            -   `## Action Items / Follow-ups` (e.g., monitor feedback, consider advanced port negotiation).

-   **[Low Priority] Task 4: Build, Lint, and Runtime Verification**
    -   [ ] Run `npm run build` to ensure no TypeScript or build errors.
    -   [ ] Run `npm run lint` (and `npm run lint:fix`) to ensure code style and quality.
    -   [ ] Perform manual runtime testing:
        -   [ ] Start one instance of `codecompass`.
        -   [ ] In a separate terminal, start a second instance of `codecompass` using the same port. Verify it detects the first, prints its status, and exits gracefully.
        -   [ ] Stop both instances.
        -   [ ] Start a different, simple HTTP server on the configured port (e.g., using `python -m http.server <port>` or a simple Node.js server).
        -   [ ] Attempt to start `codecompass` on that port. Verify it warns that the port is in use by another application and exits with an error.
