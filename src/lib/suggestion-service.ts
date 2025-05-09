import { v4 as uuidv4 } from 'uuid';
import { v4 as uuidv4 } from 'uuid';
import { LLMProvider } from "./llm-provider";
import { logger } from "./config-service"; // configService might not be directly used here anymore
import { incrementCounter, timeExecution, trackFeedbackScore } from "./metrics";
import { AgentInitialQueryResponse, AgentState } from './types';

// Re-define a local enhancedWithRetry or import a shared one if available.
// For now, let's assume the LLMProvider's generateText handles its own retries.
// If not, this service would need its own retry logic for orchestrating calls.

async function evaluateSuggestionInternal(
  originalPrompt: string,
  suggestion: string,
  llmProvider: LLMProvider
): Promise<{ score: number; feedback: string }> {
  try {
    const evaluationPrompt = `You are evaluating a response to the following request:
    
Request: ${originalPrompt}

Response:
${suggestion}

Evaluate this response on a scale of 1-10 based on:
1. Relevance to the request
2. Completeness of the answer
3. Accuracy of information
4. Clarity and structure

Provide your score (1-10) and specific feedback on how the response could be improved.
Format your answer as:
Score: [number]
Feedback: [your detailed feedback]`;

    // The LLMProvider's generateText should handle its own timeout and retries.
    const evaluationResponse = await llmProvider.generateText(evaluationPrompt);

    const scoreMatch = evaluationResponse.match(/Score:\s*(\d+)/i);
    const score = scoreMatch ? parseInt(scoreMatch[1], 10) : 5;

    const feedbackMatch = evaluationResponse.match(/Feedback:\s*([\s\S]+)/i);
    const feedback = feedbackMatch ? feedbackMatch[1].trim() : "No specific feedback provided.";

    trackFeedbackScore(score);
    return { score, feedback };
  } catch (error: unknown) {
    const err = error instanceof Error ? error : new Error(String(error));
    logger.warn("Failed to evaluate suggestion within SuggestionPlanner", { error: err.message });
    return { score: 7, feedback: "Evaluation failed, proceeding with original response." };
  }
}

export class SuggestionPlanner {
  private llmProvider: LLMProvider;

  constructor(llmProvider: LLMProvider) {
    this.llmProvider = llmProvider;
  }

  public async initiateAgentQuery(
    prompt: string, 
    sessionId?: string
  ): Promise<AgentInitialQueryResponse> {
    incrementCounter('suggestion_planner_initiate_requests');
    const resolvedSessionId = sessionId || uuidv4();

    try {
      const planText = await timeExecution('suggestion_planner_initiate_plan_generation_time', async () => {
        logger.info(`SuggestionPlanner: Generating plan for agent query (sessionId: ${resolvedSessionId}, prompt length: ${prompt.length})`);

        const planPrompt = `You are planning a response to the following request:
      
${prompt}

Break this down into logical steps. What information do you need? How will you structure your response?
Provide a concise plan with 3-5 steps.`;

        const plan = await this.llmProvider.generateText(planPrompt);
        logger.info(`SuggestionPlanner: Generated plan (sessionId: ${resolvedSessionId}): ${plan.substring(0, 100)}...`);
        incrementCounter('suggestion_planner_step_plan_success');
        return plan;
      });

      const agentState: AgentState = {
        sessionId: resolvedSessionId,
        query: prompt,
        planText: planText,
        steps: [], // No steps executed yet
        context: [],
        finalResponse: undefined,
        isComplete: false,
      };

      return {
        sessionId: resolvedSessionId,
        status: "PLAN_GENERATED",
        message: "Initial plan for agent query generated successfully.",
        generatedPlanText: planText,
        agentState: agentState,
      };

    } catch (error: unknown) {
      incrementCounter('suggestion_planner_initiate_errors');
      const err = error instanceof Error ? error : new Error(String(error));
      logger.error("SuggestionPlanner: Error during initiateAgentQuery", {
        sessionId: resolvedSessionId,
        message: err.message,
        promptLength: prompt.length,
        promptSnippet: prompt.slice(0, 100) + (prompt.length > 100 ? '...' : '')
      });

      // Return an error response consistent with AgentInitialQueryResponse
      const errorAgentState: AgentState = {
        sessionId: resolvedSessionId,
        query: prompt,
        steps: [],
        context: [],
        isComplete: false,
      };
      return {
        sessionId: resolvedSessionId,
        status: "ERROR",
        message: `SuggestionPlanner failed to generate plan: ${err.message}`,
        agentState: errorAgentState,
      };
    }
  }

  // The rest of the original planAndGenerate logic (execution, evaluation, refinement)
  // would be refactored into one or more new methods that can be called subsequently,
  // using the agentState and sessionId. For example:
  // public async executeAgentStep(agentState: AgentState): Promise<AgentStateUpdate> { ... }
  // This is beyond the current refactoring request.
}
