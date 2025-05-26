# Debug Session: Vitest and TypeScript Errors

**Date:** 2024-05-26
**Git Commit (Initial):** (User to fill with current git commit SHA)

## Initial Problem Statement

The `npm run build` command fails due to:
1.  Vitest test failures in `src/tests/index.test.ts` and `src/tests/server.test.ts` (mocking/initialization errors related to hoisting).
2.  All integration tests in `src/tests/integration/stdio-client-server.integration.test.ts` fail with "Connection closed", likely due to server-side EADDRINUSE errors stemming from misconfiguration of `HTTP_PORT` in the spawned server.
3.  TypeScript compilation errors in `src/tests/server.test.ts` (duplicate identifiers, type mismatches with Vitest `Mock` type, incorrect Axios mock structure, missing file extensions, read-only property assignments).

## Attempt 1: Fix Hoisting and Reference Errors in Test Setup

### Issues:
- `src/tests/index.test.ts`: `ReferenceError: Cannot access 'distLibServerPath' before initialization` in `vi.mock`.
- `src/tests/server.test.ts`: `ReferenceError: Cannot access 'stableMockConfigServiceInstance' before initialization` in `vi.mock`.

### Proposed Changes:
- **`src/tests/index.test.ts`**:
    - Ensured `distLibServerPath` is defined at the top of the file, before any `vi.mock` calls that use it as a path argument.
    - Modified the `ServerStartupError` mock to be a proper class constructor (the existing class definition in `index.test.ts` was confirmed suitable and correctly referenced by the mock).
    - Added missing `options` argument to `new ServerStartupError(...)` call.
- **`src/tests/server.test.ts`**:
    - Moved the definitions of `stableMockConfigServiceInstance` and `stableMockLoggerInstance` (and their types `MockedConfigService`, `MockedLogger`) to be lexically before the `vi.mock('../lib/config-service', ...)` call.
    - Ensured `serverLibModule` is imported after all top-level mocks it might depend on.

### Result (After Applying Changes from Attempt 1):
- The `ReferenceError: Cannot access 'distLibServerPath' before initialization` in `src/tests/index.test.ts` persisted.
- The `ReferenceError: Cannot access 'stableMockConfigServiceInstance' before initialization` in `src/tests/server.test.ts` (causing `[vitest] There was an error when mocking a module`) persisted.
- The proposed changes were insufficient or other factors were at play.

### Next Step:
- Address TypeScript compilation errors in `src/tests/server.test.ts`.

### Blockers:
- Persistent hoisting/initialization errors.

---

## Attempt 2: Fix `src/tests/server.test.ts` - TypeScript Compilation Errors

### Issues:
- Duplicate identifiers (`WinstonLogger`, `nock`, `MockedLogger`, `MockedConfigService`).
- `TS2707: Generic type 'Mock<T>' requires 0-1 args` for `Mock<A, R>` and `Mock<[], void>`.
- `TS2339: Property 'get'/'post'/etc. does not exist on type 'Mock<Procedure>'` for `mockAxiosInstance`.
- `TS2835: Relative import paths need explicit file extensions`.
- `TS2540: Cannot assign to read-only property 'AGENT_QUERY_TIMEOUT'`.
- `TS2322: findFreePortSpy` signature.

### Proposed Changes:
- **Duplicate Identifiers**:
    - Removed the second (later) declarations of `type MockedLogger`, `type MockedConfigService`.
    - Removed the second import of `type { Logger as WinstonLogger } from 'winston';`.
    - Removed the second import of `import nock from 'nock';`.
- **TS2707 `Mock<A, R>` & `Mock<[], void>`**:
    - Ensured `import type { Mock } from 'vitest';` is present. The error `TS2707` for `Mock<A,R>` (expecting 0-1 type args) was puzzling as Vitest's `Mock` type takes 2. This was likely due to a type conflict or an issue with how TypeScript was resolving the `Mock` type in that context. The fix involved ensuring the correct `Mock` type from Vitest is used and that its generic arguments are correctly formed (e.g., `Mock<(...args: A) => R>`).
    - Corrected `Mock<A,R>` to `Mock<A,R>` (kept as is, assuming `vitest.Mock` is correctly imported and used) and `Mock<[], void>` to `Mock<[], void>`. The primary fix here is ensuring the `Mock` type is correctly resolved from Vitest.
