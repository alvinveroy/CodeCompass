import axios from "axios";
// Keep path for join if needed locally, though configService has CONFIG_DIR
import { configService, logger } from "./config-service";

// Constants like DEEPSEEK_API_URL are now primarily sourced from configService.
// Local fallbacks are no longer defined here to ensure configService is the single source of truth.
// import { incrementCounter, recordTiming, timeExecution } from "./metrics"; // Metrics removed
import { preprocessText } from "../utils/text-utils";
import { withRetry } from "../utils/retry-utils";

// Rate limiting state
const requestTimestamps: number[] = [];

async function waitForRateLimit(): Promise<void> {
  const now = Date.now();
  const rpmLimit = configService.DEEPSEEK_RPM_LIMIT;

  // Remove timestamps older than 1 minute
  while (requestTimestamps.length > 0 && requestTimestamps[0] < now - 60000) {
    requestTimestamps.shift();
  }

  if (requestTimestamps.length >= rpmLimit) {
    const timeToWait = (requestTimestamps[0] + 60000) - now;
    if (timeToWait > 0) {
      logger.info(`DeepSeek rate limit nearly reached (${requestTimestamps.length}/${rpmLimit} requests in last minute). Delaying next request for ${timeToWait}ms.`);
      // const delayStartTime = Date.now(); // Metrics removed
      await new Promise(resolve => setTimeout(resolve, timeToWait));
      // recordTiming('deepseek_rate_limit_delay_ms', Date.now() - delayStartTime); // Metrics removed
    }
  }
  requestTimestamps.push(now);
}


/**
 * Check if DeepSeek API key is configured
 * @returns boolean - True if API key is configured, false otherwise
 */
export function checkDeepSeekApiKey(): boolean {
  // ConfigService handles loading the API key from file and environment.
  // It also updates process.env.DEEPSEEK_API_KEY.
  // This function now primarily serves to check if the key (from any source) is valid/present.
  
  const apiKey = configService.DEEPSEEK_API_KEY; // Gets the effective API key
  
  if (!apiKey) {
    logger.error("DeepSeek API key is not configured. Set DEEPSEEK_API_KEY environment variable or run 'npm run set-deepseek-key'.");
    return false;
  }
  
  // process.env.DEEPSEEK_API_KEY is updated by configService.
  // Global scope setting is not strictly necessary if configService is the source of truth.
  
  logger.info(`DeepSeek API key configured (via ConfigService). Length: ${apiKey.length}`);
  return true;
}

/**
 * Test DeepSeek API connection
 * @returns Promise<boolean> - True if connection is successful, false otherwise
 */
