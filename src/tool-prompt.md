# CodeCompass MCP Tool

CodeCompass is a tool that helps you understand and navigate your codebase.

## Usage

To use CodeCompass, call one of the following functions:

### search_code
Search for code in your repository based on a query.

```bash
mcpm-aider call codecompass search_code '{"query": "your search query"}'
```

### generate_suggestion
Generate code suggestions based on a query or prompt.

```bash
mcpm-aider call codecompass generate_suggestion '{"query": "how to implement feature X"}'
```

### get_repository_context
Get context about your repository related to a specific query.

```bash
mcpm-aider call codecompass get_repository_context '{"query": "project structure"}'
```

## Examples

1. Search for code related to authentication:
```bash
mcpm-aider call codecompass search_code '{"query": "user authentication"}'
```

2. Get suggestions for implementing a new feature:
```bash
mcpm-aider call codecompass generate_suggestion '{"query": "implement a rate limiter"}'
```

3. Get context about error handling in the project:
```bash
mcpm-aider call codecompass get_repository_context '{"query": "error handling patterns"}'
```
