#!/usr/bin/env node

import { McpServer, McpServerTransport } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import axios from "axios";
import { QdrantClient } from "@qdrant/js-client-rest";
import git from "isomorphic-git";
import fs from "fs/promises";
import path from "path";
import { z } from "zod";

// Configuration
const OLLAMA_HOST = process.env.OLLAMA_HOST || "http://127.0.0.1:11434";
const QDRANT_HOST = process.env.QDRANT_HOST || "http://127.0.0.1:6333";
const COLLECTION_NAME = "codecompass";
const EMBEDDING_MODEL = "nomic-embed-text:v1.5";
const SUGGESTION_MODEL = "llama3.1:8b";

// Schema for validating tool inputs
const SearchCodeSchema = z.object({
  query: z.string().min(1, "Query is required"),
});

const GenerateSuggestionSchema = z.object({
  query: z.string().min(1, "Query is required"),
});

const GetRepositoryContextSchema = z.object({
  query: z.string().min(1, "Query is required"),
});

// Types
interface OllamaEmbeddingResponse {
  embedding: number[];
}

interface OllamaGenerateResponse {
  response: string;
}

interface QdrantPoint {
  id: string;
  vector: number[];
  payload: {
    filepath: string;
    content: string;
    last_modified: string;
  };
}

interface QdrantSearchResult {
  id: string;
  payload: {
    content: string;
    filepath: string;
    last_modified: string;
  };
  score: number;
}

// Check Ollama availability
async function checkOllama(): Promise<boolean> {
  console.error("Attempting to connect to Ollama at", OLLAMA_HOST);
  try {
    const response = await axios.get(OLLAMA_HOST, { timeout: 5000 });
    console.error("Ollama response:", response.status, response.data);
    console.log("Ollama is available");
    return true;
  } catch (error: any) {
    console.error("Ollama connection error:", {
      message: error.message,
      code: error.code,
      response: error.response
        ? {
            status: error.response.status,
            data: error.response.data,
          }
        : null,
    });
    throw new Error(
      `Ollama is not running at ${OLLAMA_HOST}. Please start it with: ollama serve`
    );
  }
}

// Initialize Qdrant client and collection
async function initializeQdrant(): Promise<QdrantClient> {
  const client = new QdrantClient({ url: QDRANT_HOST });
  try {
    await client.getCollections();
    console.log("Qdrant is available");
    // Create collection if it doesn't exist
    const collections = await client.getCollections();
    if (!collections.collections.some((c) => c.name === COLLECTION_NAME)) {
      await client.createCollection(COLLECTION_NAME, {
        vectors: { size: 768, distance: "Cosine" }, // nomic-embed-text:v1.5 produces 768-dim embeddings
      });
      console.log(`Created Qdrant collection: ${COLLECTION_NAME}`);
    }
    return client;
  } catch (error: any) {
    console.error("Qdrant initialization error:", error.message);
    throw new Error(`Failed to connect to Qdrant at ${QDRANT_HOST}`);
  }
}

// Generate embeddings using Ollama
async function generateEmbedding(text: string): Promise<number[]> {
  try {
    const response = await axios.post<OllamaEmbeddingResponse>(
      `${OLLAMA_HOST}/api/embeddings`,
      {
        model: EMBEDDING_MODEL,
        prompt: text,
      }
    );
    return response.data.embedding;
  } catch (error: any) {
    console.error("Ollama embedding error:", error.message);
    throw new Error("Failed to generate embedding");
  }
}

// Generate suggestions using Ollama
async function generateSuggestion(prompt: string): Promise<string> {
  try {
    const response = await axios.post<OllamaGenerateResponse>(
      `${OLLAMA_HOST}/api/generate`,
      {
        model: SUGGESTION_MODEL,
        prompt,
        stream: false,
      }
    );
    return response.data.response;
  } catch (error: any) {
    console.error("Ollama suggestion error:", error.message);
    throw new Error("Failed to generate suggestion");
  }
}