- **TS2339 `mockAxiosInstance` properties**:
    - Restructured the `vi.mock('axios', ...)` factory. The factory now returns an object where `default` is an object containing mocked methods like `get: vi.fn()`, `post: vi.fn()`, `create: vi.fn()`, `isAxiosError: vi.fn()`. These methods are also exported directly for named imports.
- **TS2835 Relative import extension**:
    - Changed `await import('../lib/server')` to `await import('../lib/server.js')` in the `startProxyServer` test suite's `beforeEach`.
- **TS2540 Read-only property `AGENT_QUERY_TIMEOUT`**:
    - Adjusted the `MockedConfigService` type definition to ensure `AGENT_QUERY_TIMEOUT` is mutable, allowing assignment in tests.
- **TS2322 `findFreePortSpy` signature**:
    - Corrected the type of the `findFreePortSpy` variable to `Mock<[number], Promise<number>>` to match the actual signature of `findFreePort` in `server.ts`. Ensured the `vi.spyOn(...).mockResolvedValue(...)` or `mockImplementation` aligns with this signature.

### Result (After Applying Changes from Attempt 2):
- Most TypeScript errors were resolved.
- However, the `TS2707: Generic type 'Mock<T>' requires 0-1 type arguments` error in `src/tests/server.test.ts` persisted.

### Next Step:
- Fix `ConfigService.HTTP_PORT` getter and address integration test failures.

### Blockers:
- The `TS2707` error for `Mock<A,R>` might persist if there's a deeper `tsconfig.json` issue or a global type conflict for `Mock`.
- Hoisting errors from Attempt 1 still present.

---

## Attempt 3: Fix `ConfigService.HTTP_PORT` Getter and Integration Test Failures

### Issue:
- All 9 integration tests in `src/tests/integration/stdio-client-server.integration.test.ts` fail with `MCP error -32000: Connection closed`.
- Server logs from these tests show `EADDRINUSE` on port 3001, with `configService.HTTP_PORT is: 3001` even when `HTTP_PORT="0"` is in the spawned server's environment. This points to an issue in how `configService.HTTP_PORT` resolves `0`.

### Proposed Changes:
- **`src/lib/config-service.ts`**:
    - Modified the `HTTP_PORT` getter to correctly return `0` if `this._httpPort` is `0` (or if `global.CURRENT_HTTP_PORT` is `0`), instead of falling back to `_httpPortFallback`. The priority order is: `global.CURRENT_HTTP_PORT` (if set and valid, including 0), then `this._httpPort` (if set and valid, including 0), then `this._httpPortFallback`.
- **`src/tests/integration/stdio-client-server.integration.test.ts`**:
    - Reviewed `beforeEach` to ensure it correctly sets up the environment for the spawned server with `HTTP_PORT: '0'` in `processOptions.env` for `StdioClientTransport`.
    - Ensured `afterEach` robustly cleans up the client and transport. `StdioClientTransport.close()` should handle server process termination.
    - Added more detailed logging for spawned server environment variables.
- **`src/lib/server.ts` (`startServer` function)**:
    - Verified that `httpPort = configService.HTTP_PORT;` correctly receives `0` after the `ConfigService` fix.
    - Ensured `if (httpPort === 0)` block is correctly entered, `findFreePort` is called, and its result is used for `httpServer.listen()`.
    - Added debug logging around port determination and EADDRINUSE handling.
    - Corrected `findFreePort` logic to properly handle promise rejection for successful port finding.
    - Ensured `startProxyServer` correctly handles promise resolution/rejection and returns the server instance or null.

