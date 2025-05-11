# Documentation for `src/scripts/test-deepseek.ts`

This document provides an overview and explanation of the `src/scripts/test-deepseek.ts` file.

## Purpose

The `test-deepseek.ts` script is a command-line utility designed to verify the integration and functionality of the DeepSeek API within the CodeCompass application. It performs tests for basic API connectivity and text generation capabilities.

## Key Logic

1.  **Import Dependencies**: The script imports `testDeepSeekConnection` and `generateWithDeepSeek` functions from `../lib/deepseek.ts`.
2.  **Main Function (`main`)**:
    *   Logs the start of the test (`🔍 Testing DeepSeek connection...`).
    *   **Connection Test**:
        *   Calls `testDeepSeekConnection()` to check if a connection can be established with the DeepSeek API using the currently configured API key.
        *   Logs whether the connection test was successful (`✅ Successful`) or failed (`❌ Failed`).
    *   **Text Generation Test (Conditional)**:
        *   If the connection test is successful, it proceeds to test text generation.
        *   Calls `generateWithDeepSeek()` with the prompt "Write a short hello world message".
        *   Logs whether the generation test was successful and prints the `result`.
    *   **Embedding Note**:
        *   Includes a console log stating that DeepSeek is no longer used for embeddings and that Ollama (specifically `nomic-embed-text:v1.5` model) handles all embedding tasks. This serves as an informational note for users running the test.
    *   Logs the completion of the DeepSeek test (`🔍 DeepSeek test complete`).
3.  **Error Handling**:
    *   The `main` function is wrapped in a `try...catch` block to handle errors that may occur during the tests.
    *   If an error occurs, it logs an error message (`❌ Test failed with error:`) and, if the error object contains a `response` property (common for API errors from libraries like `axios`), it logs the `response.data` and `response.status`.
    *   An outer `.catch` block handles any unhandled promise rejections from `main()`, logging the error (`Unhandled error:`) and exiting with status code 1.

## Usage

The script is intended to be run from the command line, typically via an npm script defined in `package.json`:

```bash
npm run test:deepseek
```
The `package.json` script `test:deepseek` is defined as: `"test:deepseek": "ts-node src/scripts/test-deepseek.ts"`.

This script is a diagnostic tool for developers and users to quickly check if the DeepSeek integration is configured correctly and operational for text generation.
