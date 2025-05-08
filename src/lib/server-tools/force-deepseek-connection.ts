import { logger } from "../config";
import axios from "axios";

/**
 * Force a connection to the DeepSeek API with explicit parameters
 * This bypasses all the normal configuration and directly tests the API
 */
export async function forceDeepseekConnection(params: Record<string, unknown>): Promise<Record<string, unknown>> {
  logger.info("Running force DeepSeek API connection test");
  
  // Get API key from params or environment
  const apiKey = (params.apiKey as string) || process.env.DEEPSEEK_API_KEY || "";
  if (!apiKey) {
    return {
      success: false,
      error: "No API key provided. Use {\"apiKey\": \"your-api-key\"} or set DEEPSEEK_API_KEY environment variable."
    };
  }
  
  // Get API URL from params or use default endpoint
  const apiUrl = (params.apiUrl as string) || process.env.DEEPSEEK_API_URL || "https://api.deepseek.com/chat/completions";
  
  // Get model from params or use default
  const model = (params.model as string) || process.env.DEEPSEEK_MODEL || "deepseek-coder";
  
  // Log test parameters
  logger.info(`Force testing DeepSeek API with key length: ${apiKey.length}, key prefix: ${apiKey.substring(0, 5)}...`);
  logger.info(`Using API URL: ${apiUrl}`);
  logger.info(`Using model: ${model}`);
  
  // Force set environment variables
  process.env.DEEPSEEK_API_KEY = apiKey as string;
  process.env.DEEPSEEK_API_URL = apiUrl as string;
  process.env.DEEPSEEK_MODEL = model as string;
  
  try {
    // Make a simple request to test the API
    const response = await axios.post(
      apiUrl,
      {
        model: model,
        messages: [{ role: "user", content: "Hello" }],
        max_tokens: 10
      },
      {
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${apiKey}`
        },
        timeout: 15000
      }
    );
    
    logger.info(`DeepSeek API response status: ${response.status}`);
    
    if (response.status === 200) {
      // Success - return details about the response
      return {
        success: true,
        status: response.status,
        statusText: response.statusText,
        apiUrl: apiUrl,
        apiKeyLength: apiKey.length,
        apiKeyPrefix: apiKey.substring(0, 5),
        model: model,
        responseData: {
          model: response.data.model,
          choices: response.data.choices ? response.data.choices.length : 0,
          content: response.data.choices && response.data.choices.length > 0 ? 
                  response.data.choices[0].message.content : "No content"
        },
        message: "DeepSeek API connection successful",
        environmentSet: {
          DEEPSEEK_API_KEY: "Set",
          DEEPSEEK_API_URL: apiUrl,
          DEEPSEEK_MODEL: model
        }
      };
    } else {
      // Non-200 response
      return {
        success: false,
        status: response.status,
        statusText: response.statusText,
        apiUrl: apiUrl,
        apiKeyLength: apiKey.length,
        apiKeyPrefix: apiKey.substring(0, 5),
        model: model,
        error: `Unexpected response status: ${response.status}`
      };
    }
  } catch (error: unknown) {
    // Log detailed error information
    const err = error as Error & { 
      code?: string; 
      response?: { 
        status: number; 
        statusText: string; 
        data: unknown; 
      } 
    };
    
    logger.error("DeepSeek API test failed", {
      message: err.message,
      code: err.code,
      response: err.response ? {
        status: err.response.status,
        statusText: err.response.statusText,
        data: err.response.data
      } : "No response data"
    });
    
    // Return error details
    return {
      success: false,
      apiUrl: apiUrl,
      apiKeyLength: apiKey.length,
      apiKeyPrefix: apiKey.substring(0, 5),
      model: model,
      error: (error as Error).message,
      errorCode: (error as any).code,
      responseStatus: (error as any).response?.status,
      responseData: (error as any).response?.data,
      troubleshooting: [
        "1. Verify your API key is correct",
        "2. Ensure the API URL is correct (should be https://api.deepseek.com/chat/completions)",
        "3. Check your network connection and any proxies",
        "4. Verify the DeepSeek service is available",
        "5. Try with a different model like 'deepseek-coder'"
      ]
    };
  }
}
