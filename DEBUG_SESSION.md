# Remaining Tasks for CodeCompass Debugging

Based on the debugging session up to Attempt 65 (commit `7f14f61`), the following critical issues and diagnostic steps remain:

**Overall Goal:** Achieve a clean build (`npm run build` with no TypeScript/transform errors and all tests passing).

**I. Critical Test Failures & Diagnostic Priorities:**

1.  **`src/tests/index.test.ts` - SUT Mocking Failure (19 Failures):**
    *   **Problem:** The System Under Test (SUT - `dist/index.js`), when dynamically imported and run by the `runMainWithArgs` helper, consistently fails to use the mocks defined in `src/tests/index.test.ts` (e.g., for `startServerHandler`, `StdioClientTransport`, `configService`). This leads to spies not being called and tests failing.
    *   **Immediate Next Step (Analyze Attempt 65 Output):**
        *   Examine the build output from Attempt 65 (commit `7f14f61`).
        *   **Crucially, check if `[SUT_INDEX_TS_DEBUG]` logs from `src/index.ts` are now visible in the `src/tests/index.test.ts` output.** These logs (including `VITEST_WORKER_ID`, `typeof importedModule`, `isMock` status of `startServerHandler` and `configService`) are essential to understand if the SUT is running in the correct Vitest context and what versions of its dependencies it's actually importing.
        *   The modification to `mockConsoleLog` in Attempt 65 (to be a pure spy) was intended to help clarify if SUT logs are being captured by the test runner or if they are being missed entirely.
    *   **Subsequent Actions (If SUT logs are visible & confirm no mocks):**
        *   Compare `VITEST_WORKER_ID` between the test's mock factory logs and the SUT's logs.
        *   Investigate why the SUT's module resolution isn't picking up the mocked versions despite `vi.mock` factories running.
    *   **Subsequent Actions (If SUT logs are STILL NOT visible):**
        *   Investigate `stdout/stderr` capture for child processes spawned by `runMainWithArgs` (especially for CLI tests). Ensure SUT logs are being piped and made visible to the Vitest test runner.

2.  **Integration Test - `get_session_history` Discrepancy (1 Failure):**
    *   **Problem:** In `src/tests/integration/stdio-client-server.integration.test.ts`, the `addQueryToSession` function (called via the `agent_query` tool) correctly updates `session.queries` in memory (e.g., to 2 queries, confirmed by immutable replacement and logging). However, a subsequent `get_session_history` tool call retrieves the *same session object instance* (confirmed by `_debug_retrievalCount` and `SESSIONS_MAP_INSTANCE_ID` logs) but its `queries` array appears stale (e.g., only 1 query).
    *   **Immediate Next Step (Analyze Attempt 65 Output):**
        *   Examine the full SUT `stdout` from the integration test run.
        *   Look for the detailed session state logs (`[STATE_DEBUG]`, `[SERVER_TOOL_DEBUG]`, `[STATE_TS_CONSOLE_DEBUG]`) added in previous attempts. These logs should show deep copies of `session.queries` at various stages:
            *   In `src/lib/state.ts`: `getOrCreateSession` (on retrieval), `addQueryToSession` (before and after immutable update), `getSessionHistory` (immediately after map `get`).
            *   In `src/lib/server.ts`: `agent_query` handler (after `addQueryToSession`, and after re-fetching session), `get_session_history` handler (after map `get`, before formatting).
        *   The goal is to pinpoint exactly when the `queries` array content diverges from the expected state despite being the same object instance.
    *   **Subsequent Actions:** Based on log analysis, determine if the issue is:
        *   An unexpected modification/replacement of the `queries` array on the session object between tool calls.
        *   A problem with how `getSessionHistory` in `state.ts` retrieves or processes the `queries` array from the map entry.
        *   A subtle caching layer or object re-hydration issue if applicable (though current evidence points to direct map access).

3.  **`src/tests/server.test.ts` - `startProxyServer` Timeouts (4 Failures):**
    *   **Problem:** Four tests within the `startProxyServer` suite consistently time out (currently 30000ms).
    *   **Immediate Next Step (Analyze Attempt 65 Output):**
        *   Examine the build output for `src/tests/server.test.ts`.
        *   Check for `[PROXY_DEBUG]` log messages from `src/lib/server.ts` (within the `startProxyServer` function). These logs were added to trace the asynchronous flow: start of function, before/after `findFreePort` call, before/after internal `http.createServer().listen()` call, and resolutions/rejections of these operations.
        *   Identify where the execution is hanging.
    *   **Subsequent Actions:**
        *   Based on where it hangs, refine the mocks for `findFreePortSpy` (ensuring it resolves/rejects as expected for each test case) or the internal `http.Server.listen` mock (ensuring its callback is invoked asynchronously and correctly).

4.  **Integration Test - LLM Mock Assertion Alignment (Potentially 2 Failures for `generate_suggestion` & `get_repository_context`):**
    *   **Problem:** Tests for `generate_suggestion` and `get_repository_context` might fail if their `toContain` assertions are not perfectly aligned with the detailed content of the SUT's self-mocked LLM responses (from `createMockLLMProvider` in `src/lib/llm-provider.ts`).
    *   **Immediate Next Step (Analyze Attempt 65 Output):**
        *   Examine the `console.log` output for `suggestionText` and `repoContextText` that was added in `src/tests/integration/stdio-client-server.integration.test.ts` (commit `7f14f61`) just before the assertions.
        *   Compare this logged actual output with the expected strings in the test assertions and with the SUT self-mock logic in `src/lib/llm-provider.ts` (specifically the `generateText` mock within `createMockLLMProvider`).
    *   **Subsequent Actions:**
        *   Adjust the `expect(...).toContain(...)` assertions in the tests to precisely match key phrases or structures from the actual SUT self-mocked responses. Ensure that the conditions within `createMockLLMProvider` for returning specific detailed responses are being met by the prompts generated in the tests.

**II. Other Persistent Test Failures (Lower Priority until Blockers Resolved):**

*   **`src/tests/index.test.ts` - Other Failures:**
    *   `--json` output test: `mockConsoleLog` is not capturing SUT's `console.log` output. This is likely linked to the main SUT mocking/log capture issue.
    *   `fs.readFileSync` mock for `changelog` command not called.
*   **`src/tests/integration/stdio-client-server.integration.test.ts` - `trigger_repository_update` (1 Failure):**
    *   The `qdrantModule.batchUpsertVectors` spy is not being called. Investigate mock setup for `qdrant` and conditions within SUT's `indexRepository` logic.

**General Strategy:**
*   Prioritize fixing issues that prevent tests from running or that block understanding of other failures (e.g., SUT log visibility).
*   Analyze diagnostic logs carefully after each attempt.
*   Make incremental changes and test frequently.
