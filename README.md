# CodeCompass: Your AI-Powered Vibe Coding Companion with MCP

**Introduction**: CodeCompass is an AI coding assistant for Vibe Coding, leveraging the Model Context Protocol (MCP) to connect Git repositories to AI assistants. Run locally with Ollama for privacy or configure with OpenAI for cloud power. Integrate with VSCode, Cursor, and Claude for seamless development.

Struggling to debug complex code or implement new features? CodeCompass transforms your Git repositories into an AI-driven knowledge base, empowering [Vibe Coding](https://en.wikipedia.org/wiki/Vibe_coding)—a revolutionary approach where you describe tasks in natural language, and AI generates code. As a [Model Context Protocol (MCP)](https://www.anthropic.com/news/model-context-protocol) server, CodeCompass connects AI assistants like [Claude](https://claude.ai/) to your codebase, delivering context-aware coding assistance. Built with [Qdrant](https://qdrant.tech/) for vector storage and [Ollama](https://ollama.com/) for local privacy, it’s configurable to use cloud models like OpenAI.

A cornerstone of the Vibe coder arsenal, CodeCompass streamlines debugging, feature implementation, and codebase exploration. Star the [CodeCompass GitHub](https://github.com/alvinveroy/CodeCompass) and join the future of AI-driven development!

## What is Vibe Coding?
Vibe Coding, coined by Andrej Karpathy in February 2025, lets developers use natural language prompts to instruct AI to generate code. Describe the “vibe” of your project—like “build a login page”—and AI delivers, making coding accessible to all. CodeCompass enhances this by providing AI assistants with deep repository context.

## What is the Model Context Protocol (MCP)?
The [Model Context Protocol (MCP)](https://www.anthropic.com/news/model-context-protocol) is an open standard by Anthropic that connects AI assistants to data sources, such as Git repositories, for relevant responses. CodeCompass implements MCP to serve codebase data, enabling precise AI-driven coding assistance for Vibe Coding.

## Why Choose CodeCompass?
- **Local Privacy with Ollama**: Runs models locally by default for data security, ideal for sensitive projects.
- **Cloud Flexibility**: Configurable to use online models like OpenAI or DeepSeek for enhanced performance.
- **Agentic RAG**: An AI agent autonomously retrieves code, documentation, and metadata for comprehensive answers.
- **Vibe Coding Ready**: Supports natural language prompts for intuitive code generation.
- **Developer-Friendly**: Integrates with VSCode, Cursor, Zed, Claude Desktop, and more.
- **Metrics & Diagnostics**: Built-in tools for tracking performance and diagnosing issues.
- **Project Management**: Integration with TaskMaster AI for task tracking and management.
- **Knowledge Graph**: Build and query knowledge graphs about your codebase with MCP Memory.
- **Library Documentation**: Access up-to-date documentation for libraries with Context7.
- **Project Management**: Integration with TaskMaster AI for task tracking and management.
- **Knowledge Graph**: Build and query knowledge graphs about your codebase with MCP Memory.
- **Library Documentation**: Access up-to-date documentation for libraries with Context7.

## Installation
### Prerequisites
- Node.js (v20+)
- TypeScript (v5+)
- [Docker](https://www.docker.com/) (for Qdrant)
- [Ollama](https://ollama.com/download) (for local models: `nomic-embed-text:v1.5`, `llama3.1:8b`) or OpenAI API key (for cloud models)
- A local Git repository

### Setup
1. **Start Qdrant**:
   ```bash
   docker run -d -p 127.0.0.1:6333:6333 qdrant/qdrant
   ```
2. **Set Up AI Models**:
   - **Local (Ollama)**:
     ```bash
     ollama pull nomic-embed-text:v1.5
     ollama pull llama3.1:8b
     ollama serve
     ```
   - **Cloud (OpenAI)**: Obtain an [OpenAI API key](https://platform.openai.com/account/api-keys).

### Installation Options
1. **Clone and Install**:
   ```bash
   git clone https://github.com/alvinveroy/CodeCompass
   cd codecompass
   npm install
   npm run build
   ```
2. **Using npx**:
   ```bash
   npx @alvinveroy/codecompass
   ```
3. **Using Docker**:
   ```bash
   docker pull alvinveroy/codecompass:latest
   docker run -p 3000:3000 -v /path/to/your/repo:/app/repo alvinveroy/codecompass
   ```

## Configuration
Set environment variables in your shell, MCP client, or `.env` file:

| Variable                  | Default Value                     | Description                              |
|---------------------------|-----------------------------------|------------------------------------------|
| `LLM_PROVIDER`            | `ollama`                          | AI provider (`ollama`, `openai`, or `deepseek`) |
| `OLLAMA_HOST`             | `http://localhost:11434`          | Ollama server address (for `ollama`)     |
| `OPENAI_API_KEY`          | None                              | OpenAI API key (for `openai`)            |
| `DEEPSEEK_API_KEY`        | None                              | DeepSeek API key (for `deepseek`)        |
| `DEEPSEEK_API_URL`        | Default DeepSeek API endpoint     | Custom DeepSeek API endpoint (optional)  |
| `QDRANT_HOST`             | `http://localhost:6333`           | Qdrant server address                    |
| `EMBEDDING_MODEL`         | `nomic-embed-text:v1.5`           | Embedding model (Ollama)                 |
| `SUGGESTION_MODEL`        | `llama3.1:8b`                     | Suggestion model (Ollama)                |
| `OPENAI_EMBEDDING_MODEL`  | `text-embedding-ada-002`          | Embedding model (OpenAI)                 |
| `OPENAI_SUGGESTION_MODEL` | `gpt-4o`                          | Suggestion model (OpenAI)                |
| `MCP_PORT`                | `3000`                            | MCP server port                          |
| `LOG_LEVEL`               | `info`                            | Logging level                            |

**Example .env for OpenAI**:
```env
LLM_PROVIDER=openai
OPENAI_API_KEY=sk-xxx
QDRANT_HOST=http://localhost:6333
MCP_PORT=3000
OPENAI_EMBEDDING_MODEL=text-embedding-ada-002
OPENAI_SUGGESTION_MODEL=gpt-4o
```

**Example .env for DeepSeek**:
```env
LLM_PROVIDER=deepseek
DEEPSEEK_API_KEY=sk-xxx
QDRANT_HOST=http://localhost:6333
MCP_PORT=3000
```

**Setting DeepSeek API Key via CLI**:
```bash
npm run set-deepseek-key YOUR_API_KEY
```

## Usage
Interact with CodeCompass via MCP using tools optimized for Vibe Coding:

- **View Repository Structure**:
  ```javascript
  server.resource("repo://structure")
  ```
- **Search Code**:
  ```javascript
  server.tool("search_code", { query: "authentication endpoint" })
  ```
- **Get Repository Context**:
  ```javascript
  server.tool("get_repository_context", { query: "Add user login" })
  ```
- **Generate Suggestion**:
  ```javascript
  server.tool("generate_suggestion", { query: "Fix null pointer in auth", code: "..." })
  ```
- **Agent Query** (Multi-step reasoning):
  ```javascript
  server.tool("agent_query", { query: "How does the authentication flow work?", maxSteps: 5 })
  ```
- **Check Provider Status**:
  ```javascript
  server.tool("check_provider", { verbose: true })
  ```
- **Switch Models**:
  ```javascript
  server.tool("switch_suggestion_model", { model: "llama3.1:8b" })
  ```
- **Access Changelog**:
  ```javascript
  server.tool("get_changelog", {})
  ```
- **Manage Tasks with TaskMaster**:
  ```javascript
  server.tool("taskmaster-ai", "get_tasks", { projectRoot: "/path/to/project" })
  ```
- **Build Knowledge Graph**:
  ```javascript
  server.tool("@modelcontextprotocol/memory", "create_entities", { entities: [...] })
  ```
- **Get Library Documentation**:
  ```javascript
  server.tool("context7", "get-library-docs", { context7CompatibleLibraryID: "vercel/nextjs" })
  ```
- **Access Changelog**:
  ```javascript
  server.tool("get_changelog", {})
  ```
- **Manage Tasks with TaskMaster**:
  ```javascript
  server.tool("taskmaster-ai", "get_tasks", { projectRoot: "/path/to/project" })
  ```
- **Build Knowledge Graph**:
  ```javascript
  server.tool("@modelcontextprotocol/memory", "create_entities", { entities: [...] })
  ```
- **Get Library Documentation**:
  ```javascript
  server.tool("context7", "get-library-docs", { context7CompatibleLibraryID: "vercel/nextjs" })
  ```

### Vibe Coding Example
**Scenario**: You want to implement user authentication.

1. **Prompt AI**: Tell your assistant (e.g., Claude), “Add OAuth authentication to my app.”
2. **Context Retrieval**: CodeCompass fetches relevant code and documentation via MCP.
3. **AI Response**: Suggests OAuth implementation with code snippets tailored to your repository.
4. **Refine**: Ask, “Use Google OAuth,” and CodeCompass updates the context for a refined suggestion.

## Integration with Development Tools
CodeCompass integrates seamlessly with popular IDEs and tools, enhancing your Vibe Coding workflow. Below are detailed setup instructions.

### Cursor
1. Install [Cursor](https://www.cursor.com/).
2. Open Cursor settings (`cursor.json`).
3. Add CodeCompass as a custom command:
   ```json
   {
     "commands": [
       {
         "name": "CodeCompass",
         "command": "npx",
         "args": ["-y", "@alvinveroy/codecompass@latest"],
         "env": {
           "LLM_PROVIDER": "ollama",
           "OLLAMA_HOST": "http://localhost:11434",
           "QDRANT_HOST": "http://localhost:6333"
         }
       }
     ]
   }
   ```
4. For OpenAI, update `env`:
   ```json
   {
     "env": {
       "LLM_PROVIDER": "openai",
       "OPENAI_API_KEY": "sk-xxx",
       "QDRANT_HOST": "http://localhost:6333"
     }
   }
   ```
5. Use via Cursor’s AI interface: Prompt, “Debug my login function,” and CodeCompass provides context.

### VSCode
1. Install [VSCode](https://code.visualstudio.com/) and the [Codeium](https://codeium.com/) extension for AI support.
2. Create a `.vscode/settings.json` file:
   ```json
   {
     "codeium.customCommands": [
       {
         "name": "CodeCompass",
         "command": "npx",
         "args": ["-y", "@alvinveroy/codecompass@latest"],
         "env": {
           "LLM_PROVIDER": "ollama",
           "OLLAMA_HOST": "http://localhost:11434",
           "QDRANT_HOST": "http://localhost:6333"
         }
       }
     ]
   }
   ```
3. For OpenAI, modify `env` as above.
4. Access via Codeium’s chat: Ask, “Suggest a REST API structure,” and CodeCompass enhances the response.

### Windsurf
1. Install [Windsurf](https://windsurf.dev/) (AI-powered IDE).
2. Configure Windsurf’s settings (`windsurf.json`):
   ```json
   {
     "customTools": [
       {
         "name": "CodeCompass",
         "command": "npx",
         "args": ["-y", "@alvinveroy/codecompass@latest"],
         "env": {
           "LLM_PROVIDER": "ollama",
           "OLLAMA_HOST": "http://localhost:11434",
           "QDRANT_HOST": "http://localhost:6333"
         }
       }
     ]
   }
   ```
3. For OpenAI, update `env` accordingly.
4. Prompt Windsurf’s AI: “Explore my codebase for database models,” and CodeCompass provides context.

### Zed
1. Install [Zed](https://zed.dev/).
2. Configure Zed’s settings (`settings.json`):
   ```json
   {
     "assistant": {
       "custom_commands": [
         {
           "name": "CodeCompass",
           "command": "npx",
           "args": ["-y", "@alvinveroy/codecompass@latest"],
           "env": {
             "LLM_PROVIDER": "ollama",
             "OLLAMA_HOST": "http://localhost:11434",
             "QDRANT_HOST": "http://localhost:6333"
           }
         }
       ]
     }
   }
   ```
3. For OpenAI, adjust `env`.
4. Use Zed’s assistant: Ask, “Implement a user profile page,” and CodeCompass supplies relevant data.

### Claude Desktop
1. Install [Claude Desktop](https://www.anthropic.com/) (if available).
2. Configure via a custom script or `.env` file:
   ```env
   LLM_PROVIDER=ollama
   OLLAMA_HOST=http://localhost:11434
   QDRANT_HOST=http://localhost:6333
   ```
3. Run CodeCompass:
   ```bash
   npx @alvinveroy/codecompass
   ```
4. For OpenAI, update `.env` with `OPENAI_API_KEY`.
5. Prompt Claude: “Fix my API endpoint,” and CodeCompass enhances the response via MCP.

### Claude Code
1. Use [Claude Code](https://www.anthropic.com/) within supported IDEs or standalone.
2. Install via Smithery:
   ```bash
   npx -y @smithery/cli install @alvinveroy/codecompass --client claude
   ```
3. Configure environment variables in your IDE or `.env` as above.
4. Prompt: “Generate a GraphQL schema,” and CodeCompass provides context.

## Use Cases
| Use Case                | Description                                                                 | Benefit for Vibe Coding                            |
|-------------------------|-----------------------------------------------------------------------------|----------------------------------------------------|
| **Debugging**           | Query AI to identify and fix code errors.                                   | Fast, context-aware solutions reduce downtime.     |
| **Feature Implementation** | Describe features for AI-generated code.                                 | Accelerates development with tailored suggestions. |
| **Code Exploration**    | Navigate codebases with natural language queries.                           | Simplifies large project understanding.            |
| **Onboarding**          | Provide new developers with AI-driven codebase insights.                    | Eases integration with contextual explanations.   |

## Diagnostics and Troubleshooting

CodeCompass includes several diagnostic tools to help troubleshoot issues:

- **Reset Metrics**: Clear all performance counters
  ```javascript
  server.tool("reset_metrics", {})
  ```
- **Debug Provider**: Test provider configuration
  ```javascript
  server.tool("debug_provider", {})
  ```
- **Model Switch Diagnostic**: Diagnose model switching issues
  ```javascript
  server.tool("model_switch_diagnostic", {})
  ```
- **Get Changelog**: View version history
  ```javascript
  server.tool("get_changelog", {})
  ```
- **Get Session History**: View detailed session information
  ```javascript
  server.tool("get_session_history", { sessionId: "your-session-id" })
  ```
- **Get Session History**: View detailed session information
  ```javascript
  server.tool("get_session_history", { sessionId: "your-session-id" })
  ```

## Why CodeCompass for the Vibe Coder Arsenal?
CodeCompass is a must-have in the Vibe coder arsenal, a collection of tools for AI-driven development. By implementing [MCP](https://www.anthropic.com/news/model-context-protocol), it connects your repository to AI assistants, enabling Vibe Coding with:
- **Privacy-First**: Local Ollama models keep data secure.
- **Flexible AI**: Supports cloud models like OpenAI and DeepSeek for versatility.
- **Seamless Integration**: Enhances IDEs for efficient workflows.
- **Democratized Coding**: Makes coding accessible via natural language.
- **Metrics & Diagnostics**: Built-in tools for performance monitoring and troubleshooting.
- **Project Management**: Integrated TaskMaster AI for comprehensive project tracking.
- **Knowledge Representation**: Build and query knowledge graphs about your codebase.
- **Documentation Access**: Retrieve up-to-date library documentation with Context7.
- **Project Management**: Integrated TaskMaster AI for comprehensive project tracking.
- **Knowledge Representation**: Build and query knowledge graphs about your codebase.
- **Documentation Access**: Retrieve up-to-date library documentation with Context7.

## Contributing
Join our community! See [CONTRIBUTING.md](https://github.com/alvinveroy/CodeCompass/blob/main/CONTRIBUTING.md) for guidelines.

## License
[MIT License](https://github.com/alvinveroy/CodeCompass/blob/main/LICENSE.md)

## Repository
[CodeCompass GitHub](https://github.com/alvinveroy/CodeCompass)
