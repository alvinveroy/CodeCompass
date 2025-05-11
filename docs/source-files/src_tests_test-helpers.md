# Documentation for `src/tests/test-helpers.ts`

-   **File Path**: `src/tests/test-helpers.ts`
-   **Purpose**: This file provides utility functions specifically designed to assist in setting up and tearing down test environments for other test suites within the project. These helpers primarily manage environment variables that control the behavior of services or simulate certain conditions, such as provider unavailability.

## Functions

### 1. `setupProviderUnavailabilityTest()`

-   **Purpose**: This function is used to simulate a scenario where an LLM provider (e.g., Ollama, DeepSeek) is unavailable. It achieves this by setting a specific environment variable (`TEST_PROVIDER_UNAVAILABLE`) to `'true'`.
-   **Usage**:
    ```typescript
    import { setupProviderUnavailabilityTest } from './test-helpers';

    describe('Feature X with Provider Unavailability', () => {
      let cleanup: () => void;

      beforeEach(() => {
        cleanup = setupProviderUnavailabilityTest();
      });

      afterEach(() => {
        cleanup(); // Resets the environment variable
      });

      it('should handle provider unavailability gracefully', () => {
        // ... test logic that expects the provider to be unavailable
      });
    });
    ```
-   **Mechanism**:
    -   Sets `process.env.TEST_PROVIDER_UNAVAILABLE = 'true'`.
    -   Returns a cleanup function.
-   **Cleanup Function**:
    -   The returned function, when called (typically in `afterEach`), deletes `process.env.TEST_PROVIDER_UNAVAILABLE`, restoring the environment to its previous state regarding this variable. This ensures that the test does not interfere with other tests.

### 2. `resetTestEnvironment()`

-   **Purpose**: This function provides a more general way to clean up multiple test-specific environment variables. It is designed to ensure that the test environment is reset to a known state, preventing side effects between tests or test suites.
-   **Usage**:
    ```typescript
    import { resetTestEnvironment } from './test-helpers';

    describe('Another Feature Test', () => {
      beforeEach(() => {
        // Potentially set some environment variables for the test
        process.env.LLM_PROVIDER = 'test-provider';
      });

      afterEach(() => {
        resetTestEnvironment(); // Clean up all known test environment variables
      });

      it('should behave correctly under specific conditions', () => {
        // ... test logic
      });
    });
    ```
-   **Mechanism**:
    -   Deletes `process.env.TEST_PROVIDER_UNAVAILABLE`.
    -   Deletes `process.env.FORCE_PROVIDER_UNAVAILABLE`.
    -   Deletes `process.env.LLM_PROVIDER`.
-   **Note**: This function is useful for ensuring that specific environment variables manipulated during tests are cleared, preventing them from affecting subsequent tests. It's more comprehensive than the cleanup function returned by `setupProviderUnavailabilityTest` if multiple such variables are in play.

## Importance

These helper functions are crucial for writing robust and isolated tests, especially when testing error handling, fallback mechanisms, or conditional logic based on environment settings. By providing controlled ways to manipulate and reset the test environment, they help ensure that tests are reliable and do not interfere with each other.
