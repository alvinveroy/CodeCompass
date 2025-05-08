import axios from "axios";
import { logger, OLLAMA_HOST, SUGGESTION_MODEL, MAX_INPUT_LENGTH, REQUEST_TIMEOUT, MAX_RETRIES, RETRY_DELAY } from "./config";
import { OllamaEmbeddingResponse, OllamaGenerateResponse } from "./types";
import { preprocessText } from "./utils";
import { incrementCounter, timeExecution, trackFeedbackScore } from "./metrics";

/**
 * Check if Ollama server is running and accessible
 * @returns Promise<boolean> - True if Ollama is accessible, false otherwise
 */
export async function checkOllama(): Promise<boolean> {
  const host = process.env.OLLAMA_HOST || OLLAMA_HOST;
  logger.info(`Checking Ollama at ${host}`);
  
  try {
    await enhancedWithRetry(async () => {
      const response = await axios.get(host, { timeout: 10000 });
      logger.info(`Ollama status: ${response.status}`);
    });
    return true;
  } catch (error: unknown) {
    const err = error instanceof Error ? error : new Error(String(error));
    logger.error(`Failed to connect to Ollama: ${err.message}`);
    return false;
  }
}

/**
 * Check if a specific Ollama model is available
 * @param model - The model name to check
 * @param isEmbeddingModel - Whether this is an embedding model
 * @returns Promise<boolean> - True if model is available, false otherwise
 */
export async function checkOllamaModel(model: string, isEmbeddingModel: boolean): Promise<boolean> {
  const host = process.env.OLLAMA_HOST || OLLAMA_HOST;
  logger.info(`Checking Ollama model: ${model}`);
  
  try {
    if (isEmbeddingModel) {
      const response = await axios.post<OllamaEmbeddingResponse>(
        `${host}/api/embeddings`,
        { model, prompt: "test" },
        { timeout: 10000 }
      );
      if (response.status === 200 && response.data.embedding) {
        logger.info(`Ollama model ${model} is available`);
        return true;
      }
    } else {
      const response = await axios.post<OllamaGenerateResponse>(
        `${host}/api/generate`,
        { model, prompt: "test", stream: false },
        { timeout: 10000 }
      );
      if (response.status === 200 && response.data.response) {
        logger.info(`Ollama model ${model} is available`);
        return true;
      }
    }
    throw new Error(`Model ${model} not functional`);
  } catch (error: unknown) {
    const err = error instanceof Error ? error : new Error(String(error));
    const axiosError = error as { response?: { status: number; data: unknown } };
    
    logger.error(`Ollama model check error for ${model}`, {
      message: err.message,
      response: axiosError.response
        ? {
            status: axiosError.response.status,
            data: axiosError.response.data,
          }
        : null,
    });
    throw new Error(
      `Ollama model ${model} is not available. Pull it with: ollama pull ${model}`
    );
  }
}

// Enhanced withRetry function with exponential backoff
async function enhancedWithRetry<T>(
  fn: () => Promise<T>, 
  retries = MAX_RETRIES, 
  initialDelay = RETRY_DELAY
): Promise<T> {
  let lastError: Error | undefined;
  let currentDelay = initialDelay;
  
  for (let i = 0; i < retries; i++) {
    try {
      return await fn();
    } catch (error: unknown) {
      const err = error instanceof Error ? error : new Error(String(error));
      lastError = err;
      
      // Check if it's a timeout error
      const axiosError = error as { code?: string; response?: { status: number } };
      const isTimeout = axiosError.code === 'ECONNABORTED' || 
                        err.message.includes('timeout') ||
                        axiosError.response?.status === 500;
      
      if (isTimeout) {
        logger.warn(`Request timed out (attempt ${i + 1}/${retries}). Retrying in ${currentDelay}ms...`);
      } else {
        logger.warn(`Retry ${i + 1}/${retries} after error: ${error.message}`);
      }
      
      // Wait before retrying with exponential backoff
      await new Promise(resolve => setTimeout(resolve, currentDelay));
      currentDelay *= 2; // Exponential backoff
    }
  }
  
  throw lastError || new Error("All retries failed");
}

