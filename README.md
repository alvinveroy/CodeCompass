[![MseeP.ai Security Assessment Badge](https://mseep.net/pr/alvinveroy-codecompass-badge.png)](https://mseep.ai/app/alvinveroy-codecompass)

![CodeCompass Logo](https://raw.githubusercontent.com/alvinveroy/CodeCompass/main/docs/images/logo.png)

# CodeCompass

CodeCompass helps developers tackle legacy or existing codebases by giving AI coding assistants the context they need to deliver spot-on suggestions. Legacy code is tough for AI—it’s often messy, outdated, and lacks clear documentation. CodeCompass solves this by analyzing your codebase with Qdrant Vector Store and powering AI with Ollama (local) or cloud agents like DeepSeek, using its Agentic RAG feature to make suggestions smarter and more relevant. It’s like giving your AI a roadmap to your code, so you can vibe code effortlessly.

---

## Features

- **Codebase Analysis**: Maps your repository's structure and dependencies.
- **Smart AI Context**: Uses Agentic RAG to make AI suggestions fit your code perfectly.
- **Flexible Setup**: Runs locally with Ollama or connects to cloud AI like DeepSeek.

## Prerequisites

- **Node.js** v20+ ([nodejs.org](https://nodejs.org))
- **Docker** for Qdrant ([docker.com](https://www.docker.com))
- **Ollama** with models `nomic-embed-text:v1.5` and `llama3.1:8b` ([ollama.com](https://ollama.com))
- **DeepSeek API Key** (optional, for cloud; get from [Deepseek](https://platform.deepseek.com))

## Installation

1. **Install Ollama**:
   - **Linux**:
     ```bash
     curl -fsSL https://ollama.com/install.sh | sh
     ```
   - **macOS/Windows**: Download from [ollama.com](https://ollama.com/download).
   - Start and pull models:
     ```bash
     ollama serve
     ollama pull nomic-embed-text:v1.5
     ollama pull llama3.1:8b
     ```

2. **Install Qdrant**:
   ```bash
   docker run -p 6333:6333 -p 6334:6334 qdrant/qdrant
   ```
   Verify at [http://localhost:6333/dashboard](http://localhost:6333/dashboard).

3. **Install CodeCompass**:
   ```bash
   npx -y @alvinveroy/codecompass@latest /path/to/your/repo
   ```

## Configuration

Set environment variables (optional; defaults work for local setup):
- `LLM_PROVIDER`: `ollama` (local) or `deepseek` (cloud).
- `DEEPSEEK_API_KEY`: Your DeepSeek API key for cloud use.

## Setting Up with Cursor

1. Edit `~/.cursor/mcp.json`:
   ```json
   {
     "mcpServers": {
       "codecompass": {
         "command": "npx",
         "args": ["-y", "@alvinveroy/codecompass@latest", "/path/to/your/repo"],
         "env": {
           "DEEPSEEK_API_KEY": "your_deepseek_api_key"
         }
       }
     }
   }
   ```
2. Replace `your_deepseek_api_key` with your DeepSeek API key (or omit for Ollama).
3. Restart Cursor.

**Note**: For Cline in VSCode, configure similarly in `cline_mcp_settings.json` (see [Cline Docs](https://github.com/saoudrizwan/claude-dev)).

## Usage

With CodeCompass set up, use natural language prompts in Cursor or other AI tools to vibe code—interact with your codebase intuitively. The Agentic RAG feature, powered by Qdrant and Ollama/DeepSeek, ensures your AI understands your code’s context for precise results. Here are some examples:

- “Hey CodeCompass, find any unused functions in my codebase.”
- “Can CodeCompass suggest modern JavaScript updates for this old module?”
- “Show me how my repo’s architecture fits together, CodeCompass.”
- “CodeCompass, check for risky patterns like `eval()` and suggest fixes.”
- “Help me add a login feature by finding similar code in my repo, CodeCompass.”

These prompts let you work naturally, making coding feel like a conversation with your codebase.

## Contributing

Fork, branch, and submit a pull request. See [CONTRIBUTING.md](https://github.com/alvinveroy/CodeCompass/blob/main/CONTRIBUTING.md).

## License

[MIT License](https://github.com/alvinveroy/CodeCompass/blob/main/LICENSE).