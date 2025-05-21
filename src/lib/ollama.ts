import axios, { AxiosError } from "axios"; // axios will be used by OllamaProvider.generateText
import { configService, logger } from "./config-service";
import { OllamaEmbeddingResponse, OllamaGenerateResponse } from "./types"; // OllamaGenerateResponse might be used by OllamaProvider
import { preprocessText } from "../utils/text-utils";
// import { incrementCounter, timeExecution } from "./metrics"; // Metrics removed
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
    // if (isEmbeddingModel) { // This block is effectively the same as the else block's start
    //   const response = await axios.post<OllamaEmbeddingResponse>(
    // This can be simplified as the initial check for response.status and response.data.embedding/response
    // is the main differentiator, not the type of POST.
    // However, the request body *is* different. Let's keep the structure but fix the error handling.

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
    // throw new Error(`Model ${model} not functional`); // This was a bit too aggressive. The error below is better.
    logger.warn(`Ollama model ${model} did not return expected data structure in response.`); // More specific log
    // Fall through to throw the more general error below if this path is taken.
    // This ensures an error is always thrown if the positive checks don't pass.
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
    throw new Error(
      `Ollama model ${model} is not available. Pull it with: ollama pull ${model}`
    );
  }
}

/**
 * Generate embeddings for text using Ollama
 * @param text - The text to generate embeddings for
 * @returns Promise<number[]> - The embedding vector
 */
export async function generateEmbedding(text: string): Promise<number[]> {
  // incrementCounter('embedding_requests'); // Metrics removed
  
  const processedText = preprocessText(text);
  const truncatedText = processedText.length > configService.MAX_INPUT_LENGTH ? processedText.slice(0, configService.MAX_INPUT_LENGTH) : processedText;
  
  try {
    // return await timeExecution('embedding_generation', async () => { // Metrics removed
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
        
        return res.data;
      });
      
      // incrementCounter('embedding_success'); // Metrics removed
      return response.embedding;
    // }); // Metrics removed
  } catch (error: unknown) {
    // incrementCounter('embedding_errors'); // Metrics removed
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
    throw new Error(`Failed to generate embedding: ${err.message}`);
  }
}
