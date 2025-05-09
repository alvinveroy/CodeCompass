import axios from "axios"; // axios will be used by OllamaProvider.generateText
import { configService, logger } from "./config-service";
import { OllamaEmbeddingResponse, OllamaGenerateResponse } from "./types"; // OllamaGenerateResponse might be used by OllamaProvider
import { preprocessText } from "../utils/text-utils";
import { incrementCounter, timeExecution } from "./metrics";

/**
 * Check if Ollama server is running and accessible
 * @returns Promise<boolean> - True if Ollama is accessible, false otherwise
 */
export async function checkOllama(): Promise<boolean> {
  const host = configService.OLLAMA_HOST;
  logger.info(`Checking Ollama at ${host}`);
  
  try {
    await enhancedWithRetry(async () => {
      const response = await axios.get(host, { timeout: 10000 }); // Specific timeout for check
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
  const host = configService.OLLAMA_HOST;
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
  retries = configService.MAX_RETRIES, 
  initialDelay = configService.RETRY_DELAY
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
        logger.warn(`Retry ${i + 1}/${retries} after error: ${err.message}`);
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
  const truncatedText = processedText.length > configService.MAX_INPUT_LENGTH ? processedText.slice(0, configService.MAX_INPUT_LENGTH) : processedText;
  
  try {
    return await timeExecution('embedding_generation', async () => {
      const host = configService.OLLAMA_HOST;
      const model = configService.EMBEDDING_MODEL; // Use configured embedding model
      
      const response = await enhancedWithRetry(async () => {
        logger.info(`Generating embedding for text (length: ${truncatedText.length}, snippet: "${truncatedText.slice(0, 100)}...")`);
        const res = await axios.post<OllamaEmbeddingResponse>(
          `${host}/api/embeddings`,
          { model: model, prompt: truncatedText },
          { timeout: configService.REQUEST_TIMEOUT }
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
      response?: { status: number; data: unknown } 
    };
    
    logger.error("Ollama embedding error", {
      message: err.message,
      code: axiosError.code,
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
