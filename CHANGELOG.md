# Changelog

All notable changes to CodeCompass will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [1.1.0] - 2025-05-06

### Added
- Environment variable configuration for Ollama and Qdrant endpoints
- Automatic detection of current working directory
- Improved documentation with formatted code blocks
- Configuration table in README

### Changed
- Removed requirement to specify repository path in command line arguments
- Updated client integration examples to use environment variables
- Improved README formatting and readability

### Fixed
- Issue with workspace folder path resolution

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
