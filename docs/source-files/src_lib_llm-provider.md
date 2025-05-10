# File: src/lib/llm-provider.ts

## Purpose

This module defines an abstraction layer for interacting with various Large Language Model (LLM) providers (Ollama, DeepSeek, OpenAI, Gemini, Claude). It provides a consistent interface (`LLMProvider`) for operations like checking connection status, generating text, generating embeddings, and processing feedback. It also includes a factory pattern to instantiate the correct provider based on configuration and a caching mechanism for LLM responses.

## Key Responsibilities/Exports

-   **`LLMProvider` Interface**:
    -   Defines the contract for all LLM provider implementations:
        -   `checkConnection(): Promise<boolean>`
        -   `generateText(prompt: string, forceFresh?: boolean): Promise<string>`
        -   `generateEmbedding(text: string): Promise<number[]>`
        -   `processFeedback(originalPrompt: string, suggestion: string, feedback: string, score: number): Promise<string>`

-   **Provider Implementations**:
    -   **`OllamaProvider`**: Implements `LLMProvider` for Ollama. Uses `axios` for HTTP requests to the Ollama server. Handles text generation and embedding generation (delegating to `src/lib/ollama.ts` for embeddings).
    -   **`DeepSeekProvider`**: Implements `LLMProvider` for DeepSeek. Delegates to functions in `src/lib/deepseek.ts` for API interactions. Uses Ollama for embeddings as per current policy.
    -   **`HybridProvider`**: A provider that can use different underlying providers for suggestion generation and embedding generation. Currently, it always uses Ollama for embeddings.
    -   **Placeholder Providers** (`OpenAIProvider`, `GeminiProvider`, `ClaudeProvider`): Basic structures are in place, but their core methods (like `generateText`) are not fully implemented and throw errors. They perform basic API key checks.

-   **Provider Factory (`getLLMProvider`)**:
    -   Dynamically instantiates and returns the appropriate `LLMProvider` based on `configService` settings (primarily `SUGGESTION_PROVIDER` and `EMBEDDING_PROVIDER`).
    -   Implements a simple cache (`providerCache`) for provider instances to avoid re-instantiation if configuration hasn't changed.
    -   Handles a test environment by creating a "test provider" that might bypass some live checks.
    -   If `SUGGESTION_PROVIDER` and `EMBEDDING_PROVIDER` differ, it instantiates a `HybridProvider`.

-   **Model Switching (`switchSuggestionModel`)**:
    -   Allows dynamically changing the suggestion model and provider.
    -   Infers the provider if not explicitly given (e.g., 'deepseek' for models containing 'deepseek').
    -   Checks provider availability before switching.
    -   Updates `configService` with the new settings and persists them.
    -   Clears the `providerCache` to ensure the next call to `getLLMProvider` uses the new settings.

-   **Caching**:
    -   `llmCache`: An instance of `NodeCache` used by `OllamaProvider` and `DeepSeekProvider` to cache LLM text generation responses, reducing redundant API calls.
    -   `providerCache`: A simple cache for the `LLMProvider` instance itself.
    -   `clearProviderCache()`: Exported function to manually clear the `providerCache`.

## Notes

-   Relies heavily on `configService` for all provider-specific configurations (API keys, URLs, model names).
-   Uses `withRetry` from `src/utils/retry-utils.ts` for API calls within `OllamaProvider`.
-   The current policy is that **embeddings are always generated using Ollama**, regardless of the configured suggestion provider. This is enforced in `DeepSeekProvider`, `HybridProvider`, and the placeholder cloud providers.
-   The placeholder providers (OpenAI, Gemini, Claude) are not yet functional for text generation.
-   The module includes logging for provider instantiation, switching, and API interactions.
-   Metrics collection has been removed.
