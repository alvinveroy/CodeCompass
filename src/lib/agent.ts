import { logger, configService } from "./config-service";
import { getLLMProvider } from "./llm-provider";
import { getOrCreateSession, addQuery, addSuggestion, updateContext, getRecentQueries, getRelevantResults } from "./state";
import { QdrantClient } from "@qdrant/js-client-rest";
import { searchWithRefinement } from "./query-refinement"; // Changed import path
import { validateGitRepository, getRepositoryDiff } from "./repository";
import { AgentState, AgentStep, ParsedToolCall } from "./types"; // Added ParsedToolCall
import git from "isomorphic-git";
import fs from "fs/promises";
import path from "path";

// Helper function for robust stringification of unknown step output
function stringifyStepOutput(output: unknown): string {
  if (typeof output === 'string') {
    return output;
  }
  if (output === null || output === undefined) {
    return String(output); // Handles null and undefined correctly
  }
  // Explicitly handle arrays and objects for JSON.stringify
  if (Array.isArray(output) || (typeof output === 'object' && output !== null)) {
    try {
      return JSON.stringify(output, null, 2);
    } catch {
      // Fallback for non-serializable objects or objects with circular refs
      return '[Unserializable Object]';
    }
  }
  // For other primitives (number, boolean, symbol, bigint), String() is safe.
  // This addresses the new error at line 27 if 'output' was an unhandled object type.
  // eslint-disable-next-line @typescript-eslint/no-base-to-string
  return String(output);
}

// Tool registry for agent to understand available tools
export interface Tool {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  requiresModel: boolean;
}

// Tool registry with descriptions for the agent
export const toolRegistry: Tool[] = [
  {
    name: "search_code",
    description: "Search for code in the repository based on a query. Returns relevant code snippets with file paths and summaries.",
    parameters: {
      query: "string - The search query to find relevant code",
      sessionId: "string (optional) - Session ID to maintain context across requests"
    },
    requiresModel: false
  },
  {
    name: "get_repository_context",
    description: "Get comprehensive context about the repository based on a query. Returns relevant files, code snippets, and recent changes.",
    parameters: {
      query: "string - The query to find relevant repository context",
      sessionId: "string (optional) - Session ID to maintain context across requests"
    },
    requiresModel: false
  },
  {
    name: "generate_suggestion",
    description: "Generate a code suggestion based on a query and repository context. Returns a detailed code suggestion with explanation.",
    parameters: {
      query: "string - The query describing what suggestion is needed",
      sessionId: "string (optional) - Session ID to maintain context across requests"
    },
    requiresModel: true
  },
  {
    name: "get_changelog",
    description: "Get the project's changelog to understand recent updates and changes.",
    parameters: {},
    requiresModel: false
  },
  {
    name: "analyze_code_problem",
    description: "Analyze a code problem in depth, providing root cause analysis and implementation plan.",
    parameters: {
      query: "string - Description of the code problem to analyze",
      sessionId: "string (optional) - Session ID to maintain context across requests"
    },
    requiresModel: true
  },
  {
    name: "request_additional_context",
    description: "Request additional or different types of context when current information is insufficient. Use this to get more search results, full file content, or list files in a directory.",
    parameters: {
      context_type: "string - Type of context needed. Enum: ['MORE_SEARCH_RESULTS', 'FULL_FILE_CONTENT', 'DIRECTORY_LISTING', 'ADJACENT_FILE_CHUNKS']", // Added ADJACENT_FILE_CHUNKS
      query_or_path: "string - The original search query (for MORE_SEARCH_RESULTS), the full file path (for FULL_FILE_CONTENT or ADJACENT_FILE_CHUNKS), or the directory path (for DIRECTORY_LISTING)",
      // Add chunk_index as a new parameter description
      chunk_index: "integer (optional) - The 0-indexed number of the current chunk, required if context_type is ADJACENT_FILE_CHUNKS.",
      reasoning: "string (optional) - Brief explanation of why this additional context is needed and how it will help answer the user's query.",
      sessionId: "string (optional) - Session ID to maintain context across requests"
    },
    requiresModel: false // The tool itself doesn't require an LLM, though its sub-operations might (e.g., summarization)
  },
  {
    name: "request_more_processing_steps",
    description: "Requests additional processing steps if the current task requires more iterations than initially allocated. Use this if you are making progress but need more turns to complete the objective. This does not guarantee more steps, but signals intent.",
    parameters: {
      reasoning: "string - A brief explanation of why more processing steps are needed."
    },
    requiresModel: false // This tool itself doesn't call an LLM directly
  }
];

// Helper function to get processed diff (summarized or truncated if necessary)
// Exported for spying
export async function getProcessedDiff(
  repoPath: string,
  suggestionModelAvailable: boolean
): Promise<string> {
  const diffContent = await getRepositoryDiff(repoPath);

  // Check if diffContent is one of the "no useful diff" messages
  const noUsefulDiffMessages = [
    "No Git repository found",
    "No changes found in the last two commits.",
    "Not enough commits to compare.", // Add any other similar messages from getRepositoryDiff
  ];
  const isEffectivelyEmptyDiff = !diffContent || noUsefulDiffMessages.includes(diffContent);

  if (!isEffectivelyEmptyDiff) {
    const MAX_DIFF_LENGTH = configService.MAX_DIFF_LENGTH_FOR_CONTEXT_TOOL;

    if (diffContent.length > MAX_DIFF_LENGTH) {
      if (suggestionModelAvailable) {
        try {
          const llmProvider = await getLLMProvider();
          const summaryPrompt = `Summarize the following git diff concisely, focusing on the most significant changes, additions, and deletions (e.g., 3-5 key bullet points or a short paragraph). The project is "${path.basename(repoPath)}".\n\nGit Diff:\n${diffContent}`;
          const summarizedDiff = await llmProvider.generateText(summaryPrompt);
          logger.info(`Summarized large diff content for repository: ${repoPath}`);
          return summarizedDiff; // Return the summary
        } catch (summaryError) {
          const sErr = summaryError instanceof Error ? summaryError : new Error(String(summaryError));
          logger.warn(`Failed to summarize diff for ${repoPath}. Using truncated diff. Error: ${sErr.message}`);
          return `Diff is large. Summary attempt failed. Truncated diff:\n${diffContent.substring(0, MAX_DIFF_LENGTH)}...`;
        }
      } else {
        logger.warn(`Suggestion model not available to summarize large diff for ${repoPath}. Using truncated diff.`);
        return `Diff is large. Full content omitted as suggestion model is offline. Truncated diff:\n${diffContent.substring(0, MAX_DIFF_LENGTH)}...`;
      }
    }
    // If diff is not too long, return it as is
    return diffContent;
  } else if (!diffContent) {
    return "No diff information available.";
  }
  // If it's one of the noUsefulDiffMessages, return it as is
  return diffContent;
}

