# File: src/lib/ollama.ts

## Purpose

This module handles all direct interactions with an Ollama server. It provides functions to check the server's availability, verify if specific models are available on the server, and generate embeddings for text using a configured Ollama embedding model.

## Key Responsibilities/Exports

-   **`checkOllama(): Promise<boolean>`**:
    -   Checks if the Ollama server (specified by `configService.OLLAMA_HOST`) is running and accessible.
    -   Makes a GET request to the Ollama server's root endpoint.
    -   Uses `withRetry` from `src/utils/retry-utils.ts` for robustness.
    -   Returns `true` if accessible, `false` otherwise, logging relevant information.

-   **`checkOllamaModel(model: string, isEmbeddingModel: boolean): Promise<boolean>`**:
    -   Verifies if a specific Ollama model is available and functional on the server.
    -   If `isEmbeddingModel` is true, it attempts to generate a test embedding.
    -   If `isEmbeddingModel` is false, it attempts to generate a short text response.
    -   Uses `axios` to make POST requests to `/api/embeddings` or `/api/generate` endpoints.
    -   Returns `true` if the model is available and functional, `false` otherwise (e.g., on API error or if the response structure is unexpected). It does not throw an error itself; callers decide if a `false` return is critical.

-   **`generateEmbedding(text: string): Promise<number[]>`**:
    -   Generates vector embeddings for the input text using the Ollama server.
    -   Uses the embedding model specified by `configService.EMBEDDING_MODEL`.
    -   Checks that the returned embedding vector matches `configService.EMBEDDING_DIMENSION`.
    -   Preprocesses the input text using `preprocessText` from `src/utils/text-utils.ts`.
    -   Truncates text if it exceeds `configService.MAX_INPUT_LENGTH`.
    -   Makes a POST request to the `/api/embeddings` endpoint.
    -   Uses `withRetry` for robustness.
    -   Returns the embedding vector. Throws an error if generation fails, if the embedding is invalid (e.g. contains NaN, non-finite values), or if its dimension doesn't match `configService.EMBEDDING_DIMENSION`.

## Notes

-   This module relies heavily on `configService` for Ollama host URL, embedding model name, embedding dimension, request timeouts, and retry settings.
-   All API interactions are wrapped with `withRetry` to handle transient network issues.
-   Detailed logging is included for diagnostics, including request details and error messages.
-   The `checkOllamaModel` function is crucial for ensuring that models specified in the configuration are actually usable before attempting operations with them.
-   Metrics collection has been removed from this module.
-   Functions for direct text generation (like a standalone `generateTextWithOllama`) are not present in this file; such functionality is handled by `OllamaProvider` in `src/lib/llm-provider.ts`.
