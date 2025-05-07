# Available Tools

## tool: codecompass

### function: agent_query
Run an AI agent that can perform multiple steps to answer complex questions about your codebase. The agent can use other tools internally to gather information and provide a comprehensive response.
**Parameters**:
{"type":"object","properties":{"query":{"type":"string","description":"The question or task for the agent to process"},"sessionId":{"type":"string","description":"Optional session ID to maintain context between requests"},"maxSteps":{"type":"number","description":"Maximum number of reasoning steps the agent should take (default: 5)"}},"required":["query"]}

### function: search_code
Search for code in your repository based on a query. This function uses semantic search to find relevant code snippets that match your query.
**Parameters**:
{"type":"object","properties":{"query":{"type":"string","description":"The search query to find relevant code in the repository"},"sessionId":{"type":"string","description":"Optional session ID to maintain context between requests"}},"required":["query"]}

### function: get_changelog
Retrieve the changelog for the repository. This function returns the contents of the CHANGELOG.md file if it exists.
**Parameters**:
{"type":"object","properties":{},"required":[]}

### function: reset_metrics
Reset all the tracking metrics for the current session. This is useful for benchmarking or starting fresh measurements.
**Parameters**:
{"type":"object","properties":{},"required":[]}

### function: get_session_history
Retrieve the history of queries and suggestions from a specific session. This helps track your interaction with CodeCompass.
**Parameters**:
{"type":"object","properties":{"sessionId":{"type":"string","description":"The session ID to retrieve history for"}},"required":["sessionId"]}

### function: get_repository_context
Get high-level context about your repository related to a specific query. This provides an overview of relevant project structure, patterns, and conventions.
**Parameters**:
{"type":"object","properties":{"query":{"type":"string","description":"The query to get repository context for"},"sessionId":{"type":"string","description":"Optional session ID to maintain context between requests"}},"required":["query"]}

### function: generate_suggestion
Generate code suggestions based on a query or prompt. This function uses AI to provide implementation ideas and code examples.
**Parameters**:
{"type":"object","properties":{"query":{"type":"string","description":"The query or prompt for generating code suggestions"},"sessionId":{"type":"string","description":"Optional session ID to maintain context between requests"}},"required":["query"]}

### function: provide_feedback
Provide feedback on a suggestion to improve future recommendations.
**Parameters**:
{"type":"object","properties":{"sessionId":{"type":"string","description":"The session ID that received the suggestion"},"feedbackId":{"type":"string","description":"The ID of the suggestion to provide feedback for"},"score":{"type":"number","description":"Rating score from 1-10"},"comments":{"type":"string","description":"Detailed feedback comments"},"originalQuery":{"type":"string","description":"The original query that generated the suggestion"},"suggestion":{"type":"string","description":"The suggestion that was provided"}},"required":["sessionId","score","comments","originalQuery","suggestion"]}

### function: analyze_code_problem
Analyze a code problem through multiple steps: problem analysis, root cause identification, and implementation planning.
**Parameters**:
{"type":"object","properties":{"query":{"type":"string","description":"Description of the code problem to analyze"},"sessionId":{"type":"string","description":"Optional session ID to maintain context between requests"}},"required":["query"]}

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

4. Use the agent to answer a complex question:
```bash
mcpm-aider call codecompass agent_query '{"query": "How does the authentication flow work in this codebase?"}'
```

5. Analyze a code problem:
```bash
mcpm-aider call codecompass analyze_code_problem '{"query": "The search function is returning incorrect results when searching for special characters"}'
```

6. Provide feedback on a suggestion:
```bash
mcpm-aider call codecompass provide_feedback '{"sessionId": "session_1234", "score": 8, "comments": "Good suggestion but could be more efficient", "originalQuery": "implement rate limiter", "suggestion": "..."}'
```

7. Check your interaction history with CodeCompass:
```bash
mcpm-aider call codecompass get_session_history '{"sessionId": "session_1234"}'
```
