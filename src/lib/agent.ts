import { logger, configService } from "./config-service";
import { getLLMProvider } from "./llm-provider";
// import { incrementCounter, timeExecution } from "./metrics"; // Metrics removed
import { getOrCreateSession, addQuery, addSuggestion, updateContext, getRecentQueries, getRelevantResults } from "./state";
import { QdrantClient } from "@qdrant/js-client-rest";
import { AgentState, AgentStep } from "./types";
import { searchWithRefinement } from "./query-refinement"; // Changed import path
import { validateGitRepository, getRepositoryDiff } from "./repository";
import git from "isomorphic-git";
import fs from "fs/promises";
import path from "path";

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
  }
];

// Helper function to get processed diff (summarized or truncated if necessary)
async function getProcessedDiff(
  repoPath: string,
  suggestionModelAvailable: boolean
): Promise<string> {
  let diffContent = await getRepositoryDiff(repoPath);

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
function generateAgentSystemPrompt(availableTools: Tool[]): string {
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
export function parseToolCalls(output: string): { tool: string; parameters: unknown }[] {
  // Log the output for debugging
  logger.debug("Parsing tool calls from output", { outputLength: output.length });
  
  // Split the output by lines and look for lines starting with TOOL_CALL:
  const lines = output.split('\n');
  const results: { tool: string; parameters: unknown }[] = [];
  
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (line.startsWith('TOOL_CALL:')) {
      try {
        // Extract the JSON part
        const jsonPart = line.substring('TOOL_CALL:'.length).trim();
        logger.debug("Found potential tool call", { jsonPart });
        
        const parsed = JSON.parse(jsonPart) as { tool?: string; parameters?: unknown };
        logger.debug("Successfully parsed JSON", { parsed });
        
        if (parsed && typeof parsed.tool === 'string' && parsed.parameters) {
          results.push({
            tool: parsed.tool,
            parameters: parsed.parameters
          });
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
  if (!toolInfo) {
    throw new Error(`Tool not found: ${tool}`);
  }
  
  // Check if the tool requires the suggestion model
  if (toolInfo.requiresModel && !suggestionModelAvailable) {
    throw new Error(`Tool ${tool} requires the suggestion model which is not available`);
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
      
      // Format results for the agent
      const formattedResults = results.map(r => {
        const payload = r.payload;
        let filepathDisplay = payload.filepath;

        // Safely access optional properties
        if (payload.is_chunked) {
          filepathDisplay = `${payload.filepath} (Chunk ${(payload.chunk_index ?? 0) + 1}/${payload.total_chunks ?? 'N/A'})`;
        }
        return {
          filepath: filepathDisplay,
          snippet: payload.content.slice(0, 2000),
          last_modified: payload.last_modified,
          relevance: r.score,
          is_chunked: !!payload.is_chunked,
        };
      });
      
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
      
      const context = results.map(r => {
        const payload = r.payload;
        let filepathDisplay = payload.filepath;

        if (payload.is_chunked) {
          filepathDisplay = `${payload.filepath} (Chunk ${(payload.chunk_index ?? 0) + 1}/${payload.total_chunks ?? 'N/A'})`;
        }
        return {
          filepath: filepathDisplay,
          snippet: payload.content.slice(0, 2000),
          last_modified: payload.last_modified,
          relevance: r.score,
          is_chunked: !!payload.is_chunked,
          // Store original path for potential re-assembly logic later if needed
          original_filepath: payload.filepath,
          chunk_index: payload.chunk_index,
          total_chunks: payload.total_chunks,
        };
      });
      
      // Add query to session
      addQuery(session.id, query, results);
      
      return {
        sessionId: session.id,
        refinedQuery,
        recentQueries,
        diff: processedDiff, // Use the processed (potentially summarized or truncated) diff
        results: context
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
      
      // Map search results to context
      const context = results.map(r => {
        const payload = r.payload;
        let filepathDisplay = payload.filepath;

        if (payload.is_chunked) {
          filepathDisplay = `${payload.filepath} (Chunk ${(payload.chunk_index ?? 0) + 1}/${payload.total_chunks ?? 'N/A'})`;
        }
        return {
          filepath: filepathDisplay, // This will be the display path including chunk info
          original_filepath: payload.filepath,
          snippet: payload.content.slice(0, 2000),
          last_modified: payload.last_modified,
          relevance: r.score,
          is_chunked: !!payload.is_chunked,
          chunk_index: payload.chunk_index,
          total_chunks: payload.total_chunks,
        };
      });
      
      const prompt = `
**Context**:
Repository: ${repoPath}
Files: ${files.slice(0, 10).join(", ")}${files.length > 10 ? "..." : ""}
Recent Changes: ${processedDiff ? processedDiff.substring(0, 1000) : "Not available"}${processedDiff && processedDiff.length > 1000 ? "..." : ""} 
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
        suggestion: suggestion,
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
      
      const context = contextResults.map(r => {
        const payload = r.payload;
        let filepathDisplay = payload.filepath;

        if (payload.is_chunked) {
          filepathDisplay = `${payload.filepath} (Chunk ${(payload.chunk_index ?? 0) + 1}/${payload.total_chunks ?? 'N/A'})`;
        }
        return {
          filepath: filepathDisplay,
          original_filepath: payload.filepath,
          snippet: payload.content.slice(0, 2000),
          last_modified: payload.last_modified,
          relevance: r.score,
          is_chunked: !!payload.is_chunked,
          chunk_index: payload.chunk_index,
          total_chunks: payload.total_chunks,
        };
      });
      
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
        analysis,
        context: context.slice(0, 3) // Return only top 3 context items
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
  maxSteps = 5
): Promise<string> {
  logger.info(`Agent loop started for query: "${query}" (Session: ${sessionId || 'new'})`);
  
  // Log the current provider and model being used by the agent, sourced from ConfigService
  logger.info(`Agent running with provider: ${configService.SUGGESTION_PROVIDER}, model: ${configService.SUGGESTION_MODEL}`);
  
  // Force refresh the provider to ensure we're using the latest settings
  // First clear any cached modules
  Object.keys(require.cache).forEach(key => {
    if (key.includes('llm-provider') || key.includes('deepseek') || key.includes('ollama')) {
      delete require.cache[key];
    }
  });
  
  // Import the clearProviderCache function and use it
  const { clearProviderCache } = await import('./llm-provider');
  clearProviderCache();
  
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
    const agentState = createAgentState(session.id, query);
    
    // Filter tools based on suggestion model availability
    const availableTools = toolRegistry.filter(tool => 
      !tool.requiresModel || (tool.requiresModel && suggestionModelAvailable)
    );
    
    // Generate system prompt
    const systemPrompt = generateAgentSystemPrompt(availableTools);
    
    // Initial user prompt
    let userPrompt = `User query: ${query}\n\nAnalyze this query and determine which tools to use to provide the best response.`;
    
    // Agent loop
    for (let step = 0; step < maxSteps; step++) {
      logger.info(`Agent step ${step + 1}/${maxSteps} for query: ${query}`);
      
      // Generate agent reasoning and tool selection
      const agentPrompt = `${systemPrompt}\n\n${userPrompt}`;
      
      // Add context from previous steps if available
      if (agentState.steps.length > 0) {
        const contextStr = agentState.steps.map(step => 
          `Previous tool: ${step.tool}\nResults: ${JSON.stringify(step.output, null, 2)}`
        ).join('\n\n');
        
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
      
      // Execute each tool call
      for (const toolCall of toolCalls) {
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
          agentState.steps.push({
            tool: toolCall.tool,
            input: toolCall.parameters,
            output: toolOutput,
            reasoning: agentOutput
          } as unknown as AgentStep);
          
          // Add context from tool output
          agentState.context.push(toolOutput);
          
          // Update user prompt with tool results
          userPrompt += `\n\nTool: ${toolCall.tool}\nResults: ${JSON.stringify(toolOutput, null, 2)}\n\nBased on these results, what's your next step? If you have enough information, provide a final response to the user.`;
          
         
        } catch (_error: unknown) {
          const _err = _error instanceof Error ? _error : new Error(String(_error));
          logger.error(`Error executing tool ${toolCall.tool}`, { error: _err.message });
          
          // Add error to user prompt
          userPrompt += `\n\nError executing tool ${toolCall.tool}: ${_err.message}\n\nPlease try a different approach or provide a response with the information you have.`;
        }
      }
      
      // Check if we've reached the maximum number of steps
      if (step === maxSteps - 1 && !agentState.isComplete) {
        // Generate final response based on collected information
        const finalPrompt = `${systemPrompt}\n\n${userPrompt}\n\nYou've reached the maximum number of steps. Please provide your final response to the user based on the information collected so far.`;
        const llmProvider = await getLLMProvider();
        agentState.finalResponse = await llmProvider.generateText(finalPrompt);
        agentState.isComplete = true;
      }
    }
    
    // If we somehow don't have a final response, generate one
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
          agentState.steps.map(s => `Used ${s.tool} and found: ${JSON.stringify(s.output).substring(0, 200)}...`).join("\n\n");
      }
    }
    
    // Add the final response as a suggestion in the session
    addSuggestion(session.id, query, agentState.finalResponse);
    
    // Format the final response
    const formattedResponse = `# CodeCompass Agent Response

${agentState.finalResponse}

Session ID: ${session.id} (Use this ID in future requests to maintain context)`;
    
    return formattedResponse;
}
