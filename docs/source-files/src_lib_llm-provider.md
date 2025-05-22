# File: src/lib/llm-provider.ts

## Purpose

This module defines an abstraction layer for interacting with various Large Language Model (LLM) providers (Ollama, DeepSeek, OpenAI, Gemini, Claude). It provides a consistent interface (`LLMProvider`) for operations like checking connection status, generating text, generating embeddings, and processing feedback. It also includes a factory pattern to instantiate the correct provider based on configuration and a caching mechanism for LLM responses.

## Key Responsibilities/Exports

-   **`LLMProvider` Interface**:
    -   Defines the contract for all LLM provider implementations:
        -   `checkConnection(): Promise<boolean>`
        -   `generateText(prompt: string, forceFresh?: boolean): Promise<string>`: `forceFresh` (optional boolean) bypasses cache if true.
        -   `generateEmbedding(text: string): Promise<number[]>`
        -   `processFeedback(originalPrompt: string, suggestion: string, feedback: string, score: number): Promise<string>`

-   **Provider Implementations**:
    -   **`OllamaProvider`**: Implements `LLMProvider` for Ollama.
        -   `generateText`: Uses `axios.post` to `/api/generate` with `withRetry`. Caches responses.
        -   `generateEmbedding`: Delegates to `ollama.generateEmbedding`.
        -   `processFeedback`: Constructs a new prompt incorporating the feedback and calls its own `generateText` method.
    -   **`DeepSeekProvider`**: Implements `LLMProvider` for DeepSeek.
        -   `generateText`: Delegates to `deepseek.generateWithDeepSeek` (which includes `withRetry`). Caches responses.
        -   `generateEmbedding`: Explicitly calls `ollama.generateEmbedding` as per policy.
        -   `processFeedback`: Constructs a new prompt and calls its own `generateText` method.
    -   **`HybridProvider`**: A provider that can use different underlying providers for suggestion generation and embedding generation.
        -   `generateEmbedding`: Explicitly calls `ollama.generateEmbedding`.
    -   **Placeholder Providers** (`OpenAIProvider`, `GeminiProvider`, `ClaudeProvider`): Basic structures are in place, but their core methods (like `generateText`) are not fully implemented and throw errors. They perform basic API key checks.

-   **Provider Factory (`getLLMProvider`)**:
    -   Dynamically instantiates and returns the appropriate `LLMProvider` based on `configService` settings.
    -   Uses an internal `providerCache` (keys: `suggestionModel`, `suggestionProvider`, `embeddingProvider`; max age ~2s) to avoid re-instantiation if configuration hasn't changed recently.
    -   The `instantiateProvider` helper is used for actual instantiation, and `createProvider` handles logic like DeepSeek falling back to Ollama if the API key is missing or connection fails.
    -   Handles a test environment by creating a "test provider" that might bypass some live checks.
    -   If `SUGGESTION_PROVIDER` and `EMBEDDING_PROVIDER` differ, it instantiates a `HybridProvider`.

-   **Model Switching (`switchSuggestionModel`)**:
    -   Allows dynamically changing the suggestion model and provider.
    -   Infers the provider if not explicitly given.
    -   Checks provider availability using `checkProviderAvailability`.
    -   Updates `configService` using its setters (e.g., `setSuggestionModel`, `setSuggestionProvider`) and calls `configService.persistModelConfiguration()`.
    -   Clears the `providerCache` to ensure the next call to `getLLMProvider` uses the new settings.

-   **Caching**:
    -   `llmCache`: An instance of `NodeCache` (default TTL 1 hour) used by `OllamaProvider` and `DeepSeekProvider` to cache LLM text generation responses.
    -   `providerCache`: A simple in-memory cache for the `LLMProvider` instance itself, with a short TTL.
    -   `clearProviderCache()`: Exported function to manually clear the `providerCache`.

### Internal Helper Functions

The module also contains several internal helper functions that support `getLLMProvider` and `switchSuggestionModel`:

-   `createTestProvider(suggestionProvider: string): LLMProvider`: Creates a provider instance specifically for test environments.
-   `createProvider(providerName: string): Promise<LLMProvider>`: Instantiates the appropriate provider (e.g., `OllamaProvider`, `DeepSeekProvider`) via `instantiateProvider`. Handles fallback logic (e.g., DeepSeek to Ollama if API key/connection fails).
-   `instantiateProvider(providerName: string): LLMProvider`: Looks up provider constructor in `providerRegistry` and creates an instance.
-   `handleTestEnvironment(normalizedModel: string, provider: string): Promise<boolean>`: Manages model switching logic specifically for test environments.
-   `checkProviderAvailability(provider: string, normalizedModel: string): Promise<boolean>`: Checks if a given provider is available and configured correctly, primarily by calling the provider's own `checkConnection` method.
-   `setModelConfiguration(normalizedModel: string, provider: string): void`: Updates `configService` (via its setters) with the new suggestion model, suggestion provider, and sets the embedding provider (always to "ollama").
-   `configureEmbeddingProvider(provider: string): Promise<void>`: Ensures that if the suggestion provider is different from Ollama (e.g., DeepSeek), Ollama is still checked for embedding capabilities, as it's the designated embedding provider.

## Notes

-   Relies heavily on `configService` for all provider-specific configurations (API keys, URLs, model names).
-   Uses `withRetry` from `src/utils/retry-utils.ts` for API calls within `OllamaProvider`.
-   The current policy is that **embeddings are always generated using Ollama**, regardless of the configured suggestion provider. This is enforced in `DeepSeekProvider`, `HybridProvider`, and the placeholder cloud providers.
-   The placeholder providers (OpenAI, Gemini, Claude) are not yet functional for text generation.
-   The module includes logging for provider instantiation, switching, and API interactions.
-   Metrics collection has been removed.
