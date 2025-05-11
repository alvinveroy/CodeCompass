# Documentation for `src/tests/llm-provider.test.ts`

-   **File Path**: `src/tests/llm-provider.test.ts`
-   **Purpose**: This file contains unit tests for the LLM (Large Language Model) provider functionalities within `src/lib/llm-provider.ts`. It specifically focuses on testing `getLLMProvider` (including provider caching and instantiation based on configuration), and `switchSuggestionModel` (ensuring correct provider switching, configuration persistence, and connection checks). The tests aim to guarantee that the system can reliably manage and switch between different LLM providers like Ollama and DeepSeek.

## Test Structure and Key Components

The test suite utilizes `vitest` as its testing framework.

### Mocking Strategy:

A significant aspect of this test suite is its comprehensive mocking strategy:

-   **`../lib/ollama`**: Functions from this module (e.g., `checkOllama`, `generateSuggestion`) are mocked using `vi.mock`. This allows simulating Ollama's behavior without actual API calls, focusing tests on the `OllamaProvider` wrapper logic within `llm-provider.ts`.
-   **`../lib/deepseek`**: Similar to Ollama, DeepSeek-specific functions (e.g., `testDeepSeekConnection`, `generateWithDeepSeek`, `checkDeepSeekApiKey`) are mocked to isolate the `DeepSeekProvider` logic.
-   **`../lib/config-service`**: This is a critical mock. `ConfigService` is the central point for application configuration. The mock simulates this singleton and allows tests to:
    -   Control values that `llm-provider.ts` reads (e.g., `SUGGESTION_MODEL`, `SUGGESTION_PROVIDER`, API keys) by providing getters that typically read from `process.env` (e.g., `get SUGGESTION_MODEL() { return process.env.SUGGESTION_MODEL || 'llama3.1:8b'; }`).
    -   Verify that `ConfigService` methods like `persistModelConfiguration`, `setSuggestionModel`, and `setSuggestionProvider` are called with the correct arguments during model or provider switching.
    -   Expose necessary readonly configuration constants (e.g., `OLLAMA_HOST`, `MAX_RETRIES`) that might be used by other modules indirectly invoked during the tests (like `retry-utils`).

### Test Suites:

1.  **`describe('switchSuggestionModel', ...)`**:
    -   **Purpose**: This suite tests the `switchSuggestionModel` function, which is responsible for changing the active LLM model and its associated provider.
    -   **Key Behaviors Tested**:
        -   **Switching to DeepSeek**: Verifies that calling `switchSuggestionModel('deepseek-coder')` correctly:
            -   Calls `configService.setSuggestionModel` with "deepseek-coder".
            -   Calls `configService.setSuggestionProvider` with "deepseek".
            -   Invokes `deepseek.testDeepSeekConnection` (via the provider's `checkConnection`).
            -   Calls `configService.persistModelConfiguration`.
        -   **Switching to Ollama**: Verifies similar correct calls for an Ollama model (e.g., `llama3.1:8b`), ensuring `ollama.checkOllama` is invoked.
    -   **Setup**: Mocks for `deepseek.testDeepSeekConnection`, `deepseek.checkDeepSeekApiKey`, and `ollama.checkOllama` are configured to resolve to `true` to simulate successful connection checks during the switch.

2.  **`describe('getLLMProvider', ...)`**:
    -   **Purpose**: This suite tests the `getLLMProvider` factory function, which is responsible for returning an instance of the currently configured LLM provider.
    -   **Key Behaviors Tested**:
        -   **DeepSeek Provider Instantiation**: When `process.env.SUGGESTION_PROVIDER` is "deepseek", it verifies that `getLLMProvider` returns a `DeepSeekProvider` instance. This is confirmed by checking for the existence of expected methods on the provider object and ensuring `deepseek.testDeepSeekConnection` was called.
        -   **Ollama Provider Instantiation**: Similarly, when `SUGGESTION_PROVIDER` is "ollama", it checks for an `OllamaProvider` instance and the invocation of `ollama.checkOllama`.
        -   **Provider Caching**: It tests the caching mechanism. After `getLLMProvider` is called once, subsequent calls (without configuration changes or cache clearing) should return the cached provider instance. This is verified by ensuring that the underlying connection check functions (e.g., `ollama.checkOllama`) are *not* called on the second invocation of `getLLMProvider`.
    -   **Setup**: `process.env.SUGGESTION_PROVIDER` and `process.env.SUGGESTION_MODEL` are manipulated to simulate different configurations. Connection check mocks are set to return `true`. `clearProviderCache()` is used to ensure a clean state for cache tests.

### Setup and Teardown Hooks (`beforeEach`, `afterEach`):

-   **Environment Variable Management**:
    -   `beforeEach`: A predefined list of environment variables (e.g., `LLM_PROVIDER`, `SUGGESTION_MODEL`, API keys) has their current values saved. These variables are then deleted from `process.env` to ensure a clean slate for each test. Critical test environment variables like `NODE_ENV` and `VITEST` are preserved if they were initially set.
    -   `afterEach`: The saved environment variables are restored to their original values.
-   **Global State Management**:
    -   `beforeEach`: Global variables used by `configService` or `llm-provider` (e.g., `global.CURRENT_SUGGESTION_MODEL`) are reset.
    -   `afterEach`: These global variables are restored.
-   **Mock Reset**: `vi.resetAllMocks()` is called in `beforeEach` to clear call history and reset mock implementations.
-   **Cache Clearing**: `clearProviderCache()` (from `../lib/llm-provider`) is called in `beforeEach` to ensure that tests for provider instantiation and caching start without a pre-existing cached provider.

## Dependencies:

-   **`vitest`**: The core testing framework (`describe`, `it`, `expect`, `vi`, `beforeEach`, `afterEach`).
-   **`../lib/llm-provider`**: The module under test, containing `getLLMProvider`, `switchSuggestionModel`, and `clearProviderCache`.
-   **`../lib/ollama`**, **`../lib/deepseek`**: These are the modules representing the actual LLM clients/SDKs. They are fully mocked in these tests.
-   **`../lib/config-service`**: The application's configuration service, also heavily mocked to control test conditions.

This test suite is vital for maintaining the reliability of CodeCompass's ability to interact with various LLMs, ensuring that provider selection, configuration, and switching mechanisms function correctly under different scenarios.
