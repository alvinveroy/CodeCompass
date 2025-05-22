import { logger, configService } from "./config-service";
import { getLLMProvider } from "./llm-provider";
import { getOrCreateSession, addSuggestion, addAgentSteps } from "./state";
import { QdrantClient } from "@qdrant/js-client-rest";
import { getRepositoryDiff } from "./repository";
import { AgentState, ParsedToolCall } from "./types"; // Added ParsedToolCall
import path from "path";
import { z } from "zod";
import * as capabilities from "./agent_capabilities"; // Import all capabilities

// Define Zod schema for agent_query tool's parameters
const AgentQueryToolParamsSchema = z.object({
  user_query: z.string().describe("The user's detailed question or task regarding the codebase."),
  session_id: z.string().optional().describe("The session ID for maintaining context.")
});
export type AgentQueryToolParams = z.infer<typeof AgentQueryToolParamsSchema>;

// Define Zod schema for parsing capability calls from LLM output
// This is what the orchestrator LLM should output.
const CapabilityCallSchema = z.object({
  capability: z.string().describe("The name of the internal capability to call."),
  parameters: z.record(z.unknown()).describe("The parameters for the capability."),
  reasoning: z.string().optional().describe("The reasoning for choosing this capability and parameters.")
});
export type ParsedCapabilityCall = z.infer<typeof CapabilityCallSchema>;

// Add this schema definition near the other Zod schemas at the top of the file,
// or just before `capabilityDefinitions` array.
const FormattedSearchResultSchema = z.object({
  filepath: z.string(),
  snippet: z.string(),
  last_modified: z.string().optional(),
  relevance: z.number().optional(),
  is_chunked: z.boolean().optional(),
  original_filepath: z.string().optional(),
  chunk_index: z.number().int().optional(),
  total_chunks: z.number().int().optional(),
});
export type FormattedSearchResult = z.infer<typeof FormattedSearchResultSchema>;

// Define Parameter Schemas for Each Capability
const CapabilitySearchCodeSnippetsParamsSchema = z.object({
  query: z.string().describe("The search query string."),
});
export type CapabilitySearchCodeSnippetsParams = z.infer<typeof CapabilitySearchCodeSnippetsParamsSchema>;

const CapabilityGetRepositoryOverviewParamsSchema = z.object({
  query: z.string().describe("The query string to find relevant context and snippets."),
});
export type CapabilityGetRepositoryOverviewParams = z.infer<typeof CapabilityGetRepositoryOverviewParamsSchema>;

const CapabilityGetChangelogParamsSchema = z.object({}).describe("No parameters needed."); // Empty object for no params
export type CapabilityGetChangelogParams = z.infer<typeof CapabilityGetChangelogParamsSchema>;

const CapabilityFetchMoreSearchResultsParamsSchema = z.object({
  query: z.string().describe("The original or refined query string for which more results are needed."),
});
export type CapabilityFetchMoreSearchResultsParams = z.infer<typeof CapabilityFetchMoreSearchResultsParamsSchema>;

const CapabilityGetFullFileContentParamsSchema = z.object({
  filepath: z.string().describe("The path to the file within the repository."),
});
export type CapabilityGetFullFileContentParams = z.infer<typeof CapabilityGetFullFileContentParamsSchema>;

const CapabilityListDirectoryParamsSchema = z.object({
  dirPath: z.string().describe("The path to the directory within the repository."),
});
export type CapabilityListDirectoryParams = z.infer<typeof CapabilityListDirectoryParamsSchema>;

const CapabilityGetAdjacentFileChunksParamsSchema = z.object({
  filepath: z.string().describe("The path to the chunked file."),
  currentChunkIndex: z.number().int().min(0).describe("The 0-based index of the current chunk."),
});
export type CapabilityGetAdjacentFileChunksParams = z.infer<typeof CapabilityGetAdjacentFileChunksParamsSchema>;

const CapabilityGenerateSuggestionWithContextParamsSchema = z.object({
  query: z.string().describe("The user's original query or goal for the suggestion."),
  repoPathName: z.string().describe("The name of the repository (e.g., basename)."),
  filesContextString: z.string().describe("A string summarizing the relevant files or file list."),
  diffSummary: z.string().describe("A summary of recent repository changes (git diff)."),
  recentQueriesStrings: z.array(z.string()).describe("A list of recent related queries, if any."),
  relevantSnippets: z.array(FormattedSearchResultSchema).describe("An array of relevant code snippets and their metadata."),
});
export type CapabilityGenerateSuggestionWithContextParams = z.infer<typeof CapabilityGenerateSuggestionWithContextParamsSchema>;

