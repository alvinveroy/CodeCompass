import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import fs from "fs/promises";
import path from "path";
import git from "isomorphic-git";
import { QdrantClient } from "@qdrant/js-client-rest";
import { logger, COLLECTION_NAME, MAX_SNIPPET_LENGTH } from "./config";
import { SearchCodeSchema, GenerateSuggestionSchema, GetRepositoryContextSchema, QdrantSearchResult, FeedbackSchema } from "./types";
import { checkOllama, checkOllamaModel, generateEmbedding, generateSuggestion, summarizeSnippet, processFeedback } from "./ollama";
import { initializeQdrant, searchWithRefinement } from "./qdrant";
import { validateGitRepository, indexRepository, getRepositoryDiff } from "./repository";
import { getMetrics, resetMetrics, startMetricsLogging, trackToolChain } from "./metrics";
import { VERSION } from "./version";
import { getOrCreateSession, addQuery, addSuggestion, addFeedback, updateContext, getRecentQueries, getRelevantResults } from "./state";

// Normalize tool parameters to handle various input formats
export function normalizeToolParams(params: unknown): Record<string, any> {
  try {
    // Handle stringified JSON input
    if (typeof params === "string") {
      try {
        return JSON.parse(params);
      } catch {
        // If it's not valid JSON, treat it as a query string
        return { query: params };
      }
    } 
    
    // Handle object input
    if (typeof params === 'object' && params !== null) {
      if ('query' in params || 'prompt' in params || 'sessionId' in params) {
        return params as Record<string, any>;
      } else {
        // If no query property exists but we have an object, use the entire object as the query
        return { query: JSON.stringify(params) };
      }
    }
    
    // Handle primitive values
    return { query: String(params) };
  } catch (error: any) {
    logger.error("Failed to normalize parameters", { message: error.message });
    throw new Error("Invalid input format: parameters must be a valid JSON object or string");
  }
}

