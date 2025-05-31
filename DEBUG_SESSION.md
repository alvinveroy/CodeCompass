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
## Attempt 94: Addressing Build Failures (tsc errors, unit & integration test failures) - Post Commit `bb61240`

*   **Attempt Number:** 94
*   **Last Git Commit for this attempt's changes:** `bb61240` ("fix: Fix CLI args, SUT mode, and test mocks")
*   **Intended Fixes (from Attempt 93):**
    *   **`src/index.ts`:**
        *   Correct `main()` to call local `startServerHandler` in SUT mode.
        *   Correct `StdioServerParameters` structure in `handleClientCommand`.
    *   **`src/tests/index.test.ts`:**
        *   Fix `toThrowError` usage for `rpcError`.
        *   Fix `readFileSync` mock for `changelog` test.
        *   Adjust `runMainWithArgs` for default command `repoPath` handling.
*   **Applied Changes (leading to current build output):**
    *   Commit `bb61240` was applied, which included the fixes listed above.
    *   Commit `3beed84` ("test: Explicitly add 'start' for empty args in runMainWithArgs") was also applied, further refining the `runMainWithArgs` helper.
*   **Result (Based on User's `npm run build` Output after `bb61240` and `3beed84`):**
    *   **`tsc` Errors:**
        *   The `tsc` errors previously noted (`TS2353` in `src/index.ts` and `TS2345` in `src/tests/index.test.ts`) are **RESOLVED**. The build output shows `Found 0 errors in 0 files` from `tsc`.
    *   **Integration Test Failures (`src/tests/integration/stdio-client-server.integration.test.ts`):**
        *   All 9 tests still fail with `MCP error -32000: Connection closed`.
        *   The SUT's stdout still shows `TypeError: directStartServerHandler is not a function at main (/Users/alvin.tech/Projects/CodeCompass/src/index.ts:452:13)`. This indicates the fix in `src/index.ts` for SUT mode (to call the local `startServerHandler`) was either not correctly applied or there's another issue causing `startServerHandler` to be undefined in that specific execution path within `main()`.
    *   **Unit Test Failures (`src/tests/index.test.ts`):**
        *   **`mockStartServerHandler` argument issue:** 3 tests still fail with `mockStartServerHandler` being called with `indexPath` (e.g., `/Users/.../src/index.ts`) as `repoPath` instead of the expected default (`.`) or specified path. This suggests the changes to `runMainWithArgs` (including commit `3beed84`) did not fully resolve how `yargs` (or the SUT's argument parsing) determines `repoPath` for the default command.
        *   **"Promise resolved instead of rejecting" errors:** 8 tests still fail this way. This remains a significant issue, likely related to how `yargs.fail()` or `process.exit` mocks interact with the async nature of `runMainWithArgs` or the SUT's `main` function.
        *   **`mockStdioClientTransportConstructor` not called:** 3 tests for client tool commands still show this spy not being called. This could be linked to the "promise resolved" issues if error handling short-circuits execution, or if there's a problem in `handleClientCommand` itself.
        *   **`changelog` test:** This test now **PASSES**. The `readFileSync` mock fix was successful.
    *   **Server Test Timeouts (`src/tests/server.test.ts`):**
        *   4 tests in the `startProxyServer` suite are still timing out (known deferred issue).
*   **Analysis/Retrospection:**
    *   The `tsc` errors are fixed, which is good progress.
    *   The critical `TypeError: directStartServerHandler is not a function` in SUT mode for integration tests persists. This is the highest priority to fix for integration tests. The `main` function's SUT mode path needs careful review to ensure `startServerHandler` (the one defined in `src/index.ts`) is correctly in scope and called.
    *   The `repoPath` argument issue for `mockStartServerHandler` in unit tests needs further investigation. It might be that `yargs` still picks up `indexPath` (the script being run) as a positional argument for the default command if not handled carefully.
    *   The "promise resolved instead of rejecting" errors are a major blocker for unit test stability. This often points to problems in how test helpers (`runMainWithArgs`) or the SUT's main execution flow handle asynchronous errors and mocked exits.
*   **Next Steps/Plan (Attempt 94):**
    1.  **`DEBUG_SESSION.MD`:** Update with this analysis (this step).
    2.  **`src/index.ts` (SUT Mode `startServerHandler` Fix - CRITICAL):**
        *   Re-examine the `main()` function's SUT mode block (`if (process.argv.includes('--cc-integration-test-sut-mode'))`). Ensure that the `startServerHandler` called is unequivocally the one defined within `src/index.ts`. The previous fix `await startServerHandler(...)` might still be ambiguous if there's an import of a different `startServerHandler` in scope. Consider explicitly calling `this.startServerHandler` if `main` and `startServerHandler` are part of a class, or ensure no conflicting imports. Given the file structure, it's likely a direct function call, so scoping or a subtle import issue might be the culprit.
    3.  **`src/tests/index.test.ts` (Unit Test Fixes):**
        *   **`repoPath` for default command:**
            *   In `startServerHandler` within `src/index.ts`, add a specific check: if `repoPathOrArgv.repoPath` (the positional argument from yargs) is exactly `indexPath` (the path to `src/index.ts` itself, which `yargs` might interpret as the positional argument when no other is given), then treat it as if no repoPath was provided, thus defaulting to `.` internally.
            *   Alternatively, in `runMainWithArgs`, when `args.length === 0` (now `effectiveProcessArgs = ['start']`), ensure that `yargs` doesn't somehow still pick up `indexPath` as a second positional argument to `start`. This might involve how `yargs` is configured or how `process.argv` is constructed.
        *   **"Promise resolved instead of rejecting" errors:**
            *   Review the `yargs.fail()` handler in `src/index.ts`. Ensure it correctly re-throws errors or causes a non-zero exit in a way that `runMainWithArgs` can detect as a rejection, especially when `process.env.VITEST_TESTING_FAIL_HANDLER` is set.
            *   Ensure that when `mockProcessExit` throws its error, this error correctly propagates up to cause the promise returned by `runMainWithArgs` (or by `sutModule.main()`) to reject.
    4.  **Defer `mockStdioClientTransportConstructor` not called** issues until the promise rejection and `repoPath` issues are resolved, as they might be symptoms.
    5.  **Defer `server.test.ts` Timeouts.**

### Blockers
    *   SUT crashing in integration tests (`TypeError: directStartServerHandler is not a function`).
    *   Unit test failures in `src/tests/index.test.ts` related to `repoPath` argument parsing and "promise resolved instead of rejecting" errors.

### Last Analyzed Commit
    *   Git Commit SHA: `3beed84` (incorporates `bb61240`)