// Validate Git repository
async function validateGitRepository(repoPath: string): Promise<boolean> {
  try {
    const gitdir = path.join(repoPath, ".git");
    await fs.access(gitdir); // Check if .git directory exists
    await git.resolveRef({ fs, dir: repoPath, gitdir, ref: "HEAD" }); // Verify HEAD exists
    console.log("Valid Git repository found at:", repoPath);
    return true;
  } catch (error: any) {
    console.error("Git repository validation error:", error.message);
    throw new Error(
      `Invalid Git repository at ${repoPath}. Ensure it is initialized with at least one commit.`
    );
  }
}

// Index repository files in Qdrant
async function indexRepository(qdrantClient: QdrantClient, repoPath: string): Promise<void> {
  try {
    await validateGitRepository(repoPath);

    // Log Git status for debugging
    try {
      const status = await git.statusMatrix({
        fs,
        dir: repoPath,
        gitdir: path.join(repoPath, ".git"),
      });
      console.log("Git repository status:", status);
    } catch (error: any) {
      console.warn("Failed to retrieve Git status:", error.message);
    }

    // Try listing files with listFiles
    let files: string[] = [];
    try {
      files = await git.listFiles({
        fs,
        dir: repoPath,
        gitdir: path.join(repoPath, ".git"),
        ref: "HEAD",
      });
      console.log("Files from git.listFiles:", files);
    } catch (error: any) {
      console.warn("git.listFiles error:", error.message);
      // Fallback to git.walk
      try {
        const walkFiles = await git.walk({
          fs,
          dir: repoPath,
          gitdir: path.join(repoPath, ".git"),
          trees: [git.TREE({ ref: "HEAD" })],
          map: async (filepath: string, [entry]: any[]) => {
            if (!entry) return null;
            const type = await entry.type();
            if (type === "blob") return filepath;
            return null;
          },
        });
        files = Array.isArray(walkFiles) ? walkFiles.filter((f): f is string => !!f) : [];
        console.log("Files from git.walk:", files);
      } catch (walkError: any) {
        console.error("git.walk error:", walkError.message);
        throw new Error("Failed to list repository files");
      }
    }

    if (files.length === 0) {
      console.warn("No files found in repository to index. Ensure the repository has tracked files.");
      return;
    }

    for (const filepath of files) {
      try {
        const fullPath = path.join(repoPath, filepath);
        const content = await fs.readFile(fullPath, "utf8");
        const embedding = await generateEmbedding(content);
        await qdrantClient.upsert(COLLECTION_NAME, {
          points: [
            {
              id: filepath,
              vector: embedding,
              payload: {
                filepath,
                content,
                last_modified: (await fs.stat(fullPath)).mtime.toISOString(),
              },
            },
          ],
        });
        console.log(`Indexed: ${filepath}`);
      } catch (error: any) {
        console.error(`Failed to index ${filepath}:`, error.message);
      }
    }
  } catch (error: any) {
    console.error(`Failed to index repository: ${error.message}`);
    // Continue server startup
  }
}

// Get repository diff since last commit
async function getRepositoryDiff(repoPath: string): Promise<string> {
  try {
    const commits = await git.log({ fs, dir: repoPath, depth: 2 });
    if (commits.length < 2) return "No previous commits to compare";
    const [latest, previous] = commits;
    const diff = await git.diff({
      fs,
      dir: repoPath,
      gitdir: path.join(repoPath, ".git"),
      oid1: previous.oid,
      oid2: latest.oid,
    });
    return diff || "No changes since last commit";
  } catch (error: any) {
    console.error("Diff error:", error.message);
    return "Failed to retrieve diff";
  }
}

// Summarize code snippet using Ollama
async function summarizeSnippet(snippet: string): Promise<string> {
  const prompt = `Summarize the following code snippet in 50 words or less:\n\n${snippet}`;
  return await generateSuggestion(prompt);
}

