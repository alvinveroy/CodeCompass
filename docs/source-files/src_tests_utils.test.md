# Documentation for `src/tests/utils.test.ts`

-   **File Path**: `src/tests/utils.test.ts`
-   **Purpose**: This file contains unit tests for utility functions. Specifically, it tests the `withRetry` function (now located in `src/utils/retry-utils.ts`) and the `preprocessText` function (now located in `src/utils/text-utils.ts`). The tests ensure the reliability and correctness of these shared utility functions using the `vitest` testing framework.

## Test Suites and Key Behaviors

### 1. `describe('Utils Module', ...)` (Testing `withRetry`)

-   **Target Function**: `withRetry` (imported from `../utils/retry-utils`)
-   **Purpose**: This suite tests the `withRetry` utility, which is designed to automatically retry a failing asynchronous operation with exponential backoff.
-   **Key Behaviors Tested**:
    -   **Successful First Try**: Ensures the function returns the result if the operation succeeds on the first attempt, without any retries.
    -   **Success on Retry**: Verifies that the function retries a failing operation and returns the result if a subsequent attempt succeeds.
    -   **Multiple Retries Before Success**: Confirms that the function can handle multiple failures before a successful attempt.
    -   **All Retries Fail**: Checks that an error is thrown if all retry attempts are exhausted and the operation never succeeds.
    -   **Respects `MAX_RETRIES`**: Ensures that `withRetry` adheres to the `MAX_RETRIES` value from the mocked `configService` when no explicit retry count is passed to the function.
    -   **Uses `RETRY_DELAY`**: Verifies that the function uses the `RETRY_DELAY` from the mocked `configService` and applies exponential backoff for the delay between retry attempts.
-   **Mocks and Setup**:
    -   **`../lib/config-service`**: This module is mocked to control configuration values like `MAX_RETRIES` and `RETRY_DELAY`, and to spy on logger methods (`warn`, `error`, `info`, `debug`). The mock factory (`vi.mock`) imports the actual module to get original default values and then provides a `mockConfigServiceValues` object that the tests can manipulate.
    -   **`global.setTimeout`**: Mocked using `vi.spyOn` to control the execution flow of retries, allowing tests to advance timers immediately and verify the delay logic.
    -   **`vi.useFakeTimers()`**: Called in `beforeEach` to enable control over timers.
    -   **`beforeEach` Hook**:
        -   Retrieves original default retry values from the actual `configService`.
        -   Gets the mocked `configService` instance.
        -   Resets `MAX_RETRIES` and `RETRY_DELAY` on the mocked instance to their original defaults.
        -   Clears mock call history for logger methods.
    -   **`afterEach` Hook**: Restores all mocks (including `setTimeout`) and real timers.

### 2. `describe('preprocessText', ...)`

-   **Target Function**: `preprocessText` (imported from `../utils/text-utils`)
-   **Purpose**: This suite tests the `preprocessText` utility, which cleans and standardizes text strings.
-   **Key Behaviors Tested**:
    -   Trimming of leading and trailing whitespace (spaces, newlines, tabs).
    -   Replacement of multiple consecutive spaces or tabs with a single space.
    -   Preservation of single newlines while normalizing multiple consecutive newlines to a single newline.
    -   Removal of various control characters (e.g., `\x00` to `\x1F`, `\x7F`).
    -   Correct handling of empty input strings and strings consisting only of whitespace or control characters.
    -   Accurate processing of complex strings containing a mix of whitespace, control characters, and printable text.
    -   Correct handling of non-ASCII (Unicode) characters, ensuring they are preserved and processed correctly.

## Overall Structure and Dependencies

-   **Testing Framework**: `vitest` (using `describe`, `it`, `expect`, `vi`, `beforeEach`, `afterEach`).
-   **Key Imports**:
    -   `withRetry` from `../utils/retry-utils`.
    -   `preprocessText` from `../utils/text-utils`.
-   **Mocking Strategy**: The tests heavily rely on `vitest`'s mocking capabilities (`vi.mock` for modules, `vi.spyOn` for global functions) to isolate the functions under test and control their dependencies, particularly `configService` and global timers.
