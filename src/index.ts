#!/usr/bin/env node

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import axios from "axios";
import { QdrantClient } from "@qdrant/js-client-rest";
import git from "isomorphic-git";
import fs from "fs/promises";
import path from "path";
import { v4 as uuidv4 } from "uuid";
import { z } from "zod";
import winston from "winston";

// Setup Winston logger
const logger = winston.createLogger({
  level: "info",
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.json()
  ),
  transports: [
    new winston.transports.File({ filename: "codecompass.log" }),
  ],
});

// Configuration
const OLLAMA_HOST = process.env.OLLAMA_HOST || "http://127.0.0.1:11434";
const QDRANT_HOST = process.env.QDRANT_HOST || "http://127.0.0.1:6333";
const COLLECTION_NAME = "codecompass";
const EMBEDDING_MODEL = "nomic-embed-text:v1.5";
const SUGGESTION_MODEL = "llama3.1:8b";
const MAX_RETRIES = 3;
const RETRY_DELAY = 1000;
const MAX_INPUT_LENGTH = 4096;
const MAX_SNIPPET_LENGTH = 500;

// Schemas
const SearchCodeSchema = z.object({ query: z.string().min(1, "Query is required") });
const GenerateSuggestionSchema = z.object({
  query: z.string().min(1, "Query is required").optional(),
  prompt: z.string().min(1, "Prompt is required").optional(),
}).transform((data) => ({
  query: data.query || data.prompt || "",
})).refine(data => data.query.length > 0, {
  message: "Either query or prompt must be a non-empty string",
  path: ["query"],
});
const GetRepositoryContextSchema = z.object({ query: z.string().min(1, "Query is required") });

// Types
interface OllamaEmbeddingResponse { embedding: number[] }
interface OllamaGenerateResponse { response: string }
interface QdrantPoint { id: string; vector: number[]; payload: { filepath: string; content: string; last_modified: string } }
interface QdrantSearchResult { id: string | number; payload: { content: string; filepath: string; last_modified: string }; score: number }

// Utility: Retry logic
async function withRetry<T>(fn: () => Promise<T>, retries = MAX_RETRIES): Promise<T> {
  for (let i = 0; i < retries; i++) {
    try {
      return await fn();
    } catch (error: any) {
      if (i === retries - 1) throw error;
      logger.warn(`Retry ${i + 1}/${retries} after error: ${error.message}`);
      await new Promise(resolve => setTimeout(resolve, RETRY_DELAY));
    }
  }
  throw new Error("Unreachable");
}

// Utility: Preprocess input text
function preprocessText(text: string): string {
  text = text.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, "");
  text = text.replace(/\s+/g, (match) => (match.includes("\n") ? "\n" : " "));
  return text.trim();
}

// Check Ollama
async function checkOllama(): Promise<boolean> {
  logger.info(`Checking Ollama at ${OLLAMA_HOST}`);
  await withRetry(async () => {
    const response = await axios.get(OLLAMA_HOST, { timeout: 5000 });
    logger.info(`Ollama status: ${response.status}`);
  });
  return true;
}

// Check Ollama Model
async function checkOllamaModel(model: string, isEmbeddingModel: boolean): Promise<boolean> {
  logger.info(`Checking Ollama model: ${model}`);
  try {
    if (isEmbeddingModel) {
      const response = await axios.post<OllamaEmbeddingResponse>(
        `${OLLAMA_HOST}/api/embeddings`,
        { model, prompt: "test" },
        { timeout: 10000 }
      );
      if (response.status === 200 && response.data.embedding) {
        logger.info(`Ollama model ${model} is available`);
        return true;
      }
    } else {
      const response = await axios.post<OllamaGenerateResponse>(
        `${OLLAMA_HOST}/api/generate`,
        { model, prompt: "test", stream: false },
        { timeout: 10000 }
      );
      if (response.status === 200 && response.data.response) {
        logger.info(`Ollama model ${model} is available`);
        return true;
      }
    }
    throw new Error(`Model ${model} not functional`);
  } catch (error: any) {
    logger.error(`Ollama model check error for ${model}`, {
      message: error.message,
      response: error.response
        ? {
            status: error.response.status,
            data: error.response.data,
          }
        : null,
    });
    throw new Error(
      `Ollama model ${model} is not available. Pull it with: ollama pull ${model}`
    );
  }
}

// Initialize Qdrant
async function initializeQdrant(): Promise<QdrantClient> {
  logger.info(`Checking Qdrant at ${QDRANT_HOST}`);
  const client = new QdrantClient({ url: QDRANT_HOST });
  await withRetry(async () => {
    await client.getCollections();
    const collections = await client.getCollections();
    if (!collections.collections.some(c => c.name === COLLECTION_NAME)) {
      await client.createCollection(COLLECTION_NAME, { vectors: { size: 768, distance: "Cosine" } });
      logger.info(`Created collection: ${COLLECTION_NAME}`);
    }
  });
  return client;
}

// Generate Embedding
async function generateEmbedding(text: string): Promise<number[]> {
  const processedText = preprocessText(text);
  const truncatedText = processedText.length > MAX_INPUT_LENGTH ? processedText.slice(0, MAX_INPUT_LENGTH) : processedText;
  try {
    const response = await withRetry(async () => {
      logger.info(`Generating embedding for text (length: ${truncatedText.length}, snippet: "${truncatedText.slice(0, 100)}...")`);
      const res = await axios.post<OllamaEmbeddingResponse>(
        `${OLLAMA_HOST}/api/embeddings`,
        { model: EMBEDDING_MODEL, prompt: truncatedText },
        { timeout: 10000 }
      );
      return res.data;
    });
    return response.embedding;
  } catch (error: any) {
    logger.error("Ollama embedding error", {
      message: error.message,
      code: error.code,
      config: error.config,
      response: error.response
        ? {
            status: error.response.status,
            data: error.response.data,
          }
        : null,
      inputLength: truncatedText.length,
      inputSnippet: truncatedText.slice(0, 100),
    });
    throw error;
  }
}

