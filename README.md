# CodeCompass: Your AI-Powered Vibe Coding Companion with MCP 🚀

[![GitHub stars](https://img.shields.io/github/stars/alvinveroy/CodeCompass?style=social)](https://github.com/alvinveroy/CodeCompass/stargazers)
[![GitHub license](https://img.shields.io/github/license/alvinveroy/CodeCompass)](https://github.com/alvinveroy/CodeCompass/blob/main/LICENSE.md)
[![npm version](https://img.shields.io/npm/v/@alvinveroy/codecompass.svg)](https://www.npmjs.com/package/@alvinveroy/codecompass)
[![CI/CD](https://img.shields.io/github/actions/workflow/status/alvinveroy/codecompass/main.yml?branch=main)](https://github.com/alvinveroy/CodeCompass/actions)

**Unlock Supercharged Developer Productivity with AI!**

CodeCompass is a cutting-edge AI coding assistant designed for **Vibe Coding**. It leverages the **Model Context Protocol (MCP)** to seamlessly connect your Git repositories with powerful AI assistants. Whether you prefer the privacy of local models via **Ollama** or the raw power of cloud-based solutions like **OpenAI** and **DeepSeek**, CodeCompass has you covered. Integrate effortlessly with your favorite IDEs including VSCode, Cursor, Zed, and Claude Desktop to revolutionize your development workflow.

Are you tired of wrestling with complex debugging sessions or struggling to implement new features? CodeCompass transforms your entire Git repository into an intelligent, AI-driven knowledge base. This empowers **[Vibe Coding](https://en.wikipedia.org/wiki/Vibe_coding)**—a groundbreaking approach where you describe your coding tasks in natural language, and AI brings them to life. As a **[Model Context Protocol (MCP)](https://www.anthropic.com/news/model-context-protocol)** server, CodeCompass acts as the crucial bridge, feeding your AI assistants (like **[Claude](https://claude.ai/)**) rich, relevant context directly from your codebase. This ensures highly accurate, context-aware coding assistance.

Built with the robust **[Qdrant](https://qdrant.tech/)** vector database for efficient similarity searches and **[Ollama](https://ollama.com/)** for secure, local model hosting, CodeCompass is engineered for flexibility and performance.

CodeCompass is more than just a tool; it's a cornerstone of the modern Vibe Coder's arsenal. It streamlines debugging, accelerates feature implementation, and makes codebase exploration intuitive. **Star the [CodeCompass GitHub Repository](https://github.com/alvinveroy/CodeCompass) and join the future of AI-driven software development!**

## What is Vibe Coding? 🤔
Vibe Coding, a term popularized by Andrej Karpathy in early 2025, represents a paradigm shift in software development. It allows developers to use natural language prompts to instruct AI models to generate, modify, or explain code. Imagine describing the "vibe" of your desired feature—like “create a sleek, modern login page with social sign-on”—and watching the AI deliver functional code. CodeCompass supercharges this process by providing AI assistants with deep, contextual understanding of your existing repository, leading to more relevant and integrated solutions.

## What is the Model Context Protocol (MCP)? 🌐
The **[Model Context Protocol (MCP)](https://www.anthropic.com/news/model-context-protocol)** is an open standard, pioneered by Anthropic. It defines a universal way for AI assistants to connect with and retrieve information from diverse data sources, such as Git repositories, databases, or document stores. CodeCompass implements an MCP server, specifically tailored to serve codebase data (code snippets, documentation, commit history, etc.). This enables AI assistants to generate responses and code that are deeply informed by the specific context of your project, making Vibe Coding incredibly effective.

## Why Choose CodeCompass? ✨
CodeCompass is packed with features designed to elevate your coding experience:

- 🛡️ **Local Privacy with Ollama**: Run powerful LLMs locally by default, ensuring your code and data remain secure. Perfect for proprietary or sensitive projects.
- ☁️ **Cloud Flexibility**: Seamlessly switch to online models from OpenAI, DeepSeek, or other providers for access to the latest and most powerful AI capabilities.
- 🧠 **Agentic RAG (Retrieval Augmented Generation)**: Employs an intelligent AI agent that autonomously retrieves relevant code snippets, documentation, and repository metadata to provide comprehensive and accurate answers.
- 🗣️ **Vibe Coding Ready**: Natively supports natural language prompts, making code generation intuitive and accessible to everyone.
- 💻 **Developer-Friendly CLI & Integrations**: Easy-to-use command-line interface and smooth integration with popular IDEs like VSCode, Cursor, Zed, and Claude Desktop.
- 📊 **Metrics & Diagnostics**: Built-in tools for tracking LLM performance, usage patterns, and diagnosing connectivity issues.
- 🛠️ **Extensible Toolset**:
    - **Project Management**: Integrate with TaskMaster AI for streamlined task tracking and project management directly within your AI-assisted workflow.
    - **Knowledge Graph**: Build and query rich knowledge graphs about your codebase using the MCP Memory tool, uncovering hidden relationships and insights.
    - **Library Documentation**: Instantly access up-to-date documentation for various libraries through the Context7 integration.

## Installation 🛠️

Get CodeCompass up and running in minutes!

### Prerequisites
- **Node.js**: Version 20 or higher.
- **TypeScript**: Version 5 or higher (for development).
- **[Docker](https://www.docker.com/get-started)**: Required for running the Qdrant vector database.
- **[Ollama](https://ollama.com/download)** (Recommended for local setup):
    - Ensure Ollama is installed and running.
    - Pull the default models:
      ```bash
      ollama pull nomic-embed-text:v1.5  # For embeddings
      ollama pull llama3.1:8b          # For suggestions
      ```
    - You can verify the models are available by running `ollama list`.
- **API Keys (Optional for Cloud Setup)**:
    - **OpenAI**: An [OpenAI API key](https://platform.openai.com/account/api-keys) if you plan to use OpenAI models.
    - **DeepSeek**: A DeepSeek API key if you plan to use DeepSeek models.
- **A local Git repository** that you want CodeCompass to analyze.

### Step 1: Set Up Qdrant (Vector Database)
Qdrant stores the vector embeddings of your codebase, enabling fast semantic search.

1.  **Pull the Qdrant Docker image**:
    ```bash
    docker pull qdrant/qdrant
    ```
2.  **Run the Qdrant container**:
    ```bash
    docker run -d -p 127.0.0.1:6333:6333 -p 127.0.0.1:6334:6334 \
        -v $(pwd)/qdrant_storage:/qdrant/storage \
        qdrant/qdrant
    ```
    - This command maps port `6333` (for gRPC) and `6334` (for HTTP REST API) to your localhost.
    - It also mounts a local directory (`qdrant_storage` in your current working directory) for persistent storage. Adjust the path as needed.
3.  **Verify Qdrant is running**: Open `http://localhost:6333/dashboard` in your browser. You should see the Qdrant dashboard.

### Step 2: Set Up AI Models (Ollama or Cloud)

#### Local Setup with Ollama (Recommended for Privacy & Cost-Effectiveness)
1.  **Install Ollama**: Follow the instructions on the [Ollama website](https://ollama.com/download).
2.  **Pull Required Models**: CodeCompass uses `nomic-embed-text:v1.5` for generating embeddings and `llama3.1:8b` for generating code suggestions by default.
    ```bash
    ollama pull nomic-embed-text:v1.5
    ollama pull llama3.1:8b
    ```
    You can choose other models compatible with Ollama by setting the environment variables (see Configuration section).
3.  **Ensure Ollama Server is Running**:
    Typically, Ollama runs as a background service after installation. You can check its status or start it manually:
    ```bash
    ollama serve
    ```
    To verify, you can list models: `ollama list`.

#### Cloud Setup (OpenAI, DeepSeek)
1.  **Obtain API Keys**:
    - For **OpenAI**: Get your API key from [OpenAI API Keys](https://platform.openai.com/account/api-keys).
    - For **DeepSeek**: Get your API key from the DeepSeek platform.
2.  **Configure Environment Variables**: Set the `LLM_PROVIDER` variable to `openai` or `deepseek` and provide the respective API key (e.g., `OPENAI_API_KEY` or `DEEPSEEK_API_KEY`). See the Configuration section for more details.

### Step 3: Install CodeCompass

Choose one of the following installation methods:

#### Option 1: Clone and Install (for Developers & Contributors)
```bash
git clone https://github.com/alvinveroy/CodeCompass.git
cd CodeCompass
npm install
npm run build
# Test the CLI
./dist/index.js --help 
# Or link for global access (optional)
# npm link 
# codecompass --help
```

#### Option 2: Using NPX (Quickest Way to Run)
This method runs CodeCompass directly without cloning the repository.
```bash
npx @alvinveroy/codecompass --help
npx @alvinveroy/codecompass /path/to/your/repo
```

#### Option 3: Using Docker (Isolated Environment)
This is useful for running CodeCompass in a containerized environment.
```bash
docker pull alvinveroy/codecompass:latest
# Example: Run CodeCompass server for a repository located at /Users/me/myproject
docker run -p 3000:3000 \
  -v /Users/me/myproject:/app/repo \
  -e LLM_PROVIDER="ollama" \
  -e OLLAMA_HOST="http://host.docker.internal:11434" \
  # Add other environment variables as needed
  alvinveroy/codecompass:latest
```
**Note for Docker users**: If Ollama is running on your host machine, you might need to use `http://host.docker.internal:11434` (on Docker Desktop for Mac/Windows) or your host's IP address for `OLLAMA_HOST` so the CodeCompass container can reach it.

## Configuration ⚙️
CodeCompass can be configured using environment variables. You can set them in your shell, within your MCP client's settings, or by creating a `.env` file in the project root when running from a cloned repository.

| Variable                  | Default Value                     | Description                                                                 |
|---------------------------|-----------------------------------|-----------------------------------------------------------------------------|
| `LLM_PROVIDER`            | `ollama`                          | AI provider: `ollama`, `openai`, or `deepseek`.                             |
| `OLLAMA_HOST`             | `http://localhost:11434`          | Ollama server address (used if `LLM_PROVIDER` is `ollama`).                 |
| `OPENAI_API_KEY`          | (None)                            | Your OpenAI API key (used if `LLM_PROVIDER` is `openai`).                   |
| `DEEPSEEK_API_KEY`        | (None)                            | Your DeepSeek API key (used if `LLM_PROVIDER` is `deepseek`).               |
| `DEEPSEEK_API_URL`        | Default DeepSeek API endpoint     | Custom DeepSeek API endpoint (optional, for `deepseek` provider).           |
| `QDRANT_HOST`             | `http://localhost:6333`           | Qdrant server address (ensure Qdrant is running here).                      |
| `EMBEDDING_MODEL`         | `nomic-embed-text:v1.5`           | Default embedding model (used by Ollama for embeddings).                    |
| `SUGGESTION_MODEL`        | `llama3.1:8b`                     | Default suggestion model (used by Ollama for generating text/code).         |
| `OPENAI_EMBEDDING_MODEL`  | `text-embedding-ada-002`          | Embedding model for OpenAI (if `LLM_PROVIDER` is `openai`).                 |
| `OPENAI_SUGGESTION_MODEL` | `gpt-4o`                          | Suggestion model for OpenAI (if `LLM_PROVIDER` is `openai`).                |
| `MCP_PORT`                | `3000`                            | Port on which the CodeCompass MCP server will listen.                       |
| `LOG_LEVEL`               | `info`                            | Logging level (`error`, `warn`, `info`, `http`, `verbose`, `debug`, `silly`). |

**Example `.env` file for OpenAI**:
```env
LLM_PROVIDER=openai
OPENAI_API_KEY=sk-your-openai-api-key-here
QDRANT_HOST=http://localhost:6333
MCP_PORT=3000
# Optional: Specify OpenAI models if different from defaults
# OPENAI_EMBEDDING_MODEL=text-embedding-3-small
# OPENAI_SUGGESTION_MODEL=gpt-4-turbo
```

**Example `.env` file for DeepSeek**:
```env
LLM_PROVIDER=deepseek
DEEPSEEK_API_KEY=sk-your-deepseek-api-key-here
QDRANT_HOST=http://localhost:6333
MCP_PORT=3000
# Optional: Specify DeepSeek models if needed (usually configured via SUGGESTION_MODEL)
# SUGGESTION_MODEL=deepseek-coder
```

**Setting DeepSeek API Key via CLI**:
If you prefer not to use environment variables for the DeepSeek API key, you can set it using the dedicated script:
```bash
# From the root of your cloned CodeCompass directory
npm run set-deepseek-key YOUR_API_KEY
# This will store the key in a local configuration file managed by ConfigService.
```

## Usage 🚀

Once CodeCompass is installed and configured, you can interact with it in two main ways:

### 1. Command-Line Interface (CLI)
CodeCompass offers a CLI for quick actions like viewing help, version, or the changelog, and for starting the MCP server.

- **Display Help Information**:
  ```bash
  codecompass --help
  # or
  codecompass -h
  ```
- **Show Version**:
  ```bash
  codecompass --version
  # or
  codecompass -v
  ```
- **View Changelog**:
  ```bash
  codecompass --changelog
  # For potentially more detailed output in the future (currently same as without --verbose)
  codecompass --changelog --verbose
  ```
- **Start the MCP Server**:
  ```bash
  # Analyze the repository in the current directory
  codecompass

  # Analyze a specific repository
  codecompass /path/to/your/git/repository
  ```
  The server will start, index your repository (if it's the first time or changes are detected), and listen for MCP requests on the configured port (default `3000`).

### 2. Provider Management CLI (`codecompass-provider`)
CodeCompass includes a separate command-line tool, `codecompass-provider`, for managing and inspecting your LLM provider configuration directly. This tool is available if you have cloned and built the project.

- **Show Current Provider Status**:
  ```bash
  npm run codecompass-provider status
  # Displays: Current Suggestion Model, Current Suggestion Provider, Current Embedding Provider
  ```
- **Switch Suggestion Model**:
  ```bash
  npm run codecompass-provider switch <model_name>
  # Example: npm run codecompass-provider switch deepseek-coder
  # Note: This change is for the current session. For permanent changes,
  # set environment variables or update your model configuration file.
  ```
- **Test Current LLM Provider Connection**:
  ```bash
  npm run codecompass-provider test
  # Verifies connectivity with the currently configured LLM provider.
  ```
- **Help for Provider CLI**:
  ```bash
  npm run codecompass-provider --help
  ```

### 3. Model Context Protocol (MCP) Tools
Interact with CodeCompass programmatically via an MCP client (e.g., within your IDE integration or a custom script). Here are some key tools:

- **View Repository Structure**: Get an overview of your project's directory layout.
  ```javascript
  // Example MCP client-side code
  const structure = await server.resource("repo://structure");
  console.log(structure);
  ```
- **Search Code Semantically**: Find code snippets relevant to your query.
  ```javascript
  const searchResults = await server.tool("search_code", { query: "function for user authentication" });
  console.log(searchResults);
  ```
- **Get Repository Context for a Query**: Understand how different parts of your codebase relate to a specific task or question.
  ```javascript
  const context = await server.tool("get_repository_context", { query: "How is database migration handled?" });
  console.log(context);
  ```
- **Generate Code Suggestions**: Get AI-powered code suggestions based on your query and existing code.
  ```javascript
  const suggestion = await server.tool("generate_suggestion", { 
    query: "Refactor this to use async/await", 
    code: "function fetchData() { return fetch(...).then(...); }" 
  });
  console.log(suggestion);
  ```
- **Agent Query (Multi-step Reasoning)**: For complex queries, the AI agent can perform multiple steps (e.g., search code, then get context, then generate a suggestion).
  ```javascript
  const agentResponse = await server.tool("agent_query", { 
    query: "Outline the steps to add a new payment gateway, considering existing patterns.", 
    maxSteps: 5 
  });
  console.log(agentResponse);
  ```
- **Check Provider Status**: Verify your LLM provider connection and configuration.
  ```javascript
  const providerStatus = await server.tool("check_provider", { verbose: true });
  console.log(providerStatus);
  ```
- **Switch Suggestion Models Dynamically**: Change the LLM used for suggestions on the fly.
  ```javascript
  const switchResult = await server.tool("switch_suggestion_model", { model: "deepseek-coder", provider: "deepseek" });
  console.log(switchResult);
  ```
- **Access Changelog Programmatically**: Retrieve the project's changelog.
  ```javascript
  const changelog = await server.tool("get_changelog", {});
  console.log(changelog);
  ```
- **Manage Tasks with TaskMaster AI**: Interface with TaskMaster AI for project management.
  ```javascript
  const tasks = await server.tool("taskmaster-ai", "get_tasks", { projectRoot: "/path/to/taskmaster/project" });
  console.log(tasks);
  ```
- **Build and Query Knowledge Graphs**: Use MCP Memory to create and explore knowledge graphs about your codebase.
  ```javascript
  const newEntities = await server.tool("@modelcontextprotocol/memory", "create_entities", { entities: [/* ... your entities ... */] });
  console.log(newEntities);
  ```
- **Get Library Documentation with Context7**: Fetch documentation for software libraries.
  ```javascript
  // First, resolve the library ID
  const libIdResponse = await server.tool("context7", "resolve-library-id", { libraryName: "react" });
  // Then, use the ID to get docs
  const docs = await server.tool("context7", "get-library-docs", { context7CompatibleLibraryID: libIdResponse.selectedLibraryId, topic: "hooks" });
  console.log(docs);
  ```

### Vibe Coding Example: Step-by-Step
**Scenario**: You want to implement robust error handling for an API endpoint.

1.  **Prompt your AI Assistant**: In your MCP-compatible IDE (e.g., Cursor with CodeCompass integrated), you might say:
    *"Hey CodeCompass, I need to add comprehensive error handling to the `/users/{id}` endpoint. It should handle not found errors, validation errors, and unexpected server errors, returning appropriate JSON responses and status codes."*
2.  **Context Retrieval (CodeCompass in Action)**:
    - CodeCompass receives this query via MCP.
    - Its agent might first use `search_code` to find files related to the `/users/{id}` endpoint.
    - Then, it might use `get_repository_context` to understand existing error handling patterns in your project.
    - This context is passed back to the LLM.
3.  **AI Generates a Solution**: The LLM, now equipped with deep context, provides a tailored suggestion:
    *"Okay, based on your existing Express.js setup and how you handle errors in `authService.ts`, here's how you can enhance the `/users/{id}` endpoint..."*
    (Followed by relevant code snippets, middleware suggestions, or modifications to existing files.)
4.  **Iterate and Refine**: You can continue the conversation:
    *"Thanks! Can you also make sure it logs errors using our standard Winston logger setup?"*
    CodeCompass again fetches context about your logging setup, and the AI refines its suggestion.

This iterative, context-aware process is the essence of Vibe Coding, supercharged by CodeCompass.

## Integration with Development Tools 🧩
CodeCompass integrates seamlessly with popular IDEs and tools, enhancing your Vibe Coding workflow. Below are detailed setup instructions.

### Cursor
1.  Install [Cursor](https://www.cursor.com/).
2.  Open Cursor settings (usually `Cmd/Ctrl + ,`, then find `cursor.json` or the relevant settings UI).
3.  Add CodeCompass as a custom command. If `cursor.json` is used:
    ```json
    {
      "commands": [
        {
          "name": "CodeCompass",
          "command": "npx",
          "args": ["-y", "@alvinveroy/codecompass@latest"],
          "env": {
            "LLM_PROVIDER": "ollama", // Or "openai", "deepseek"
            "OLLAMA_HOST": "http://localhost:11434", // If using ollama
            // "OPENAI_API_KEY": "sk-xxx", // If using openai
            "QDRANT_HOST": "http://localhost:6333"
            // Add other ENV VARS as needed
          }
        }
      ]
    }
    ```
4.  Use via Cursor’s AI interface: Prompt, “Debug my login function,” and CodeCompass provides context.

### VSCode
1.  Install [VSCode](https://code.visualstudio.com/). An extension that supports custom AI commands or MCP integration (like a future version of Codeium or a dedicated MCP client extension) would be ideal.
2.  For now, you can run CodeCompass as a separate server and configure your AI assistant (if it supports MCP) to connect to it.
3.  Alternatively, if using an extension like Codeium that allows custom commands which can invoke shell scripts, you could create a wrapper script. Example for `.vscode/settings.json` (hypothetical, depends on extension capabilities):
    ```json
    {
      "someAiExtension.customCommands": [
        {
          "name": "CodeCompass Contextual Query",
          // This would be a script that runs CodeCompass, gets output, and feeds to AI
          "command": "sh /path/to/your/codecompass_query_script.sh", 
          "args": ["${selectedText}", "${currentFile}"] 
          // "env": { ... CodeCompass ENV VARS ... }
        }
      ]
    }
    ```
    *Actual integration will depend on specific VSCode extension capabilities for MCP or custom tool invocation.*

### Windsurf
1.  Install [Windsurf](https://windsurf.dev/) (AI-powered IDE).
2.  Configure Windsurf’s settings (e.g., `windsurf.json` or through its UI):
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
            // Add other ENV VARS
          }
        }
      ]
    }
    ```
3.  Prompt Windsurf’s AI: “Explore my codebase for database models,” and CodeCompass provides context.

### Zed
1.  Install [Zed](https://zed.dev/).
2.  Configure Zed’s settings (e.g., `settings.json` or through its UI for assistant configuration):
    ```json
    {
      "assistant": {
        "custom_commands": [ // Or similar configuration key for external tools
          {
            "name": "CodeCompass",
            "command": "npx",
            "args": ["-y", "@alvinveroy/codecompass@latest"],
            "env": {
              "LLM_PROVIDER": "ollama",
              "OLLAMA_HOST": "http://localhost:11434",
              "QDRANT_HOST": "http://localhost:6333"
              // Add other ENV VARS
            }
          }
        ]
      }
    }
    ```
3.  Use Zed’s assistant: Ask, “Implement a user profile page,” and CodeCompass supplies relevant data.

### Claude Desktop
1.  Install [Claude Desktop](https://www.anthropic.com/claude#claude-apps) (if available and supports MCP).
2.  Start CodeCompass server first:
    ```bash
    # Set environment variables in your shell or via .env if running from clone
    export LLM_PROVIDER=ollama
    export OLLAMA_HOST=http://localhost:11434
    export QDRANT_HOST=http://localhost:6333
    # ... other vars
    
    npx @alvinveroy/codecompass /path/to/your/repo
    ```
3.  Configure Claude Desktop to connect to CodeCompass MCP server (e.g., `http://localhost:3000`). This step depends on Claude Desktop's specific MCP client configuration options.
4.  Prompt Claude: “Fix my API endpoint,” and CodeCompass enhances the response via MCP.

### Claude Code (via Smithery)
1.  Use [Claude Code](https://www.anthropic.com/) within supported IDEs or standalone.
2.  Install CodeCompass as an MCP tool via Smithery:
    ```bash
    npx -y @smithery/cli install @alvinveroy/codecompass --client claude
    ```
    This typically registers CodeCompass with your Claude environment.
3.  Ensure CodeCompass server is running with appropriate environment variables (as shown in Claude Desktop setup).
4.  Prompt: “Generate a GraphQL schema based on my existing models,” and CodeCompass provides context.

## Use Cases 💡
CodeCompass empowers a variety of development tasks:

| Use Case                 | Description                                                                                                | Benefit for Vibe Coding                                                              |
|--------------------------|------------------------------------------------------------------------------------------------------------|--------------------------------------------------------------------------------------|
| **Advanced Debugging**   | Query AI to identify root causes of complex bugs, leveraging full codebase context.                        | Get fast, accurate solutions that consider interdependencies, reducing downtime.     |
| **Feature Implementation** | Describe desired features in natural language; AI generates code skeletons or full implementations.        | Accelerate development cycles with contextually relevant, tailored code suggestions. |
| **Codebase Exploration** | Navigate and understand large, unfamiliar codebases using natural language queries about functionality.    | Simplify onboarding and make it easier to contribute to complex projects.            |
| **Code Refactoring**     | Ask AI to refactor specific code sections for performance, readability, or to adhere to new patterns.      | Improve code quality efficiently with AI-driven insights.                            |
| **Documentation Generation**| Request AI to generate documentation (e.g., JSDoc, Python docstrings) for functions or modules.        | Keep documentation up-to-date with less manual effort.                               |
| **Onboarding New Developers**| Provide new team members with an AI-powered guide to the codebase, answering their specific questions. | Ease the learning curve and integrate new developers more quickly.                   |

## Diagnostics and Troubleshooting 🩺

CodeCompass includes several tools and CLI options to help you monitor its status and troubleshoot issues:

### Using the Command Line:
- **Help**: `codecompass --help` or `codecompass -h` - Displays all available CLI commands and options.
- **Version**: `codecompass --version` or `codecompass -v` - Shows the installed version of CodeCompass.
- **Changelog**: `codecompass --changelog` - Displays the project's changelog.

### Using MCP Tools (via an MCP client):
- **Check Provider Status**: `server.tool("check_provider", { verbose: true })`
  - Tests your primary LLM provider connection (Ollama, OpenAI, DeepSeek) and displays current configuration details. Essential for a quick health check.
- **DeepSeek Specific Diagnostics**: `server.tool("deepseek_diagnostic", {})`
  - Performs a detailed check of your DeepSeek API key, URL, and connectivity if you're using DeepSeek.
- **Force DeepSeek Connection Test**: `server.tool("force_deepseek_connection", { apiKey: "YOUR_API_KEY_OPTIONAL", apiUrl: "YOUR_API_URL_OPTIONAL", model: "YOUR_MODEL_OPTIONAL" })`
  - Allows a direct connection test to the DeepSeek API, bypassing some local configurations. Parameters are optional; if not provided, values from `configService` (environment variables or config files) are used.
- **Reset Metrics**: `server.tool("reset_metrics", {})`
  - Clears all accumulated performance and usage counters. Useful when you want to start monitoring from a clean slate.
- **Get Changelog (Programmatic)**: `server.tool("get_changelog", {})`
  - Retrieves the project's version history, same content as the CLI command but accessible programmatically.
- **Get Session History**: `server.tool("get_session_history", { sessionId: "your-session-id" })`
  - Retrieves detailed information about a specific user session, including queries and tool calls, aiding in debugging specific interaction flows.

**Common Troubleshooting Steps**:
1.  **Check Qdrant**: Ensure the Qdrant Docker container is running and accessible (default: `http://localhost:6333`).
2.  **Check Ollama**: If using Ollama, ensure `ollama serve` is running and the necessary models are pulled (`ollama list`). Check `OLLAMA_HOST`.
3.  **API Keys**: If using OpenAI or DeepSeek, double-check your API keys and ensure `LLM_PROVIDER` is set correctly.
4.  **Environment Variables**: Verify all necessary environment variables are correctly set and accessible by the CodeCompass process.
5.  **Logs**: Check the console output from CodeCompass server for any error messages or warnings. Increase `LOG_LEVEL` for more detail.

## Why Contribute? 🤝
CodeCompass is an ambitious open-source project aiming to redefine how developers interact with code using AI. By contributing, you can:
- **Shape the Future of AI in Coding**: Help build a leading tool in the rapidly evolving landscape of AI-assisted development.
- **Solve Real-World Problems**: Address the challenges developers face daily, making coding more accessible and efficient.
- **Learn and Grow**: Work with cutting-edge technologies like LLMs, vector databases, and the Model Context Protocol.
- **Join a Vibrant Community**: Collaborate with like-minded developers passionate about AI and open source.

We welcome contributions of all kinds, from bug fixes and documentation improvements to new features and integrations.

## Contributing Guidelines
Excited to contribute? We'd love to have you! Please read our [CONTRIBUTING.md](https://github.com/alvinveroy/CodeCompass/blob/main/CONTRIBUTING.md) for detailed guidelines on how to get started, our development process, and coding standards.

## License
CodeCompass is licensed under the [MIT License](https://github.com/alvinveroy/CodeCompass/blob/main/LICENSE.md).

## Stay Connected & Star Us!
- **GitHub Repository**: [CodeCompass on GitHub](https://github.com/alvinveroy/CodeCompass) - Don't forget to star us if you find CodeCompass useful!
- **Issues & Feature Requests**: [GitHub Issues](https://github.com/alvinveroy/CodeCompass/issues)
