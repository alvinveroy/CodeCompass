import axios from "axios";
import { logger, DEEPSEEK_API_KEY, DEEPSEEK_MODEL, REQUEST_TIMEOUT, MAX_RETRIES, RETRY_DELAY } from "./config";
// Use the correct v1 API endpoints
const DEEPSEEK_API_URL = "https://api.deepseek.com/v1/chat/completions";
const DEEPSEEK_EMBEDDING_URL = "https://api.deepseek.com/v1/embeddings";
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
  
  // Force set the API key in the environment variable to ensure it's available
  if (apiKey && !process.env.DEEPSEEK_API_KEY) {
    process.env.DEEPSEEK_API_KEY = apiKey;
    logger.info("Set DEEPSEEK_API_KEY in environment from config");
  }
  
  // Log that we found the API key (without revealing it)
  logger.info(`DeepSeek API key is configured: ${apiKey ? "Yes" : "No"}, value length: ${apiKey.length}`);
  return true;
}

/**
 * Test DeepSeek API connection
 * @returns Promise<boolean> - True if connection is successful, false otherwise
 */
export async function testDeepSeekConnection(): Promise<boolean> {
  try {
    // Check if API key is configured
    const apiKey = process.env.DEEPSEEK_API_KEY || DEEPSEEK_API_KEY;
    if (!apiKey) {
      logger.error("DeepSeek API key is not configured. Set DEEPSEEK_API_KEY environment variable.");
      return false;
    }

    logger.info(`Testing DeepSeek API connection with key length: ${apiKey.length}, key prefix: ${apiKey.substring(0, 5)}...`);
    const apiUrl = process.env.DEEPSEEK_API_URL || DEEPSEEK_API_URL;
    logger.info(`Using DeepSeek API URL: ${apiUrl}`);
    
    // Force set the API key in the environment variable to ensure it's available
    process.env.DEEPSEEK_API_KEY = apiKey;
    
    try {
      logger.info(`Sending test request to DeepSeek API at ${apiUrl}`);
      logger.info(`Using model: ${DEEPSEEK_MODEL}`);
      
      // Add more detailed request logging
      logger.debug(`DeepSeek test request payload: ${JSON.stringify({
        model: DEEPSEEK_MODEL,
        messages: [{ role: "user", content: "Hello" }],
        max_tokens: 10
      })}`);
      
      const response = await axios.post(
        apiUrl,
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
          timeout: 15000 // Increase timeout for test request
        }
      );
      
      // Log more details about the response for debugging
      logger.debug(`DeepSeek API response: ${JSON.stringify({
        status: response.status,
        statusText: response.statusText,
        headers: response.headers,
        data: response.data
      })}`);
      
      logger.info(`DeepSeek API response status: ${response.status}`);

      if (response.status === 200) {
        logger.info("DeepSeek API connection successful");
        return true;
      }
      
      logger.warn(`DeepSeek API test failed with status: ${response.status}`);
      return false;
    } catch (requestError: any) {
      logger.error("DeepSeek API connection test failed", {
        message: requestError.message,
        code: requestError.code,
        response: requestError.response ? {
          status: requestError.response.status,
          statusText: requestError.response.statusText,
          data: JSON.stringify(requestError.response.data)
        } : 'No response data',
        request: requestError.request ? 'Request present' : 'No request data'
      });
      
      // Check for specific error types
      if (requestError.code === 'ECONNREFUSED') {
        logger.error("Connection refused. Check if the DeepSeek API endpoint is correct and accessible.");
      } else if (requestError.response && requestError.response.status === 401) {
        logger.error("Authentication failed. Check your DeepSeek API key.");
      } else if (requestError.response && requestError.response.status === 404) {
        logger.error("API endpoint not found. Check the DeepSeek API URL.");
      }
      
      return false;
    }
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
    // Force check API key and log detailed information
    const apiKey = process.env.DEEPSEEK_API_KEY || DEEPSEEK_API_KEY;
    if (!apiKey) {
      logger.error("DeepSeek API key not configured. Set DEEPSEEK_API_KEY environment variable.");
      throw new Error("DeepSeek API key not configured");
    }
    logger.info(`DeepSeek API key is configured with length: ${apiKey.length}`);

    return await timeExecution('deepseek_generation', async () => {
      logger.info(`Generating with DeepSeek for prompt (length: ${prompt.length})`);
      
      const apiUrl = process.env.DEEPSEEK_API_URL || DEEPSEEK_API_URL;
      // Ensure we're getting the latest value from the environment
      const model = process.env.DEEPSEEK_MODEL || DEEPSEEK_MODEL;
      
      logger.debug(`Using DeepSeek API URL: ${apiUrl}`);
      logger.debug(`Using model: ${model}`);
      
      const response = await enhancedWithRetry(async () => {
        logger.debug(`Sending request to DeepSeek API at ${apiUrl} with model ${model}`);
        
        // Log request payload for debugging (without the full prompt)
        logger.debug(`Request payload: ${JSON.stringify({
          model: model,
          messages: [{ role: "user", content: `${prompt.substring(0, 50)}...` }],
          temperature: 0.7,
          max_tokens: 2048
        })}`);
        
        const res = await axios.post(
          apiUrl,
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
        // Log more detailed error information
        logger.debug(`DeepSeek error details:`, {
          code: error.code,
          message: error.message,
          response: error.response ? {
            status: error.response.status,
            statusText: error.response.statusText,
            data: error.response.data
          } : 'No response data'
        });
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
    // Force check API key and log detailed information
    const apiKey = process.env.DEEPSEEK_API_KEY || DEEPSEEK_API_KEY;
    if (!apiKey) {
      logger.error("DeepSeek API key not configured. Set DEEPSEEK_API_KEY environment variable.");
      throw new Error("DeepSeek API key not configured");
    }
    logger.info(`DeepSeek API key is configured with length: ${apiKey.length}`);

    const processedText = preprocessText(text);
    
    return await timeExecution('deepseek_embedding_generation', async () => {
      logger.info(`Generating embedding with DeepSeek for text (length: ${processedText.length})`);
      logger.debug(`Using DeepSeek embedding URL: ${DEEPSEEK_EMBEDDING_URL}`);
      
      const response = await enhancedWithRetry(async () => {
        logger.debug(`Sending embedding request to DeepSeek API with model: deepseek-embedding`);
        
        const res = await axios.post(
          DEEPSEEK_EMBEDDING_URL,
          {
            model: "deepseek-embedding",
            input: processedText
          },
          {
            headers: {
              "Content-Type": "application/json",
              "Authorization": `Bearer ${apiKey}`
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