const CapabilityAnalyzeCodeProblemWithContextParamsSchema = z.object({
  problemQuery: z.string().describe("The user's description of the code problem."),
  relevantSnippets: z.array(FormattedSearchResultSchema).describe("An array of code snippets relevant to the problem."),
});
export type CapabilityAnalyzeCodeProblemWithContextParams = z.infer<typeof CapabilityAnalyzeCodeProblemWithContextParamsSchema>;

// Define a type for the list of available capabilities to pass to the prompt
export interface CapabilityDefinition {
  name: keyof typeof capabilities; // Ensures name is a valid capability function
  description: string;
  parameters_schema: z.ZodType<unknown>; // Zod schema for parameters
}

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
        name: "agent_query",
        description: "Processes the user's complex query about the codebase. Analyzes the query, formulates a plan using available internal capabilities (like code search, file reading, history analysis), executes the plan step-by-step, and synthesizes the information to provide a comprehensive answer to the user's original request.",
        parameters: { // This matches AgentQueryToolParamsSchema structure for documentation
          user_query: "string - The user's detailed question or task regarding the codebase.",
          session_id: "string (optional) - The session ID for maintaining context across interactions."
        },
        requiresModel: true // The agent's planning and synthesis steps require an LLM.
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
export function generateAgentSystemPrompt(
  availableCapabilities: CapabilityDefinition[] // Changed parameter
): string {
  return `You are CodeCompass Orchestrator, an AI assistant that helps developers by understanding their queries about a codebase and breaking them down into a series of steps using available internal capabilities.
Your goal is to gather information piece by piece and then synthesize it to provide a comprehensive answer to the original user query.

You have access to the following internal capabilities:

${availableCapabilities.map(cap => `
Capability: ${cap.name}
Description: ${cap.description}
Parameters (JSON Schema): ${JSON.stringify(cap.parameters_schema?._def || { description: cap.parameters_schema?.description }, null, 2)}
`).join('\n')}

When responding to the user's main query, follow these steps:
1. Analyze the user's query to understand their intent and what information is needed.
2. Formulate a plan. Think step-by-step.
3. Choose the most appropriate capability to execute next to gather a piece of information for your plan.
4. Explain your reasoning for choosing this capability and specify the exact parameters to use.
5. **CRITICAL**: Format your chosen capability call as a single, valid JSON object. This JSON object **MUST BE THE ONLY CONTENT** in your response. Do not include any other text before or after the JSON object.
   Example JSON format:
   {"capability": "capability_name", "parameters": {...parameters_object...}, "reasoning": "Your reasoning here..."}
6. After receiving the results from the capability, analyze them.
7. Decide if you have enough information to answer the user's original query.
   - If yes, provide a comprehensive final answer to the user. Do NOT use the JSON capability call format for the final answer. Just provide the answer as plain text.
   - If no, repeat from step 3, choosing the next best capability.
8. If you believe you are making progress on a complex task but require more processing steps than initially allocated, you can output a special JSON object:
   {"capability": "request_more_processing_time", "parameters": {"reasoning": "Your reason for needing more time..."}, "reasoning": "Need more iterations."}
   This may allow you additional interactions. Use this judiciously.

Important guidelines:
- Break down complex queries into multiple capability calls.
- Accumulate context from the results of each capability call.
- Be concise in your reasoning for choosing a capability.
- Only use capabilities that are relevant to gathering information for the user's query.
- Ensure parameters match the schema for the chosen capability.
- If a capability requires context gathered by previous capabilities (e.g., 'capability_generateSuggestionWithContext' needs 'relevantSnippets'), ensure you have gathered that context first.
- If after using available capabilities you still lack sufficient information, clearly state in your final answer that it's based on limited information and specify what was lacking.
- Do not hallucinate. If you cannot answer confidently, explain what's missing.

Example of choosing a capability:
User Query: "Find functions related to user authentication in 'src/auth.ts'"

Your thought process:
1. The user wants to find functions in a specific file related to a topic.
2. First, I should get the content of 'src/auth.ts'.
3. Then, I can analyze that content for "user authentication" functions. (Or, if a search capability is very good, I might try searching directly).
Let's start by getting the file content.

Your output (JSON only):
{"capability": "capability_getFullFileContent", "parameters": {"filepath": "src/auth.ts"}, "reasoning": "Need to retrieve the content of 'src/auth.ts' to analyze it for authentication functions."}

After getting the file content, you might then decide you have enough information to answer, or you might use another capability (e.g., a hypothetical 'analyze_code_for_topic' if it existed, or simply use your own intelligence to parse the retrieved content for the final answer).
If providing the final answer, your output would be plain text, e.g.:
"In 'src/auth.ts', the following functions appear related to user authentication: \`loginUser()\`, \`verifyToken()\`, ..."
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

// Add this new function:
export function parseCapabilityCall(llmOutput: string): ParsedCapabilityCall | null {
  try {
    // Assuming the LLM outputs *only* the JSON object for a capability call.
    const trimmedOutput = llmOutput.trim();
    // Basic check to see if it looks like a JSON object
    if (trimmedOutput.startsWith("{") && trimmedOutput.endsWith("}")) {
      const parsedJson = JSON.parse(trimmedOutput);
      const validationResult = CapabilityCallSchema.safeParse(parsedJson);
      if (validationResult.success) {
        logger.debug("Successfully parsed capability call", { data: validationResult.data });
        return validationResult.data;
      } else {
        logger.warn("Parsed JSON does not match CapabilityCallSchema", { errors: validationResult.error.issues, json: parsedJson });
      }
    }
  } catch (error) {
    const _err = error instanceof Error ? error : new Error(String(error));
    logger.warn("Failed to parse LLM output as a capability call JSON", { output: llmOutput, error: _err.message });
  }
  return null; // Return null if not a valid capability call
}

// Add this new async function:
async function runAgentQueryOrchestrator(
  params: AgentQueryToolParams,
  qdrantClient: QdrantClient,
  repoPath: string,
  suggestionModelAvailable: boolean // This indicates if LLM-dependent capabilities can be used
): Promise<string> { // Returns the final synthesized answer string
  const { user_query, session_id } = params;
  logger.info(`Agent Query Orchestrator started for user query: "${user_query}" (Session: ${session_id || 'new'})`);

  const session = getOrCreateSession(session_id, repoPath);
  const agentState: AgentState = createAgentState(session.id, user_query); // createAgentState might need adjustment if it sets up a plan

  // Define available capabilities for the orchestrator's prompt
  // This list needs to be maintained and schemas defined for each capability's parameters.
  const capabilityDefinitions: CapabilityDefinition[] = [
    { name: "capability_searchCodeSnippets", description: "Searches for code snippets in the repository based on a query string.", parameters_schema: CapabilitySearchCodeSnippetsParamsSchema },
    { name: "capability_getRepositoryOverview", description: "Gets an overview of the repository including recent changes (diff summary) and relevant code snippets for a query.", parameters_schema: CapabilityGetRepositoryOverviewParamsSchema },
    { name: "capability_getChangelog", description: "Retrieves the project's CHANGELOG.md file.", parameters_schema: CapabilityGetChangelogParamsSchema },
    { name: "capability_fetchMoreSearchResults", description: "Fetches more search results for a given query, typically used if initial results are insufficient.", parameters_schema: CapabilityFetchMoreSearchResultsParamsSchema },
    { name: "capability_getFullFileContent", description: "Retrieves the full content of a specified file.", parameters_schema: CapabilityGetFullFileContentParamsSchema },
    { name: "capability_listDirectory", description: "Lists the contents (files and subdirectories) of a specified directory.", parameters_schema: CapabilityListDirectoryParamsSchema },
    { name: "capability_getAdjacentFileChunks", description: "Retrieves code chunks adjacent to a previously identified chunk of a file.", parameters_schema: CapabilityGetAdjacentFileChunksParamsSchema },
    // LLM-dependent capabilities - orchestrator should gather context first, then LLM synthesizes.
    // Or, these could be called by the orchestrator if the LLM explicitly plans to use them for final synthesis.
    { name: "capability_generateSuggestionWithContext", description: "Generates a code suggestion based on a query and extensive provided context (files, diff, snippets). Call this after gathering sufficient context.", parameters_schema: CapabilityGenerateSuggestionWithContextParamsSchema },
    { name: "capability_analyzeCodeProblemWithContext", description: "Analyzes a code problem based on a query and provided relevant code snippets. Call this after gathering snippets.", parameters_schema: CapabilityAnalyzeCodeProblemWithContextParamsSchema },
  ];

  const orchestratorSystemPrompt = generateAgentSystemPrompt(capabilityDefinitions);
  let currentPromptContent = `Original User Query: ${user_query}\n\nAnalyze this query and formulate a plan. Then, choose your first capability call or provide a direct answer if no capabilities are needed.`;

  let orchestratorSteps = 0;
  const maxOrchestratorSteps = configService.AGENT_ABSOLUTE_MAX_STEPS; // Use absolute max for the orchestrator's internal loop

  const capabilityContext: capabilities.CapabilityContext = {
    qdrantClient,
    repoPath,
    suggestionModelAvailable,
  };

  while (orchestratorSteps < maxOrchestratorSteps && !agentState.isComplete) {
    orchestratorSteps++;
    logger.info(`Orchestrator Step ${orchestratorSteps}/${maxOrchestratorSteps} for query: "${user_query}"`);

    const fullPrompt = `${orchestratorSystemPrompt}\n\n${currentPromptContent}`;
    const llmProvider = await getLLMProvider(); // Get provider inside loop if it can change, or outside if static
    
    logger.debug(`Orchestrator (step ${orchestratorSteps}) sending prompt to LLM. Length: ${fullPrompt.length}`);
    // logger.silly("Orchestrator prompt content:", { prompt: fullPrompt }); // Potentially very verbose

    let llmResponseText: string;
    try {
        const timeoutPromise = new Promise<string>((_, reject) => {
          setTimeout(() => reject(new Error("Orchestrator LLM call timed out")), configService.AGENT_QUERY_TIMEOUT);
        });
        llmResponseText = await Promise.race([
          llmProvider.generateText(fullPrompt),
          timeoutPromise
        ]);
        logger.debug(`Orchestrator (step ${orchestratorSteps}) LLM response received. Length: ${llmResponseText.length}`);
    } catch (error) {
        const err = error instanceof Error ? error : new Error(String(error));
        logger.error(`Orchestrator LLM call failed or timed out: ${err.message}`);
        agentState.finalResponse = `Error during orchestration: LLM call failed. ${err.message}`;
        agentState.isComplete = true;
        break;
    }

    const parsedCapability = parseCapabilityCall(llmResponseText);

    if (parsedCapability) {
      if (parsedCapability.capability === "request_more_processing_time") {
        // This special capability doesn't actually exist in agent_capabilities.ts
        // It's a signal from the LLM. The loop condition already uses absolute max.
        // We could potentially extend a softer limit here if we had one.
        logger.info("Orchestrator: LLM requested more processing time.", { reasoning: parsedCapability.parameters.reasoning });
        currentPromptContent += `\n\nThought: Processing time extension acknowledged. Current step ${orchestratorSteps}/${maxOrchestratorSteps}. Continue planning.`;
        // Add a step to agentState to record this request
        agentState.steps.push({
            tool: "internal_request_more_time", // Use a distinct name
            input: parsedCapability.parameters,
            output: { status: "Acknowledged, loop continues up to absolute max steps." },
            reasoning: parsedCapability.reasoning || "LLM requested more processing time."
        });
        if (orchestratorSteps >= maxOrchestratorSteps -1) { // -1 because step will increment
             logger.warn("Orchestrator: LLM requested more time, but already at absolute max steps. Will terminate after this.");
        }
        continue; // Continue to the next iteration, allowing LLM to make another decision
      }

      const rawCapabilityName = parsedCapability.capability;
      // Type guard to check if rawCapabilityName is a valid key of capabilities
      if (Object.prototype.hasOwnProperty.call(capabilities, rawCapabilityName)) {
        const capabilityName = rawCapabilityName as keyof typeof capabilities; // Now safer
        const capabilityFunc = capabilities[capabilityName];

        if (typeof capabilityFunc === 'function') {
          const capabilityDef = capabilityDefinitions.find(cd => cd.name === capabilityName);
          if (!capabilityDef) {
            // This case should ideally not be hit if capabilityName is derived from `keyof typeof capabilities`
            // and capabilityDefinitions is comprehensive.
            logger.error(`Orchestrator: Capability definition not found for known capability "${capabilityName}"`);
            currentPromptContent += `\n\nInternal Error: Capability definition missing for "${capabilityName}". Please report this.`;
            agentState.steps.push({
                tool: "internal_error",
                input: { capability_name: capabilityName },
                output: { error: `Capability definition for "${capabilityName}" not found internally.` },
                reasoning: "Internal error during capability definition lookup."
            });
          } else {
            // Validate parameters
            const validationResult = capabilityDef.parameters_schema.safeParse(parsedCapability.parameters);

            if (!validationResult.success) {
              logger.warn(`Orchestrator: Invalid parameters for capability ${capabilityName}. Errors:`, { errors: validationResult.error.issues, providedParams: parsedCapability.parameters });
              currentPromptContent += `\n\nError: Invalid parameters provided for capability "${capabilityName}".
Expected schema: ${JSON.stringify(capabilityDef.parameters_schema?._def || { description: capabilityDef.parameters_schema?.description }, null, 2)}
Errors: ${validationResult.error.issues.map(issue => `${issue.path.join('.')}: ${issue.message}`).join(', ')}
Please correct the parameters and try again.`;
              agentState.steps.push({
                tool: capabilityName,
                input: parsedCapability.parameters,
                output: { error: "Invalid parameters", details: validationResult.error.issues },
                reasoning: parsedCapability.reasoning || "Attempted to call capability with invalid parameters."
              });
            } else {
              // Parameters are valid, proceed with execution
              try {
                logger.info(`Orchestrator executing capability: ${capabilityName}`, { params: validationResult.data });
                // eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-assignment
                const capabilityResult = await capabilityFunc(capabilityContext, validationResult.data as any);

                agentState.steps.push({
                  tool: capabilityName,
                input: validationResult.data, // Log validated and potentially transformed data
                output: capabilityResult,
                // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
                reasoning: parsedCapability.reasoning || llmResponseText
              });

              // NEW: Add significant results to agentState.context
              // Store the output of successful capability calls.
              agentState.context.push({
                sourceCapability: capabilityName,
                timestamp: new Date().toISOString(),
                data: capabilityResult
              });

              currentPromptContent += `\n\nExecuted Capability: ${capabilityName}\nParameters: ${JSON.stringify(validationResult.data)}\nResults: ${stringifyStepOutput(capabilityResult)}\n\nWhat is your next step or final answer?`;
            } catch (capError) {
              const cErr = capError instanceof Error ? capError : new Error(String(capError));
              logger.error(`Orchestrator: Error executing capability ${capabilityName}: ${cErr.message}`, { stack: cErr.stack });
              currentPromptContent += `\n\nError executing capability ${capabilityName}: ${cErr.message}. Please try a different approach or provide a response with the information you have.`;
              agentState.steps.push({
                tool: capabilityName,
                input: validationResult.data,
                output: { error: `Failed to execute: ${cErr.message}` },
                reasoning: parsedCapability.reasoning || "Attempted to call capability, but execution failed."
              });
            }
          }
        }
        } else {
          // This case should ideally not be hit if all entries in 'capabilities' are functions.
          logger.warn(`Orchestrator: Capability "${capabilityName}" found but is not a function.`);
              currentPromptContent += `\n\nInternal Error: Capability "${capabilityName}" is not executable.`;
              agentState.steps.push({
                  tool: "internal_error_non_function_capability",
                  input: { capability_name: capabilityName },
                  output: { error: `Capability "${capabilityName}" is not executable.` },
                  reasoning: "Internal error: capability entry is not a function."
              });
            }
      } else {
        // This 'else' handles the case where rawCapabilityName is not a key of 'capabilities'
        // This replaces the old 'else' block that handled unknown capabilities.
        logger.warn(`Orchestrator: LLM tried to call unknown capability "${rawCapabilityName}"`);
        currentPromptContent += `\n\nError: You tried to call an unknown capability: "${rawCapabilityName}". Please choose from the available capabilities.`;
        agentState.steps.push({
            tool: "unknown_capability_call",
            input: { capability_name: rawCapabilityName, parameters: parsedCapability.parameters },
            output: { error: `Capability "${rawCapabilityName}" not found.` },
            reasoning: parsedCapability.reasoning || "LLM attempted to call an unknown capability."
        });
      }
    } else {
      // Not a capability call, assume it's the final answer
      logger.info("Orchestrator: LLM provided a final answer.");
      agentState.finalResponse = llmResponseText;
      agentState.isComplete = true;
    }
  } // End of while loop

  if (!agentState.isComplete) {
    logger.warn(`Orchestrator reached max steps (${maxOrchestratorSteps}) without a final answer. Synthesizing a fallback response.`);
    // Ask LLM to synthesize based on current state if no explicit final answer was given
    const fallbackPrompt = `${orchestratorSystemPrompt}\n\n${currentPromptContent}\n\nYou have reached the maximum number of steps. Please provide your final answer to the user based on the information collected so far.`;
    const llmProvider = await getLLMProvider();
    try {
        agentState.finalResponse = await Promise.race([
            llmProvider.generateText(fallbackPrompt),
            new Promise<string>((_, reject) => setTimeout(() => reject(new Error("Fallback response generation timed out")), configService.AGENT_QUERY_TIMEOUT / 2)) // Shorter timeout
        ]);
    } catch (fallbackError) {
        const fbErr = fallbackError instanceof Error ? fallbackError : new Error(String(fallbackError));
        logger.error(`Orchestrator: Fallback response generation failed: ${fbErr.message}`);
        agentState.finalResponse = "The agent reached its processing limit and could not generate a final summary. Please try rephrasing your query or contact support if this persists.";
    }
    agentState.isComplete = true;
  }

  // Persist final state to session (optional, depending on how session state is used later)
  // For now, addSuggestion handles adding the final response.
  // updateContext(session.id, repoPath, undefined, agentState); // If we want to save full agent state

  // Persist the final response as a suggestion
  addSuggestion(session.id, user_query, agentState.finalResponse || "No final response generated.");
  
  // NEW: Persist the full agent state to the session
  // The `context` field within `agentState` is now populated with capability outputs.
  // The third argument to updateContext (for general context items) can be undefined
  // as we are managing context within agentState.
  addAgentSteps(session.id, agentState.query, agentState.steps, agentState.finalResponse || "No final response was generated.");
  logger.info(`Orchestrator finished. Full agent state for session ${session.id} persisted. Final response added.`);
  
  return agentState.finalResponse || "No final response was generated by the orchestrator.";
}

// Execute a tool call
export async function executeToolCall(
  toolCall: { tool: string; parameters: unknown },
  qdrantClient: QdrantClient,
  repoPath: string,
  suggestionModelAvailable: boolean
): Promise<unknown> {
  const { tool, parameters } = toolCall;
  const toolInfo = toolRegistry.find(t => t.name === tool);

  if (!toolInfo) {
    logger.error(`Tool not found: ${tool}`);
    throw new Error(`Tool not found: ${tool}`);
  }

  // This check is important as agent_query (and thus orchestration) requires an LLM.
  if (toolInfo.requiresModel && !suggestionModelAvailable) {
    logger.warn(`Attempt to use model-dependent tool '${tool}' when model is unavailable.`);
    throw new Error(`Tool ${tool} requires the suggestion model which is not available`);
  }

  switch (tool) {
    case "agent_query": {
      // Validate parameters for agent_query
      const validationResult = AgentQueryToolParamsSchema.safeParse(parameters);
      if (!validationResult.success) {
        logger.error("Invalid parameters for agent_query tool", { errors: validationResult.error.issues, params: parameters });
        throw new Error(`Invalid parameters for agent_query: ${validationResult.error.message}`);
      }
      // Call the orchestrator
      return await runAgentQueryOrchestrator(
        validationResult.data,
        qdrantClient,
        repoPath,
        suggestionModelAvailable
      );
    }
    // Cases for old tools (search_code, get_repository_context, etc.) should be removed
    // as they are no longer directly callable tools.
    // If they are still present, ensure they throw an error indicating they are refactored.
    case "search_code": // Example of how to mark old tools
    case "get_repository_context":
    case "generate_suggestion":
    case "get_changelog":
    case "analyze_code_problem":
    case "request_additional_context":
    case "request_more_processing_steps":
      logger.error(`Attempted to call refactored tool '${tool}' directly.`);
      throw new Error(`Tool '${tool}' is an internal capability and cannot be called directly. Use 'agent_query'.`);

    default:
      logger.error(`Tool execution not implemented: ${tool}`);
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
): Promise<string> { // Returns the final formatted response string
  logger.info(`Outer Agent Loop started for query: "${query}" (Session: ${sessionId || 'new'})`);
  
  // Ensure provider is ready (existing logic from your file)
  logger.info(`Agent running with provider: ${configService.SUGGESTION_PROVIDER}, model: ${configService.SUGGESTION_MODEL}`);
  const currentProvider = await getLLMProvider(); // Force refresh handled by getLLMProvider if needed
  const isConnected = await currentProvider.checkConnection();
  logger.info(`Agent confirmed provider: ${isConnected ? "connected" : "disconnected"}`);
  if (!isConnected && suggestionModelAvailable) { // suggestionModelAvailable implies we expect a connection
      logger.error(`Agent provider ${configService.SUGGESTION_PROVIDER} is not connected. Aborting.`);
      return "Error: The AI suggestion provider is not connected. Please check your configuration and network.";
  }
  // Test generation (existing logic)
  if (suggestionModelAvailable) {
    try {
        const _testResult = await currentProvider.generateText("Test message");
        logger.info(`Agent verified provider ${configService.SUGGESTION_PROVIDER} is working`);
    } catch (error: unknown) {
        logger.error(`Agent failed to verify provider ${configService.SUGGESTION_PROVIDER}: ${error instanceof Error ? error.message : String(error)}`);
        return `Error: Failed to verify the AI suggestion provider. ${error instanceof Error ? error.message : String(error)}`;
    }
  } else {
     logger.info("Suggestion model is not available. Agent will operate in a limited mode if possible, or fail if agent_query requires it.");
     // agent_query requires a model, so this path will likely lead to an error in executeToolCall if suggestionModelAvailable is false.
  }

  const session = getOrCreateSession(sessionId, repoPath);

  // The outer loop's system prompt is now very simple, guiding towards agent_query.
  // Or, we can assume the LLM will always pick agent_query if it's the only one.
  // For robustness, let's provide a minimal system prompt.
  const outerSystemPrompt = `You are a helpful assistant. To answer any user query about the codebase, you MUST use the "agent_query" tool.
Tool: agent_query
Description: ${toolRegistry[0].description}
Parameters: ${JSON.stringify(toolRegistry[0].parameters, null, 2)}`;

  const initialUserPromptForOuterLoop = `User query: ${query}\n\nPlease use the "agent_query" tool to process this query.`;
  const agentPrompt = `${outerSystemPrompt}\n\n${initialUserPromptForOuterLoop}`;

  let finalAnswer: string;

  try {
    logger.info("Outer loop: Requesting LLM to invoke agent_query tool.");
    const llmProvider = await getLLMProvider();
    const llmOutput = await llmProvider.generateText(agentPrompt); // LLM should output a TOOL_CALL for agent_query

    const toolCalls = parseToolCalls(llmOutput); // Existing parseToolCalls

    if (toolCalls.length > 0 && toolCalls[0].tool === "agent_query") {
      logger.info("Outer loop: LLM correctly chose agent_query. Executing...");
      // Execute agent_query, which now contains the main orchestration logic
      const orchestratorResponse = await executeToolCall(
        toolCalls[0], // Assuming the first (and only) call is agent_query
        qdrantClient,
        repoPath,
        suggestionModelAvailable
      );
      finalAnswer = typeof orchestratorResponse === 'string' ? orchestratorResponse : JSON.stringify(orchestratorResponse);
    } else {
      logger.warn("Outer loop: LLM did not call agent_query as expected. Output was:", { llmOutput });
      finalAnswer = "The agent did not follow instructions to use the 'agent_query' tool. Raw LLM output: " + llmOutput;
      addSuggestion(session.id, query, finalAnswer); // Log this unexpected response
    }
  } catch (error) {
    const err = error instanceof Error ? error : new Error(String(error));
    logger.error(`Error in outer agent loop: ${err.message}`, { stack: err.stack });
    finalAnswer = `An error occurred while processing your request: ${err.message}`;
    addSuggestion(session.id, query, finalAnswer); // Log error response
  }
  
  const formattedResponse = `# CodeCompass Agent Response

${finalAnswer}

Session ID: ${session.id} (Use this ID in future requests to maintain context)`;
  
  return formattedResponse;
}
