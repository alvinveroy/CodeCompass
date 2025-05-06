# CodeCompass: AI-Powered Codebase Navigation

CodeCompass is a TypeScript-based MCP server that transforms your Git repository into an AI-driven knowledge base. Using Qdrant for vector storage and Ollama's nomic-embed-text:v1.5 for embeddings and llama3.1:8b for suggestions, it indexes your codebase and documentation, delivering context-aware prompts for LLMs like Claude or Cursor.

## Features

Codebase Analysis: Indexes Git repositories, storing code and documentation in Qdrant.
AI-Driven Context: Generates concise prompts with code summaries, documentation, and metadata.
Diff Tracking: Includes repository update timestamps for change awareness.
Developer Tools: Offers resources (repo://structure, repo://files/*) and tools (search_code, generate_suggestion, get_repository_context).

## Prerequisites

Node.js (v20+)
TypeScript (v5+)
Docker (for Qdrant)
Ollama (with nomic-embed-text:v1.5 and llama3.1:8b models)
A local Git repository

## Installation

Option 1: Clone and Install

Clone the Repository:
git clone <https://github.com/alvinveroy/codecompass.git>
cd codecompass

Install Dependencies:
npm install

Build the Project:
npm run build

Option 2: Install and Run with npx
Run CodeCompass directly using npx:
npx @alvinveroy/codecompass /path/to/your/repo

Note: The npx command downloads the compiled package from npm and runs the server.

## Setup Instructions

Start Qdrant:
docker run -d -p 127.0.0.1:6333:6333 qdrant/qdrant

Start Ollama:

Install Ollama (docs).
Pull models:ollama pull nomic-embed-text:v1.5
ollama pull llama3.1:8b

Run Ollama:ollama serve

## Usage

Build and run the MCP server with your repository path:
npm run build
node dist/index.js /path/to/your/repo

Or, using npx:
npx @alvinveroy/codecompass /path/to/your/repo

## Example Commands

View Repository Structure:const structure = await server.resource("repo://structure");
console.log(structure.content[0].text);

Search Code:const results = await server.tool("search_code", { query: "login function" });
console.log(results.content[0].text);

Get LLM Context:const context = await server.tool("get_repository_context", { query: "Implement login" });
console.log(context.content[0].text);

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
{
  "mcpServers": {
    "codecompass": {
      "command": "npx",
      "args": ["-y", "@alvinveroy/codecompass@latest", "${workspaceFolder}"]
    }
  }
}

Alternative: Use Bun
{
  "mcpServers": {
    "codecompass": {
      "command": "bunx",
      "args": ["-y", "@alvinveroy/codecompass@latest", "${workspaceFolder}"]
    }
  }
}

Alternative: Use Deno
{
  "mcpServers": {
    "codecompass": {
      "command": "deno",
      "args": ["run", "--allow-net", "npm:@alvinveroy/codecompass@latest", "${workspaceFolder}"]
    }
  }
}

Install in VSCode
Add to VSCode MCP configuration:
{
  "servers": {
    "CodeCompass": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "@alvinveroy/codecompass@latest", "${workspaceFolder}"]
    }
  }
}

Install in Windsurf
Add to Windsurf MCP config:
{
  "mcpServers": {
    "codecompass": {
      "command": "npx",
      "args": ["-y", "@alvinveroy/codecompass@latest", "${workspaceFolder}"]
    }
  }
}

Install in Zed
Add to Zed settings.json:
{
  "context_servers": {
    "CodeCompass": {
      "command": {
        "path": "npx",
        "args": ["-y", "@alvinveroy/codecompass@latest", "${workspaceFolder}"]
      },
      "settings": {}
    }
  }
}

Install in Claude Code
Run:
claude mcp add codecompass -- npx -y @alvinveroy/codecompass@latest ${workspaceFolder}

Install in Claude Desktop
Add to claude_desktop_config.json:
{
  "mcpServers": {
    "codecompass": {
      "command": "npx",
      "args": ["-y", "@alvinveroy/codecompass@latest", "${workspaceFolder}"]
    }
  }
}

## Contributing

See CONTRIBUTING.md for guidelines. Submit pull requests or issues on GitHub.
License
MIT License. See LICENSE.md.

Star this repo to stay updated with CodeCompass, your ultimate AI coding companion!
