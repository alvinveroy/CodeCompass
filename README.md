# CodeCompass: AI-Powered Codebase Navigation

CodeCompass is a powerful Node.js MCP server that transforms your Git repository into an AI-driven knowledge base. By leveraging Qdrant for vector storage and Ollama's nomic-embed-text:v1.5 for embeddings and llama3.1:8b for suggestions, it indexes your codebase and documentation, delivering context-aware prompts for LLMs like Claude or Cursor. Perfect for developers looking to streamline coding, reduce errors, and gain deep project insights.

## Features

Codebase Analysis: Indexes Git repositories, storing code and documentation in Qdrant.
AI-Driven Context: Generates concise prompts with code summaries, documentation, and metadata.
Diff Tracking: Includes repository update timestamps for change awareness.
Developer Tools: Offers resources (repo://structure, repo://files/*) and tools (search_code, generate_suggestion, get_repository_context).

## Prerequisites

Node.js (v20+)
Docker (for Qdrant)
Ollama (with nomic-embed-text:v1.5 and llama3.1:8b models)
A local Git repository

## Installation

Option 1: Clone and Install

Clone the Repository:
git clone <https://github.com/your-username/codecompass.git>
cd codecompass

Install Dependencies:
npm install

Option 2: Install and Run with npx
Run CodeCompass directly using npx:
npx codecompass /path/to/your/repo

Note: Ensure npx is installed (included with Node.js). The npx codecompass command downloads the package from npm and runs the server with your repository path.

## Setup Instructions

Start Qdrant:
docker run -p 6333:6333 qdrant/qdrant

Start Ollama:

Install Ollama (docs).
Pull models:ollama pull nomic-embed-text:v1.5
ollama pull llama3.1:8b

Run Ollama:ollama serve

Usage
Run the MCP server with your repository path:
node src/index.js /path/to/your/repo

Or, using npx:
npx codecompass /path/to/your/repo

Example Commands

View Repository Structure:const structure = await server.resource('repo://structure');
console.log(structure.content[0].text);

Search Code:const results = await server.tool('search_code', { query: 'login function' });
console.log(results.content[0].text);

Get LLM Context:const context = await server.tool('get_repository_context', { query: 'Implement login' });
console.log(context.content[0].text);

Integration
🛠️ Getting Started
Requirements

Node.js >= v20.0.0
Cursor, VSCode, Claude Desktop, Windsurf, Zed, Claude Code, or another MCP client

Installing via Smithery
To install CodeCompass MCP Server automatically via Smithery:
npx -y @smithery/cli install codecompass --client claude

Install in Cursor
Go to: Settings -> Cursor Settings -> MCP -> Add new global MCP server
Add the following configuration to your Cursor ~/.cursor/mcp.json file (recommended for global use). Alternatively, install in a specific project by creating .cursor/mcp.json in your project folder. See Cursor MCP docs for more info.
{
  "mcpServers": {
    "codecompass": {
      "command": "npx",
      "args": ["-y", "codecompass@latest", "${workspaceFolder}"]
    }
  }
}

Alternative: Use Bun
{
  "mcpServers": {
    "codecompass": {
      "command": "bunx",
      "args": ["-y", "codecompass@latest", "${workspaceFolder}"]
    }
  }
}

Alternative: Use Deno
{
  "mcpServers": {
    "codecompass": {
      "command": "deno",
      "args": ["run", "--allow-net", "npm:codecompass@latest", "${workspaceFolder}"]
    }
  }
}

Install in VSCode
Add the following to your VSCode MCP configuration file (e.g., settings.json or a dedicated MCP config). See VSCode MCP docs for more info.
{
  "servers": {
    "CodeCompass": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "codecompass@latest", "${workspaceFolder}"]
    }
  }
}

Install in Windsurf
Add the following to your Windsurf MCP config file. See Windsurf MCP docs for more info.
{
  "mcpServers": {
    "codecompass": {
      "command": "npx",
      "args": ["-y", "codecompass@latest", "${workspaceFolder}"]
    }
  }
}

Install in Zed
Add the following to your Zed settings.json. See Zed Context Server docs for more info.
{
  "context_servers": {
    "CodeCompass": {
      "command": {
        "path": "npx",
        "args": ["-y", "codecompass@latest", "${workspaceFolder}"]
      },
      "settings": {}
    }
  }
}

Install in Claude Code
Run the following command. See Claude Code MCP docs for more info.
claude mcp add codecompass -- npx -y codecompass@latest ${workspaceFolder}

Install in Claude Desktop
Add the following to your Claude Desktop claude_desktop_config.json file. See Claude Desktop MCP docs for more info.
{
  "mcpServers": {
    "codecompass": {
      "command": "npx",
      "args": ["-y", "codecompass@latest", "${workspaceFolder}"]
    }
  }
}

Contributing
Contributions are welcome! Please read our CONTRIBUTING.md for guidelines and submit pull requests or issues on GitHub.
License
CodeCompass is licensed under the MIT License. See LICENSE.md for details.

Star this repo to stay updated with CodeCompass, your ultimate AI coding companion!
