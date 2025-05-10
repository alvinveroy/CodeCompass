# `src/utils/retry-utils.ts`

## Overview

The `src/utils/retry-utils.ts` module provides a generic utility function, `withRetry`, designed to automatically retry an asynchronous operation if it fails. This is particularly useful for network requests or other operations that might be prone to transient errors.

## Key Functions

### `withRetry<T>(fn: () => Promise<T>, retries = configService.MAX_RETRIES): Promise<T>`

-   **Purpose**: Executes a given asynchronous function (`fn`) and retries it a specified number of times if it throws an error.
-   **Type Parameters**:
    -   `T`: The expected return type of the asynchronous function `fn`.
-   **Parameters**:
    -   `fn: () => Promise<T>`: The asynchronous function to execute and potentially retry. This function should return a `Promise`.
    -   `retries: number` (optional): The maximum number of retry attempts. Defaults to `configService.MAX_RETRIES` (which is typically 3). The function will be executed `retries + 1` times in total if all attempts fail (initial attempt + `retries` retries).
-   **Returns**: `Promise<T>` - A promise that resolves with the result of `fn` if it succeeds within the allowed attempts. If all attempts fail, the promise rejects with the error from the last attempt.
-   **Process**:
    1.  Iterates up to `retries` times (effectively, `retries + 1` total attempts including the initial one).
    2.  In each iteration, it `await`s the execution of `fn()`.
    3.  **Success**: If `fn()` resolves successfully, `withRetry` immediately returns the resolved value.
    4.  **Failure**: If `fn()` rejects (throws an error):
        -   The error is caught and stored as `lastError`.
        -   A warning message is logged, indicating the retry attempt number and the error message.
        -   If it's not the last retry attempt (`i < retries - 1`), it waits for a delay before the next attempt. The delay uses exponential backoff: `configService.RETRY_DELAY * Math.pow(2, i)`.
    5.  **All Retries Failed**: If the loop completes without `fn()` succeeding, the `lastError` encountered is thrown. If no error was somehow caught (which shouldn't happen if `fn` fails), a generic "All retries failed" error is thrown.

## Dependencies

-   `../lib/config-service`: For accessing `configService.MAX_RETRIES`, `configService.RETRY_DELAY`, and the `logger`.

## Usage Example

```typescript
import { withRetry } from './retry-utils';
import { someAsyncOperationThatMightFail } from './api-client';

async function fetchDataReliably() {
  try {
    const data = await withRetry(async () => {
      // This is the function that will be retried
      return await someAsyncOperationThatMightFail();
    });
    console.log("Data fetched successfully:", data);
  } catch (error) {
    console.error("Failed to fetch data after multiple retries:", error);
  }
}
```

## Notes

-   The `retries` parameter in `withRetry` actually means the number of *additional* attempts after the first one fails. So, `retries = 3` means up to 4 total attempts.
-   The exponential backoff strategy helps in situations where the external service might be temporarily overloaded, giving it increasing amounts of time to recover between retries.