// Helper function to process (summarize if needed) a single snippet
// Exported for spying
export async function processSnippet(
  snippet: string,
  query: string, // The user's query for context-aware summarization
  filepath: string, // Filepath for context
  suggestionModelAvailable: boolean
): Promise<string> {
  const MAX_LENGTH = configService.MAX_SNIPPET_LENGTH_FOR_CONTEXT_NO_SUMMARY;

  if (snippet.length > MAX_LENGTH) {
    if (suggestionModelAvailable) {
      try {
        const llmProvider = await getLLMProvider();
        const summaryPrompt = `The user's query is: "${query}". Concisely summarize the following code snippet from file "${filepath}", focusing on its relevance to the query. Aim for 2-4 key points or a short paragraph. Retain important identifiers or logic if possible. Snippet:\n\n\`\`\`\n${snippet}\n\`\`\``;
        const summarizedSnippet = await llmProvider.generateText(summaryPrompt);
        logger.info(`Summarized long snippet from ${filepath} for query "${query}". Original length: ${snippet.length}, Summary length: ${summarizedSnippet.length}`);
        return summarizedSnippet;
      } catch (summaryError) {
        const sErr = summaryError instanceof Error ? summaryError : new Error(String(summaryError));
        logger.warn(`Failed to summarize snippet from ${filepath} for query "${query}". Using truncated snippet. Error: ${sErr.message}`);
        return `${snippet.substring(0, MAX_LENGTH)}... (summary failed, snippet truncated)`;
      }
    } else {
      logger.warn(`Suggestion model not available to summarize long snippet from ${filepath}. Using truncated snippet.`);
      return `${snippet.substring(0, MAX_LENGTH)}... (snippet truncated, summary unavailable)`;
    }
  }
  return snippet; // Return original snippet if not too long
}

// Create a new agent state
export function createAgentState(sessionId: string, query: string): AgentState {
  return {
    sessionId: sessionId,
    query: query,
    steps: [],
    context: [],
    isComplete: false
  };
}

// Generate the agent system prompt
// Exported for testing
export function generateAgentSystemPrompt(availableTools: Tool[]): string {
  return `You are CodeCompass Agent, an AI assistant that helps developers understand and work with codebases.
You will be provided with context from the repository, which may include search results, file content, and summaries of recent changes (diffs).
If a diff is very large, a summary will be given. Use all provided information to inform your responses and plans.

You have access to the following tools:

${availableTools.map(tool => `
Tool: ${tool.name}
Description: ${tool.description}
Parameters: ${JSON.stringify(tool.parameters, null, 2)}
`).join('\n')}

When responding to user queries, follow these steps:
1. Analyze the user's query to understand their intent
2. Decide which tool(s) would be most helpful to answer the query
3. For each tool you decide to use:
   - Explain your reasoning for choosing this tool
   - Specify the exact parameters to use
   - Format your tool call as: TOOL_CALL: {"tool": "tool_name", "parameters": {...}}
4. After receiving tool results, analyze them and decide if you need additional information
5. If you need more information, repeat steps 2-4
6. Once you have all necessary information, provide a comprehensive response to the user

Important guidelines:
- Break down complex queries into multiple tool calls
- Accumulate context across steps
- Be concise in your reasoning
- Only use tools that are relevant to the query
- Format tool calls exactly as specified above
- If you are making good progress on a complex task but require more turns to fully address the user's query, 
  you can use the 'request_more_processing_steps' tool. Provide a brief 'reasoning'. 
  This may allow you additional interactions, up to a system-defined absolute maximum. Use this judiciously.

CRITICAL CONTEXT ASSESSMENT:
1. Before formulating a response or deciding on next steps, meticulously review all provided context (search results, code snippets, repository information, diffs).
2. Assess if this context is sufficient and relevant to fully address the user's query. Consider the query's specificity, breadth, and implied goals.
3. Identify any gaps or areas where the context might be lacking.

HANDLING INSUFFICIENT CONTEXT:
- If initial search results for a broad or complex query are sparse, of low relevance, or clearly incomplete:
    - Consider re-using the 'search_code' or 'get_repository_context' tools with a refined, broadened, or more targeted query. Explain your reasoning for the new query.
- If you believe specific information is missing that could be obtained (e.g., full file content, details about a specific module, wider search results):
    - Use the 'request_additional_context' tool. Specify the 'context_type' (e.g., 'MORE_SEARCH_RESULTS', 'FULL_FILE_CONTENT', 'DIRECTORY_LISTING', 'ADJACENT_FILE_CHUNKS'), 
      provide the relevant 'query_or_path' (which is the filepath for 'FULL_FILE_CONTENT' and 'ADJACENT_FILE_CHUNKS'), 
      and for 'ADJACENT_FILE_CHUNKS' also provide 'chunk_index' (integer, the 0-indexed number of the chunk you currently have).
      Explain your 'reasoning'.
    - Example: If you need the full content of 'src/utils/auth.ts', use TOOL_CALL: {"tool": "request_additional_context", "parameters": {"context_type": "FULL_FILE_CONTENT", "query_or_path": "src/utils/auth.ts", "reasoning": "Need to see the full implementation of authentication helpers."}}
    - Example for ADJACENT_FILE_CHUNKS: If you have chunk 2 of 'src/utils/parser.ts' and need surrounding context:
      TOOL_CALL: {"tool": "request_additional_context", "parameters": {"context_type": "ADJACENT_FILE_CHUNKS", "query_or_path": "src/utils/parser.ts", "chunk_index": 2, "reasoning": "The current chunk seems incomplete, need to see adjacent code."}}
    - If after using available tools (including 'request_additional_context') you still lack sufficient information, clearly state in your response that the answer is based on limited information and specify what was lacking.
- Do not hallucinate or provide speculative answers beyond the available context. If you cannot answer confidently, explain what's missing.

## Example 1: Simple Code Search

User query: "Find all files that handle authentication"

I'll use the search_code tool to find relevant code related to authentication.

TOOL_CALL: {"tool": "search_code", "parameters": {"query": "authentication login user session"}}

## Example 2: Understanding Repository Structure

User query: "Give me an overview of this repository"

I'll use get_repository_context to understand the overall structure and purpose of the repository.

TOOL_CALL: {"tool": "get_repository_context", "parameters": {"query": "repository structure overview main components"}}

## Example 3: Multi-step Query

User query: "How does error handling work in the API routes?"

First, I'll search for API routes to understand their structure.

TOOL_CALL: {"tool": "search_code", "parameters": {"query": "API routes endpoints"}}

Now that I understand the API structure, I'll specifically look for error handling patterns.

TOOL_CALL: {"tool": "search_code", "parameters": {"query": "error handling try catch API routes"}}

Based on both searches, I can provide a comprehensive explanation of error handling in the API routes.
`;
}

