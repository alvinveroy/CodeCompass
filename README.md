![CodeCompass Logo](https://raw.githubusercontent.com/alvinveroy/CodeCompass/main/docs/images/logo.png)

# CodeCompass

CodeCompass helps developers tackle legacy or existing codebases by giving AI coding assistants the context they need to deliver spot-on suggestions. Legacy code is tough for AI—it’s often messy, outdated, and lacks clear documentation. CodeCompass solves this by analyzing your codebase with Qdrant Vector Store and powering AI with Ollama (local) or cloud agents like DeepSeek, using its Agentic RAG feature to make suggestions smarter and more relevant. It’s like giving your AI a roadmap to your code, so you can vibe code effortlessly.

---

## Features

- **Codebase Analysis**: Maps your repository's structure and dependencies, now with support for indexing very large files through automated chunking.
- **Smart AI Context with Agentic RAG**: Utilizes a sophisticated Retrieval Augmented Generation (RAG) approach. The central `agent_query` tool intelligently orchestrates internal capabilities to gather comprehensive context. This includes analyzing `git diff` information (summarized if large), dynamically summarizing extensive file lists or code snippets, and more, ensuring AI suggestions are highly relevant.
- **Intelligent Agent Orchestration**: The core `agent_query` tool allows the AI to plan and execute multi-step tasks. It can proactively use a suite of internal capabilities to:
  - Search code (`capability_searchCodeSnippets`)
  - Retrieve full file content (`capability_getFullFileContent`), with summarization for large files.
  - List directory contents (`capability_listDirectory`).
  - Fetch adjacent code chunks (`capability_getAdjacentFileChunks`).
  - Analyze repository overviews including diffs and relevant snippets (`capability_getRepositoryOverview`).
  - Request more search results (`capability_fetchMoreSearchResults`) or more processing time if a query is complex.
- **Flexible Setup**: Runs locally with Ollama or connects to cloud AI like DeepSeek.
- **Highly Configurable**: Offers extensive environment variables to fine-tune indexing parameters, agent behavior (like loop steps and refinement iterations), context processing limits, and specific LLM models for tasks like summarization.

## Project Status and Roadmap

**Current Status:**
CodeCompass has successfully implemented its core features, including:
- Codebase analysis using Qdrant Vector Store.
- Agentic RAG (Retrieval Augmented Generation) for intelligent AI suggestions.
- Flexible integration with local LLMs via Ollama (e.g., `llama3.1:8b`, `nomic-embed-text:v1.5`) and cloud-based LLMs like DeepSeek.

The project is actively maintained and considered stable for its current feature set.

**Future Enhancements (Under Consideration):**
While the core functionality is robust, potential future directions include:
- Support for a broader range of LLM providers (e.g., OpenAI, Gemini, Claude).
- More sophisticated agent capabilities and additional tool integrations.
- Enhanced repository indexing techniques for even more precise context retrieval.
- Streamlined user configuration and an even smoother setup experience.
- Deeper integrations with various IDEs and development workflows.

We welcome community contributions and suggestions for future development! Please see our [CONTRIBUTING.md](https://github.com/alvinveroy/CodeCompass/blob/main/CONTRIBUTING.md).

## Prerequisites

- **Node.js** v20+ ([nodejs.org](https://nodejs.org))
- **Docker** for Qdrant ([docker.com](https://www.docker.com))
- **Ollama** ([ollama.com](https://ollama.com)): For local LLM and embedding capabilities.
  - Required models (can be configured via environment variables, see Configuration section):
    - Embedding Model: `nomic-embed-text:v1.5` (default)
    - Suggestion Model (if using Ollama for suggestions): `llama3.1:8b` (default)
- **DeepSeek API Key** (optional, for cloud-based suggestions; get from [Deepseek](https://platform.deepseek.com))

## Installation

1. **Install Ollama**:
   - **Linux**:
     ```bash
     curl -fsSL https://ollama.com/install.sh | sh
     ```
   - **macOS/Windows**: Download from [ollama.com](https://ollama.com/download).
   - Ensure the Ollama application is running (or run `ollama serve` in your terminal if you installed the CLI version).
   - Pull the default models (or the models you intend to configure):
     ```bash
     ollama pull nomic-embed-text:v1.5  # Default embedding model
     ollama pull llama3.1:8b            # Default Ollama suggestion model
     ```
     You can verify installed models with `ollama list`.

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

CodeCompass relies on environment variables for its configuration. These variables can be set in several ways:

1.  **Directly in your shell**: For the current session or persistently by adding them to your shell's profile script.
2.  **System-wide**: Setting them at the operating system level.
3.  **Through MCP client settings**: If you're using CodeCompass via an MCP client like Cursor or Cline, you can often define environment variables within their respective configuration files (e.g., `mcp.json` for Cursor). This is detailed in the "Setting Up with Cursor" section.
4.  **Using a `.env` file**: For convenience, especially during local development, you can place a `.env` file in the root directory of the repository you are analyzing with CodeCompass. CodeCompass will load variables from this file.

Below are instructions for setting environment variables directly in your shell or system-wide, followed by a list of common variables.

### Setting Environment Variables

**For Linux and macOS:**

You can set an environment variable for the current terminal session using the `export` command:
```bash
export VAR_NAME="value"
```
For example:
```bash
export LLM_PROVIDER="deepseek"
export DEEPSEEK_API_KEY="your_deepseek_api_key_here"
```
These settings will only last for the current session. To make them permanent, add these `export` lines to your shell's configuration file:
- For Bash (common default): `~/.bashrc` or `~/.bash_profile`
- For Zsh (common on macOS): `~/.zshrc`
After editing the file, reload it (e.g., `source ~/.bashrc` or `source ~/.zshrc`) or open a new terminal.

**For Windows:**

Using Command Prompt (cmd.exe):
```cmd
set VAR_NAME="value"
```
For example:
```cmd
set LLM_PROVIDER="deepseek"
set DEEPSEEK_API_KEY="your_deepseek_api_key_here"
```
This sets the variable for the current Command Prompt session only.

Using PowerShell:
```powershell
$Env:VAR_NAME = "value"
```
For example:
```powershell
$Env:LLM_PROVIDER = "deepseek"
$Env:DEEPSEEK_API_KEY = "your_deepseek_api_key_here"
```
This sets the variable for the current PowerShell session only.

To set environment variables permanently on Windows:
1.  Search for "environment variables" in the Start Menu.
2.  Click on "Edit the system environment variables".
3.  In the System Properties window, click the "Environment Variables..." button.
4.  You can set User variables (for the current user) or System variables (for all users). Click "New..." under the desired section.
5.  Enter the variable name (e.g., `LLM_PROVIDER`) and value (e.g., `deepseek`).
6.  Click OK on all windows. You may need to restart your Command Prompt, PowerShell, or even your computer for the changes to take full effect.

Alternatively, to set a user environment variable permanently from Command Prompt (requires a new command prompt to see the effect):
```cmd
setx VAR_NAME "value"
```
Example:
```cmd
setx LLM_PROVIDER "deepseek"
setx DEEPSEEK_API_KEY "your_deepseek_api_key_here"
```

### Common Environment Variables (Reference)

Here's a list of important environment variables. If you choose to use a `.env` file, you can copy this structure.

```env
# --- General Configuration ---
# LOG_LEVEL: Logging level (e.g., error, warn, info, verbose, debug, silly). Default: info
# LOG_LEVEL=info

# --- Qdrant Configuration ---
# QDRANT_HOST: URL for the Qdrant vector store server.
QDRANT_HOST=http://localhost:6333
# COLLECTION_NAME: Name of the Qdrant collection for this repository.
# It's good practice to use a unique name per repository if you manage multiple.
# COLLECTION_NAME=codecompass_default_collection
# QDRANT_SEARCH_LIMIT_DEFAULT: Default number of results to fetch from Qdrant during standard searches. Default: 10
# QDRANT_SEARCH_LIMIT_DEFAULT=10

# --- Ollama Configuration (for local LLM and embeddings) ---
# OLLAMA_HOST: URL for the Ollama server.
OLLAMA_HOST=http://localhost:11434

# --- LLM Provider Configuration ---
# LLM_PROVIDER: Specifies the primary LLM provider for generating suggestions.
# Supported values: "ollama", "deepseek", "openai", "gemini", "claude". Default: "ollama"
LLM_PROVIDER=ollama

# SUGGESTION_MODEL: The specific model to use for suggestions.
# If LLM_PROVIDER="ollama", example: "llama3.1:8b", "codellama:7b"
# If LLM_PROVIDER="deepseek", example: "deepseek-coder"
# If LLM_PROVIDER="openai", example: "gpt-4-turbo-preview", "gpt-3.5-turbo"
# If LLM_PROVIDER="gemini", example: "gemini-pro"
# If LLM_PROVIDER="claude", example: "claude-2", "claude-3-opus-20240229"
# Default for Ollama: "llama3.1:8b"
SUGGESTION_MODEL=llama3.1:8b

# EMBEDDING_PROVIDER: Specifies the provider for generating embeddings.
# Currently, "ollama" is the primary supported embedding provider. Default: "ollama"
EMBEDDING_PROVIDER=ollama

# EMBEDDING_MODEL: The specific model to use for embeddings via Ollama.
# Default: "nomic-embed-text:v1.5"
EMBEDDING_MODEL=nomic-embed-text:v1.5

# --- Cloud Provider API Keys (only needed if using respective providers) ---
# DEEPSEEK_API_KEY: Your API key for DeepSeek.
# DEEPSEEK_API_KEY=your_deepseek_api_key_here

# OPENAI_API_KEY: Your API key for OpenAI.
# OPENAI_API_KEY=your_openai_api_key_here

# GEMINI_API_KEY: Your API key for Google Gemini.
# GEMINI_API_KEY=your_gemini_api_key_here

# CLAUDE_API_KEY: Your API key for Anthropic Claude.
# CLAUDE_API_KEY=your_claude_api_key_here

# --- DeepSeek Specific (Optional) ---
# DEEPSEEK_API_URL: Custom API URL for DeepSeek if not using the default.
# Default: "https://api.deepseek.com/chat/completions"
# DEEPSEEK_API_URL=https://api.deepseek.com/chat/completions
# DEEPSEEK_RPM_LIMIT: Requests per minute limit for DeepSeek. Default: 20
# DEEPSEEK_RPM_LIMIT=20

# --- Agent Configuration ---
# MAX_FILES_FOR_SUGGESTION_CONTEXT_NO_SUMMARY: Maximum number of files to list directly in the generate_suggestion tool's context
# before attempting to summarize the file list using an LLM. Default: 15
# MAX_FILES_FOR_SUGGESTION_CONTEXT_NO_SUMMARY=15

# MAX_SNIPPET_LENGTH_FOR_CONTEXT_NO_SUMMARY: Maximum length of a code snippet to include in context without summarization.
# Snippets longer than this will be summarized by an LLM if available. Default: 1500
# MAX_SNIPPET_LENGTH_FOR_CONTEXT_NO_SUMMARY=1500

# MAX_DIFF_LENGTH_FOR_CONTEXT_TOOL: Maximum length of a git diff to include in context without summarization.
# Diffs longer than this will be summarized by an LLM if available. Default: 3000
# MAX_DIFF_LENGTH_FOR_CONTEXT_TOOL=3000

# AGENT_DEFAULT_MAX_STEPS: Default maximum number of steps (tool calls or LLM responses) the agent will take. Default: 10
# AGENT_DEFAULT_MAX_STEPS=10

# AGENT_ABSOLUTE_MAX_STEPS: Absolute maximum number of steps the agent can take, even if it requests more. Default: 15
# AGENT_ABSOLUTE_MAX_STEPS=15

# MAX_REFINEMENT_ITERATIONS: Maximum number of iterations for query refinement. Default: 3
# MAX_REFINEMENT_ITERATIONS=3

# FILE_INDEXING_CHUNK_SIZE_CHARS: Target size for chunks when indexing large files (in characters). Default: 1000
# FILE_INDEXING_CHUNK_SIZE_CHARS=1000

# FILE_INDEXING_CHUNK_OVERLAP_CHARS: Overlap between chunks when indexing large files (in characters). Default: 200
# FILE_INDEXING_CHUNK_OVERLAP_CHARS=200

# SUMMARIZATION_MODEL: LLM model to use for summarization tasks (e.g., long diffs, long snippets).
# If empty or not set, defaults to the SUGGESTION_MODEL.
# SUMMARIZATION_MODEL= # Example: llama3.1:8b or deepseek-coder

# REFINEMENT_MODEL: LLM model to use for LLM-powered query refinement.
# If empty or not set, defaults to the SUGGESTION_MODEL.
# REFINEMENT_MODEL= # Example: llama3.1:8b or deepseek-coder

# REQUEST_ADDITIONAL_CONTEXT_MAX_SEARCH_RESULTS: Number of search results to fetch when agent uses 'request_additional_context' with type 'MORE_SEARCH_RESULTS'. Default: 20
# REQUEST_ADDITIONAL_CONTEXT_MAX_SEARCH_RESULTS=20

# AGENT_QUERY_TIMEOUT: Timeout in milliseconds for agent's LLM reasoning steps. Default: 180000 (3 minutes)
# AGENT_QUERY_TIMEOUT=180000
```

**Note**: When setting environment variables directly or via MCP client configurations, you do not need to create a `.env` file. The list above serves as a reference for the variable names and their purposes. For a local setup with Ollama, the default settings often work without needing to set many environment variables, unless you want to customize models or providers. If using cloud providers like DeepSeek, setting the respective `API_KEY` and adjusting `LLM_PROVIDER` and `SUGGESTION_MODEL` is necessary.

## Troubleshooting

- **Model Not Found (Ollama):**
  - Ensure you have pulled the correct model names using `ollama pull <model_name>`.
  - Verify installed models with `ollama list`.
  - Check that your `OLLAMA_HOST` environment variable is correct and the Ollama server is accessible.
  - Ensure the `SUGGESTION_MODEL` (if using Ollama for suggestions) and `EMBEDDING_MODEL` environment variables match the models you have pulled.

- **Connection Refused (Ollama/Qdrant):**
  - Verify the Ollama server is running (e.g., `ollama serve` or the Ollama application).
  - Verify the Qdrant Docker container is running (`docker ps`) and accessible on the configured host/port (default `http://localhost:6333`).
  - Check your firewall settings if they might be blocking local connections.

- **API Key Issues (DeepSeek, OpenAI, Gemini, Claude):**
  - Double-check that the respective API key (e.g., `DEEPSEEK_API_KEY`) is correctly set in your environment variables or `.env` file.
  - Ensure the key is valid and has not expired or reached its quota.
  - For DeepSeek, you can use the `npm run test-deepseek` script (if available in your setup) to diagnose connection issues.

- **Incorrect Provider/Model Mismatch:**
  - Ensure `LLM_PROVIDER` and `SUGGESTION_MODEL` environment variables are compatible (e.g., use a DeepSeek model name like `deepseek-coder` when `LLM_PROVIDER=deepseek`).

- **General Issues:**
  - Check CodeCompass logs for more detailed error messages. You might need to set `LOG_LEVEL=debug` for more verbose output.
  - Ensure Node.js and Docker are correctly installed and running.

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
2. Replace `your_deepseek_api_key` with your DeepSeek API key (or omit for Ollama). You can set any of the environment variables listed in the "Configuration" section (e.g., `LLM_PROVIDER`, `SUGGESTION_MODEL`) within this `env` block, and CodeCompass will use them.
3. Restart Cursor.

**Note**: For Cline in VSCode, configure similarly in `cline_mcp_settings.json` (see [Cline Docs](https://github.com/saoudrizwan/claude-dev)). Environment variables set in this manner will also be recognized by CodeCompass.

## Usage

With CodeCompass set up, use natural language prompts in Cursor or other AI tools to vibe code—interact with your codebase intuitively. The Agentic RAG feature, powered by Qdrant and Ollama/DeepSeek, ensures your AI understands your code’s context for precise results. Here are some examples:
Your primary interaction will be through a natural language query, which invokes the powerful `agent_query` tool. This tool then orchestrates various internal capabilities to understand and respond to your request. Here are some examples of how you might prompt the system:
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

## Audits

[![Verified on MseeP](https://mseep.ai/badge.svg)](https://mseep.ai/app/ef61b10d-edf7-4ca9-9b5a-4c2ab20d48b3)

[![MseeP.ai Security Assessment Badge](https://mseep.net/pr/alvinveroy-codecompass-badge.png)](https://mseep.ai/app/alvinveroy-codecompass)
