# CodeCompass Debugging Session Log

**Overall Goal:** Achieve a clean build (`npm run build` with no TypeScript/transform errors and all tests passing).

---
## Summary of Historical Debugging Efforts (Attempts 66 through 91)

The debugging process (spanning commits from approximately `7f14f61` to `691bb8f`) has focused on achieving a clean build and resolving numerous test failures across unit and integration tests.

**1. SUT Mocking in `src/tests/index.test.ts` (Unit Tests for CLI):**
    *   **Initial Problem:** The System Under Test (`src/index.ts`), when dynamically imported by the `runMainWithArgs` helper, consistently failed to use mocks defined in `src/tests/index.test.ts`. This resulted in widespread "spy not called" errors.
    *   **Evolution & Fixes:**
        *   Shifted from testing `dist/index.js` to directly testing `src/index.ts` to align with CI practices and improve mock applicability.
        *   Addressed `tsc` errors in `src/index.ts` (e.g., `await` in non-async yargs `.fail()` handler - fixed around commit `e107328`) that prevented the SUT from loading correctly.
        *   Iteratively refined `vi.mock` calls in `src/tests/index.test.ts`. This involved:
            *   Debugging path resolution for dynamic `require` calls made by the SUT. Ensured `libPath` in `src/index.ts` correctly resolved to `src/lib` and used `.ts` extensions when `VITEST_WORKER_ID` was set.
            *   Tackled `ReferenceError: Cannot access 'variable' before initialization` (e.g., `__vi_import_0__`, `serverTsAbsolutePath`) due to Vitest's mock hoisting. The solution evolved towards using static string literals (e.g., `../../src/lib/server.ts`) as path arguments to `vi.mock`, as dynamically constructed paths (even with `path.join` or `path.resolve` at the top level) proved problematic for hoisting.
    *   **Key Challenge Remaining (as of Attempt 91):** The `ReferenceError` related to `vi.mock` path hoisting in `src/tests/index.test.ts` persisted, indicating that the strategy for specifying mock paths for the SUT's dynamically imported dependencies was still not fully robust against Vitest's hoisting mechanism.

**2. Integration Tests (`src/tests/integration/stdio-client-server.integration.test.ts`):**
    *   **Environment Variable Propagation to SUT:**
        *   **Problem:** Critical environment variables (e.g., `CODECOMPASS_INTEGRATION_TEST_MOCK_LLM`, `CODECOMPASS_INTEGRATION_TEST_MOCK_QDRANT`), intended to activate SUT-internal mocks, were not reaching the spawned SUT child process. This was a major blocker, causing the SUT to attempt real operations or use default providers.
        *   **Evolution:** Diagnostics confirmed variables were set in the test's `currentTestSpawnEnv`. Investigation focused on `StdioClientTransport` from `@modelcontextprotocol/sdk`. Analysis of the SDK's `stdio.js` (around Attempt 88, commit `b8f8e12`) revealed that `env` options needed to be passed as a top-level property in the transport parameters, not nested under an `options` property.
        *   **Status (as of Attempt 91):** `tsc` errors related to `StdioTransportParams` (TS2353) and `env` object typing in `src/index.ts` (TS2322 for `serverProcessParams.env`) were identified. While the `StdioClientTransport` instantiation in tests was corrected (commit `691bb8f`), the SUT-side `tsc` errors for `env` object construction in `handleClientCommand` (and the fundamental propagation via the SDK) remained critical.
    *   **Qdrant Mocking (`trigger_repository_update` test):**
        *   **Problem:** Test failed as the SUT appeared not to use its Qdrant mock, or logs from the mock were not captured.
        *   **Evolution:** Extensive diagnostics were added. Confirmed `CODECOMPASS_INTEGRATION_TEST_MOCK_QDRANT=true` was intended to activate the mock. Traced calls to `batchUpsertVectors`. Ensured the mock client's `upsert` method in `src/lib/qdrant.ts` matched the real client's API and logged a specific message (`[MOCK_QDRANT_UPSERT]`).
        *   A breakthrough occurred around commit `871ebe9` where SUT logs confirmed `IsMock: true` for the Qdrant client and that `client.upsert` was the correct mocked function. However, the `console.error` log from this mock was not captured by the test. This regressed later (e.g., commit `a57a437` showed `IsMock: false`) due to the overarching environment variable propagation failure.
    *   **LLM Mocking & Assertions (`agent_query`, `generate_suggestion`, etc.):**
        *   **Problem:** Tests frequently failed due to mismatches between expected SUT self-mocked LLM responses (often simple "SUT_SELF_MOCK:..." strings) and actual detailed markdown/code outputs from the SUT, or tools not being found.
        *   **Evolution:** Assertions were adjusted multiple times. The core issue was often traced back to the SUT's `createMockLLMProvider` not being used (because `CODECOMPASS_INTEGRATION_TEST_MOCK_LLM` was not propagated to the SUT) or its internal `if` conditions for specific prompts not being met, causing fall-through to more generic mock responses or attempts to use real providers.
    *   **Session State (`get_session_history`):** An early issue involved stale session history. This was temporarily mitigated by adjusting assertions to isolate the bug, but the root cause became secondary to the more fundamental mocking and environment variable issues.

