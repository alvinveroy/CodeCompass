import axios from "axios";
import { logger, OLLAMA_HOST, EMBEDDING_MODEL, SUGGESTION_MODEL, MAX_INPUT_LENGTH } from "./config";
import { OllamaEmbeddingResponse, OllamaGenerateResponse } from "./types";
import { withRetry, preprocessText } from "./utils";

// Check Ollama
export async function checkOllama(): Promise<boolean> {
  logger.info(`Checking Ollama at ${OLLAMA_HOST}`);
  await withRetry(async () => {
    const response = await axios.get(OLLAMA_HOST, { timeout: 5000 });
    logger.info(`Ollama status: ${response.status}`);
  });
  return true;
}

// Check Ollama Model
export async function checkOllamaModel(model: string, isEmbeddingModel: boolean): Promise<boolean> {
  logger.info(`Checking Ollama model: ${model}`);
  try {
    if (isEmbeddingModel) {
      const response = await axios.post<OllamaEmbeddingResponse>(
        `${OLLAMA_HOST}/api/embeddings`,
        { model, prompt: "test" },
        { timeout: 10000 }
      );
      if (response.status === 200 && response.data.embedding) {
        logger.info(`Ollama model ${model} is available`);
        return true;
      }
    } else {
      const response = await axios.post<OllamaGenerateResponse>(
        `${OLLAMA_HOST}/api/generate`,
        { model, prompt: "test", stream: false },
        { timeout: 10000 }
      );
      if (response.status === 200 && response.data.response) {
        logger.info(`Ollama model ${model} is available`);
        return true;
      }
    }
    throw new Error(`Model ${model} not functional`);
  } catch (error: any) {
    logger.error(`Ollama model check error for ${model}`, {
      message: error.message,
      response: error.response
        ? {
            status: error.response.status,
            data: error.response.data,
          }
        : null,
    });
    throw new Error(
      `Ollama model ${model} is not available. Pull it with: ollama pull ${model}`
    );
  }
}

// Generate Embedding
export async function generateEmbedding(text: string): Promise<number[]> {
  const processedText = preprocessText(text);
  const truncatedText = processedText.length > MAX_INPUT_LENGTH ? processedText.slice(0, MAX_INPUT_LENGTH) : processedText;
  try {
    const response = await withRetry(async () => {
      logger.info(`Generating embedding for text (length: ${truncatedText.length}, snippet: "${truncatedText.slice(0, 100)}...")`);
      const res = await axios.post<OllamaEmbeddingResponse>(
        `${OLLAMA_HOST}/api/embeddings`,
        { model: EMBEDDING_MODEL, prompt: truncatedText },
        { timeout: 10000 }
      );
      return res.data;
    });
    return response.embedding;
  } catch (error: any) {
    logger.error("Ollama embedding error", {
      message: error.message,
      code: error.code,
      config: error.config,
      response: error.response
        ? {
            status: error.response.status,
            data: error.response.data,
          }
        : null,
      inputLength: truncatedText.length,
      inputSnippet: truncatedText.slice(0, 100),
    });
    throw error;
  }
}

// Generate Suggestion
export async function generateSuggestion(prompt: string): Promise<string> {
  try {
    logger.info(`Generating suggestion for prompt (length: ${prompt.length})`);
    const response = await withRetry(async () => {
      const res = await axios.post<OllamaGenerateResponse>(
        `${OLLAMA_HOST}/api/generate`,
        { model: SUGGESTION_MODEL, prompt, stream: false },
        { timeout: 60000 } // Increased timeout to 60 seconds for complex prompts
      );
      return res.data;
    });
    return response.response;
  } catch (error: any) {
    logger.error("Ollama suggestion error", {
      message: error.message,
      code: error.code,
      response: error.response
        ? {
            status: error.response.status,
            data: error.response.data,
          }
        : null,
      promptLength: prompt.length,
      promptSnippet: prompt.slice(0, 100) + (prompt.length > 100 ? '...' : '')
    });
    throw new Error("Failed to generate suggestion: " + (error.message || "Unknown error"));
  }
}

// Summarize Snippet
export async function summarizeSnippet(snippet: string): Promise<string> {
  const prompt = `Summarize this code snippet in 50 words or less:\n\n${snippet}`;
  return await generateSuggestion(prompt);
}