// Parse tool calls from LLM output
export function parseToolCalls(output: string): ParsedToolCall[] {
  // Log the output for debugging
  logger.debug("Parsing tool calls from output", { outputLength: output.length });
  
  // Split the output by lines and look for lines starting with TOOL_CALL:
  const lines = output.split('\n');
  const results: ParsedToolCall[] = [];
  
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (line.startsWith('TOOL_CALL:')) {
      try {
        // Extract the JSON part
        const jsonPart = line.substring('TOOL_CALL:'.length).trim();
        logger.debug("Found potential tool call", { jsonPart });
        
        const parsedJson: unknown = JSON.parse(jsonPart);
        logger.debug("Successfully parsed JSON", { parsedJson });
        
        // Type guard for ParsedToolCall
        const isParsedToolCall = (item: unknown): item is ParsedToolCall => {
          if (typeof item !== 'object' || item === null) {
            return false;
          }
          // Now item is confirmed to be an object and not null
          const p = item as Record<string, unknown>; // Cast to Record for safer 'in' checks if preferred, or use item directly
          return (
            'tool' in p && typeof p.tool === 'string' &&
            'parameters' in p && typeof p.parameters === 'object' && p.parameters !== null
          );
        };

        if (isParsedToolCall(parsedJson)) {
          results.push({
            tool: parsedJson.tool, // Access directly after type guard
            parameters: parsedJson.parameters // Access directly after type guard
          });
        } else {
          logger.warn("Parsed JSON part does not match expected tool call structure", { parsedJsonPart: jsonPart });
        }
      } catch (error: unknown) {
        const _err = error instanceof Error ? error : new Error(String(error));
        logger.error("Failed to parse tool call", { line, error: _err });
      }
    }
  }
  
  logger.debug(`Found ${results.length} valid tool calls`);
  return results;
}

