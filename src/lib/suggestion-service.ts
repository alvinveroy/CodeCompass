import { LLMProvider } from "./llm-provider";
import { configService, logger } from "./config-service";
import { incrementCounter, timeExecution, trackFeedbackScore } from "./metrics";

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

  public async planAndGenerate(prompt: string): Promise<string> {
    incrementCounter('suggestion_planner_requests');

    try {
      return await timeExecution('suggestion_planner_total_time', async () => {
        logger.info(`SuggestionPlanner: Generating suggestion for prompt (length: ${prompt.length})`);

        // Step 1: Plan the approach
        const planPrompt = `You are planning a response to the following request:
      
${prompt}

Break this down into logical steps. What information do you need? How will you structure your response?
Provide a concise plan with 3-5 steps.`;

        const plan = await timeExecution('suggestion_planner_step_plan', () => 
          this.llmProvider.generateText(planPrompt)
        );
        logger.info(`SuggestionPlanner: Generated plan: ${plan.substring(0, 100)}...`);
        incrementCounter('suggestion_planner_step_plan_success');

        // Step 2: Execute the plan to generate the suggestion
        const executionPrompt = `You previously created this plan to respond to a request:
      
${plan}

Now, execute this plan to respond to the original request:

${prompt}

Provide a comprehensive, well-structured response following your plan.`;

        const initialSuggestion = await timeExecution('suggestion_planner_step_execute', () =>
          this.llmProvider.generateText(executionPrompt)
        );
        incrementCounter('suggestion_planner_step_execute_success');

        // Step 3: Self-evaluate and refine if needed
        const evaluation = await timeExecution('suggestion_planner_step_evaluate', () =>
          evaluateSuggestionInternal(prompt, initialSuggestion, this.llmProvider)
        );
        incrementCounter('suggestion_planner_step_evaluate_success');
        
        if (evaluation.score < 7) {
          logger.info(`SuggestionPlanner: Low evaluation score (${evaluation.score}), refining suggestion`);
          const refinementPrompt = `You previously generated this response to the request:
        
Request: ${prompt}

Your response:
${initialSuggestion}

However, there are some issues with your response:
${evaluation.feedback}

Please provide an improved version addressing these issues.`;

          const refinedSuggestion = await timeExecution('suggestion_planner_step_refine', () =>
            this.llmProvider.generateText(refinementPrompt)
          );
          incrementCounter('suggestion_planner_step_refine_success');
          incrementCounter('suggestion_planner_final_success_refined');
          return refinedSuggestion;
        }
        
        incrementCounter('suggestion_planner_final_success_initial');
        return initialSuggestion;
      });
    } catch (error: unknown) {
      incrementCounter('suggestion_planner_errors');
      const err = error instanceof Error ? error : new Error(String(error));
      logger.error("SuggestionPlanner: Error during planAndGenerate", {
        message: err.message,
        promptLength: prompt.length,
        promptSnippet: prompt.slice(0, 100) + (prompt.length > 100 ? '...' : '')
      });
      throw new Error(`SuggestionPlanner failed: ${err.message}`);
    }
  }
}
