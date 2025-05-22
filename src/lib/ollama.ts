import axios, { AxiosError } from "axios"; // axios will be used by OllamaProvider.generateText
import { configService, logger } from "./config-service";
import { OllamaEmbeddingResponse, OllamaGenerateResponse } from "./types"; // OllamaGenerateResponse might be used by OllamaProvider
import { preprocessText } from "../utils/text-utils";
import { withRetry } from "../utils/retry-utils";

/**
 * Check if Ollama server is running and accessible
 * @returns Promise<boolean> - True if Ollama is accessible, false otherwise
 */
export async function checkOllama(): Promise<boolean> {
  const host = configService.OLLAMA_HOST;
  logger.info(`Checking Ollama at ${host}`);
  
  try {
    await withRetry(async () => {
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
      // If not returned true, it means it's not functional for this path
      logger.warn(`Ollama embedding model ${model} did not return expected data structure.`);
      return false; // Explicitly return false
    } else {
      const response = await axios.post<OllamaGenerateResponse>( // Add type argument here
        `${host}/api/generate`,
        { model, prompt: "test", stream: false },
        { timeout: 10000 }
      );
      if (response.status === 200 && response.data && typeof response.data.response === 'string') { // Check response.data and its type
        logger.info(`Ollama model ${model} is available`);
        return true;
      }
      // If not returned true, it means it's not functional for this path
      logger.warn(`Ollama generation model ${model} did not return expected data structure.`);
      return false; // Explicitly return false
    }
    // The logic above now ensures a boolean is always returned from the try block's success paths.
    // The original fall-through to throw an error is no longer needed here,
    // as we explicitly return false if the checks fail.
  } catch (error: unknown) {
    const err = error instanceof Error ? error : new Error(String(error));
    const errorDetails: { message: string, response?: { status: number; data: unknown } } = { message: err.message };

    if (axios.isAxiosError(error)) {
      const axiosError = error as AxiosError;
      errorDetails.response = axiosError.response
        ? {
            status: axiosError.response.status,
            data: axiosError.response.data,
          }
        : undefined;
    }
    
    logger.error(`Ollama model check error for ${model}`, errorDetails);
    // Instead of throwing, we should return false as per the function's Promise<boolean> signature
    // The caller can decide if this constitutes a critical failure.
    return false;
  }
}

/**
 * Generate embeddings for text using Ollama
 * @param text - The text to generate embeddings for
 * @returns Promise<number[]> - The embedding vector
 */
export async function generateEmbedding(text: string): Promise<number[]> {
  const processedText = preprocessText(text);
  const truncatedText = processedText.length > configService.MAX_INPUT_LENGTH ? processedText.slice(0, configService.MAX_INPUT_LENGTH) : processedText;
  
  try {
      const host = configService.OLLAMA_HOST;
      const model = configService.EMBEDDING_MODEL; // Use configured embedding model
      
      const response = await withRetry(async () => {
        logger.info(`Generating embedding for text (length: ${truncatedText.length}, snippet: "${truncatedText.slice(0, 100)}...")`);
        const res = await axios.post<OllamaEmbeddingResponse>(
          `${host}/api/embeddings`,
          { model: model, prompt: truncatedText },
          { timeout: configService.REQUEST_TIMEOUT }
        );
        
        if (!res.data.embedding || !Array.isArray(res.data.embedding)) {
          throw new Error("Invalid embedding response from Ollama API");
        }
        
        // Ensure the embedding is an array of numbers and has the expected dimension
        if (!Array.isArray(res.data.embedding) || res.data.embedding.some(isNaN)) {
          throw new Error(`Ollama API returned an invalid embedding vector (not an array of numbers or contains NaN) for model ${model}. Length: ${res.data.embedding?.length}`);
        }
        // ADD THIS CHECK:
        const expectedDimension = configService.EMBEDDING_DIMENSION;
        if (res.data.embedding.length !== expectedDimension) {
          logger.error(`Ollama API returned an embedding vector with unexpected dimension for model ${model}. Expected: ${expectedDimension}, Actual: ${res.data.embedding.length}.`);
          throw new Error(`Ollama API returned an embedding vector with unexpected dimension. Expected: ${expectedDimension}, Actual: ${res.data.embedding.length}`);
        }
        return res.data; // Return the whole OllamaEmbeddingResponse object
      });
      
      return response.embedding;
  } catch (error: unknown) {
    const err = error instanceof Error ? error : new Error(String(error));
    
    const errorLogDetails: { // Changed let to const
      message: string;
      code?: string;
      response?: { status: number; data: unknown };
      inputLength: number;
      inputSnippet: string;
    } = {
      message: err.message,
      inputLength: truncatedText.length,
      inputSnippet: truncatedText.slice(0, 100),
    };

    if (axios.isAxiosError(error)) {
      const axiosError = error as AxiosError;
      errorLogDetails.code = axiosError.code;
      errorLogDetails.response = axiosError.response
        ? {
            status: axiosError.response.status,
            data: axiosError.response.data,
          }
        : undefined;
    }
    
    logger.error("Ollama embedding error", errorLogDetails);
    // It's critical to re-throw here so that the calling function (e.g., in repository.ts)
    // knows that embedding failed and can skip adding a point with a bad/missing vector.
    // Or, return a specific marker like null/undefined if the caller is designed to handle it.
    throw new Error(`Failed to generate embedding with Ollama model ${configService.EMBEDDING_MODEL}: ${err.message}`);
  }
}