**3. `src/tests/server.test.ts` (`startProxyServer` Timeouts):**
    *   **Problem:** Four tests in this suite consistently timed out.
    *   **Status:** This issue was largely deferred throughout the debugging process due to the higher priority of `index.test.ts` SUT mocking and integration test environment/mocking issues. Lack of clear diagnostic logs from the SUT in these specific test runs hindered direct progress.

**4. TypeScript Compilation (`tsc`) Errors:**
    *   Several `tsc` errors were encountered and fixed, including:
        *   `await` used in non-async functions (e.g., yargs `.fail()` handler).
        *   Type mismatches for environment variables being passed to child processes (`string | undefined` vs. `string`).
        *   Incorrect typings or property placement for SDK parameters (e.g., `StdioTransportParams` and `env` property).

**Overall Retrospection:**
The debugging journey involved extensive work on Vitest mocking for dynamically imported SUT dependencies, managing environment variable propagation to child processes spawned by tests, and ensuring correct path resolution for module loading in various contexts (source vs. packaged, test execution vs. direct run). Key challenges included Vitest's mock hoisting behavior with non-literal paths, issues with the external `StdioClientTransport` SDK's handling of environment variables, and cascading failures where `tsc` errors or SUT crashes obscured underlying test logic problems. The process underscored the necessity of meticulous diagnostic logging and iterative refinement of both SUT code (for testability) and the test setups themselves.

---
## Attempt 101: Verifying `indexPath` Definition Fix

*   **Attempt Number:** 101
*   **Last Git Commit for this attempt's changes:** `4b44e12` ("fix: Define indexPath based on execution context")
*   **Intended Fixes (from Attempt 100):**
    *   **`src/index.ts`:** Define the `indexPath` variable in the module scope, determining its value based on the execution context (packaged, source, or dist).
*   **Applied Changes (leading to current state):**
    *   Commit `4b44e12` was applied, which should have defined `indexPath`.
*   **Expected Result:**
    *   The `tsc` errors "Cannot find name 'indexPath'" in `src/index.ts` (previously on lines 474 and 566) should be resolved.
*   **Attempt Number:** 102 (Analysis of build output from after commit `4b44e12`)
*   **Intended Fixes (from Attempt 101):**
    *   `src/index.ts`: Define `indexPath` to resolve `tsc` errors. (This was successful)
*   **Applied Changes:**
    *   Commit `4b44e12` was applied.