// Main server setup
async function startServer(repoPath: string): Promise<void> {
  console.error("Starting CodeCompass MCP server...");

  try {
    // Check dependencies
    await checkOllama();
    const qdrantClient = await initializeQdrant();

    // Index repository
    console.log("Indexing repository:", repoPath);
    await indexRepository(qdrantClient, repoPath);

    // Initialize MCP server
    const server = new McpServer();
    const transport: McpServerTransport = new StdioServerTransport();
    await server.connect(transport);

    // Register resources
    server.registerResource("repo://structure", async () => {
      try {
        await validateGitRepository(repoPath);
        const files = await git.listFiles({
          fs,
          dir: repoPath,
          gitdir: path.join(repoPath, ".git"),
          ref: "HEAD",
        });
        return { content: [{ text: files.join("\n") }] };
      } catch (error: any) {
        return { content: [{ text: `Error retrieving repository structure: ${error.message}` }] };
      }
    });

    server.registerResource("repo://files/*", async (params: { path: string }) => {
      const filepath = params.path.replace(/^repo:\/\/files\//, "");
      try {
        const content = await fs.readFile(path.join(repoPath, filepath), "utf8");
        return { content: [{ text: content }] };
      } catch (error: any) {
        return { content: [{ text: `Error reading file ${filepath}: ${error.message}` }] };
      }
    });

    // Register tools
    server.registerTool("search_code", async (params: unknown) => {
      const { query } = SearchCodeSchema.parse(params);
      const embedding = await generateEmbedding(query);
      const results = await qdrantClient.search(COLLECTION_NAME, {
        vector: embedding,
        limit: 5,
      });
      const summaries = await Promise.all(
        results.map(async (result: QdrantSearchResult) => ({
          filepath: result.id,
          snippet: result.payload.content.slice(0, 200),
          summary: await summarizeSnippet(result.payload.content.slice(0, 200)),
        }))
      );
      return {
        content: summaries.map((s) => ({
          text: `File: ${s.filepath}\nSnippet: ${s.snippet}\nSummary: ${s.summary}`,
        })),
      };
    });

    server.registerTool("generate_suggestion", async (params: unknown) => {
      const { query } = GenerateSuggestionSchema.parse(params);
      const suggestion = await generateSuggestion(query);
      return { content: [{ text: suggestion }] };
    });

    server.registerTool("get_repository_context", async (params: unknown) => {
      const { query } = GetRepositoryContextSchema.parse(params);
      const embedding = await generateEmbedding(query);
      const searchResults = await qdrantClient.search(COLLECTION_NAME, {
        vector: embedding,
        limit: 3,
      });
      const diff = await getRepositoryDiff(repoPath);
      const context = searchResults.map((r: QdrantSearchResult) => ({
        filepath: r.id,
        snippet: r.payload.content.slice(0, 200),
        last_modified: r.payload.last_modified,
      }));
      const summary = await generateSuggestion(
        `Provide a brief context for the query "${query}" based on the following files and diff:\nFiles: ${JSON.stringify(
          context,
          null,
          2
        )}\nDiff: ${diff}`
      );
      return {
        content: [
          {
            text: `Context for "${query}":\n${summary}\n\nRelevant Files:\n${context
              .map(
                (c) =>
                  `${c.filepath} (Last modified: ${c.last_modified})\n${c.snippet}`
              )
              .join("\n\n")}\n\nRecent Changes:\n${diff}`,
          },
        ],
      };
    });

    console.log("CodeCompass MCP server running for repository:", repoPath);
    // Keep the process alive
    await new Promise(() => {});
  } catch (error: any) {
    console.error("Failed to start CodeCompass:", error.message);
    process.exit(1);
  }
}

// Run the server
const repoPath = process.argv[2] || ".";
startServer(repoPath);