export async function testDeepSeekConnection(): Promise<boolean> {
  try {
    const apiKey = configService.DEEPSEEK_API_KEY;
    if (!apiKey) {
      logger.error("DeepSeek API key is not configured (via ConfigService). Set DEEPSEEK_API_KEY environment variable or use ~/.codecompass/deepseek-config.json.");
      return false;
    }
    // process.env.DEEPSEEK_API_KEY is managed by configService.

    logger.info(`Testing DeepSeek API connection with key length: ${apiKey.length}, key prefix: ${apiKey.substring(0, 5)}...`);
    
    const apiUrl = configService.DEEPSEEK_API_URL;
    // process.env.DEEPSEEK_API_URL is managed by configService.
    
    logger.info(`Using DeepSeek API URL: ${apiUrl}`);
    
    try {
      const modelToTest = configService.DEEPSEEK_MODEL;
      logger.info(`Sending test request to DeepSeek API at ${apiUrl}`);
      logger.info(`Using model: ${modelToTest}`);
      
      // Add more detailed request logging
      logger.debug(`DeepSeek test request payload: ${JSON.stringify({
        model: modelToTest,
        messages: [{ role: "user", content: "Hello" }],
        max_tokens: 10
      })}`);
      
      const response = await axios.post(
        apiUrl,
        {
          model: modelToTest,
          messages: [{ role: "user", content: "Hello" }],
          max_tokens: 10
        },
        {
          headers: {
            "Content-Type": "application/json",
            "Authorization": `Bearer ${apiKey}`
          },
          timeout: 15000 // Specific timeout for this test is fine
        }
      );
      
      // Log more details about the response for debugging
      logger.debug(`DeepSeek API response: ${JSON.stringify({
        status: response.status,
        statusText: response.statusText,
        headers: response.headers,
        data: response.data
      })}`);
      
      logger.info(`DeepSeek API test request to ${apiUrl} completed with status: ${response.status}`);

      if (response.status === 200) {
        logger.info("DeepSeek API connection successful");
        return true;
      }
      
      logger.warn(`DeepSeek API test failed with status: ${response.status}`);
      return false;
    } catch (requestError: unknown) {
      const err: Error = requestError instanceof Error ? requestError : new Error(String(requestError));

      // Define an interface for the log payload for clarity
      interface DeepSeekErrorLogPayload {
        message: string;
        code?: string;
        response?: { status: number; statusText: string; data: string; } | string;
        request?: string;
      }

      // Safely extract Axios-specific error details for logging
      const logPayload: DeepSeekErrorLogPayload = { message: err.message };

      if (axios.isAxiosError(requestError)) {
        logPayload.code = requestError.code;
        logPayload.request = requestError.request ? 'Request present' : 'No request data';

        if (requestError.response) {
          let responseDataString: string;
          try {
            responseDataString = typeof requestError.response.data === 'string'
              ? requestError.response.data
              : JSON.stringify(requestError.response.data);
          } catch { // 'e' removed as it's unused
            responseDataString = "[Unserializable response data]";
          }
          logPayload.response = {
            status: requestError.response.status,
            statusText: requestError.response.statusText,
            data: responseDataString,
          };
        } else {
          logPayload.response = 'No response data';
        }

        // Check for specific error types using the narrowed requestError
        if (requestError.code === 'ECONNREFUSED') {
          logger.error("Connection refused. Check if the DeepSeek API endpoint is correct and accessible.");
        } else if (requestError.response && requestError.response.status === 401) {
          logger.error("Authentication failed. Check your DeepSeek API key.");
        } else if (requestError.response && requestError.response.status === 404) {
          logger.error("API endpoint not found. Check the DeepSeek API URL.");
        }
      } else {
        // For non-Axios errors
        logPayload.response = 'No response data (not an Axios error)';
        logPayload.request = 'No request data (not an Axios error)';
      }

      logger.error("DeepSeek API connection test failed", logPayload);
      return false;
    }
  } catch (error: unknown) {
    const err = error instanceof Error ? error : new Error(String(error));
    
    let errorCode: string | undefined;
    let errorResponseData: unknown; // Changed from unknown | undefined
    let errorResponseStatus: number | undefined;

    if (axios.isAxiosError(error)) {
        errorCode = error.code;
        if (error.response) {
            errorResponseData = error.response.data;
            errorResponseStatus = error.response.status;
        }
    }
    
    logger.error("DeepSeek API connection test failed (outer catch)", {
      message: err.message,
      code: errorCode,
      response: errorResponseStatus !== undefined ? { status: errorResponseStatus, data: errorResponseData } : null,
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
  // incrementCounter('deepseek_requests'); // Metrics removed
  
  try {
    const apiKey = configService.DEEPSEEK_API_KEY;
    if (!apiKey) {
      logger.error("DeepSeek API key not configured (via ConfigService).");
      throw new Error("DeepSeek API key not configured");
    }
    logger.info(`DeepSeek API key is configured with length: ${apiKey.length}`);

    await waitForRateLimit();

    // return await timeExecution('deepseek_generation', async () => { // Metrics removed
      logger.info(`Generating with DeepSeek for prompt (length: ${prompt.length})`);
      
      const apiUrl = configService.DEEPSEEK_API_URL;
      const model = configService.DEEPSEEK_MODEL;
      
      logger.debug(`Using DeepSeek API URL: ${apiUrl}`);
      logger.debug(`Using model: ${model}`);

      interface DeepSeekChoice {
        message: {
          content: string;
        };
      }
      
      interface DeepSeekChatResponse {
        choices: DeepSeekChoice[];
        // Add other fields if necessary, e.g., usage
      }
      
      const response = await withRetry(async () => {
        logger.debug(`Sending request to DeepSeek API at ${apiUrl} with model ${model}`);
        
        // Log request payload for debugging (without the full prompt)
        logger.debug(`Request payload: ${JSON.stringify({
          model: model,
          messages: [{ role: "user", content: `${prompt.substring(0, 50)}...` }],
          temperature: 0.7,
          max_tokens: 2048
        })}`);
        
        const res = await axios.post<DeepSeekChatResponse>(
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
            timeout: configService.REQUEST_TIMEOUT * 2 
          }
        );
        
        if (!res.data.choices || res.data.choices.length === 0) {
          logger.error(`DeepSeek API request to ${apiUrl} failed with status ${res.status}: Invalid response structure. Response data: ${JSON.stringify(res.data)}`);
          throw new Error("Invalid response from DeepSeek API");
        }
        logger.info(`DeepSeek API request to ${apiUrl} (generateText) completed with status: ${res.status}`);
        return res.data.choices[0].message.content;
      });
      
      // incrementCounter('deepseek_success'); // Metrics removed
      return response;
    // }); // Metrics removed
  } catch (error: unknown) {
    // incrementCounter('deepseek_errors'); // Metrics removed
    const err = error instanceof Error ? error : new Error(String(error));
    const axiosError = error as import('axios').AxiosError<{ message?: string }>;
    
    logger.error("DeepSeek API error", {
      message: err.message,
      code: axiosError.code,
      response: axiosError.response ? {
        status: axiosError.response.status,
        data: axiosError.response.data
      } : null,
      promptLength: prompt.length,
      promptSnippet: prompt.slice(0, 100) + (prompt.length > 100 ? '...' : '')
    });
    throw new Error(`Failed to generate with DeepSeek: ${err.message}`);
  }
}

// Generate embeddings with DeepSeek API
export async function generateEmbeddingWithDeepSeek(text: string): Promise<number[]> {
  // incrementCounter('deepseek_embedding_requests'); // Metrics removed
  
  try {
    const apiKey = configService.DEEPSEEK_API_KEY;
    if (!apiKey) {
      logger.error("DeepSeek API key not configured (via ConfigService).");
      throw new Error("DeepSeek API key not configured");
    }
    logger.info(`DeepSeek API key is configured with length: ${apiKey.length}`);

    const processedText = preprocessText(text);

    await waitForRateLimit();
    
    // return await timeExecution('deepseek_embedding_generation', async () => { // Metrics removed
      // Construct embedding URL based on API URL from configService
      const embeddingUrl = configService.DEEPSEEK_API_URL.includes("api.deepseek.com") 
        ? "https://api.deepseek.com/embeddings" 
        : configService.DEEPSEEK_API_URL.replace("/chat/completions", "/embeddings");

      logger.info(`Generating embedding with DeepSeek for text (length: ${processedText.length})`);
      logger.debug(`Using DeepSeek embedding URL: ${embeddingUrl}`);

      interface DeepSeekEmbeddingData {
        embedding: number[];
        // Add other fields if necessary
      }
      
      interface DeepSeekEmbeddingResponse {
        data: DeepSeekEmbeddingData[];
        // Add other fields if necessary, e.g., usage
      }
      
      const response = await withRetry(async () => {
        logger.debug(`Sending embedding request to DeepSeek API with model: deepseek-embedding`);
        
        const res = await axios.post<DeepSeekEmbeddingResponse>(
          embeddingUrl,
          {
            model: "deepseek-embedding",
            input: processedText
          },
          {
            headers: {
              "Content-Type": "application/json",
              "Authorization": `Bearer ${apiKey}`
            },
            timeout: configService.REQUEST_TIMEOUT * 1.5
          }
        );
        
        if (!res.data.data || !res.data.data[0].embedding) {
          logger.error(`DeepSeek API request to ${embeddingUrl} failed with status ${res.status}: Invalid embedding response structure. Response data: ${JSON.stringify(res.data)}`);
          throw new Error("Invalid embedding response from DeepSeek API");
        }
        logger.info(`DeepSeek API request to ${embeddingUrl} (generateEmbedding) completed with status: ${res.status}`);
        return res.data.data[0].embedding;
      });
      
      // incrementCounter('deepseek_embedding_success'); // Metrics removed
      return response;
    // }); // Metrics removed
  } catch (error: unknown) {
    // incrementCounter('deepseek_embedding_errors'); // Metrics removed
    const err = error instanceof Error ? error : new Error(String(error));
    const axiosError = error as import('axios').AxiosError<{ message?: string }>;
    
    logger.error("DeepSeek embedding error", {
      message: err.message,
      code: axiosError.code,
      response: axiosError.response ? {
        status: axiosError.response.status,
        data: axiosError.response.data
      } : null,
      textLength: text.length,
      textSnippet: text.slice(0, 100) + (text.length > 100 ? '...' : '')
    });
    throw new Error(`Failed to generate embedding with DeepSeek: ${err.message}`);
  }
}