// Generate a chain ID for tracking tool chains
function generateChainId(): string {
  return `chain_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;
}

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
      version: VERSION,
      vendor: "CodeCompass",
      capabilities: {
        resources: {
          "repo://structure": {},
          "repo://files/*": {},
          "repo://health": {},
          "repo://metrics": {},
          "repo://version": {},
        },
        tools: {
          search_code: {},
          ...(suggestionModelAvailable ? { generate_suggestion: {}, get_repository_context: {} } : {}),
          get_changelog: {},
        },
      },
    });

    // Register resources
    if (typeof server.resource !== "function") {
      throw new Error("MCP server does not support 'resource' method");
    }
    
    // Add health check resource
    server.resource("repo://health", "repo://health", {}, async () => {
      const status = {
        ollama: await checkOllama().then(() => "healthy").catch(() => "unhealthy"),
        qdrant: await qdrantClient.getCollections().then(() => "healthy").catch(() => "unhealthy"),
        repository: await validateGitRepository(repoPath) ? "healthy" : "unhealthy",
        version: VERSION,
        timestamp: new Date().toISOString()
      };
      return { contents: [{ uri: "repo://health", text: JSON.stringify(status, null, 2) }] };
    });
    
    // Add metrics resource
    server.resource("repo://metrics", "repo://metrics", {}, async () => {
      const metrics = getMetrics();
      return { contents: [{ uri: "repo://metrics", text: JSON.stringify(metrics, null, 2) }] };
    });
    
    // Add version resource
    server.resource("repo://version", "repo://version", {}, async () => {
      return { contents: [{ uri: "repo://version", text: VERSION }] };
    });
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

    // Start metrics logging
    const metricsInterval = startMetricsLogging(300000); // Log metrics every 5 minutes
    
    // Connect to transport after registering all capabilities
    const transport = new StdioServerTransport();
    await server.connect(transport);

    logger.info(`CodeCompass MCP server running for repository: ${repoPath}`);
    
    // Ensure metrics interval is cleared on shutdown
    process.on('SIGINT', () => {
      clearInterval(metricsInterval);
      logger.info("Server shutting down, metrics logging stopped");
      process.exit(0);
    });
    
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
  
  // Search Code Tool with iterative refinement
  server.tool("search_code", async (params: unknown) => {
    const chainId = generateChainId();
    trackToolChain(chainId, "search_code");
    
    logger.info("Received params for search_code", { params });
    const normalizedParams = normalizeToolParams(params);
    const { query, sessionId } = SearchCodeSchema.parse(normalizedParams);
    
    // Get or create session
    const session = getOrCreateSession(sessionId, repoPath);
    
    // Log the extracted query to confirm it's working
    logger.info("Extracted query for search_code", { query, sessionId: session.id });
    
    const isGitRepo = await validateGitRepository(repoPath);
    const files = isGitRepo
      ? await git.listFiles({ fs, dir: repoPath, gitdir: path.join(repoPath, ".git"), ref: "HEAD" })
      : [];
    
    // Update context in session
    updateContext(session.id, repoPath, files);
    
    // Use iterative query refinement
    const { results, refinedQuery, relevanceScore } = await searchWithRefinement(
      qdrantClient, 
      query, 
      files
    );
    
    // Add query to session
    addQuery(session.id, query, results, relevanceScore);
    
    // Generate summaries for the results
    const summaries = await Promise.all(results.map(async result => ({
      filepath: (result.payload as QdrantSearchResult['payload']).filepath,
      snippet: (result.payload as QdrantSearchResult['payload']).content.slice(0, MAX_SNIPPET_LENGTH),
      summary: suggestionModelAvailable
        ? await summarizeSnippet((result.payload as QdrantSearchResult['payload']).content.slice(0, MAX_SNIPPET_LENGTH))
        : "Summary unavailable (suggestion model not loaded)",
      last_modified: (result.payload as QdrantSearchResult['payload']).last_modified,
      relevance: result.score,
    })));
    
    // Format the response as clean markdown
    const formattedResponse = `# Search Results for: "${query}"
${refinedQuery !== query ? `\n> Query refined to: "${refinedQuery}"` : ''}

${summaries.map(s => `
## ${s.filepath}
- Last Modified: ${s.last_modified}
- Relevance: ${s.relevance.toFixed(2)}

### Code Snippet
\`\`\`
${s.snippet}
\`\`\`

### Summary
${s.summary}
`).join('\n')}

Session ID: ${session.id} (Use this ID in future requests to maintain context)`;
    
    return {
      content: [{
        type: "text",
        text: formattedResponse,
      }],
    };
  });

  // Add get_changelog tool
  server.tool("get_changelog", async () => {
    try {
      const changelogPath = path.join(projectRoot, 'CHANGELOG.md');
      const changelog = await fs.readFile(changelogPath, 'utf8');
      
      return {
        content: [{
          type: "text",
          text: `# CodeCompass Changelog (v${VERSION})\n\n${changelog}`,
        }],
      };
    } catch (error) {
      logger.error("Failed to read changelog", { error });
      return {
        content: [{
          type: "text",
          text: `# Error Reading Changelog\n\nFailed to read the changelog file. Current version is ${VERSION}.`,
        }],
      };
    }
  });
  
  // Add reset_metrics tool
  server.tool("reset_metrics", async () => {
    resetMetrics();
    return {
      content: [{
        type: "text",
        text: "# Metrics Reset\n\nAll metrics have been reset successfully.",
      }],
    };
  });
  
  // Add get_session_history tool
  server.tool("get_session_history", async (params: unknown) => {
    const normalizedParams = normalizeToolParams(params);
    const { sessionId } = normalizedParams;
    
    if (!sessionId) {
      throw new Error("Session ID is required");
    }
    
    try {
      const session = getOrCreateSession(sessionId);
      
      return {
        content: [{
          type: "text",
          text: `# Session History (${session.id})

## Session Info
- Created: ${new Date(session.createdAt).toISOString()}
- Last Updated: ${new Date(session.lastUpdated).toISOString()}
- Repository: ${session.context.repoPath}

## Queries (${session.queries.length})
${session.queries.map((q, i) => `
### Query ${i+1}: "${q.query}"
- Timestamp: ${new Date(q.timestamp).toISOString()}
- Results: ${q.results.length}
- Relevance Score: ${q.relevanceScore.toFixed(2)}
`).join('')}

## Suggestions (${session.suggestions.length})
${session.suggestions.map((s, i) => `
### Suggestion ${i+1}
- Timestamp: ${new Date(s.timestamp).toISOString()}
- Prompt: "${s.prompt.substring(0, 100)}..."
${s.feedback ? `- Feedback Score: ${s.feedback.score}/10
- Feedback Comments: ${s.feedback.comments}` : '- No feedback provided'}
`).join('')}`,
        }],
      };
    } catch (error: any) {
      return {
        content: [{
          type: "text",
          text: `# Error\n\n${error.message}`,
        }],
      };
    }
  });
    
  if (suggestionModelAvailable) {
    // Generate Suggestion Tool with multi-step reasoning
    server.tool("generate_suggestion", async (params: unknown) => {
      const chainId = generateChainId();
      trackToolChain(chainId, "generate_suggestion");
      
      logger.info("Received params for generate_suggestion", { params });
      const normalizedParams = normalizeToolParams(params);
      const { query, sessionId } = GenerateSuggestionSchema.parse(normalizedParams);
      
      // Get or create session
      const session = getOrCreateSession(sessionId, repoPath);
      
      // Log the extracted query to confirm it's working
      logger.info("Extracted query for generate_suggestion", { query, sessionId: session.id });
      
      // First, use search_code internally to get relevant context
      trackToolChain(chainId, "search_code");
      
      const isGitRepo = await validateGitRepository(repoPath);
      const files = isGitRepo
        ? await git.listFiles({ fs, dir: repoPath, gitdir: path.join(repoPath, ".git"), ref: "HEAD" })
        : [];
      const diff = await getRepositoryDiff(repoPath);
      
      // Update context in session
      updateContext(session.id, repoPath, files, diff);
      
      // Get recent queries from session to provide context
      const recentQueries = getRecentQueries(session.id);
      const relevantResults = getRelevantResults(session.id);
      
      // Use iterative query refinement for better search results
      const { results, refinedQuery } = await searchWithRefinement(
        qdrantClient, 
        query, 
        files
      );
      
      // Map search results to context
      const context = results.map(r => ({
        filepath: (r.payload as QdrantSearchResult['payload']).filepath,
        snippet: (r.payload as QdrantSearchResult['payload']).content.slice(0, MAX_SNIPPET_LENGTH),
        last_modified: (r.payload as QdrantSearchResult['payload']).last_modified,
        relevance: r.score,
      }));
      
      // Include previous relevant results if current results are limited
      if (context.length < 2 && relevantResults.length > 0) {
        const additionalContext = relevantResults
          .filter(r => !context.some(c => c.filepath === r.payload?.filepath))
          .slice(0, 2)
          .map(r => ({
            filepath: r.payload?.filepath || "unknown",
            snippet: r.payload?.content?.slice(0, MAX_SNIPPET_LENGTH) || "",
            last_modified: r.payload?.last_modified || "unknown",
            relevance: r.score || 0.5,
            note: "From previous related query"
          }));
        
        context.push(...additionalContext);
      }

      const prompt = `
**Context**:
Repository: ${repoPath}
Files: ${files.join(", ")}
Recent Changes: ${diff}
${recentQueries.length > 0 ? `Recent Queries: ${recentQueries.join(", ")}` : ''}

**Relevant Snippets**:
${context.map(c => `File: ${c.filepath} (Last modified: ${c.last_modified}, Relevance: ${c.relevance.toFixed(2)}${c.note ? `, Note: ${c.note}` : ''})\n${c.snippet}`).join("\n\n")}

**Instruction**:
Based on the provided context and snippets, generate a detailed code suggestion for "${query}". Include:
- A suggested code implementation or improvement.
- An explanation of how it addresses the query.
- References to the provided snippets or context where applicable.
Ensure the suggestion is concise, practical, and leverages the repository's existing code structure. If the query is ambiguous, provide a general solution with assumptions clearly stated.
      `;
      
      // Generate suggestion with multi-step reasoning
      const suggestion = await generateSuggestion(prompt);
      
      // Add suggestion to session
      addSuggestion(session.id, query, suggestion);
      
      // Format the response as clean markdown
      const formattedResponse = `# Code Suggestion for: "${query}"
${refinedQuery !== query ? `\n> Query refined to: "${refinedQuery}"` : ''}

## Suggestion
${suggestion}

## Context Used
${context.map(c => `
### ${c.filepath}
- Last modified: ${c.last_modified}
- Relevance: ${c.relevance.toFixed(2)}
${c.note ? `- Note: ${c.note}` : ''}

\`\`\`
${c.snippet}
\`\`\`
`).join('\n')}

## Recent Changes
\`\`\`
${diff}
\`\`\`

Session ID: ${session.id} (Use this ID in future requests to maintain context)
Feedback ID: ${chainId} (Use this ID to provide feedback on this suggestion)`;
      
      return {
        content: [{
          type: "text",
          text: formattedResponse,
        }],
      };
    });
    
    // Add a new feedback tool
    server.tool("provide_feedback", async (params: unknown) => {
      logger.info("Received params for provide_feedback", { params });
      const normalizedParams = normalizeToolParams(params);
      const { sessionId, feedbackId, score, comments, originalQuery, suggestion } = FeedbackSchema.parse(normalizedParams);
      
      // Get session
      const session = getOrCreateSession(sessionId);
      
      // Add feedback to session
      addFeedback(session.id, score, comments);
      
      // Process feedback to improve the suggestion
      const improvedSuggestion = await processFeedback(
        originalQuery,
        suggestion,
        comments,
        score
      );
      
      // Format the response
      const formattedResponse = `# Improved Suggestion Based on Your Feedback

Thank you for your feedback (score: ${score}/10).

## Original Query
${originalQuery}

## Your Feedback
${comments}

## Improved Suggestion
${improvedSuggestion}

Session ID: ${session.id}`;
      
      return {
        content: [{
          type: "text",
          text: formattedResponse,
        }],
      };
    });

    // Get Repository Context Tool with state management
    server.tool("get_repository_context", async (params: unknown) => {
      const chainId = generateChainId();
      trackToolChain(chainId, "get_repository_context");
      
      logger.info("Received params for get_repository_context", { params });
      const normalizedParams = normalizeToolParams(params);
      const { query, sessionId } = GetRepositoryContextSchema.parse(normalizedParams);
      
      // Get or create session
      const session = getOrCreateSession(sessionId, repoPath);
      
      // Log the extracted query to confirm it's working
      logger.info("Extracted query for repository context", { query, sessionId: session.id });
      
      const isGitRepo = await validateGitRepository(repoPath);
      const files = isGitRepo
        ? await git.listFiles({ fs, dir: repoPath, gitdir: path.join(repoPath, ".git"), ref: "HEAD" })
        : [];
      const diff = await getRepositoryDiff(repoPath);
      
      // Update context in session
      updateContext(session.id, repoPath, files, diff);
      
      // Use iterative query refinement
      const { results, refinedQuery } = await searchWithRefinement(
        qdrantClient, 
        query, 
        files
      );
      
      // Get recent queries from session to provide context
      const recentQueries = getRecentQueries(session.id);
      
      const context = results.map(r => ({
        filepath: (r.payload as QdrantSearchResult['payload']).filepath,
        snippet: (r.payload as QdrantSearchResult['payload']).content.slice(0, MAX_SNIPPET_LENGTH),
        last_modified: (r.payload as QdrantSearchResult['payload']).last_modified,
        relevance: r.score,
      }));
      
      const summaryPrompt = `
**Context**:
Repository: ${repoPath}
Files: ${files.join(", ")}
Recent Changes: ${diff}
${recentQueries.length > 0 ? `Recent Queries: ${recentQueries.join(", ")}` : ''}

**Relevant Snippets**:
${context.map(c => `File: ${c.filepath} (Last modified: ${c.last_modified}, Relevance: ${c.relevance.toFixed(2)})\n${c.snippet}`).join("\n\n")}

**Instruction**:
Provide a concise summary of the context for "${query}" based on the repository files and recent changes. Highlight key information relevant to the query, referencing specific files or snippets where applicable.
      `;
      
      // Generate summary with multi-step reasoning
      const summary = await generateSuggestion(summaryPrompt);
      
      // Add query to session
      addQuery(session.id, query, results);
      
      // Format the response as clean markdown
      const formattedResponse = `# Repository Context Summary for: "${query}"
${refinedQuery !== query ? `\n> Query refined to: "${refinedQuery}"` : ''}

## Summary
${summary}

## Relevant Files
${context.map(c => `
### ${c.filepath}
- Last modified: ${c.last_modified}
- Relevance: ${c.relevance.toFixed(2)}

\`\`\`
${c.snippet}
\`\`\`
`).join('\n')}