### Result (After Applying Changes from Attempt 3):
- The integration tests in `src/tests/integration/stdio-client-server.integration.test.ts` **still failed** with `MCP error -32000: Connection closed`.
- Spawned server logs confirmed `EADDRINUSE` on port 3001: `[Spawned Server EADDRINUSE DEBUG] Entered EADDRINUSE block. Current httpPort variable is: 3001. configService.HTTP_PORT is: 3001`.
- This indicated that `HTTP_PORT="0"` and `NODE_ENV="test"` were likely not being correctly propagated to or interpreted by the `ConfigService` in the spawned child process, despite the `ConfigService.HTTP_PORT` getter logic appearing correct. The issue seemed to be with how environment variables were passed to the child process via `StdioClientTransport`.
- The previous note about `StdioClientTransport` using `processOptions` deliberately might have been related to a different problem, as the `EADDRINUSE` strongly suggested `processOptions.env` was not working as expected for environment variable propagation compared to the standard `options.env` (from `child_process.SpawnOptions`).

### Next Step:
- Address all persistent errors: hoisting issues, TypeScript `Mock` type error, and the critical integration test failures due to `EADDRINUSE`.

### Blockers:
- Incorrect environment variable propagation to child processes in integration tests.
- Persistent Vitest hoisting/reference errors.
- Persistent TypeScript `Mock` type resolution error.

---

## Attempt 4: Comprehensive Fix for Hoisting, TypeScript, and Integration Test Failures (Partial Success)

### Issues Addressed:
1.  **Hoisting/Reference Errors**:
    *   `src/tests/index.test.ts`: `ReferenceError: Cannot access 'distLibServerPath' before initialization`. (Still failing)
    *   `src/tests/server.test.ts`: `ReferenceError: Cannot access 'stableMockConfigServiceInstance' before initialization` (leading to `[vitest] There was an error when mocking a module`). (Still failing)
2.  **TypeScript Error**:
    *   `src/tests/server.test.ts`: `TS2707: Generic type 'Mock<T>' requires 0-1 type arguments`. (Partially addressed, new TS errors appeared).
3.  **Integration Test Failures (`EADDRINUSE`)**:
    *   All tests in `src/tests/integration/stdio-client-server.integration.test.ts` fail with `MCP error -32000: Connection closed` because the spawned server encounters an `EADDRINUSE` on port 3001. (Still failing)

### Changes Applied in Attempt 4:

1.  **`src/tests/integration/stdio-client-server.integration.test.ts` (Fix EADDRINUSE):**
    *   Modified the `StdioClientTransport` instantiation to use the correct `options` property (which corresponds to `child_process.SpawnOptions`) for passing environment variables, instead of the non-standard `processOptions`.
    *   Imported `SpawnOptions` from `child_process`.
    *   Defined an interface `StdioTransportParams` for `StdioClientTransport` parameters for clarity.
    *   Applied the `StdioTransportParams` type cast to the `StdioClientTransport` constructor options.

2.  **`src/tests/index.test.ts` (Hoisting for `distLibServerPath`):**
    *   Confirmed `distLibServerPath` is defined at the very top of the file, before any `vi.mock` statements. No structural changes were made as the order appeared correct.

3.  **`src/tests/server.test.ts` (Hoisting for `stableMockConfigServiceInstance`):**
    *   Confirmed `stableMockConfigServiceInstance` and `stableMockLoggerInstance` are defined lexically before the `vi.mock('../lib/config-service', ...)` call. No structural changes were made as the order appeared correct.

4.  **`src/tests/server.test.ts` (Fix TypeScript `TS2707 Mock` type error):**
    *   Aliased the import of `Mock` from `vitest` to `VitestMock` (i.e., `import type { Mock as VitestMock } from 'vitest';`).
    *   Updated all usages of `Mock<A, R>` and `Mock<[], void>` to use `VitestMock<A, R>` and `VitestMock<[], void>` respectively.

### Result (After Applying Changes from Attempt 4):
-   **Integration Tests (`stdio-client-server.integration.test.ts`)**: Still failing with `MCP error -32000: Connection closed` and spawned server logs show `EADDRINUSE` on port 3001. The change to `options: { env: currentTestSpawnEnv }` did not resolve the environment variable propagation issue for `HTTP_PORT="0"`.
-   **Hoisting/Reference Errors (`index.test.ts`, `server.test.ts`)**: Still failing with `Cannot access '...' before initialization`.
-   **TypeScript Errors (`server.test.ts`)**:
    -   The original `TS2707` errors for `VitestMock<A,R>` and `VitestMock<[],void>` persist, indicating the alias might not have been applied correctly everywhere or there's a deeper issue with how TypeScript is resolving `VitestMock`.
    -   New errors `TS2304: Cannot find name 'Mock'` appeared, suggesting some `Mock` usages were not updated to `VitestMock`.