/**
 * Generate embeddings for text using Ollama
 * @param text - The text to generate embeddings for
 * @returns Promise<number[]> - The embedding vector
 */
export async function generateEmbedding(text: string): Promise<number[]> {
  incrementCounter('embedding_requests');
  
  const processedText = preprocessText(text);
  const truncatedText = processedText.length > MAX_INPUT_LENGTH ? processedText.slice(0, MAX_INPUT_LENGTH) : processedText;
  
  try {
    return await timeExecution('embedding_generation', async () => {
      const host = process.env.OLLAMA_HOST || OLLAMA_HOST;
      // Always use nomic-embed-text:v1.5 for embeddings
      const model = "nomic-embed-text:v1.5";
      
      const response = await enhancedWithRetry(async () => {
        logger.info(`Generating embedding for text (length: ${truncatedText.length}, snippet: "${truncatedText.slice(0, 100)}...")`);
        const res = await axios.post<OllamaEmbeddingResponse>(
          `${host}/api/embeddings`,
          { model: model, prompt: truncatedText },
          { timeout: REQUEST_TIMEOUT }
        );
        
        if (!res.data.embedding || !Array.isArray(res.data.embedding)) {
          throw new Error("Invalid embedding response from Ollama API");
        }
        
        return res.data;
      });
      
      incrementCounter('embedding_success');
      return response.embedding;
    });
  } catch (error: unknown) {
    incrementCounter('embedding_errors');
    const err = error instanceof Error ? error : new Error(String(error));
    const axiosError = error as { 
      code?: string; 
      config?: unknown; 
      response?: { status: number; data: unknown } 
    };
    
    logger.error("Ollama embedding error", {
      message: err.message,
      code: axiosError.code,
      config: axiosError.config,
      response: axiosError.response
        ? {
            status: axiosError.response.status,
            data: axiosError.response.data,
          }
        : null,
      inputLength: truncatedText.length,
      inputSnippet: truncatedText.slice(0, 100),
    });
    throw new Error(`Failed to generate embedding: ${err.message}`);
  }
}

// Generate Suggestion with multi-step reasoning
export async function generateSuggestion(prompt: string): Promise<string> {
  incrementCounter('suggestion_requests');
  
  try {
    return await timeExecution('suggestion_generation', async () => {
      logger.info(`Generating suggestion for prompt (length: ${prompt.length})`);
      
      // Step 1: Plan the approach
      const planPrompt = `You are planning a response to the following request:
      
${prompt}

Break this down into logical steps. What information do you need? How will you structure your response?
Provide a concise plan with 3-5 steps.`;
      
      const plan = await enhancedWithRetry(async () => {
        const res = await axios.post<OllamaGenerateResponse>(
          `${OLLAMA_HOST}/api/generate`,
          { model: SUGGESTION_MODEL, prompt: planPrompt, stream: false },
          { timeout: REQUEST_TIMEOUT }
        );
        return res.data.response;
      });
      
      logger.info(`Generated plan: ${plan.substring(0, 100)}...`);
      
      // Step 2: Execute the plan to generate the suggestion
      const executionPrompt = `You previously created this plan to respond to a request:
      
${plan}

Now, execute this plan to respond to the original request:

${prompt}

Provide a comprehensive, well-structured response following your plan.`;
      
      const response = await enhancedWithRetry(async () => {
        const res = await axios.post<OllamaGenerateResponse>(
          `${OLLAMA_HOST}/api/generate`,
          { model: SUGGESTION_MODEL, prompt: executionPrompt, stream: false },
          { timeout: REQUEST_TIMEOUT }
        );
        return res.data;
      });
      
      // Step 3: Self-evaluate and refine if needed
      const evaluation = await evaluateSuggestion(prompt, response.response);
      
      // If evaluation score is low, refine the response
      if (evaluation.score < 7) {
        logger.info(`Low evaluation score (${evaluation.score}), refining suggestion`);
        
        const refinementPrompt = `You previously generated this response to the request:
        
Request: ${prompt}

Your response:
${response.response}

However, there are some issues with your response:
${evaluation.feedback}

Please provide an improved version addressing these issues.`;
        
        const refinedResponse = await enhancedWithRetry(async () => {
          const res = await axios.post<OllamaGenerateResponse>(
            `${OLLAMA_HOST}/api/generate`,
            { model: SUGGESTION_MODEL, prompt: refinementPrompt, stream: false },
            { timeout: REQUEST_TIMEOUT }
          );
          return res.data.response;
        });
        
        incrementCounter('suggestion_refinements');
        incrementCounter('suggestion_success');
        return refinedResponse;
      }
      
      incrementCounter('suggestion_success');
      return response.response;
    });
  } catch (error: unknown) {
    incrementCounter('suggestion_errors');
    const err = error instanceof Error ? error : new Error(String(error));
    const axiosError = error as { code?: string; response?: { status: number; data: unknown } };
    
    logger.error("Ollama suggestion error", {
      message: err.message,
      code: axiosError.code,
      response: axiosError.response
        ? {
            status: axiosError.response.status,
            data: axiosError.response.data,
          }
        : null,
      promptLength: prompt.length,
      promptSnippet: prompt.slice(0, 100) + (prompt.length > 100 ? '...' : '')
    });
    throw new Error("Failed to generate suggestion: " + (err.message || "Unknown error"));
  }
}

