import { v4 as uuidv4 } from 'uuid';
import { LLMProvider } from "./llm-provider";
import { logger } from "./config-service"; // configService might not be directly used here anymore
import { incrementCounter, timeExecution, trackFeedbackScore } from "./metrics";
import { AgentInitialQueryResponse, AgentState, AgentStepExecutionResponse, AgentStep } from './types';

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

  public async executeNextAgentStep(
    currentState: AgentState
  ): Promise<AgentStepExecutionResponse> {
    incrementCounter('suggestion_planner_execute_step_requests');
    
    if (currentState.isComplete) {
      return {
        sessionId: currentState.sessionId,
        status: "COMPLETED",
        message: "Agent process is already complete.",
        agentState: currentState,
      };
    }

    if (!currentState.planText) {
      logger.error("SuggestionPlanner: Cannot execute next step, planText is missing.", { sessionId: currentState.sessionId });
      // Update state to reflect error
      currentState.isComplete = true; // Mark as complete to prevent further processing
      return {
        sessionId: currentState.sessionId,
        status: "ERROR",
        message: "Cannot execute next step: Plan text is missing from agent state.",
        agentState: currentState,
      };
    }

    try {
      const executedStepsSummary = currentState.steps.map(
        (s, index) => `Step ${index + 1}: ${s.reasoning || s.tool}\nOutput: ${s.output || JSON.stringify(s.input)}`
      ).join('\n\n') || 'No steps executed yet.';

      const executionPrompt = `
Original User Query:
${currentState.query}

Overall Plan:
${currentState.planText}

Previously Executed Steps:
${executedStepsSummary}

Based on the plan and the steps already taken, identify the single next logical step to work towards fulfilling the original user query.
1. Reasoning: Briefly describe your reasoning for choosing this specific next step.
2. Output: Execute the step and provide its output. This output should be self-contained for this step.
3. Plan Complete: Is the overall plan now complete with this step? Answer exactly "Yes" or "No".
4. Final Answer: If Plan Complete is "Yes", provide the final consolidated answer to the original user query, drawing from all executed steps. If "No", write "Not applicable".

Format your response strictly as follows, ensuring each label is on a new line:
Reasoning: [Your reasoning for this step]
Output: [The output of executing this step]
Plan Complete: [Yes/No]
Final Answer: [The final answer if Plan Complete is Yes, otherwise "Not applicable"]
`;

      logger.info(`SuggestionPlanner: Generating next step for agent query (sessionId: ${currentState.sessionId})`);
      const llmResponse = await timeExecution('suggestion_planner_execute_step_llm_time', () =>
        this.llmProvider.generateText(executionPrompt)
      );
      incrementCounter('suggestion_planner_execute_step_llm_success');
      logger.info(`SuggestionPlanner: LLM response for step execution (sessionId: ${currentState.sessionId}): ${llmResponse.substring(0,150)}...`);

      // Parse the structured LLM response
      const reasoningMatch = llmResponse.match(/Reasoning:\s*([\s\S]*?)(?=\nOutput:|\nPlan Complete:|$)/i);
      const outputMatch = llmResponse.match(/Output:\s*([\s\S]*?)(?=\nPlan Complete:|\nFinal Answer:|$)/i);
      const planCompleteMatch = llmResponse.match(/Plan Complete:\s*(Yes|No)/i);
      const finalAnswerMatch = llmResponse.match(/Final Answer:\s*([\s\S]*?$)/i);

      const reasoning = reasoningMatch ? reasoningMatch[1].trim() : "No reasoning provided by LLM.";
      const output = outputMatch ? outputMatch[1].trim() : "No output provided by LLM for this step.";
      const planComplete = planCompleteMatch ? planCompleteMatch[1].trim().toLowerCase() === 'yes' : false;
      let finalAnswer = finalAnswerMatch ? finalAnswerMatch[1].trim() : undefined;
      
      if (finalAnswer && (finalAnswer.toLowerCase() === "not applicable" || finalAnswer === "")) {
        finalAnswer = undefined;
      }

      const newStep: AgentStep = {
        tool: "LLM_STEP_EXECUTION", // Generic tool for now
        input: "Execution of next step based on plan", // Conceptual input
        output: output,
        reasoning: reasoning,
      };

      currentState.steps.push(newStep);
      currentState.isComplete = planComplete;
      if (planComplete && finalAnswer) {
        currentState.finalResponse = finalAnswer;
      } else if (planComplete && !finalAnswer) {
        // If LLM says complete but gives no final answer, we might use the last step's output
        // or synthesize one. For now, log a warning.
        logger.warn("SuggestionPlanner: Plan marked complete by LLM, but no final answer provided. Using last step output as fallback.", { sessionId: currentState.sessionId });
        currentState.finalResponse = output; // Fallback, could be improved
      }


      return {
        sessionId: currentState.sessionId,
        status: currentState.isComplete ? "COMPLETED" : "STEP_EXECUTED",
        message: currentState.isComplete ? "Agent process completed." : "Agent step executed successfully.",
        executedStep: newStep,
        agentState: currentState,
      };

    } catch (error: unknown) {
      incrementCounter('suggestion_planner_execute_step_errors');
      const err = error instanceof Error ? error : new Error(String(error));
      logger.error("SuggestionPlanner: Error during executeNextAgentStep", {
        sessionId: currentState.sessionId,
        message: err.message,
      });
      
      // Update state to reflect error, but don't mark as complete unless it's a fatal state.
      // For now, we'll let it be retried or handled by the caller.
      return {
        sessionId: currentState.sessionId,
        status: "ERROR",
        message: `SuggestionPlanner failed to execute next step: ${err.message}`,
        agentState: currentState, // Return current state, possibly with no new step
      };
    }
  }
}