### Next Step:
-   Re-investigate the integration test `EADDRINUSE` issue. The `HTTP_PORT="0"` is critical.
-   Correct all TypeScript errors in `src/tests/server.test.ts` by ensuring `VitestMock` is used consistently.
-   Re-evaluate the hoisting errors.

### Blockers:
-   Persistent `EADDRINUSE` in integration tests despite attempts to pass `HTTP_PORT="0"`.
-   Persistent Vitest hoisting/reference errors.
-   TypeScript errors related to `Mock` type usage.

---

## Attempt 5: Fix `HTTP_PORT` Parsing, Server Test Hoisting, and TypeScript `Mock` Types

**Git Commit (After Attempt 4):** (User to fill with git commit SHA after applying Attempt 4 changes)
**Git Commit (After Attempt 5):** 80afcca

### Issues Addressed:
1.  **Integration Test `EADDRINUSE`**: Caused by `HTTP_PORT="0"` not being correctly parsed in `configService.reloadConfigsFromFile`.
2.  **Hoisting/Reference Error in `src/tests/server.test.ts`**: `Cannot access 'stableMockConfigServiceInstance' before initialization`.
3.  **TypeScript Errors in `src/tests/server.test.ts`**:
    *   `TS2707: Generic type 'Mock<T>' requires 0-1 type arguments` (persisting for `VitestMock`).
    *   `TS2304: Cannot find name 'Mock'` (new instances where `VitestMock` alias wasn't applied).

### Proposed Changes for Attempt 5:

1.  **`src/lib/config-service.ts` (Fix `HTTP_PORT` parsing):**
    *   In `reloadConfigsFromFile`, replace the existing `HTTP_PORT` parsing logic with the more robust parsing logic similar to the constructor:
        ```typescript
        // (Code for robust HTTP_PORT parsing as detailed in previous interactions)
        const httpPortEnvReload = process.env.HTTP_PORT;
        if (httpPortEnvReload !== undefined && httpPortEnvReload !== null && httpPortEnvReload.trim() !== "") {
          const parsedPortReload = parseInt(httpPortEnvReload, 10);
          if (!isNaN(parsedPortReload) && parsedPortReload >= 0 && parsedPortReload <= 65535) { // Allow 0
            this._httpPort = parsedPortReload;
          } else {
            this.logger.warn(`Invalid HTTP_PORT environment variable during reload: "${httpPortEnvReload}". Falling back to default: ${this._httpPortFallback}`);
            this._httpPort = this._httpPortFallback;
          }
        } else {
          // If HTTP_PORT is not in env during reload, fall back to default.
          this._httpPort = this._httpPortFallback;
        }
        ```

2.  **`src/tests/server.test.ts` (Fix Hoisting for `stableMockConfigServiceInstance`):**
    *   Modify the `vi.mock('../lib/config-service', ...)` factory to use getters for `configService` and `logger`:
        ```typescript
        vi.mock('../lib/config-service', () => ({
          get configService() { return stableMockConfigServiceInstance; },
          get logger() { return stableMockLoggerInstance; },
        }));
        ```
    * Note: Other TypeScript type fixes for `VitestMock` and `MockInstance` in `src/tests/server.test.ts` appear to be already applied in the provided file version. The `TS2707` or `TS2304` errors, if they persist, may indicate deeper configuration issues.

### Expected Result of Attempt 5:
-   The `EADDRINUSE` error in integration tests should be resolved if `HTTP_PORT="0"` is now correctly handled by the spawned server's `ConfigService`.
-   The hoisting error for `stableMockConfigServiceInstance` in `server.test.ts` should be resolved by the getter pattern.
-   TypeScript errors related to `Mock` vs `VitestMock` (TS2707, TS2304) might persist if they are due to underlying configuration issues rather than type declarations in `server.test.ts`.
-   The hoisting error for `distLibServerPath` in `index.test.ts` is not addressed in this attempt and will likely persist.
