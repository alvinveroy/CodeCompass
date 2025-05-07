# Available Tools

## tool: codecompass

### function: search_code
Search for code in your repository based on a query. This function uses semantic search to find relevant code snippets that match your query.
**Parameters**:
{"type":"object","properties":{"query":{"type":"string","description":"The search query to find relevant code in the repository"},"files":{"type":"array","items":{"type":"string"},"description":"Optional list of specific files to search within"}},"required":["query"]}

### function: get_changelog
Retrieve the recent changes made to the repository. This function shows commit history and diffs to help understand what has changed.
**Parameters**:
{"type":"object","properties":{"limit":{"type":"number","description":"Maximum number of commits to retrieve (default: 5)"},"path":{"type":"string","description":"Optional path to limit changelog to specific files or directories"}},"required":[]}

### function: reset_metrics
Reset all the tracking metrics for the current session. This is useful for benchmarking or starting fresh measurements.
**Parameters**:
{"type":"object","properties":{},"required":[]}

### function: get_session_history
Retrieve the history of queries and suggestions from the current session. This helps track your interaction with CodeCompass.
**Parameters**:
{"type":"object","properties":{"sessionId":{"type":"string","description":"Optional session ID to retrieve history for (defaults to current session)"},"limit":{"type":"number","description":"Maximum number of history items to retrieve (default: 10)"}},"required":[]}

### function: get_repository_context
Get high-level context about your repository related to a specific query. This provides an overview of relevant project structure, patterns, and conventions.
**Parameters**:
{"type":"object","properties":{"query":{"type":"string","description":"The query to get repository context for"},"includeFiles":{"type":"boolean","description":"Whether to include file listings in the context (default: true)"}},"required":["query"]}

### function: generate_suggestion
Generate code suggestions based on a query or prompt. This function uses AI to provide implementation ideas and code examples.
**Parameters**:
{"type":"object","properties":{"query":{"type":"string","description":"The query or prompt for generating code suggestions"},"context":{"type":"string","description":"Additional context to help generate more relevant suggestions"}},"required":["query"]}

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

4. View recent changes to the repository:
```bash
mcpm-aider call codecompass get_changelog '{"limit": 3}'
```

5. Check your interaction history with CodeCompass:
```bash
mcpm-aider call codecompass get_session_history '{}'
```