// Execute a tool call
export async function executeToolCall(
  toolCall: { tool: string; parameters: unknown },
  qdrantClient: QdrantClient,
  repoPath: string,
  suggestionModelAvailable: boolean
): Promise<unknown> {
  const { tool, parameters } = toolCall;
  
  // Type assertion for parameters
  const typedParams = parameters as Record<string, unknown>;
  
  // Find the tool in the registry
  const toolInfo = toolRegistry.find(t => t.name === tool);
  
  // Check if the tool requires the suggestion model
  // This check must happen *after* confirming toolInfo exists.
  if (toolInfo && toolInfo.requiresModel && !suggestionModelAvailable) {
    logger.warn(`Attempt to use model-dependent tool '${tool}' when model is unavailable. ToolInfo: ${JSON.stringify(toolInfo)}, suggestionModelAvailable: ${suggestionModelAvailable}`);
    throw new Error(`Tool ${tool} requires the suggestion model which is not available`);
  }
  
  // If toolInfo is still not found after the above, it's a fundamental issue.
  if (!toolInfo) {
    throw new Error(`Tool not found: ${tool}`);
  }
  
  // Execute the appropriate tool
  switch (tool) {
    case "search_code": {
      const queryParam = typedParams.query;
      if (typeof queryParam !== 'string') {
        throw new Error(`Parameter 'query' for tool '${tool}' must be a string. Received: ${typeof queryParam}`);
      }
      const query: string = queryParam;

      const sessionIdParam = typedParams.sessionId;
      if (sessionIdParam !== undefined && typeof sessionIdParam !== 'string') {
        throw new Error(`Parameter 'sessionId' for tool '${tool}' must be a string if provided. Received: ${typeof sessionIdParam}`);
      }
      const sessionId: string | undefined = sessionIdParam;
      
      // Get or create session
      const session = getOrCreateSession(sessionId, repoPath);
      
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
      
      // Format results for the agent - map becomes async
      const formattedResultsPromises = results.map(async r => {
        const payload = r.payload;
        let filepathDisplay = payload.filepath;

        // Safely access optional properties
        if (payload.is_chunked) {
          filepathDisplay = `${payload.filepath} (Chunk ${(payload.chunk_index ?? 0) + 1}/${payload.total_chunks ?? 'N/A'})`;
        }

        const processedSnippet = await processSnippet(
          payload.content, 
          query, // Pass the current tool's query
          filepathDisplay, 
          suggestionModelAvailable
        );

        return {
          filepath: filepathDisplay,
          snippet: processedSnippet, // Use processed snippet
          last_modified: payload.last_modified,
          relevance: r.score,
          is_chunked: !!payload.is_chunked,
        };
      });
      const formattedResults = await Promise.all(formattedResultsPromises);
      
      return {
        sessionId: session.id,
        refinedQuery,
        relevanceScore,
        results: formattedResults
      };
    }
    
    case "get_repository_context": {
      const queryParam = typedParams.query;
      if (typeof queryParam !== 'string') {
        throw new Error(`Parameter 'query' for tool '${tool}' must be a string. Received: ${typeof queryParam}`);
      }
      const query: string = queryParam;

      const sessionIdParam = typedParams.sessionId;
      if (sessionIdParam !== undefined && typeof sessionIdParam !== 'string') {
        throw new Error(`Parameter 'sessionId' for tool '${tool}' must be a string if provided. Received: ${typeof sessionIdParam}`);
      }
      const sessionId: string | undefined = sessionIdParam;
      
      // Get or create session
      const session = getOrCreateSession(sessionId, repoPath);
      
      const isGitRepo = await validateGitRepository(repoPath);
      const files = isGitRepo
        ? await git.listFiles({ fs, dir: repoPath, gitdir: path.join(repoPath, ".git"), ref: "HEAD" })
        : [];
      
      // Use the new helper function to get the processed diff
      const processedDiff = await getProcessedDiff(repoPath, suggestionModelAvailable);
      
      // Update context in session
      updateContext(session.id, repoPath, files);
      
      // Use iterative query refinement
      const { results, refinedQuery } = await searchWithRefinement(
        qdrantClient, 
        query, 
        files
      );
      
      // Get recent queries from session to provide context
      const recentQueries = getRecentQueries(session.id);
      
      const contextPromises = results.map(async r => {
        const payload = r.payload;
        let filepathDisplay = payload.filepath;

        if (payload.is_chunked) {
          filepathDisplay = `${payload.filepath} (Chunk ${(payload.chunk_index ?? 0) + 1}/${payload.total_chunks ?? 'N/A'})`;
        }
        
        const processedSnippet = await processSnippet(
          payload.content,
          query, // Pass the current tool's query
          filepathDisplay,
          suggestionModelAvailable
        );

        return {
          filepath: filepathDisplay,
          snippet: processedSnippet, // Use processed snippet
          last_modified: payload.last_modified,
          relevance: r.score,
          is_chunked: !!payload.is_chunked,
          // Store original path for potential re-assembly logic later if needed
          original_filepath: payload.filepath,
          chunk_index: payload.chunk_index,
          total_chunks: payload.total_chunks,
        };
      });
      const context = await Promise.all(contextPromises);
      
      // Add query to session
      addQuery(session.id, query, results);
      
      return {
        sessionId: session.id,
        refinedQuery,
        recentQueries,
        diff: processedDiff, // Use the processed (potentially summarized or truncated) diff
        results: context // This now contains processed snippets
      };
    }
    
    case "generate_suggestion": {
      const queryParam = typedParams.query;
      if (typeof queryParam !== 'string') {
        throw new Error(`Parameter 'query' for tool '${tool}' must be a string. Received: ${typeof queryParam}`);
      }
      const query: string = queryParam;

      const sessionIdParam = typedParams.sessionId;
      if (sessionIdParam !== undefined && typeof sessionIdParam !== 'string') {
        throw new Error(`Parameter 'sessionId' for tool '${tool}' must be a string if provided. Received: ${typeof sessionIdParam}`);
      }
      const sessionId: string | undefined = sessionIdParam;
      
      // Get or create session
      const session = getOrCreateSession(sessionId, repoPath);
      
      // First, use search_code internally to get relevant context
      const isGitRepo = await validateGitRepository(repoPath);
      const files = isGitRepo
        ? await git.listFiles({ fs, dir: repoPath, gitdir: path.join(repoPath, ".git"), ref: "HEAD" })
        : [];
      
      // Use the new helper function to get the processed diff
      const processedDiff = await getProcessedDiff(repoPath, suggestionModelAvailable);
      
      // Update context in session
      updateContext(session.id, repoPath, files);
      
      // Get recent queries from session to provide context
      const recentQueries = getRecentQueries(session.id);
      const _relevantResults = getRelevantResults(session.id);
      
      // Use iterative query refinement for better search results
      const { results } = await searchWithRefinement(
        qdrantClient, 
        query, 
        files
      );
      
      // Prepare file list for context
      let filesContextString = "";
      const maxFilesToShowWithoutSummary = configService.MAX_FILES_FOR_SUGGESTION_CONTEXT_NO_SUMMARY;

      if (files.length > maxFilesToShowWithoutSummary && suggestionModelAvailable) {
        try {
          const llmProvider = await getLLMProvider(); // Moved here as it's needed for summarization
          const filesToSummarize = files.slice(0, 100); // Limit number of files sent for summarization to avoid overly long prompts
          const fileListPrompt = `The user query is: "${query}". Based on this query, identify the most relevant files from the following list. Provide a concise summary or list of up to ${maxFilesToShowWithoutSummary} most important file paths. If many files seem equally relevant, you can state "Several relevant files found including [example1], [example2], etc."\n\nFile list:\n${filesToSummarize.join("\n")}`;
          filesContextString = await llmProvider.generateText(fileListPrompt);
          logger.info(`Summarized file list for generate_suggestion context. Query: "${query}", Original count: ${files.length}, Summarized: "${filesContextString}"`);
        } catch (summaryError) {
          const sErr = summaryError instanceof Error ? summaryError : new Error(String(summaryError));
          logger.warn(`Failed to summarize file list for generate_suggestion. Error: ${sErr.message}. Falling back to truncated list.`);
          filesContextString = `${files.slice(0, maxFilesToShowWithoutSummary).join(", ")}${files.length > maxFilesToShowWithoutSummary ? "..." : ""}`;
        }
      } else if (files.length > 0) {
        filesContextString = `${files.slice(0, maxFilesToShowWithoutSummary).join(", ")}${files.length > maxFilesToShowWithoutSummary ? "..." : ""}`;
      } else {
        filesContextString = "No files found in repository for context.";
      }
      
      // Map search results to context - map becomes async
      const contextPromises = results.map(async r => {
        const payload = r.payload;
        let filepathDisplay = payload.filepath;

        if (payload.is_chunked) {
          filepathDisplay = `${payload.filepath} (Chunk ${(payload.chunk_index ?? 0) + 1}/${payload.total_chunks ?? 'N/A'})`;
        }

        const processedSnippet = await processSnippet(
          payload.content,
          query, // Pass the current tool's query
          filepathDisplay,
          suggestionModelAvailable
        );

        return {
          filepath: filepathDisplay, // This will be the display path including chunk info
          original_filepath: payload.filepath,
          snippet: processedSnippet, // Use processed snippet
          last_modified: payload.last_modified,
          relevance: r.score,
          is_chunked: !!payload.is_chunked,
          chunk_index: payload.chunk_index,
          total_chunks: payload.total_chunks,
        };
      });
      const context = await Promise.all(contextPromises);
      
      const prompt = `
**Context**:
Repository: ${repoPath}
Files: ${filesContextString}
Recent Changes: ${processedDiff ? (processedDiff || "").substring(0, 1000) : "Not available"}${(processedDiff || "").length > 1000 ? "..." : ""} 
${recentQueries.length > 0 ? `Recent Queries: ${recentQueries.join(", ")}` : ''}

**Relevant Snippets**:
${context.map(c => `File: ${c.filepath} (Last modified: ${c.last_modified}, Relevance: ${c.relevance.toFixed(2)})${c.is_chunked ? ` [Chunk ${(c.chunk_index ?? 0) + 1}/${c.total_chunks ?? 'N/A'} of ${c.original_filepath}]` : ''}\n${c.snippet.substring(0, 500)}${c.snippet.length > 500 ? "..." : ""}`).join("\n\n")}

**Instruction**:
Based on the provided context and snippets, generate a detailed code suggestion for "${query}". Include:
- A suggested code implementation or improvement.
- An explanation of how it addresses the query.
- References to the provided snippets or context where applicable.
      `;
      
      // Get the current LLM provider
      const llmProvider = await getLLMProvider();
      
      // Generate suggestion with the current provider
      const suggestion = await llmProvider.generateText(prompt);
      
      // Add suggestion to session
      addSuggestion(session.id, query, suggestion);
      
      return {
        sessionId: session.id,
        suggestion: suggestion || "No suggestion generated.", // Assuming 'suggestion' is defined after llmProvider.generateText(prompt)
        context: context.slice(0, 3) // Return only top 3 context items to avoid overwhelming the agent
      };
    }
    
    case "get_changelog": {
      try {
        const changelogPath = path.join(repoPath, 'CHANGELOG.md');
        try {
          const changelog = await fs.readFile(changelogPath, 'utf8');
          return {
            changelog: changelog.substring(0, 2000) // Limit size
          };
        // eslint-disable-next-line @typescript-eslint/no-unused-vars
        } catch (_error) {
          return {
            changelog: "No changelog found"
          };
        }
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      } catch (_error) {
        return {
          error: "Failed to read changelog",
          changelog: "No changelog available"
        };
      }
    }
    
    case "analyze_code_problem": {
      const queryParam = typedParams.query;
      if (typeof queryParam !== 'string') {
        throw new Error(`Parameter 'query' for tool '${tool}' must be a string. Received: ${typeof queryParam}`);
      }
      const query: string = queryParam;

      const sessionIdParam = typedParams.sessionId;
      if (sessionIdParam !== undefined && typeof sessionIdParam !== 'string') {
        throw new Error(`Parameter 'sessionId' for tool '${tool}' must be a string if provided. Received: ${typeof sessionIdParam}`);
      }
      const sessionId: string | undefined = sessionIdParam;
      
      // Get or create session
      const session = getOrCreateSession(sessionId, repoPath);
      
      // Step 1: Get repository context
      const isGitRepo = await validateGitRepository(repoPath);
      const files = isGitRepo
        ? await git.listFiles({ fs, dir: repoPath, gitdir: path.join(repoPath, ".git"), ref: "HEAD" })
        : [];
      const _diff = await getRepositoryDiff(repoPath);
      
      // Use iterative query refinement to find relevant code
      const { results: contextResults } = await searchWithRefinement(
        qdrantClient, 
        query, 
        files
      );
      
      const contextPromises = contextResults.map(async r => { // contextResults from searchWithRefinement
        const payload = r.payload;
        let filepathDisplay = payload.filepath;

        if (payload.is_chunked) {
          filepathDisplay = `${payload.filepath} (Chunk ${(payload.chunk_index ?? 0) + 1}/${payload.total_chunks ?? 'N/A'})`;
        }

        const processedSnippet = await processSnippet(
          payload.content,
          query, // Pass the current tool's query
          filepathDisplay,
          suggestionModelAvailable
        );

        return {
          filepath: filepathDisplay,
          original_filepath: payload.filepath,
          snippet: processedSnippet, // Use processed snippet
          last_modified: payload.last_modified,
          relevance: r.score,
          is_chunked: !!payload.is_chunked,
          chunk_index: payload.chunk_index,
          total_chunks: payload.total_chunks,
        };
      });
      const context = await Promise.all(contextPromises);
      
      // Step 2: Analyze the problem
      const analysisPrompt = `
**Code Problem Analysis**

Problem: ${query}

**Relevant Code**:
${context.map(c => `File: ${c.filepath}${c.is_chunked ? ` [Chunk ${(c.chunk_index ?? 0) + 1}/${c.total_chunks ?? 'N/A'} of ${c.original_filepath}]` : ''}\n\`\`\`\n${c.snippet.substring(0, 500)}${c.snippet.length > 500 ? "..." : ""}\n\`\`\``).join("\n\n")}

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
      
      // Get the current LLM provider
      const llmProvider = await getLLMProvider();
      
      // Generate analysis with the current provider
      const analysis = await llmProvider.generateText(analysisPrompt);
      
      // Add to session
      addQuery(session.id, query, contextResults);
      addSuggestion(session.id, analysisPrompt, analysis);
      
      return {
        sessionId: session.id,
        analysis, // Assuming 'analysis' is defined after llmProvider.generateText(analysisPrompt)
        context: context.slice(0, 3) // Return only top 3 context items
      };
    }
    
    case "request_additional_context": {
      const contextTypeParam = typedParams.context_type;
      const queryOrPathParam = typedParams.query_or_path;
      const reasoningParamRaw = typedParams.reasoning; // Optional
      const sessionIdParam = typedParams.sessionId;
      // Add chunkIndexParam
      const chunkIndexParam = typedParams.chunk_index;

      if (typeof contextTypeParam !== 'string' || !['MORE_SEARCH_RESULTS', 'FULL_FILE_CONTENT', 'DIRECTORY_LISTING', 'ADJACENT_FILE_CHUNKS'].includes(contextTypeParam)) {
        throw new Error(`Parameter 'context_type' for tool '${tool}' must be one of ['MORE_SEARCH_RESULTS', 'FULL_FILE_CONTENT', 'DIRECTORY_LISTING', 'ADJACENT_FILE_CHUNKS']. Received: ${contextTypeParam}`);
      }
      if (typeof queryOrPathParam !== 'string') {
        throw new Error(`Parameter 'query_or_path' for tool '${tool}' must be a string. Received: ${typeof queryOrPathParam}`);
      }
      // Add validation for chunk_index if context_type is ADJACENT_FILE_CHUNKS
      if (contextTypeParam === 'ADJACENT_FILE_CHUNKS') {
        if (typeof queryOrPathParam !== 'string' || !queryOrPathParam) { // queryOrPathParam is used as filepath here
            throw new Error(`Parameter 'query_or_path' (as filepath) for tool '${tool}' with context_type 'ADJACENT_FILE_CHUNKS' must be a non-empty string. Received: ${typeof queryOrPathParam}`);
        }
        if (typeof chunkIndexParam !== 'number' || chunkIndexParam < 0) {
            throw new Error(`Parameter 'chunk_index' for tool '${tool}' with context_type 'ADJACENT_FILE_CHUNKS' must be a non-negative integer. Received: ${typeof chunkIndexParam}`);
        }
      }
      let reasoningParamStr: string | undefined = undefined;
      if (typeof reasoningParamRaw === 'string') {
        reasoningParamStr = reasoningParamRaw;
      } else if (reasoningParamRaw !== undefined) {
        logger.warn(`Optional parameter 'reasoning' for tool '${tool}' was provided but not as a string. Received: ${typeof reasoningParamRaw}. Ignoring.`);
      }
      if (sessionIdParam !== undefined && typeof sessionIdParam !== 'string') {
        throw new Error(`Parameter 'sessionId' for tool '${tool}' must be a string if provided. Received: ${typeof sessionIdParam}`);
      }
      const sessionId: string | undefined = sessionIdParam;
      // Get or create session (consistent with other tools)
      const session = getOrCreateSession(sessionId, repoPath);

      logger.info(`Executing request_additional_context: type='${contextTypeParam}', query_or_path='${String(queryOrPathParam)}', reasoning='${reasoningParamStr || 'N/A'}'`);

      switch (contextTypeParam) {
        case 'MORE_SEARCH_RESULTS': {
          logger.info(`Executing MORE_SEARCH_RESULTS for query: "${queryOrPathParam}"`);
          const files = await git.listFiles({ fs, dir: repoPath, gitdir: path.join(repoPath, ".git"), ref: "HEAD" });
          // Use a higher limit for "more" results, e.g., 2x the default or a configured "more_results_limit"
          const moreResultsLimit = configService.REQUEST_ADDITIONAL_CONTEXT_MAX_SEARCH_RESULTS; 
          const { results, refinedQuery, relevanceScore } = await searchWithRefinement(
            qdrantClient,
            queryOrPathParam, // This is the original query
            files,
            moreResultsLimit // Pass the increased limit as the customLimit argument
            // maxRefinements and relevanceThreshold will use their default values
          );
          addQuery(session.id, queryOrPathParam, results, relevanceScore); // Log this specific request

          const formattedResultsPromises = results.map(async r => {
            const payload = r.payload;
            let filepathDisplay = payload.filepath;
            if (payload.is_chunked) {
              filepathDisplay = `${payload.filepath} (Chunk ${(payload.chunk_index ?? 0) + 1}/${payload.total_chunks ?? 'N/A'})`;
            }
            const processedSnippet = await processSnippet(
              payload.content,
              queryOrPathParam,
              filepathDisplay,
              suggestionModelAvailable
            );
            return {
              filepath: filepathDisplay,
              snippet: processedSnippet,
              last_modified: payload.last_modified,
              relevance: r.score,
              is_chunked: !!payload.is_chunked,
            };
          });
          const formattedResults = await Promise.all(formattedResultsPromises);
          return { 
            sessionId: session.id, 
            status: `Retrieved more search results for query "${queryOrPathParam}".`,
            refinedQuery,
            relevanceScore,
            results: formattedResults 
          };
        }
        case 'FULL_FILE_CONTENT': {
          logger.info(`Executing FULL_FILE_CONTENT for path: "${queryOrPathParam}"`);
          const targetFilePath = path.resolve(repoPath, queryOrPathParam); // Ensure path is absolute and within repo
          if (!targetFilePath.startsWith(path.resolve(repoPath))) {
            throw new Error(`Access denied: Path "${queryOrPathParam}" is outside the repository.`);
          }
          try {
            let fileContent = await fs.readFile(targetFilePath, 'utf8');
            const MAX_CONTENT_LENGTH = configService.MAX_SNIPPET_LENGTH_FOR_CONTEXT_NO_SUMMARY * 5; // Example: 5x snippet length for "full"

            if (fileContent.length > MAX_CONTENT_LENGTH) {
              if (suggestionModelAvailable) {
                try {
                  const llmProvider = await getLLMProvider();
                  const summaryPrompt = `The user requested the full content of "${queryOrPathParam}". The content is too long (${fileContent.length} characters). Summarize it concisely, focusing on its main purpose, key functions/classes, and overall structure. Keep the summary informative yet brief.\n\nFile Content (partial):\n${fileContent.substring(0, MAX_CONTENT_LENGTH * 2)}`; // Provide more for summary
                  fileContent = `Summary of ${queryOrPathParam}:\n${await llmProvider.generateText(summaryPrompt)}`;
                  logger.info(`Summarized large file content for ${queryOrPathParam}`);
                } catch (summaryError) {
                  const sErr = summaryError instanceof Error ? summaryError : new Error(String(summaryError));
                  logger.warn(`Failed to summarize full file content for ${queryOrPathParam}. Using truncated content. Error: ${sErr.message}`);
                  fileContent = `Content of ${queryOrPathParam} is too large. Summary attempt failed. Truncated content:\n${fileContent.substring(0, MAX_CONTENT_LENGTH)}...`;
                }
              } else {
                logger.warn(`Suggestion model not available to summarize large file ${queryOrPathParam}. Using truncated content.`);
                fileContent = `Content of ${queryOrPathParam} is too large. Full content omitted as suggestion model is offline. Truncated content:\n${fileContent.substring(0, MAX_CONTENT_LENGTH)}...`;
              }
            }
            return { sessionId: session.id, status: `Retrieved content for path "${queryOrPathParam}".`, filepath: queryOrPathParam, content: fileContent };
          } catch (error) {
            const err = error instanceof Error ? error : new Error(String(error));
            logger.error(`Failed to read file "${queryOrPathParam}": ${err.message}`);
            throw new Error(`Failed to read file "${queryOrPathParam}": ${err.message}`);
          }
        }
        case 'DIRECTORY_LISTING': {
          logger.info(`Executing DIRECTORY_LISTING for path: "${queryOrPathParam}"`);
          const targetDirPath = path.resolve(repoPath, queryOrPathParam); // Ensure path is absolute and within repo
          if (!targetDirPath.startsWith(path.resolve(repoPath))) {
            throw new Error(`Access denied: Path "${queryOrPathParam}" is outside the repository.`);
          }
          try {
            const entries = await fs.readdir(targetDirPath, { withFileTypes: true });
            const listing = entries.map(entry => ({
              name: entry.name,
              type: entry.isDirectory() ? 'directory' : 'file'
            }));
            // Limit the number of entries returned to avoid overwhelming the context
            const MAX_DIR_ENTRIES = 50; 
            if (listing.length > MAX_DIR_ENTRIES) {
                return { 
                    sessionId: session.id, 
                    status: `Retrieved directory listing for path "${queryOrPathParam}". Listing truncated.`, 
                    path: queryOrPathParam, 
                    listing: listing.slice(0, MAX_DIR_ENTRIES),
                    note: `Listing truncated. Showing first ${MAX_DIR_ENTRIES} of ${listing.length} entries.`
                };
            }
            return { sessionId: session.id, status: `Retrieved directory listing for path "${queryOrPathParam}".`, path: queryOrPathParam, listing };
          } catch (error) {
            const err = error instanceof Error ? error : new Error(String(error));
            logger.error(`Failed to list directory "${queryOrPathParam}": ${err.message}`);
            throw new Error(`Failed to list directory "${queryOrPathParam}": ${err.message}`);
          }
        }
        case 'ADJACENT_FILE_CHUNKS': {
          const filepath = queryOrPathParam; // query_or_path is the filepath for this type
          const currentChunkIndex = chunkIndexParam as number;
          logger.info(`Executing ADJACENT_FILE_CHUNKS for file: "${filepath}", current chunk: ${currentChunkIndex}`);

          const adjacentChunksInfo: { chunk_index: number; content: string; note?: string }[] = [];
          // Define how many adjacent chunks to fetch (e.g., 1 before, 1 after)
          const chunksToFetchIndices = [currentChunkIndex - 1, currentChunkIndex + 1].filter(idx => idx >= 0);
          
          // Fetch total chunks for the file to avoid querying beyond the last chunk
          // This might require a separate Qdrant query or an assumption.
          // For simplicity, we'll try to fetch and handle if not found.
          // A more robust way would be to get total_chunks if available from the initial search result.

          for (const targetIndex of chunksToFetchIndices) {
            try {
              // We need to search Qdrant for a point with matching filepath and chunk_index
              // This assumes Qdrant allows filtering effectively on these fields.
              // A direct scroll/filter might be better than a vector search if no relevant vector is available.
              const scrollResponse = await qdrantClient.scroll(configService.COLLECTION_NAME, {
                filter: {
                  must: [
                    { key: "filepath", match: { value: filepath } },
                    { key: "chunk_index", match: { value: targetIndex } }
                  ]
                },
                limit: 1,
                with_payload: true,
                with_vector: false,
              });

              if (scrollResponse.points.length > 0 && scrollResponse.points[0].payload) {
                const payload = scrollResponse.points[0].payload;
                adjacentChunksInfo.push({
                  chunk_index: payload.chunk_index as number,
                  content: payload.content as string,
                });
              } else {
                 adjacentChunksInfo.push({
                  chunk_index: targetIndex,
                  content: "", // Empty content
                  note: `Chunk ${targetIndex} not found for file ${filepath}.`
                 });
              }
            } catch (searchError) {
              const sErr = searchError instanceof Error ? searchError : new Error(String(searchError));
              logger.warn(`Failed to fetch chunk ${targetIndex} for ${filepath}: ${sErr.message}`);
              adjacentChunksInfo.push({
                chunk_index: targetIndex,
                content: "",
                note: `Error fetching chunk ${targetIndex} for file ${filepath}: ${sErr.message}`
              });
            }
          }

          if (adjacentChunksInfo.filter(c => c.content).length === 0) {
            return { 
              sessionId: session.id, 
              status: `No adjacent chunks with content found for file "${filepath}", around chunk ${currentChunkIndex}.`,
              filepath: filepath,
              requested_chunk_index: currentChunkIndex,
              retrieved_chunks: adjacentChunksInfo
            };
          }
          
          return {
            sessionId: session.id,
            status: `Retrieved adjacent chunk(s) for file "${filepath}", around chunk ${currentChunkIndex}.`,
            filepath: filepath,
            requested_chunk_index: currentChunkIndex,
            retrieved_chunks: adjacentChunksInfo.map(c => ({
                filepath: filepath, // Add filepath for clarity in results
                chunk_index: c.chunk_index,
                snippet: c.content, // Use 'snippet' to align with other search results
                note: c.note
            }))
          };
        }
        default: // Should not happen due to earlier check
          throw new Error(`Unsupported context_type: ${contextTypeParam}`);
      }
    }
    case "request_more_processing_steps": {
      const reasoningParam = typedParams.reasoning;
      if (typeof reasoningParam !== 'string') {
        throw new Error(`Parameter 'reasoning' for tool '${tool}' must be a string. Received: ${typeof reasoningParam}`);
      }
      logger.info(`Agent requested more processing steps. Reasoning: ${reasoningParam}`);
      // The actual logic for extending steps is in the main loop.
      // This tool call itself just acknowledges the request.
      return { 
        status: "Request for more processing steps acknowledged.",
        note: "The agent loop may continue if within absolute limits." 
      };
    }
    default:
      throw new Error(`Tool execution not implemented: ${tool}`);
  }
}

