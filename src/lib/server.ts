import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import fs from "fs/promises";
import path from "path";
import git from "isomorphic-git";
import { QdrantClient } from "@qdrant/js-client-rest";
import { logger, COLLECTION_NAME, MAX_SNIPPET_LENGTH } from "./config";
import { SearchCodeSchema, GenerateSuggestionSchema, GetRepositoryContextSchema, QdrantSearchResult } from "./types";
import { checkOllama, checkOllamaModel, generateEmbedding, generateSuggestion, summarizeSnippet } from "./ollama";
import { initializeQdrant } from "./qdrant";
import { validateGitRepository, indexRepository, getRepositoryDiff } from "./repository";

// Start Server
export async function startServer(repoPath: string): Promise<void> {
  logger.info("Starting CodeCompass MCP server...");

  try {
    // Validate repoPath
    if (!repoPath || repoPath === "${workspaceFolder}" || repoPath.trim() === "") {
      logger.warn("Invalid repository path provided, defaulting to current directory");
      repoPath = process.cwd();
    }

    await checkOllama();
    await checkOllamaModel(process.env.EMBEDDING_MODEL || "nomic-embed-text:v1.5", true);
    let suggestionModelAvailable = false;
    try {
      await checkOllamaModel(process.env.SUGGESTION_MODEL || "llama3.1:8b", false);
      suggestionModelAvailable = true;
    } catch (error: any) {
      logger.warn(`Warning: Ollama model ${process.env.SUGGESTION_MODEL || "llama3.1:8b"} is not available. Suggestion tools disabled: ${error.message}`);
    }
    const qdrantClient = await initializeQdrant();
    await indexRepository(qdrantClient, repoPath);

    const server = new McpServer({
      name: "CodeCompass",
      version: "1.0.0",
      vendor: "CodeCompass",
      capabilities: {
        resources: {
          "repo://structure": {},
          "repo://files/*": {},
        },
        tools: {
          search_code: {},
          ...(suggestionModelAvailable ? { generate_suggestion: {}, get_repository_context: {} } : {}),
        },
      },
    });

    // Register resources
    if (typeof server.resource !== "function") {
      throw new Error("MCP server does not support 'resource' method");
    }
    server.resource("repo://structure", "repo://structure", {}, async () => {
      const isGitRepo = await validateGitRepository(repoPath);
      const files = isGitRepo
        ? await git.listFiles({ fs, dir: repoPath, gitdir: path.join(repoPath, ".git"), ref: "HEAD" })
        : [];
      return { contents: [{ uri: "repo://structure", text: files.join("\n") }] };
    });

    server.resource("repo://files/*", "repo://files/*", {}, async (uri: URL) => {
      const filepath = uri.pathname.replace(/^\/files\//, "");
      try {
        const content = await fs.readFile(path.join(repoPath, filepath), "utf8");
        return { contents: [{ uri: uri.toString(), text: content }] };
      } catch (error: any) {
        logger.error(`Error reading file ${filepath}`, { message: error.message });
        return { contents: [{ uri: uri.toString(), text: `Error: ${error.message}` }] };
      }
    });

    // Register tools
    await registerTools(server, qdrantClient, repoPath, suggestionModelAvailable);

    // Connect to transport after registering all capabilities
    const transport = new StdioServerTransport();
    await server.connect(transport);

    logger.info(`CodeCompass MCP server running for repository: ${repoPath}`);
    await new Promise(() => {});
  } catch (error: any) {
    logger.error("Failed to start CodeCompass", { message: error.message });
    process.exit(1);
  }
}

async function registerTools(
  server: McpServer, 
  qdrantClient: QdrantClient, 
  repoPath: string, 
  suggestionModelAvailable: boolean
): Promise<void> {
  if (typeof server.tool !== "function") {
    throw new Error("MCP server does not support 'tool' method");
  }
  
  // Search Code Tool
  server.tool("search_code", async (params: unknown) => {
    logger.info("Received params for search_code", { params });
    let normalizedParams;
    try {
      // Handle stringified JSON input
      if (typeof params === "string") {
        normalizedParams = JSON.parse(params);
      } else {
        normalizedParams = params;
      }
    } catch (error: any) {
      logger.error("Failed to parse params as JSON", { message: error.message });
      throw new Error("Invalid input format: params must be a valid JSON object or string");
    }
    const { query } = SearchCodeSchema.parse(normalizedParams);
    const embedding = await generateEmbedding(query);
    const isGitRepo = await validateGitRepository(repoPath);
    const files = isGitRepo
      ? await git.listFiles({ fs, dir: repoPath, gitdir: path.join(repoPath, ".git"), ref: "HEAD" })
      : [];
    const results = await qdrantClient.search(COLLECTION_NAME, {
      vector: embedding,
      limit: 5,
      filter: files.length ? { must: [{ key: "filepath", match: { any: files } }] } : undefined,
    });
    const summaries = await Promise.all(results.map(async result => ({
      filepath: (result.payload as QdrantSearchResult['payload']).filepath,
      snippet: (result.payload as QdrantSearchResult['payload']).content.slice(0, MAX_SNIPPET_LENGTH),
      summary: suggestionModelAvailable
        ? await summarizeSnippet((result.payload as QdrantSearchResult['payload']).content.slice(0, MAX_SNIPPET_LENGTH))
        : "Summary unavailable (suggestion model not loaded)",
      last_modified: (result.payload as QdrantSearchResult['payload']).last_modified,
      relevance: result.score,
    })));
    return {
      content: summaries.map(s => ({
        type: "text",
        text: `File: ${s.filepath}\nLast Modified: ${s.last_modified}\nRelevance: ${s.relevance.toFixed(2)}\nSnippet: ${s.snippet}\nSummary: ${s.summary}`,
      })),
    };
  });

  if (suggestionModelAvailable) {
    // Generate Suggestion Tool
    server.tool("generate_suggestion", async (params: unknown) => {
      logger.info("Received params for generate_suggestion", { params });
      let normalizedParams;
      try {
        // Handle stringified JSON input
        if (typeof params === "string") {
          normalizedParams = JSON.parse(params);
        } else {
          normalizedParams = params;
        }
      } catch (error: any) {
        logger.error("Failed to parse params as JSON", { message: error.message });
        throw new Error("Invalid input format: params must be a valid JSON object or string");
      }
      const { query } = GenerateSuggestionSchema.parse(normalizedParams);
      const isGitRepo = await validateGitRepository(repoPath);
      const files = isGitRepo
        ? await git.listFiles({ fs, dir: repoPath, gitdir: path.join(repoPath, ".git"), ref: "HEAD" })
        : [];
      const diff = await getRepositoryDiff(repoPath);
      const embedding = await generateEmbedding(query);
      const searchResults = await qdrantClient.search(COLLECTION_NAME, {
        vector: embedding,
        limit: 3,
        filter: files.length ? { must: [{ key: "filepath", match: { any: files } }] } : undefined,
      });
      const context = searchResults.map(r => ({
        filepath: (r.payload as QdrantSearchResult['payload']).filepath,
        snippet: (r.payload as QdrantSearchResult['payload']).content.slice(0, MAX_SNIPPET_LENGTH),
        last_modified: (r.payload as QdrantSearchResult['payload']).last_modified,
        relevance: r.score,
      }));

      const prompt = `
**Context**:
Repository: ${repoPath}
Files: ${files.join(", ")}
Recent Changes: ${diff}

**Relevant Snippets**:
${context.map(c => `File: ${c.filepath} (Last modified: ${c.last_modified}, Relevance: ${c.relevance.toFixed(2)})\n${c.snippet}`).join("\n\n")}

**Instruction**:
Based on the provided context and snippets, generate a detailed code suggestion for "${query}". Include:
- A suggested code implementation or improvement.
- An explanation of how it addresses the query.
- References to the provided snippets or context where applicable.
Ensure the suggestion is concise, practical, and leverages the repository's existing code structure. If the query is ambiguous, provide a general solution with assumptions clearly stated.
      `;
      const suggestion = await generateSuggestion(prompt);
      return {
        content: [{
          type: "text",
          text: `Suggestion for "${query}":\n${suggestion}\n\n**Context Used**:\nFiles: ${files.join(", ")}\nRecent Changes: ${diff}\n\n**Relevant Snippets**:\n${context.map(c => `File: ${c.filepath} (Last modified: ${c.last_modified}, Relevance: ${c.relevance.toFixed(2)})\n${c.snippet}`).join("\n\n")}`,
        }],
      };
    });

    // Get Repository Context Tool
    server.tool("get_repository_context", async (params: unknown) => {
      logger.info("Received params for get_repository_context", { params });
      let normalizedParams;
      try {
        // Handle stringified JSON input
        if (typeof params === "string") {
          normalizedParams = JSON.parse(params);
        } else {
          normalizedParams = params;
        }
      } catch (error: any) {
        logger.error("Failed to parse params as JSON", { message: error.message });
        throw new Error("Invalid input format: params must be a valid JSON object or string");
      }
      // Log the normalized parameters to debug
      logger.info("Normalized params for get_repository_context", { normalizedParams });
      
      // Handle the case where the query might be directly in the params object
      let parsedParams;
      if (typeof normalizedParams === 'object' && normalizedParams !== null) {
        if ('query' in normalizedParams) {
          parsedParams = normalizedParams;
        } else {
          // If no query property exists but we have an object, use the entire object as the query
          parsedParams = { query: JSON.stringify(normalizedParams) };
        }
      } else {
        // If it's a string or other primitive, use it as the query
        parsedParams = { query: String(normalizedParams) };
      }
      
      const { query } = GetRepositoryContextSchema.parse(parsedParams);
      
      // Log the extracted query to confirm it's working
      logger.info("Extracted query for repository context", { query });
      const isGitRepo = await validateGitRepository(repoPath);
      const files = isGitRepo
        ? await git.listFiles({ fs, dir: repoPath, gitdir: path.join(repoPath, ".git"), ref: "HEAD" })
        : [];
      const diff = await getRepositoryDiff(repoPath);
      const embedding = await generateEmbedding(query);
      const searchResults = await qdrantClient.search(COLLECTION_NAME, {
        vector: embedding,
        limit: 3,
        filter: files.length ? { must: [{ key: "filepath", match: { any: files } }] } : undefined,
      });
      const context = searchResults.map(r => ({
        filepath: (r.payload as QdrantSearchResult['payload']).filepath,
        snippet: (r.payload as QdrantSearchResult['payload']).content.slice(0, MAX_SNIPPET_LENGTH),
        last_modified: (r.payload as QdrantSearchResult['payload']).last_modified,
        relevance: r.score,
      }));
      const summary = await generateSuggestion(`
**Context**:
Repository: ${repoPath}
Files: ${files.join(", ")}
Recent Changes: ${diff}

**Relevant Snippets**:
${context.map(c => `File: ${c.filepath} (Last modified: ${c.last_modified}, Relevance: ${c.relevance.toFixed(2)})\n${c.snippet}`).join("\n\n")}

**Instruction**:
Provide a concise summary of the context for "${query}" based on the repository files and recent changes. Highlight key information relevant to the query, referencing specific files or snippets where applicable.
      `);
      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            summary,
            files: context.map(c => ({
              filepath: c.filepath,
              snippet: c.snippet,
              last_modified: c.last_modified,
              relevance: c.relevance,
            })),
            recent_changes: diff,
          }, null, 2),
        }],
      };
    });
  }
}
