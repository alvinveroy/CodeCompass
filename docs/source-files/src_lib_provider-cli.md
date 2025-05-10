# `src/lib/provider-cli.ts`

## Overview

The `src/lib/provider-cli.ts` module provides a command-line interface (CLI) for managing and inspecting the Language Model (LLM) provider configurations used by CodeCompass. It allows users to check the current provider status, switch between different suggestion models, and test the connection to the configured LLM provider.

This script is intended to be run directly using Node.js (e.g., `node dist/lib/provider-cli.js <command>`) or via the npm script/bin alias `codecompass-provider`.

## CLI Commands

The script accepts the following commands:

### `status`

-   **Purpose**: Displays the currently configured suggestion model, suggestion provider, and embedding provider.
-   **Usage**: `codecompass-provider status`
-   **Output**: Prints the values of `configService.SUGGESTION_MODEL`, `configService.SUGGESTION_PROVIDER`, and `configService.EMBEDDING_PROVIDER` to the console.

### `switch <model_name>`

-   **Purpose**: Switches the primary suggestion model (and potentially its provider) used by CodeCompass.
-   **Parameters**:
    -   `model_name: string`: The name of the suggestion model to switch to (e.g., "llama3.1:8b", "deepseek-coder"). The CLI passes this name to the `switchSuggestionModel` function, which handles normalization and provider inference if necessary.
-   **Usage**: `codecompass-provider switch llama3.1:8b`
-   **Process**:
    1.  Calls `switchSuggestionModel(modelName)` from `src/lib/llm-provider.ts`.
    2.  If successful, it prints the new active model and provider from `configService` and advises how to make the change permanent (e.g., by setting environment variables or updating `~/.codecompass/model-config.json`).
    3.  If unsuccessful, it prints an error message and exits.

### `test`

-   **Purpose**: Tests the connection to the currently configured LLM provider (as specified by `configService.LLM_PROVIDER`).
-   **Usage**: `codecompass-provider test`
-   **Process**:
    1.  Retrieves the current LLM provider instance using `getLLMProvider()`.
    2.  Calls the `checkConnection()` method on the provider instance.
    3.  Prints a success message if the connection is established, or an error message if it fails.

### `--help` / `-h`

-   **Purpose**: Displays a help message outlining the available commands, their usage, and examples.
-   **Usage**: `codecompass-provider --help` or `codecompass-provider -h` or `codecompass-provider` (with no arguments).

## Main Function (`async function main()`)

-   Parses command-line arguments (`process.argv.slice(2)`).
-   Implements a `switch` statement to handle the different commands.
-   Provides basic error handling for missing arguments or unknown commands.
-   Exits with appropriate status codes (0 for success, 1 for error).

## Dependencies

-   `./llm-provider`: For `switchSuggestionModel` and `getLLMProvider` functions.
-   `./config-service`: To access current configuration values like `SUGGESTION_MODEL`, `SUGGESTION_PROVIDER`, `EMBEDDING_PROVIDER`, and `LLM_PROVIDER`.

## Example Usage

```bash
# Display current provider status
codecompass-provider status

# Switch to the Llama 3.1 8B model (assuming Ollama provider)
codecompass-provider switch llama3.1:8b

# Switch to the DeepSeek Coder model (assuming DeepSeek provider)
codecompass-provider switch deepseek-coder

# Test the connection to the current LLM provider
codecompass-provider test
```