// Run the agent loop
export async function runAgentLoop(
  query: string,
  sessionId: string | undefined,
  qdrantClient: QdrantClient,
  repoPath: string,
  suggestionModelAvailable: boolean,
  // maxSteps parameter is removed
): Promise<string> {
  logger.info(`Agent loop started for query: "${query}" (Session: ${sessionId || 'new'})`);
  
  // Log the current provider and model being used by the agent, sourced from ConfigService
  logger.info(`Agent running with provider: ${configService.SUGGESTION_PROVIDER}, model: ${configService.SUGGESTION_MODEL}`);
  
  // Force refresh the provider to ensure we're using the latest settings
  // NOTE: The following cache manipulation logic can interfere with Vitest's mocking.
  // It's commented out for testing. In a real application, this kind of cache management
  // should ideally be handled at application startup or through a more controlled mechanism.
  // First clear any cached modules
  // Object.keys(require.cache).forEach(key => {
  //   if (key.includes('llm-provider') || key.includes('deepseek') || key.includes('ollama')) {
  //     delete require.cache[key];
  //   }
  // });
  
  // Import the clearProviderCache function and use it
  // const { clearProviderCache } = await import('./llm-provider.js');
  // clearProviderCache();
  
  const currentProvider = await getLLMProvider();
  const isConnected = await currentProvider.checkConnection();
  logger.info(`Agent confirmed provider: ${isConnected ? "connected" : "disconnected"}`);
  
  // Log the actual provider and model being used, from ConfigService
  logger.info(`Agent using model: ${configService.SUGGESTION_MODEL}, provider: ${configService.SUGGESTION_PROVIDER}`);
      
  // Verify the provider is working with a test generation
  try {
    const _testResult = await currentProvider.generateText("Test message");
    logger.info(`Agent verified provider ${configService.SUGGESTION_PROVIDER} is working`);
  } catch (error: unknown) {
    logger.error(`Agent failed to verify provider ${configService.SUGGESTION_PROVIDER}: ${error instanceof Error ? error.message : String(error)}`);
  }
  
    // Get or create session
    const session = getOrCreateSession(sessionId, repoPath);
    
    // Create agent state
    const agentState: AgentState = createAgentState(session.id, query);
    
    // Filter tools based on suggestion model availability
    const availableTools = toolRegistry.filter(tool => 
      !tool.requiresModel || (tool.requiresModel && suggestionModelAvailable)
    );
    
    // Generate system prompt
    const systemPrompt = generateAgentSystemPrompt(availableTools);
    
    // Initial user prompt
    let userPrompt = `User query: ${query}\n\nAnalyze this query and determine which tools to use to provide the best response.`;

  let currentMaxSteps = configService.AGENT_DEFAULT_MAX_STEPS;
  const absoluteMaxSteps = configService.AGENT_ABSOLUTE_MAX_STEPS;
  let terminatedDueToAbsoluteMax = false;

  for (let step = 0; step < currentMaxSteps; step++) { // Loop up to currentMaxSteps
    // Check if absoluteMaxSteps has been reached due to extensions
    if (step >= absoluteMaxSteps) {
        logger.warn(`Agent loop reached absolute maximum steps (${absoluteMaxSteps}) and will terminate.`);
        terminatedDueToAbsoluteMax = true;
        break;
    }
    logger.info(`Agent step ${step + 1}/${currentMaxSteps} (Absolute Max: ${absoluteMaxSteps}) for query: ${query}`);
    
    // Generate agent reasoning and tool selection
    const agentPrompt = `${systemPrompt}\n\n${userPrompt}`;
      
      // Add context from previous steps if available
      if (agentState.steps.length > 0) {
        const contextStr = agentState.steps.map(s => { // Changed step to s to avoid conflict with outer scope variable if any
          const outputStr = stringifyStepOutput(s.output); // Use helper
           
          // Reason: stringifyStepOutput ensures outputStr is a string, making this template literal safe.
          // The linter may not fully trace the type through the helper in all contexts for 'unknown' inputs.
          return `Previous tool: ${s.tool}\nResults: ${outputStr}`;
        }).join('\n\n');
      
        userPrompt += `\n\nContext from previous steps:\n${contextStr}`;
      }
      
      // Get the current LLM provider
      const llmProvider = await getLLMProvider();
      
      // Get agent reasoning with timeout handling
      let agentOutput: string;
      logger.info(`Agent (step ${step + 1}): Generating reasoning and tool selection...`);
      try {
        // Set a timeout promise
        const timeoutPromise = new Promise<string>((_, reject) => {
          setTimeout(() => reject(new Error("Agent reasoning timed out")), 60000); // 60 second timeout
        });
        
        // Race the LLM generation against the timeout
        agentOutput = await Promise.race([
          llmProvider.generateText(agentPrompt),
          timeoutPromise
        ]);
        logger.info(`Agent (step ${step + 1}): Reasoning and tool selection generated.`);
      } catch (error) {
        logger.warn(`Agent (step ${step + 1}): Reasoning timed out or failed: ${error instanceof Error ? error.message : String(error)}`);
        // Provide a fallback response that continues the agent loop
        agentOutput = "TOOL_CALL: " + JSON.stringify({
          tool: "search_code",
          parameters: { query: query, sessionId: session.id }
        });
      }
      
      // Check if the agent wants to make tool calls
      const toolCalls = parseToolCalls(agentOutput);
      
      // If no tool calls, consider the agent's response as final
      if (toolCalls.length === 0) {
        agentState.finalResponse = agentOutput;
        agentState.isComplete = true;
        break;
      }
      
      let extendedIteration = false;
      // Execute each tool call
      for (const toolCall of toolCalls) {
        if (toolCall.tool === "request_more_processing_steps") {
          if (currentMaxSteps < absoluteMaxSteps) {
            logger.info("Agent requested more processing steps. Extending currentMaxSteps to absoluteMaxSteps.");
            currentMaxSteps = absoluteMaxSteps;
            extendedIteration = true; // Signal that this iteration was primarily for extension
          } else {
            logger.warn("Agent requested more processing steps, but already at or beyond absoluteMaxSteps.");
          }
          // Execute the tool to acknowledge, but its main effect is on currentMaxSteps
        }
        try {
          logger.info(`Executing tool: ${toolCall.tool}`, { parameters: toolCall.parameters });
          
          // Execute tool call with timeout
          const toolOutput = await Promise.race([
            executeToolCall(
              toolCall,
              qdrantClient,
              repoPath,
              suggestionModelAvailable
            ),
            new Promise((_, reject) => {
              setTimeout(() => reject(new Error(`Tool execution timed out: ${toolCall.tool}`)), 90000); // 90 second timeout
            })
          ]);
          
          // Add step to agent state
          const newStep: AgentStep = {
            tool: toolCall.tool,
            input: toolCall.parameters, // No assertion needed, ParsedToolCall defines parameters as Record<string, unknown>
            output: toolOutput,
            reasoning: agentOutput
          };
          agentState.steps.push(newStep);

          // Add context from tool output
          agentState.context.push(toolOutput);
          
          // Update user prompt with tool results
          // Only append tool results to userPrompt if it wasn't just an extension request
          if (toolCall.tool !== "request_more_processing_steps" || !extendedIteration) {
               userPrompt += `\n\nTool: ${toolCall.tool}\nResults: ${JSON.stringify(toolOutput, null, 2)}\n\nBased on these results, what's your next step? If you have enough information, provide a final response to the user.`;
          } else if (extendedIteration && toolCalls.length === 1) {
              // If the *only* tool call was to extend, prompt for next actual step
              userPrompt += `\n\nTool: ${toolCall.tool}\nResults: ${JSON.stringify(toolOutput, null, 2)}\n\nProcessing steps extended. What is your next action?`;
          }
          
         
        } catch (_error: unknown) {
          const _err = _error instanceof Error ? _error : new Error(String(_error));
          logger.error(`Error executing tool ${toolCall.tool}`, { error: _err.message });
          
          // Add error to user prompt
          userPrompt += `\n\nError executing tool ${toolCall.tool}: ${_err.message}\n\nPlease try a different approach or provide a response with the information you have.`;
        }
      }
      
      // Check if we've reached the maximum number of steps
      if (step === currentMaxSteps - 1 && !agentState.isComplete) { // Check against currentMaxSteps
        logger.info(`Reached max steps for this phase (${currentMaxSteps}). Generating final response.`);
        const finalPrompt = `${systemPrompt}\n\n${userPrompt}\n\nYou've reached the current maximum number of steps. Please provide your final response to the user based on the information collected so far.`;
        const llmProvider = await getLLMProvider();
        agentState.finalResponse = await llmProvider.generateText(finalPrompt);
        agentState.isComplete = true;
      }
    }
    
    // If we somehow don't have a final response, generate one
    // After the loop
    if (!agentState.finalResponse) {
      const finalPrompt = `${systemPrompt}\n\n${userPrompt}\n\nPlease provide your final response to the user based on the information collected so far.`;
      const llmProvider = await getLLMProvider();
      try {
        // Set a timeout for final response generation
        agentState.finalResponse = await Promise.race([
          llmProvider.generateText(finalPrompt),
          new Promise<string>((_, reject) => {
            setTimeout(() => reject(new Error("Final response generation timed out")), 60000); // 60 second timeout
          })
        ]);
      } catch (error) {
        logger.warn(`Final response generation timed out: ${error instanceof Error ? error.message : String(error)}`);
        // Provide a fallback response
        agentState.finalResponse = "I apologize, but I couldn't complete the full analysis due to a timeout. " +
          "Here's what I found so far: " +
          agentState.steps.map((mapStep: AgentStep) => { // Renamed s to mapStep to avoid lint error if outer scope has 's'
            const toolName = mapStep.tool;
            const outputString = stringifyStepOutput(mapStep.output); // Use helper
            const safePreviewText = (outputString || 'No output').substring(0, 200);
            return `Used ${toolName} and found: ${safePreviewText}...`;
          }).join("\n\n");
      }
    }
    
    // Append note if terminated due to absolute max steps, regardless of how finalResponse was set
    if (terminatedDueToAbsoluteMax) {
        agentState.finalResponse = (agentState.finalResponse || "Processing was terminated.") +
        "\n[Note: The agent utilized the maximum allowed processing steps.]";
    }
    
    // Add the final response as a suggestion in the session
    addSuggestion(session.id, query, agentState.finalResponse);
    
    // Format the final response
    const formattedResponse = `# CodeCompass Agent Response

${agentState.finalResponse}

Session ID: ${session.id} (Use this ID in future requests to maintain context)`;
    
    return formattedResponse;
}
