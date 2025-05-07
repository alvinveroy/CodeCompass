# CodeCompass: AI-Powered Codebase Navigation

CodeCompass is a TypeScript-based MCP server that transforms your Git repository into an AI-driven knowledge base. Using Qdrant for vector storage and Ollama's nomic-embed-text:v1.5 for embeddings and llama3.1:8b for suggestions, it indexes your codebase and documentation, delivering context-aware prompts for LLMs like Claude or Cursor.

## Features

- **Codebase Analysis**: Indexes Git repositories, storing code and documentation in Qdrant.
- **AI-Driven Context**: Generates concise prompts with code summaries, documentation, and metadata.
- **Diff Tracking**: Includes repository update timestamps for change awareness.
- **Developer Tools**: Offers resources (repo://structure, repo://files/*) and tools (search_code, generate_suggestion, get_repository_context).
- **Fully Configurable**: Customize Ollama and Qdrant endpoints through environment variables or client configuration.
- **Automatic Directory Detection**: Uses the current working directory without requiring manual specification.

## Prerequisites

- Node.js (v20+)
- TypeScript (v5+)
- Docker (for Qdrant)
- Ollama (with nomic-embed-text:v1.5 and llama3.1:8b models)
- A local Git repository

## Installation

### Option 1: Clone and Install

1. **Clone the Repository**:
   ```bash
   git clone https://github.com/alvinveroy/codecompass.git
   cd codecompass
   ```

2. **Install Dependencies**:
   ```bash
   npm install
   ```

3. **Build the Project**:
   ```bash
   npm run build
   ```

### Option 2: Install and Run with npx
Run CodeCompass directly using npx:
```bash
npx @alvinveroy/codecompass
```

Note: The npx command downloads the compiled package from npm and runs the server.

## Setup Instructions

### Start Qdrant:
```bash
docker run -d -p 127.0.0.1:6333:6333 qdrant/qdrant
```

### Start Ollama:

1. Install Ollama ([docs](https://ollama.ai/download)).
2. Pull models:
   ```bash
   ollama pull nomic-embed-text:v1.5
   ollama pull llama3.1:8b
   ```
3. Run Ollama:
   ```bash
   ollama serve
   ```

## Configuration

CodeCompass can be configured using environment variables either in your shell or in your MCP client configuration:

| Variable | Description | Default |
|----------|-------------|---------|
| `OLLAMA_HOST` | Ollama API endpoint | `http://localhost:11434` |
| `QDRANT_HOST` | Qdrant server endpoint | `http://localhost:6333` |
| `EMBEDDING_MODEL` | Model for generating embeddings | `nomic-embed-text:v1.5` |
| `SUGGESTION_MODEL` | Model for generating suggestions | `llama3.1:8b` |
| `MCP_PORT` | Port for MCP server | `3000` |
| `LOG_LEVEL` | Logging verbosity | `info` |

You can set these variables:
1. In your shell before running CodeCompass
2. In your MCP client configuration (see integration examples below)
3. In a `.env` file in your project directory

## Usage

Build and run the MCP server:
```bash
npm run build
node dist/index.js
```

Or, using npx:
```bash
npx @alvinveroy/codecompass
```

CodeCompass automatically uses the current working directory as the repository path. No need to specify a path manually!

### Version Information

To check the current version:
```bash
npx @alvinveroy/codecompass --version
```

For a complete changelog, see the [CHANGELOG.md](./CHANGELOG.md) file or run:
```bash
npx @alvinveroy/codecompass --changelog
```

## Example Commands

```typescript
// View Repository Structure
const structure = await server.resource("repo://structure");
console.log(structure.content[0].text);

// Search Code
const results = await server.tool("search_code", { query: "login function" });
console.log(results.content[0].text);

// Get LLM Context
const context = await server.tool("get_repository_context", { query: "Implement login" });
console.log(context.content[0].text);

// Get Changelog Information
const changelog = await server.tool("get_changelog", {});
console.log(changelog.content[0].text);

// Reset Metrics
const reset = await server.tool("reset_metrics", {});
console.log(reset.content[0].text);

// View Session History
const history = await server.tool("get_session_history", { sessionId: "session_123456789" });
console.log(history.content[0].text);

// Analyze Code Problem
const analysis = await server.tool("analyze_code_problem", { 
  query: "Fix the authentication error in login.ts",
  sessionId: "session_123456789" 
});
console.log(analysis.content[0].text);
```

## Integration

### 🛠️ Getting Started

Requirements

Node.js >= v20.0.0
TypeScript >= v5.2.2
Cursor, VSCode, Claude Desktop, Windsurf, Zed, Claude Code, or another MCP client

Installing via Smithery
To install CodeCompass MCP Server automatically via Smithery:
npx -y @smithery/cli install @alvinveroy/codecompass --client claude

Install in Cursor
Add to ~/.cursor/mcp.json:
```json
{
  "mcpServers": {
    "codecompass": {
      "command": "npx",
      "args": ["-y", "@alvinveroy/codecompass@latest"],
      "env": {
        "OLLAMA_HOST": "http://localhost:11434",
        "QDRANT_HOST": "http://localhost:6333",
        "EMBEDDING_MODEL": "nomic-embed-text:v1.5",
        "SUGGESTION_MODEL": "llama3.1:8b",
        "LOG_LEVEL": "info"
      }
    }
  }
}
```

Alternative: Use Bun
```json
{
  "mcpServers": {
    "codecompass": {
      "command": "bunx",
      "args": ["-y", "@alvinveroy/codecompass@latest"],
      "env": {
        "OLLAMA_HOST": "http://localhost:11434",
        "QDRANT_HOST": "http://localhost:6333",
        "EMBEDDING_MODEL": "nomic-embed-text:v1.5",
        "SUGGESTION_MODEL": "llama3.1:8b"
      }
    }
  }
}
```

Alternative: Use Deno
```json
{
  "mcpServers": {
    "codecompass": {
      "command": "deno",
      "args": ["run", "--allow-net", "npm:@alvinveroy/codecompass@latest"],
      "env": {
        "OLLAMA_HOST": "http://localhost:11434",
        "QDRANT_HOST": "http://localhost:6333",
        "EMBEDDING_MODEL": "nomic-embed-text:v1.5",
        "SUGGESTION_MODEL": "llama3.1:8b"
      }
    }
  }
}
```

Install in VSCode
Add to VSCode MCP configuration:
```json
{
  "servers": {
    "CodeCompass": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "@alvinveroy/codecompass@latest"],
      "env": {
        "OLLAMA_HOST": "http://localhost:11434",
        "QDRANT_HOST": "http://localhost:6333",
        "EMBEDDING_MODEL": "nomic-embed-text:v1.5",
        "SUGGESTION_MODEL": "llama3.1:8b"
      }
    }
  }
}
```

Install in Windsurf
Add to Windsurf MCP config:
```json
{
  "mcpServers": {
    "codecompass": {
      "command": "npx",
      "args": ["-y", "@alvinveroy/codecompass@latest"],
      "env": {
        "OLLAMA_HOST": "http://localhost:11434",
        "QDRANT_HOST": "http://localhost:6333",
        "EMBEDDING_MODEL": "nomic-embed-text:v1.5",
        "SUGGESTION_MODEL": "llama3.1:8b"
      }
    }
  }
}
```

Install in Zed
Add to Zed settings.json:
```json
{
  "context_servers": {
    "CodeCompass": {
      "command": {
        "path": "npx",
        "args": ["-y", "@alvinveroy/codecompass@latest"]
      },
      "env": {
        "OLLAMA_HOST": "http://localhost:11434",
        "QDRANT_HOST": "http://localhost:6333",
        "EMBEDDING_MODEL": "nomic-embed-text:v1.5",
        "SUGGESTION_MODEL": "llama3.1:8b"
      },
      "settings": {}
    }
  }
}
```

Install in Claude Code
Run:
```bash
claude mcp add codecompass -- npx -y @alvinveroy/codecompass@latest
```

Install in Claude Desktop
Add to claude_desktop_config.json:
```json
{
  "mcpServers": {
    "codecompass": {
      "command": "npx",
      "args": ["-y", "@alvinveroy/codecompass@latest"],
      "env": {
        "OLLAMA_HOST": "http://localhost:11434",
        "QDRANT_HOST": "http://localhost:6333",
        "EMBEDDING_MODEL": "nomic-embed-text:v1.5",
        "SUGGESTION_MODEL": "llama3.1:8b"
      }
    }
  }
}
```

## Version History

For a complete list of changes and version history, please see the [CHANGELOG.md](./CHANGELOG.md) file.

You can also access the changelog information programmatically through the MCP tool:
```typescript
const changelog = await server.tool("get_changelog", {});
console.log(changelog.content[0].text);
```

## Contributing

See CONTRIBUTING.md for guidelines. Submit pull requests or issues on GitHub.
License
MIT License. See LICENSE.md.

Star this repo to stay updated with CodeCompass, your ultimate AI coding companion!
