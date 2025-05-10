import { v4 as uuidv4 } from 'uuid';
import { LLMProvider } from "./llm-provider";
import { logger } from "./config-service";
import { AgentInitialQueryResponse, AgentState } from './types'; // Removed AgentStepExecutionResponse

// evaluateSuggestionInternal removed

export class SuggestionPlanner {
  private llmProvider: LLMProvider;

  constructor(llmProvider: LLMProvider) {
    this.llmProvider = llmProvider;
  }

  public async initiateAgentQuery(
    prompt: string,
    sessionId?: string
  ): Promise<AgentInitialQueryResponse> {
    const resolvedSessionId = sessionId || uuidv4();
    logger.info(`SuggestionPlanner: Initiating agent query for plan and summary (sessionId: ${resolvedSessionId}, prompt: "${prompt.substring(0, 50)}...")`);

    const agentState: AgentState = {
      sessionId: resolvedSessionId,
      query: prompt,
      planText: undefined,
      steps: [], // Steps will remain empty as we are not executing them
      context: [],
      finalResponse: undefined, // This will store the summary
      isComplete: false, // Will be set to true upon successful generation
    };

    try {
      const fullPrompt = `
User Query: "${prompt}"

Based on the user query, please perform the following two tasks:

1.  **Detailed Plan:** Create a detailed, step-by-step plan that outlines how to address the user's query. Each step should be clear and actionable.
2.  **Comprehensive Summary:** Provide a comprehensive summary that explains how following this plan would lead to a solution or answer for the user's query. This summary should synthesize the expected outcomes of the plan.

Structure your response clearly, with distinct sections for "PLAN" and "SUMMARY".

For example:

PLAN:
1.  Step 1 description.
2.  Step 2 description.
3.  Step 3 description.

SUMMARY:
By following the above plan, [explain how the plan addresses the query and what the outcome would be].
`;

      logger.info(`SuggestionPlanner: Generating plan and summary (sessionId: ${resolvedSessionId})`);
      const llmResponse = await this.llmProvider.generateText(fullPrompt);
      logger.info(`SuggestionPlanner: LLM response received (sessionId: ${resolvedSessionId}): ${llmResponse.substring(0, 200)}...`);

      // Parse the LLM response to extract plan and summary
      const planMatch = llmResponse.match(/PLAN:([\s\S]*?)SUMMARY:/i);
      const summaryMatch = llmResponse.match(/SUMMARY:([\s\S]*)/i);

      if (planMatch && planMatch[1] && summaryMatch && summaryMatch[1]) {
        agentState.planText = planMatch[1].trim();
        agentState.finalResponse = summaryMatch[1].trim(); // Summary stored in finalResponse
        agentState.isComplete = true;
        logger.info(`SuggestionPlanner: Successfully parsed plan and summary (sessionId: ${resolvedSessionId})`);
      } else {
        logger.warn(`SuggestionPlanner: Could not parse plan and summary from LLM response. Using full response as summary. (sessionId: ${resolvedSessionId})`);
        agentState.planText = "Could not parse plan from LLM response.";
        agentState.finalResponse = llmResponse; // Fallback: use the whole response as summary
        agentState.isComplete = true; // Still mark as complete, but with a parsing issue
      }
      
      return {
        sessionId: resolvedSessionId,
        status: "COMPLETED",
        message: "Agent successfully generated a plan and summary.",
        generatedPlanText: agentState.planText,
        agentState: agentState,
      };

    } catch (error: unknown) {
      const err = error instanceof Error ? error : new Error(String(error));
      logger.error("SuggestionPlanner: Error during agent query for plan and summary", {
        sessionId: resolvedSessionId,
        message: err.message,
        promptLength: prompt.length,
        promptSnippet: prompt.slice(0, 100) + (prompt.length > 100 ? '...' : '')
      });

      agentState.isComplete = true; // Mark as complete due to error
      agentState.planText = "Error generating plan.";
      agentState.finalResponse = `Error during agent processing: ${err.message}`;

      return {
        sessionId: resolvedSessionId,
        status: "ERROR",
        message: `SuggestionPlanner failed to generate plan and summary: ${err.message}`,
        generatedPlanText: agentState.planText,
        agentState: agentState,
      };
    }
  }

  // executeNextAgentStep method removed
}
