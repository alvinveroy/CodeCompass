# `src/lib/utils.ts`

## Overview

The `src/lib/utils.ts` module provides a collection of utility functions used within the CodeCompass application. These utilities handle common tasks such as retrying operations with backoff, preprocessing text, and measuring function performance.

## Key Functions

### `withRetry<T>(fn: () => Promise<T>, retries = configService.MAX_RETRIES): Promise<T>`

-   **Purpose**: Executes a given asynchronous function (`fn`) and retries it a specified number of times if it throws an error. This version uses exponential backoff for delays between retries.
-   **Type Parameters**:
    -   `T`: The expected return type of the asynchronous function `fn`.
-   **Parameters**:
    -   `fn: () => Promise<T>`: The asynchronous function to execute and potentially retry.
    -   `retries: number` (optional): The maximum number of retry attempts. Defaults to `configService.MAX_RETRIES`.
-   **Returns**: `Promise<T>` - A promise that resolves with the result of `fn` if it succeeds. If all attempts fail, the promise rejects with the error from the last attempt.
-   **Process**:
    1.  Iterates up to `retries` times.
    2.  In each iteration, it `await`s `fn()`.
    3.  If `fn()` succeeds, its result is returned.
    4.  If `fn()` fails:
        -   The error is logged with a warning.
        -   If more retries are allowed, it waits for a delay calculated using exponential backoff (`configService.RETRY_DELAY * Math.pow(2, i)`) before the next attempt.
    5.  If all retries fail, the last encountered error is thrown.

### `preprocessText(text: string): string`

-   **Purpose**: Cleans and standardizes input text by removing control characters and normalizing whitespace.
-   **Parameters**:
    -   `text: string`: The input string to preprocess.
-   **Returns**: `string` - The preprocessed string.
-   **Process**:
    1.  Removes ASCII control characters (except for common whitespace characters like tab, line feed, carriage return) using the regex `[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]`.
    2.  Replaces sequences of whitespace characters with a single space, but preserves newline characters if they are part of the sequence.
    3.  Trims leading and trailing whitespace from the resulting string.

### `withMetrics<T extends (...args: any[]) => Promise<any>>(fn: T): (...args: Parameters<T>) => Promise<ReturnType<T>>`

-   **Purpose**: A higher-order function that wraps an asynchronous function to measure and log its execution time.
-   **Type Parameters**:
    -   `T`: A function type that takes any arguments and returns a Promise.
-   **Parameters**:
    -   `fn: T`: The asynchronous function to wrap.
-   **Returns**: `(...args: Parameters<T>) => Promise<ReturnType<T>>` - A new asynchronous function that, when called, executes the original function, logs its performance, and returns its result or throws its error.
-   **Process**:
    1.  When the wrapped function is called:
        -   Logs the start of execution, including the function's name.
        -   Records the start time using `performance.now()`.
        -   Executes the original function `fn` with the provided arguments.
        -   On successful completion:
            -   Calculates the duration.
            -   Logs the function name and execution time.
            -   Returns the result of `fn`.
        -   If `fn` throws an error:
            -   Calculates the duration.
            -   Logs the function name, failure status, execution time, and the error.
            -   Rethrows the error.

## Dependencies

-   `perf_hooks`: For the `performance.now()` method used in `withMetrics`.
-   `./config-service`: For accessing `configService.MAX_RETRIES`, `configService.RETRY_DELAY`, and the `logger` instance.
