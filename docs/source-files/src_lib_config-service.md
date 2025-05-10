# File: src/lib/config-service.ts

## Purpose

This file defines the `ConfigService` singleton, which is responsible for managing all configuration settings for the CodeCompass application. It centralizes configuration loading from environment variables and JSON configuration files, provides typed access to configuration values, and allows for dynamic updates and persistence of certain settings.

## Key Responsibilities/Exports

-   **`ConfigService` Class (Singleton)**:
    -   **Initialization**:
        -   Determines configuration directory (`~/.codecompass/`) and log directory.
        -   Sets up Winston logger for file-based logging and stderr for errors.
        -   Initializes configuration properties with defaults, then overrides with environment variables, and finally with values from `model-config.json` and `deepseek-config.json` if they exist.
        -   Updates `process.env` and `global` variables (like `CURRENT_LLM_PROVIDER`) to reflect the effective configuration.
    -   **Configuration Properties**:
        -   `OLLAMA_HOST`, `QDRANT_HOST`, `COLLECTION_NAME`
        -   `LLM_PROVIDER`, `SUGGESTION_MODEL`, `EMBEDDING_MODEL`
        -   `DEEPSEEK_API_KEY`, `DEEPSEEK_API_URL`, `DEEPSEEK_MODEL`, `DEEPSEEK_RPM_LIMIT`
        -   `OPENAI_API_KEY`, `GEMINI_API_KEY`, `CLAUDE_API_KEY`
        -   `AGENT_QUERY_TIMEOUT`
        -   `USE_MIXED_PROVIDERS`, `SUGGESTION_PROVIDER`, `EMBEDDING_PROVIDER`
        -   Constants like `MAX_INPUT_LENGTH`, `MAX_SNIPPET_LENGTH`, `REQUEST_TIMEOUT`, `MAX_RETRIES`, `RETRY_DELAY`.
    -   **File Loading**:
        -   `loadDeepSeekConfigFromFile()`: Loads DeepSeek specific settings from `~/.codecompass/deepseek-config.json`.
        -   `loadModelConfigFromFile()`: Loads general model settings from `~/.codecompass/model-config.json`.
        -   `loadConfigurationsFromFile()`: Orchestrates loading from both files, applying precedence (file > env > default).
    -   **Persistence**:
        -   `persistModelConfiguration()`: Saves current model-related settings (suggestion model/provider, embedding provider, OpenAI/Gemini/Claude keys) to `model-config.json`.
        -   `persistDeepSeekConfiguration()`: Saves DeepSeek API key and URL to `deepseek-config.json`.
    -   **Dynamic Setters**:
        -   Provides public methods like `setSuggestionModel()`, `setSuggestionProvider()`, `setEmbeddingProvider()`, `setDeepSeekApiKey()`, `setOpenAIApiKey()`, etc., which update the internal state, `process.env`, global variables, and then persist the changes.
    -   **`reloadConfigsFromFile()`**: Allows re-initializing all configurations from environment and files.
    -   **`initializeGlobalState()`**: Updates global Node.js variables for easy access to current provider settings.
    -   **`logger`**: Exports the configured Winston logger instance.

-   **Exported Instances**:
    -   `configService`: The singleton instance of `ConfigService`.
    -   `logger`: The logger instance from `configService`.

## Notes

-   **Configuration Precedence**: The service establishes a clear precedence: persisted file configurations > environment variables > hardcoded defaults.
-   **Centralized Management**: Acts as the single source of truth for all application configurations.
-   **Dynamic Updates**: Supports runtime changes to key configurations (e.g., active LLM model/provider) and persists them.
-   **Global State**: For convenience, some critical current settings (like active LLM provider and model) are also exposed via Node.js `global` variables.
-   **Error Handling**: Includes logging for file loading errors.
-   The service ensures that `process.env` is updated to reflect the final effective configuration, which is important for compatibility with libraries or parts of the code that might read directly from `process.env`.
