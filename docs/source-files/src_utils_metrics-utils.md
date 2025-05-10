# `src/utils/metrics-utils.ts`

## Overview

The `src/utils/metrics-utils.ts` module provides a utility function, `withMetrics`, for wrapping asynchronous functions to measure and log their execution time. This is useful for performance monitoring and debugging.

## Key Functions

### `withMetrics<T extends (...args: any[]) => Promise<any>>(fn: T): (...args: Parameters<T>) => Promise<ReturnType<T>>`

-   **Purpose**: A higher-order function that wraps an asynchronous function to measure and log its execution time.
-   **Type Parameters**:
    -   `T`: A function type that takes any arguments and returns a Promise.
-   **Parameters**:
    -   `fn: T`: The asynchronous function to wrap.
-   **Returns**: `(...args: Parameters<T>) => Promise<ReturnType<T>>` - A new asynchronous function that, when called, executes the original function, logs its performance, and returns its result or throws its error.
-   **Process**:
    1.  When the wrapped function is called:
        -   Logs the start of execution, including the function's name (or "anonymousFunction" if the name is not available), using `logger.debug`.
        -   Records the start time using `performance.now()`.
        -   Executes the original function `fn` with the provided arguments.
        -   **On successful completion**:
            -   Calculates the duration.
            -   Logs the function name and execution time (e.g., "Function myAsyncFunc executed in 123.45ms") using `logger.info`.
            -   Returns the result of `fn`.
        -   **If `fn` throws an error**:
            -   Calculates the duration.
            -   Logs the function name, failure status, execution time, and the error object (e.g., "Function myAsyncFunc failed after 67.89ms") using `logger.error`.
            -   Rethrows the error.

## Dependencies

-   `perf_hooks`: For the `performance.now()` method.
-   `../lib/config-service`: For accessing the `logger` instance. The actual import in `src/utils/metrics-utils.ts` is `import { logger } from "../lib/config-service";`.
