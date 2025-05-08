import { logger } from "./config";
import { getLLMProvider } from "./llm-provider";
import { incrementCounter, timeExecution } from "./metrics";
import { getOrCreateSession, addQuery, addSuggestion, updateContext, getRecentQueries, getRelevantResults } from "./state";
import { QdrantClient } from "@qdrant/js-client-rest";
import { QdrantSearchResult, AgentState } from "./types";
import { searchWithRefinement } from "./qdrant";
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

// Create a new agent state
export function createAgentState(sessionId: string, query: string): AgentState {
  return {
    sessionId,
    query,
    steps: [],
    context: [],
    isComplete: false
  };
}

// Generate the agent system prompt
function generateAgentSystemPrompt(availableTools: Tool[]): string {
  return `You are CodeCompass Agent, an AI assistant that helps developers understand and work with codebases.
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
        
        const parsed = JSON.parse(jsonPart);
        logger.debug("Successfully parsed JSON", { parsed });
        
        if (parsed && parsed.tool && parsed.parameters) {
          results.push({
            tool: parsed.tool,
            parameters: parsed.parameters
          });
        }
      } catch (error: unknown) {
        const err = error instanceof Error ? error : new Error(String(error));
        logger.error("Failed to parse tool call", { line, error: err });
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
      const { query, sessionId } = parameters;
      
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
      const formattedResults = results.map(r => ({
        filepath: (r.payload as QdrantSearchResult['payload']).filepath,
        snippet: (r.payload as QdrantSearchResult['payload']).content.slice(0, 2000), // Limit snippet size
        last_modified: (r.payload as QdrantSearchResult['payload']).last_modified,
        relevance: r.score,
      }));
      
      return {
        sessionId: session.id,
        refinedQuery,
        relevanceScore,
        results: formattedResults
      };
    }
    
    case "get_repository_context": {
      const { query, sessionId } = parameters;
      
      // Get or create session
      const session = getOrCreateSession(sessionId, repoPath);
      
      const isGitRepo = await validateGitRepository(repoPath);
      const files = isGitRepo
        ? await git.listFiles({ fs, dir: repoPath, gitdir: path.join(repoPath, ".git"), ref: "HEAD" })
        : [];
      const diff = await getRepositoryDiff(repoPath);
      
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
      
      const context = results.map(r => ({
        filepath: (r.payload as QdrantSearchResult['payload']).filepath,
        snippet: (r.payload as QdrantSearchResult['payload']).content.slice(0, 2000), // Limit snippet size
        last_modified: (r.payload as QdrantSearchResult['payload']).last_modified,
        relevance: r.score,
      }));
      
      // Add query to session
      addQuery(session.id, query, results);
      
      return {
        sessionId: session.id,
        refinedQuery,
        recentQueries,
        diff,
        results: context
      };
    }
    
    case "generate_suggestion": {
      const { query, sessionId } = parameters;
      
      // Get or create session
      const session = getOrCreateSession(sessionId, repoPath);
      
      // First, use search_code internally to get relevant context
      const isGitRepo = await validateGitRepository(repoPath);
      const files = isGitRepo
        ? await git.listFiles({ fs, dir: repoPath, gitdir: path.join(repoPath, ".git"), ref: "HEAD" })
        : [];
      const _diff = await getRepositoryDiff(repoPath);
      
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
      const context = results.map(r => ({
        filepath: (r.payload as QdrantSearchResult['payload']).filepath,
        snippet: (r.payload as QdrantSearchResult['payload']).content.slice(0, 2000),
        last_modified: (r.payload as QdrantSearchResult['payload']).last_modified,
        relevance: r.score,
      }));
      
      const prompt = `
**Context**:
Repository: ${repoPath}
Files: ${files.slice(0, 10).join(", ")}${files.length > 10 ? "..." : ""}
Recent Changes: ${diff.substring(0, 500)}${diff.length > 500 ? "..." : ""}
${recentQueries.length > 0 ? `Recent Queries: ${recentQueries.join(", ")}` : ''}

**Relevant Snippets**:
${context.map(c => `File: ${c.filepath} (Last modified: ${c.last_modified}, Relevance: ${c.relevance.toFixed(2)})\n${c.snippet.substring(0, 500)}${c.snippet.length > 500 ? "..." : ""}`).join("\n\n")}

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
        suggestion,
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
        } catch (error) {
          return {
            changelog: "No changelog found"
          };
        }
      } catch (error) {
        return {
          error: "Failed to read changelog",
          changelog: "No changelog available"
        };
      }
    }
    
    case "analyze_code_problem": {
      const { query, sessionId } = parameters;
      
      // Get or create session
      const session = getOrCreateSession(sessionId, repoPath);
      
      // Step 1: Get repository context
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
        snippet: (r.payload as QdrantSearchResult['payload']).content.slice(0, 2000),
        last_modified: (r.payload as QdrantSearchResult['payload']).last_modified,
        relevance: r.score,
      }));
      
      // Step 2: Analyze the problem
      const analysisPrompt = `
**Code Problem Analysis**

Problem: ${query}

**Relevant Code**:
${context.map(c => `File: ${c.filepath}\n\`\`\`\n${c.snippet.substring(0, 500)}${c.snippet.length > 500 ? "..." : ""}\n\`\`\``).join("\n\n")}

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
  maxSteps: number = 5
): Promise<string> {
  incrementCounter('agent_runs');
  
  // Log the current provider and model being used by the agent
  logger.info(`Agent running with provider: ${global.CURRENT_SUGGESTION_PROVIDER}, model: ${global.CURRENT_SUGGESTION_MODEL}`);
  
  // Force refresh the provider to ensure we're using the latest settings
  // First clear any cached modules
  Object.keys(require.cache).forEach(key => {
    if (key.includes('llm-provider') || key.includes('deepseek') || key.includes('ollama')) {
      delete require.cache[key];
    }
  });
  
  // Load saved configuration to ensure we're using the correct model
  const { loadModelConfig } = await import('./model-persistence');
  loadModelConfig(true); // Force set the configuration
  
  // Import the clearProviderCache function and use it
  const { clearProviderCache } = await import('./llm-provider');
  clearProviderCache();
  
  const currentProvider = await getLLMProvider();
  const isConnected = await currentProvider.checkConnection();
  logger.info(`Agent confirmed provider: ${isConnected ? "connected" : "disconnected"}`);
  
  // Log the actual provider and model being used
  logger.info(`Agent using model: ${global.CURRENT_SUGGESTION_MODEL}, provider: ${global.CURRENT_SUGGESTION_PROVIDER}`);
  
  // Verify the provider is working with a test generation
  try {
    const _testResult = await currentProvider.generateText("Test message");
    logger.info(`Agent verified provider ${global.CURRENT_SUGGESTION_PROVIDER} is working`);
  } catch (error: unknown) {
    const err = error instanceof Error ? error : new Error(String(error));
    logger.error(`Agent failed to verify provider ${global.CURRENT_SUGGESTION_PROVIDER}`, { error: err });
  }
  
  return await timeExecution('agent_loop', async () => {
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
      
      // Get agent reasoning
      const agentOutput = await llmProvider.generateText(agentPrompt);
      
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
          
          const toolOutput = await executeToolCall(
            toolCall,
            qdrantClient,
            repoPath,
            suggestionModelAvailable
          );
          
          // Add step to agent state
          agentState.steps.push({
            tool: toolCall.tool,
            input: toolCall.parameters,
            output: toolOutput,
            reasoning: agentOutput
          } as AgentStep);
          
          // Add context from tool output
          agentState.context.push(toolOutput);
          
          // Update user prompt with tool results
          userPrompt += `\n\nTool: ${toolCall.tool}\nResults: ${JSON.stringify(toolOutput, null, 2)}\n\nBased on these results, what's your next step? If you have enough information, provide a final response to the user.`;
          
        } catch (error: unknown) {
          const err = error instanceof Error ? error : new Error(String(error));
          logger.error(`Error executing tool ${toolCall.tool}`, { error: err.message });
          
          // Add error to user prompt
          userPrompt += `\n\nError executing tool ${toolCall.tool}: ${err.message}\n\nPlease try a different approach or provide a response with the information you have.`;
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
      agentState.finalResponse = await llmProvider.generateText(finalPrompt);
    }
    
    // Add the final response as a suggestion in the session
    addSuggestion(session.id, query, agentState.finalResponse);
    
    // Format the final response
    const formattedResponse = `# CodeCompass Agent Response

${agentState.finalResponse}

Session ID: ${session.id} (Use this ID in future requests to maintain context)`;
    
    incrementCounter('agent_completions');
    return formattedResponse;
  });
}
