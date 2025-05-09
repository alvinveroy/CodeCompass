# Changelog

All notable changes to CodeCompass will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]
### Added
- New MCP tool: `get_changelog` to access version history programmatically
- Support for `.env` file configuration
- Command-line flag `--changelog` to display version history
- Command-line flag `--version` to display current version
- New MCP tool: `reset_metrics` to reset all metrics counters
- New MCP tool: `get_session_history` to view detailed session information
- New MCP tool: `agent_query` for multi-step reasoning and problem analysis
- Version number display in console when server starts
- DeepSeek API integration as an alternative to OpenAI
- Docker support for containerized deployment
- CLI tool for setting DeepSeek API key
- Integration with TaskMaster AI for project management
- Support for Knowledge Graph via MCP Memory tool
- Context7 integration for library documentation lookup

### Changed
- Refactored `src/lib/ollama.ts`: Removed `processFeedback` and `summarizeSnippet` functions to streamline the client and improve separation of concerns. (ffa844b)
- Refactored `src/lib/deepseek.ts`:
    - Removed local URL constants (`LOCAL_DEEPSEEK_API_URL`, `LOCAL_DEEPSEEK_EMBEDDING_URL`) and their re-export, ensuring `configService` is the single source of truth for API endpoints. (Part of 928dd38)
    - Corrected the import path for `preprocessText` from `./utils` to `../utils/text-utils`. (ced8d0c)
- Refactored `src/lib/server.ts`:
    - Removed the registration and capability entries for deprecated diagnostic tools (`debug_provider`, `reset_provider`, `direct_model_switch`, `model_switch_diagnostic`, `debug_model_switch`). (ddab05a)
    - Removed redundant registration of the `get_repository_context` tool, ensuring it's registered only once during server startup. (4612652)
    - Removed unused `registerGetRepositoryContextTool` function (dead code). (20c7bd0)
    - Fixed misplaced `generateChainId` function definition, moving it to the module's top level.
    - Refactored `normalizeToolParams` to correctly handle structured object parameters and simplify its logic.
    - Simplified parameter extraction in the `switch_suggestion_model` tool by relying on the Zod schema and the improved `normalizeToolParams`. (d592217)
- Fixed tool registration order in `src/lib/server.ts`: Moved `deepseek_diagnostic` and `force_deepseek_connection` tool registrations to occur before the server connects to the transport, ensuring they are available immediately upon server startup. (a50162f)
- Refactored `src/lib/llm-provider.ts`:
    - Removed deprecated `switchLLMProvider` function and its associated unused import of `saveModelConfig` and `loadModelConfig` from `model-persistence.ts`. (f2a3abd)
    - Moved the implementation of `processFeedback` for the Ollama provider from `src/lib/ollama.ts` into the `OllamaProvider` class within `llm-provider.ts`. This consolidates the provider-specific logic following the removal of the function from the lower-level client.
    - Added necessary metric tracking imports (`trackFeedbackScore`, `incrementCounter`) to `llm-provider.ts` for use by `OllamaProvider.processFeedback`. (39b8e0f)
- Removed unused imports from `model-persistence.ts` (`loadModelConfig`, `forceUpdateModelConfig`) in `src/lib/server.ts` as their functionalities are now covered by `configService` or were part of removed tools. (f2a3abd)
- Refactored `src/lib/model-persistence.ts` by removing `saveModelConfig`, `loadModelConfig`, and `forceUpdateModelConfig` functions as their logic is now handled directly by `ConfigService`. (162e050)
- Removed `src/lib/model-persistence.ts` as its remaining exports were unused and its functionality is covered by `configService`.
- Consolidated retry logic:
    - Removed local `enhancedWithRetry` functions from `src/lib/ollama.ts`, `src/lib/deepseek.ts`, and the `OllamaProvider` class in `src/lib/llm-provider.ts`.
    - All retryable operations in these files now use the centralized `withRetry` function from `src/utils/retry-utils.ts` for consistent retry behavior. (7f57ec6)
- Enhanced documentation for environment variable configuration
- Improved client integration examples with all configurable options
- Improved formatting for all tool outputs using Markdown for better readability
- Standardized response format across all MCP tools
- Fixed TypeScript build errors in server.ts
- Improved parameter handling for MCP tools
- Enhanced retry mechanism for API calls with better error handling
- Refactored provider switching for more reliable model changes
- Improved LLM provider system with better caching and error handling
- Reduced excessive logging by changing many info logs to debug level
- Enhanced model configuration with better defaults and persistence
- Improved code maintainability by extracting duplicate code into helper functions
- Standardized model switching logic across the codebase
- Extended agent capabilities with multi-tool reasoning

### Removed
- Removed granular diagnostic tools: `debug_provider`, `reset_provider`, `direct_model_switch`, `model_switch_diagnostic`, and `debug_model_switch` to simplify the toolset. Core diagnostics are covered by `check_provider`.

### Fixed
- Resolved multiple test failures and a build error (f543424, 33a73a0, 80fe7e2):
    - Updated `configService` mock in `tests/llm-provider.test.ts` to include setter methods.
    - Refined `configService` mock setters in `tests/llm-provider.test.ts` to correctly update `process.env` and `global` variables.
    - Adjusted `beforeEach` and `afterEach` in `tests/llm-provider.test.ts` to correctly manage and restore `process.env` properties, ensuring test isolation and resolving assertion failures for `switchSuggestionModel`.
    - Corrected `normalizeToolParams` tests in `tests/server.test.ts` and `tests/server-tools.test.ts` to align with its refactored behavior.
    - Fixed an incorrect variable name in an error message in `lib/provider-cli.ts`.
- Fixed MCP logging to prevent JSON parsing errors in Claude Desktop
- Replaced logger.configure with custom file logging implementation
- Fixed connection issues with DeepSeek API
- Resolved race conditions in model switching
- Improved error handling for missing API keys
- Fixed provider cache implementation for better performance
- Resolved test failures in LLM provider and model switching tests
- Enhanced error handling for agent tool execution

## [1.1.0] - 2025-05-06

### Added
- Environment variable configuration for Ollama and Qdrant endpoints
- Automatic detection of current working directory
- Improved documentation with formatted code blocks
- Configuration table in README
- Support for additional environment variables: `MCP_PORT`, `LOG_LEVEL`

### Changed
- Removed requirement to specify repository path in command line arguments
- Updated client integration examples to use environment variables
- Improved README formatting and readability
- Enhanced error handling for configuration issues

### Fixed
- Issue with workspace folder path resolution
- Connection retry logic for Ollama and Qdrant services

## [1.0.0] - 2025-04-15

### Added
- Initial release of CodeCompass
- MCP server implementation
- Git repository indexing
- Code search functionality
- AI-powered suggestion generation
- Repository context retrieval
- Integration with Qdrant for vector storage
- Integration with Ollama for embeddings and suggestions
- Support for multiple MCP clients (Cursor, VSCode, Windsurf, Zed, Claude)