## Recent Changes
\`\`\`
${diff}
\`\`\`

Session ID: ${session.id} (Use this ID in future requests to maintain context)`;
      
      return {
        content: [{
          type: "text",
          text: formattedResponse,
        }],
      };
    });
    
    // Add a new tool for multi-step reasoning
    server.tool("analyze_code_problem", async (params: unknown) => {
      const chainId = generateChainId();
      trackToolChain(chainId, "analyze_code_problem");
      
      logger.info("Received params for analyze_code_problem", { params });
      const normalizedParams = normalizeToolParams(params);
      const { query, sessionId } = normalizedParams;
      
      if (!query) {
        throw new Error("Query parameter is required");
      }
      
      // Get or create session
      const session = getOrCreateSession(sessionId, repoPath);
      
      // Step 1: Get repository context
      trackToolChain(chainId, "get_repository_context");
      logger.info("Step 1: Getting repository context");
      
      const isGitRepo = await validateGitRepository(repoPath);
      const files = isGitRepo
        ? await git.listFiles({ fs, dir: repoPath, gitdir: path.join(repoPath, ".git"), ref: "HEAD" })
        : [];
      const diff = await getRepositoryDiff(repoPath);
      
      // Use iterative query refinement to find relevant code
      const { results: contextResults } = await searchWithRefinement(
        qdrantClient, 
        query, 
        files
      );
      
      const context = contextResults.map(r => ({
        filepath: (r.payload as QdrantSearchResult['payload']).filepath,
        snippet: (r.payload as QdrantSearchResult['payload']).content.slice(0, MAX_SNIPPET_LENGTH),
        last_modified: (r.payload as QdrantSearchResult['payload']).last_modified,
        relevance: r.score,
      }));
      
      // Step 2: Analyze the problem
      trackToolChain(chainId, "analyze_problem");
      logger.info("Step 2: Analyzing the problem");
      
      const analysisPrompt = `
**Code Problem Analysis**

Problem: ${query}

**Relevant Code**:
${context.map(c => `File: ${c.filepath}\n\`\`\`\n${c.snippet}\n\`\`\``).join("\n\n")}

