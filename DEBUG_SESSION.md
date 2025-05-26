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

### Result:
- (To be filled after applying the change and re-running tests/build)

### Next Step:
- Address TypeScript compilation errors in `src/tests/server.test.ts`.

### Blockers:
- None anticipated for this step.

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

### Result:
- (To be filled after applying the change and re-running tests/build)

### Next Step:
- Fix `ConfigService.HTTP_PORT` getter and address integration test failures.

### Blockers:
- The `TS2707` error for `Mock<A,R>` might persist if there's a deeper `tsconfig.json` issue or a global type conflict for `Mock`.

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

### Result:
- (To be filled after applying the change and re-running tests/build)

### Next Step:
- Verify all tests pass and the build completes successfully.

### Blockers:
- Ensuring the interaction between the fixed `ConfigService`, `startServer`'s port handling, `findFreePort`'s async logic, and the `EADDRINUSE` logic is fully robust, especially the order of operations for port determination and global state updates (`global.CURRENT_HTTP_PORT`).