// Self-evaluate a suggestion
async function evaluateSuggestion(
  originalPrompt: string, 
  suggestion: string
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
    
    const evaluationResponse = await enhancedWithRetry(async () => {
      const res = await axios.post<OllamaGenerateResponse>(
        `${OLLAMA_HOST}/api/generate`,
        { model: SUGGESTION_MODEL, prompt: evaluationPrompt, stream: false },
        { timeout: REQUEST_TIMEOUT }
      );
      return res.data.response;
    });
    
    // Parse the score from the evaluation
    const scoreMatch = evaluationResponse.match(/Score:\s*(\d+)/i);
    const score = scoreMatch ? parseInt(scoreMatch[1], 10) : 5;
    
    // Extract the feedback
    const feedbackMatch = evaluationResponse.match(/Feedback:\s*([\s\S]+)/i);
    const feedback = feedbackMatch ? feedbackMatch[1].trim() : "No specific feedback provided.";
    
    // Track the feedback score in metrics
    trackFeedbackScore(score);
    
    return { score, feedback };
  } catch (error: unknown) {
    const err = error instanceof Error ? error : new Error(String(error));
    logger.warn("Failed to evaluate suggestion", { error: err.message });
    return { score: 7, feedback: "Evaluation failed, proceeding with original response." };
  }
}

// Process user feedback on a suggestion
export async function processFeedback(
  originalPrompt: string,
  suggestion: string,
  feedback: string,
  score: number
): Promise<string> {
  try {
    // Track the user feedback score
    trackFeedbackScore(score);
    
    const feedbackPrompt = `You previously provided this response to a request:
    
Request: ${originalPrompt}

Your response:
${suggestion}

The user provided the following feedback (score ${score}/10):
${feedback}

Please provide an improved response addressing the user's feedback.`;
    
    const improvedResponse = await enhancedWithRetry(async () => {
      const res = await axios.post<OllamaGenerateResponse>(
        `${OLLAMA_HOST}/api/generate`,
        { model: SUGGESTION_MODEL, prompt: feedbackPrompt, stream: false },
        { timeout: REQUEST_TIMEOUT }
      );
      return res.data.response;
    });
    
    incrementCounter('feedback_refinements');
    return improvedResponse;
  } catch (error: unknown) {
    const err = error instanceof Error ? error : new Error(String(error));
    logger.error("Failed to process feedback", { error: err.message });
    throw new Error("Failed to improve response based on feedback: " + err.message);
  }
}

// Summarize Snippet
export async function summarizeSnippet(snippet: string): Promise<string> {
  const prompt = `Summarize this code snippet in 50 words or less:\n\n${snippet}`;
  return await generateSuggestion(prompt);
}
