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

-   **`chunkText(text: string, chunkSize: number, overlap: number): string[]`**:
    -   **Purpose**: Splits a given text into smaller, potentially overlapping chunks.
    -   **Parameters**:
        -   `text: string`: The input text to be chunked.
        -   `chunkSize: number`: The maximum desired size (number of characters) for each chunk.
        -   `overlap: number`: The number of characters from the end of the previous chunk to include at the beginning of the next chunk. Must be non-negative and less than `chunkSize`.
    -   **Returns**: `string[]` - An array of text chunks.
    -   **Details**:
        -   Iterates through the text, creating substrings of `chunkSize`.
        -   The starting point for each subsequent chunk is advanced by `chunkSize - overlap`.
        -   Handles empty input text by returning an empty array.
        -   Throws an error if `chunkSize` is not positive or if `overlap` is invalid (negative or >= `chunkSize`).

## Notes

-   The `preprocessText` function is important for ensuring that text fed to LLMs is clean and consistent, which can improve the quality of embeddings and model responses. It's used by modules like `src/lib/deepseek.ts` and `src/lib/ollama.ts` before generating embeddings.
-   The `chunkText` function is used by `src/lib/repository.ts` to break down large file contents or diffs into manageable pieces for indexing and embedding.