*   **Result (Based on User's `npm run build` Output):**
    *   **TypeScript Compilation (`tsc`):** PASSED. The `indexPath` errors are resolved.
    *   **Unit Tests (`src/tests/index.test.ts`):** 16/22 FAILED.
        *   `should call startServerHandler with specified repoPath for default command`: Expected `mockStartServerHandler` to be called with `'/my/repo'`, but received `'.'`.
        *   `should call startServerHandler with specified repoPath for "start" command (positional)`: Expected `mockStartServerHandler` to be called with `'/my/repo/path'`, but received `'.'`.
        *   `should spawn server and call tool via stdio for "agent_query"`: `mockStdioClientTransportConstructor` expected to be called but was not.
        *   `should use --repo path for spawned server in client stdio mode`: `mockStdioClientTransportConstructor` expected to be called but was not.
        *   `should handle client command failure (spawn error) ...`: Promise resolved "undefined" instead of rejecting.
        *   `should handle client command failure (server process premature exit) ...`: Promise resolved "undefined" instead of rejecting.
        *   `should handle invalid JSON parameters for client command (stdio) ...`: Promise resolved "undefined" instead of rejecting.
        *   `--repo option should be used by client stdio command for spawned server`: `mockStdioClientTransportConstructor` expected to be called but was not.
        *   `--version option should display version and exit`: Promise resolved "undefined" instead of rejecting.
        *   `--help option should display help and exit`: Promise resolved "undefined" instead of rejecting.
        *   `should display changelog`: `mockedFsSpies.readFileSync` expected `StringContaining "CHANGELOG.md"`, received `"/Users/alvin.tech/Projects/CodeCompass/package.json"`.
        *   `should show error and help for unknown command`: Promise resolved "undefined" instead of rejecting.
        *   `should show error and help for unknown option`: Promise resolved "undefined" instead of rejecting.
        *   `should output raw JSON when --json flag is used on successful tool call`: Expected to find a `console.log` call with valid JSON, but none was found.
        *   `should output JSON error when --json flag is used and tool call fails with JSON-RPC error (stdio)`: Promise resolved "undefined" instead of rejecting.
        *   `should output JSON error when --json flag is used and tool call fails with generic Error (stdio)`: Promise resolved "undefined" instead of rejecting.
    *   **Integration Tests (`src/tests/integration/stdio-client-server.integration.test.ts`):** 9/9 FAILED.
        *   All tests fail with `McpError: MCP error -32000: Connection closed`.
        *   SUT logs from spawned processes indicate `VITEST_WORKER_ID: undefined` and `[SUT_INDEX_TS_SERVER_MODULE_TOKEN_CHECK] { type: 'original_server_module' }`. This strongly suggests the SUT is not using the Vitest mocks for `src/lib/server.ts` when spawned as a child.
    *   **Server Tests (`src/tests/server.test.ts`):** 4/28 FAILED.
        *   The four `startProxyServer` tests are timing out after 30 seconds:
            *   `should resolve with null if findFreePort fails`
            *   `should start the proxy server, log info, and proxy /api/ping`
            *   `should handle target server unreachable for /mcp`
            *   `should forward target server 500 error for /mcp`
    *   **Unhandled Rejection:** `ServerStartupError: Server failed to boot with fatal error` from `src/tests/index.test.ts`.
*   **Analysis/Retrospection:**
    *   The `indexPath` fix was successful for `tsc`.
    *   **Critical Issue:** The integration tests are failing because the spawned SUT (`src/index.ts`) is not recognizing the test environment and thus not loading mocked dependencies (like `src/lib/server.ts`). The `VITEST_WORKER_ID` is not propagating or being detected correctly in the child process. The SUT's dynamic import logic needs to be more robust for child processes in tests.
    *   **`src/tests/index.test.ts` Failures:**
        *   The `repoPath` argument parsing in `src/index.ts` (likely within `startServerHandler` and yargs setup) seems to incorrectly default to `.` when specific paths are provided via positional arguments.
        *   The "promise resolved instead of rejecting" errors point to issues in `runMainWithArgs` or the yargs `.fail()` handler in `src/index.ts` not correctly propagating errors/rejections.
        *   Failures where `mockStdioClientTransportConstructor` is not called suggest that `handleClientCommand` in `src/index.ts` might be exiting early or failing to set up the stdio transport, possibly due to mock resolution issues for its own dynamic imports.
        *   The changelog test failure indicates a path issue or an incorrect mock assertion for `readFileSync`.
    *   **`src/tests/server.test.ts` Timeouts:** These point to problems with async operations or mock setups within the `startProxyServer` tests, potentially related to `nock`, `axios` unmocking, or `http.Server` mocks.
*   **Next Steps/Plan (Attempt 102):**
    1.  **`DEBUG_SESSION.MD`:** Update with this analysis (this step).
    2.  **Prioritize Integration Test Mocking (`src/index.ts`, `src/tests/integration/stdio-client-server.integration.test.ts`):**
        *   Introduce a dedicated environment variable (e.g., `CODECOMPASS_FORCE_TEST_MOCKS=true`) passed from integration tests to the spawned SUT.
        *   Modify `src/index.ts` path logic to use this new variable to force `src` paths and `.ts` extensions for dynamic imports, ensuring mocks are loaded in the child SUT.
    3.  **Address `repoPath` Argument Handling in `src/index.ts`:**
        *   Refine `startServerHandler` in `src/index.ts` to correctly prioritize positional `repoPath` arguments from yargs over `indexPath` or other defaults.
    4.  **Fix Promise Rejection Issues (`src/index.ts`, `src/tests/index.test.ts`):**
        *   Ensure `yargs.fail()` in `src/index.ts` correctly throws an error when `VITEST_TESTING_FAIL_HANDLER` is set, so `cli.parseAsync()` rejects.
        *   Verify `runMainWithArgs` in `src/tests/index.test.ts` properly awaits and propagates rejections.
    5.  **Investigate `mockStdioClientTransportConstructor` Not Called (`src/index.ts`):**
        *   Ensure `handleClientCommand` in `src/index.ts` also uses the `CODECOMPASS_FORCE_TEST_MOCKS` env var for its dynamic imports and correctly passes it to the server it spawns.
    6.  **Address `server.test.ts` Timeouts:**
        *   In the `startProxyServer` test suite's `beforeEach` within `src/tests/server.test.ts`, ensure `axios` is unmocked *before* `serverLibModule` (which contains `startProxyServer`) is imported. This is to ensure `startProxyServer` itself uses the real `axios` for its operations.
    7.  **Review Remaining `index.test.ts` Failures:**
        *   Correct `readFileSync` mock/assertion for the changelog test.
        *   Ensure `console.log` is correctly spied upon and called for JSON output tests.

### Blockers (Current)
    *   **Critical:** SUT (`src/index.ts`) not using Vitest mocks when spawned as a child process in integration tests.
    *   Incorrect `repoPath` argument handling in `src/index.ts`.
    *   Error/rejection propagation issues in `src/index.ts` and `src/tests/index.test.ts`.
    *   Potential async/mock issues in `src/tests/server.test.ts` (`startProxyServer` tests).

### Last Analyzed Commit
    *   Git Commit SHA: `4b44e12` (Build output analyzed is from after this commit)
