import { logger } from "../config";
import { checkDeepSeekApiKey, testDeepSeekConnection } from "../deepseek";

/**
 * Performs a comprehensive diagnostic of the DeepSeek API configuration and connection
 */
export async function deepseekDiagnostic(): Promise<Record<string, unknown>> {
  logger.info("Running DeepSeek API diagnostic");
  
  // Get environment variables
  const envVars = {
    DEEPSEEK_API_KEY: process.env.DEEPSEEK_API_KEY ? `Set (length: ${process.env.DEEPSEEK_API_KEY.length})` : "Not set",
    DEEPSEEK_API_URL: process.env.DEEPSEEK_API_URL || "https://api.deepseek.com/chat/completions",
    DEEPSEEK_MODEL: process.env.DEEPSEEK_MODEL || "deepseek-coder",
    SUGGESTION_PROVIDER: process.env.SUGGESTION_PROVIDER,
    SUGGESTION_MODEL: process.env.SUGGESTION_MODEL,
  };
  
  // Check API key
  let apiKeyStatus = "Not configured";
  try {
    const hasApiKey = await checkDeepSeekApiKey();
    apiKeyStatus = hasApiKey ? "Configured" : "Not configured";
  } catch (error: Error | unknown) {
    apiKeyStatus = `Error: ${error.message}`;
  }
  
  // Test connection
  let connectionStatus = "Not tested";
  try {
    const connected = await testDeepSeekConnection();
    connectionStatus = connected ? "Connected" : "Failed";
    
    // If connection failed but API key is configured, provide more details
    if (!connected && apiKeyStatus === "Configured") {
      connectionStatus = "Failed - API key is configured but connection test failed. Check API URL and network connectivity.";
    }
  } catch (error: Error | unknown) {
    connectionStatus = `Error: ${error.message}`;
  }
  
  return {
    environment: envVars,
    apiKeyStatus: apiKeyStatus,
    connectionStatus: connectionStatus,
    timestamp: new Date().toISOString(),
    troubleshootingSteps: [
      "1. Ensure DEEPSEEK_API_KEY is set with a valid API key",
      "2. Verify DEEPSEEK_API_URL is set to https://api.deepseek.com/chat/completions",
      "3. Check network connectivity to the DeepSeek API",
      "4. Verify the model name is correct (e.g., deepseek-coder)",
      "5. Try setting the API key directly in the environment before starting the application"
    ]
  };
}
