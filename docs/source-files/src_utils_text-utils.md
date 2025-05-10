# File: src/utils/text-utils.ts

## Purpose

This utility file provides functions for text preprocessing. These functions are used to clean and normalize text before it's sent to language models for embedding generation or other processing tasks.

## Key Responsibilities/Exports

-   **`preprocessText(text: string): string`**:
    -   Takes a string as input.
    -   Removes null characters and other non-printable ASCII control characters (except for common whitespace like newline).
    -   Normalizes whitespace:
        -   Multiple spaces are collapsed into a single space.
        -   Newlines are preserved.
    -   Trims leading and trailing whitespace from the resulting string.
    -   Returns the cleaned and normalized string.

## Notes

-   This function is important for ensuring that text fed to LLMs is clean and consistent, which can improve the quality of embeddings and model responses.
-   It's used by modules like `src/lib/deepseek.ts` and `src/lib/ollama.ts` before generating embeddings.
