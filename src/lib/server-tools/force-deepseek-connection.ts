import { configService, logger } from "../config-service";
import axios from "axios";

/**
 * Force a connection to the DeepSeek API with explicit parameters
 * This bypasses all the normal configuration and directly tests the API
 */
export async function forceDeepseekConnection(params: Record<string, unknown>): Promise<Record<string, unknown>> {
  logger.info("Running force DeepSeek API connection test");
  configService.reloadConfigsFromFile(true); // Ensure configService has latest defaults if params are not overriding

  // Get API key from params or ConfigService (which includes env)
  const apiKey = (params.apiKey as string) || configService.DEEPSEEK_API_KEY;
  if (!apiKey) {
    return {
      success: false,
      error: "No API key provided. Use {\"apiKey\": \"your-api-key\"} or ensure DEEPSEEK_API_KEY is set via environment or ~/.codecompass/deepseek-config.json."
    };
  }
  
  // Get API URL from params or ConfigService
  const apiUrl = (params.apiUrl as string) || configService.DEEPSEEK_API_URL;
  
  // Get model from params or ConfigService
  const model = (params.model as string) || configService.DEEPSEEK_MODEL;
  
  // Log test parameters
  logger.info(`Force testing DeepSeek API with key (length: ${apiKey.length}, prefix: ${apiKey.substring(0, 5)})...`);
  logger.info(`Using API URL: ${apiUrl}`);
  logger.info(`Using model: ${model}`);
  
  // Temporarily update configService for this test if values differ from current config.
  // This tool is for direct testing, so it might not permanently alter config files unless explicitly designed to.
  // For now, we assume the provided params are for this specific test run.
  // If persistence is desired, configService.setDeepSeekApiKey etc. would be used.
  
  // For the duration of this test, if params were provided, they override configService values for the request.
  // The actual configService state (and persisted files) are not changed by this tool by default.
  
  try {
    // Make a simple request to test the API using the resolved apiKey, apiUrl, model
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
        // Reporting what was used for the test, not necessarily what's persisted.
        parametersUsed: {
          apiKeyStatus: "Provided or from config",
          apiUrl: apiUrl,
          model: model
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
      errorCode: (error as Error & { code?: string }).code,
      responseStatus: (error as Error & { response?: { status?: number } }).response?.status,
      responseData: (error as Error & { response?: { data?: unknown } }).response?.data,
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