// Generate Suggestion
async function generateSuggestion(prompt: string): Promise<string> {
  try {
    const response = await withRetry(async () => {
      const res = await axios.post<OllamaGenerateResponse>(
        `${OLLAMA_HOST}/api/generate`,
        { model: SUGGESTION_MODEL, prompt, stream: false },
        { timeout: 10000 }
      );
      return res.data;
    });
    return response.response;
  } catch (error: any) {
    logger.error("Ollama suggestion error", {
      message: error.message,
      response: error.response
        ? {
            status: error.response.status,
            data: error.response.data,
          }
        : null,
    });
    throw new Error("Failed to generate suggestion");
  }
}

// Validate Git Repository
async function validateGitRepository(repoPath: string): Promise<boolean> {
  try {
    const gitdir = path.join(repoPath, ".git");
    await fs.access(gitdir);
    await git.resolveRef({ fs, dir: repoPath, gitdir, ref: "HEAD" });
    logger.info(`Valid Git repository at: ${repoPath}`);
    return true;
  } catch (error: any) {
    logger.warn(`Failed to validate Git repository at ${repoPath}: ${error.message}`);
    return false;
  }
}

// Index Repository
async function indexRepository(qdrantClient: QdrantClient, repoPath: string): Promise<void> {
  const isGitRepo = await validateGitRepository(repoPath);
  if (!isGitRepo) {
    logger.warn(`Skipping repository indexing: ${repoPath} is not a valid Git repository`);
    return;
  }

  const files = await git.listFiles({ fs, dir: repoPath, gitdir: path.join(repoPath, ".git"), ref: "HEAD" });
  logger.info("Files to index:", { files });

  if (!files.length) {
    logger.warn("No files to index in repository.");
    return;
  }

  for (const filepath of files) {
    try {
      const fullPath = path.join(repoPath, filepath);
      const content = await fs.readFile(fullPath, "utf8");
      const embedding = await generateEmbedding(content);
      const pointId = uuidv4();
      logger.info(`Upserting to Qdrant: ${filepath} (ID: ${pointId})`);
      await qdrantClient.upsert(COLLECTION_NAME, {
        points: [{ id: pointId, vector: embedding, payload: { filepath, content, last_modified: (await fs.stat(fullPath)).mtime.toISOString() } }],
      });
      logger.info(`Indexed: ${filepath}`);
    } catch (error: any) {
      logger.error(`Failed to index ${filepath}`, {
        message: error.message,
        code: error.code,
        response: error.response
          ? {
              status: error.response.status,
              data: error.response.data,
            }
          : null,
      });
    }
  }
}

// Get Repository Diff
async function getRepositoryDiff(repoPath: string): Promise<string> {
  const isGitRepo = await validateGitRepository(repoPath);
  if (!isGitRepo) {
    logger.warn(`Cannot get repository diff: ${repoPath} is not a valid Git repository`);
    return "No Git repository found";
  }

  try {
    const commits = await git.log({ fs, dir: repoPath, depth: 2 });
    if (commits.length < 2) return "No previous commits to compare";
    const [latest, previous] = commits;
    const changes: string[] = [];
    await git.walk({
      fs,
      dir: repoPath,
      trees: [git.TREE({ ref: previous.oid }), git.TREE({ ref: latest.oid })],
      map: async (filepath, [a, b]) => {
        if (!a && !b) return;
        const change = !a ? 'added' : !b ? 'removed' : 'modified';
        changes.push(`${change}: ${filepath}`);
      },
    });
    return changes.join('\n') || "No changes since last commit";
  } catch (error: any) {
    logger.error("Diff error", { message: error.message });
    return "Failed to retrieve diff";
  }
}

// Summarize Snippet
async function summarizeSnippet(snippet: string): Promise<string> {
  const prompt = `Summarize this code snippet in 50 words or less:\n\n${snippet}`;
  return await generateSuggestion(prompt);
}

// Start Server
async function startServer(repoPath: string): Promise<void> {
  logger.info("Starting CodeCompass MCP server...");

  try {
    // Validate repoPath
    if (!repoPath || repoPath === "${workspaceFolder}" || repoPath.trim() === "") {
      logger.warn("Invalid repository path provided, defaulting to current directory");
      repoPath = process.cwd();
    }

    await checkOllama();
    await checkOllamaModel(EMBEDDING_MODEL, true);
    let suggestionModelAvailable = false;
    try {
      await checkOllamaModel(SUGGESTION_MODEL, false);
      suggestionModelAvailable = true;
    } catch (error: any) {
      logger.warn(`Warning: Ollama model ${SUGGESTION_MODEL} is not available. Suggestion tools disabled: ${error.message}`);
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
    if (typeof server.tool !== "function") {
      throw new Error("MCP server does not support 'tool' method");
    }
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

      server.tool("get_repository_context", async (params: unknown) => {
        const { query } = GetRepositoryContextSchema.parse(params);
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
    } else {
      logger.warn("Skipping registration of suggestion tools due to unavailable suggestion model.");
    }

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

const repoPath = process.argv[2] || ".";
startServer(repoPath);