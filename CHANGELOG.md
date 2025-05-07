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
- New MCP tool: `analyze_code_problem` for multi-step reasoning and problem analysis

### Changed
- Enhanced documentation for environment variable configuration
- Improved client integration examples with all configurable options
- Improved formatting for all tool outputs using Markdown for better readability
- Standardized response format across all MCP tools
- Fixed TypeScript build errors in server.ts
- Improved parameter handling for MCP tools

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
