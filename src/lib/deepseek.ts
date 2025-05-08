import axios from "axios";
import { logger, DEEPSEEK_API_KEY, DEEPSEEK_API_URL, DEEPSEEK_MODEL, REQUEST_TIMEOUT, MAX_RETRIES, RETRY_DELAY } from "./config";
import { incrementCounter, recordTiming, timeExecution, trackFeedbackScore } from "./metrics";
import { preprocessText } from "./utils";

/**
 * Check if DeepSeek API key is configured
 * @returns Promise<boolean> - True if API key is configured, false otherwise
 */
export async function checkDeepSeekApiKey(): Promise<boolean> {
  // Check if the API key is set in the environment
  const apiKey = process.env.DEEPSEEK_API_KEY || DEEPSEEK_API_KEY;
  
  if (!apiKey) {
    logger.error("DeepSeek API key is not configured. Set DEEPSEEK_API_KEY environment variable.");
    return false;
  }
  
  // Log that we found the API key (without revealing it)
  logger.info("DeepSeek API key is configured");
  return true;
}

/**
 * Test DeepSeek API connection
 * @returns Promise<boolean> - True if connection is successful, false otherwise
 */
export async function testDeepSeekConnection(): Promise<boolean> {
  try {
    if (!await checkDeepSeekApiKey()) {
      return false;
    }

    logger.info("Testing DeepSeek API connection...");
    const apiUrl = process.env.DEEPSEEK_API_URL || DEEPSEEK_API_URL;
    const apiKey = process.env.DEEPSEEK_API_KEY || DEEPSEEK_API_KEY;
    
    const response = await axios.post(
      `${apiUrl}/chat/completions`,
      {
        model: DEEPSEEK_MODEL,
        messages: [{ role: "user", content: "Hello" }],
        max_tokens: 10
      },
      {
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${apiKey}`
        },
        timeout: 10000
      }
    );

    if (response.status === 200) {
      logger.info("DeepSeek API connection successful");
      return true;
    }
    
    logger.warn(`DeepSeek API test failed with status: ${response.status}`);
    return false;
  } catch (error: any) {
    logger.error("DeepSeek API connection test failed", {
      message: error.message,
      response: error.response ? {
        status: error.response.status,
        data: error.response.data
      } : null
    });
    return false;
  }
}

/**
 * Generate text with DeepSeek API
 * @param prompt - The prompt to generate text from
 * @returns Promise<string> - The generated text
 */
export async function generateWithDeepSeek(prompt: string): Promise<string> {
  incrementCounter('deepseek_requests');
  
  try {
    if (!await checkDeepSeekApiKey()) {
      throw new Error("DeepSeek API key not configured");
    }

    return await timeExecution('deepseek_generation', async () => {
      logger.info(`Generating with DeepSeek for prompt (length: ${prompt.length})`);
      
      const apiUrl = process.env.DEEPSEEK_API_URL || DEEPSEEK_API_URL;
      const apiKey = process.env.DEEPSEEK_API_KEY || DEEPSEEK_API_KEY;
      const model = process.env.DEEPSEEK_MODEL || DEEPSEEK_MODEL;
      
      const response = await enhancedWithRetry(async () => {
        const res = await axios.post(
          `${apiUrl}/chat/completions`,
          {
            model: model,
            messages: [{ role: "user", content: prompt }],
            temperature: 0.7,
            max_tokens: 2048
          },
          {
            headers: {
              "Content-Type": "application/json",
              "Authorization": `Bearer ${apiKey}`
            },
            timeout: REQUEST_TIMEOUT
          }
        );
        
        if (!res.data.choices || res.data.choices.length === 0) {
          throw new Error("Invalid response from DeepSeek API");
        }
        
        return res.data.choices[0].message.content;
      });
      
      incrementCounter('deepseek_success');
      return response;
    });
  } catch (error: any) {
    incrementCounter('deepseek_errors');
    logger.error("DeepSeek API error", {
      message: error.message,
      code: error.code,
      response: error.response ? {
        status: error.response.status,
        data: error.response.data
      } : null,
      promptLength: prompt.length,
      promptSnippet: prompt.slice(0, 100) + (prompt.length > 100 ? '...' : '')
    });
    throw new Error(`Failed to generate with DeepSeek: ${error.message}`);
  }
}

// Enhanced retry function with exponential backoff
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
    } catch (error: any) {
      lastError = error;
      
      // Check if it's a timeout error or rate limit error
      const isTimeout = error.code === 'ECONNABORTED' || 
                        error.message?.includes('timeout');
      const isRateLimit = error.response?.status === 429;
      
      if (isTimeout) {
        logger.warn(`DeepSeek request timed out (attempt ${i + 1}/${retries}). Retrying in ${currentDelay}ms...`);
      } else if (isRateLimit) {
        logger.warn(`DeepSeek rate limit exceeded (attempt ${i + 1}/${retries}). Retrying in ${currentDelay}ms...`);
      } else {
        logger.warn(`DeepSeek retry ${i + 1}/${retries} after error: ${error.message}`);
      }
      
      // Wait before retrying with exponential backoff
      await new Promise(resolve => setTimeout(resolve, currentDelay));
      currentDelay *= 2; // Exponential backoff
    }
  }
  
  throw lastError || new Error("All retries failed");
}

// Generate embeddings with DeepSeek API
export async function generateEmbeddingWithDeepSeek(text: string): Promise<number[]> {
  incrementCounter('deepseek_embedding_requests');
  
  try {
    if (!await checkDeepSeekApiKey()) {
      throw new Error("DeepSeek API key not configured");
    }

    const processedText = preprocessText(text);
    
    return await timeExecution('deepseek_embedding_generation', async () => {
      logger.info(`Generating embedding with DeepSeek for text (length: ${processedText.length})`);
      
      const response = await enhancedWithRetry(async () => {
        const res = await axios.post(
          `${DEEPSEEK_API_URL}/embeddings`,
          {
            model: "deepseek-embedding",
            input: processedText
          },
          {
            headers: {
              "Content-Type": "application/json",
              "Authorization": `Bearer ${DEEPSEEK_API_KEY}`
            },
            timeout: REQUEST_TIMEOUT
          }
        );
        
        if (!res.data.data || !res.data.data[0].embedding) {
          throw new Error("Invalid embedding response from DeepSeek API");
        }
        
        return res.data.data[0].embedding;
      });
      
      incrementCounter('deepseek_embedding_success');
      return response;
    });
  } catch (error: any) {
    incrementCounter('deepseek_embedding_errors');
    logger.error("DeepSeek embedding error", {
      message: error.message,
      code: error.code,
      response: error.response ? {
        status: error.response.status,
        data: error.response.data
      } : null,
      textLength: text.length,
      textSnippet: text.slice(0, 100) + (text.length > 100 ? '...' : '')
    });
    throw new Error(`Failed to generate embedding with DeepSeek: ${error.message}`);
  }
}