**Instructions**:
1. Analyze the problem described above.
2. Identify potential causes based on the code snippets.
3. List possible solutions.
4. Recommend the best approach.

Structure your analysis with these sections:
- Problem Understanding
- Root Cause Analysis
- Potential Solutions
- Recommended Approach
      `;
      
      const analysis = await generateSuggestion(analysisPrompt);
      
      // Step 3: Generate implementation plan
      trackToolChain(chainId, "generate_implementation_plan");
      logger.info("Step 3: Generating implementation plan");
      
      const planPrompt = `
Based on your analysis of the problem:

${analysis}

Generate a step-by-step implementation plan to solve this problem. Include:
1. Files that need to be modified
2. Specific changes to make
3. Any new code that needs to be written
4. Testing approach to verify the solution works
      `;
      
      const implementationPlan = await generateSuggestion(planPrompt);
      
      // Add to session
      addQuery(session.id, query, contextResults);
      addSuggestion(session.id, analysisPrompt, analysis);
      addSuggestion(session.id, planPrompt, implementationPlan);
      
      // Format the response
      const formattedResponse = `# Code Problem Analysis: "${query}"

## Problem Analysis
${analysis}

## Implementation Plan
${implementationPlan}

## Relevant Code
${context.map(c => `
### ${c.filepath}
- Last modified: ${c.last_modified}
- Relevance: ${c.relevance.toFixed(2)}

\`\`\`
${c.snippet}
\`\`\`
`).join('\n')}

Session ID: ${session.id} (Use this ID in future requests to maintain context)`;
      
      return {
        content: [{
          type: "text",
          text: formattedResponse,
        }],
      };
    });
  }
}
