import { configService, logger } from "../config-service";
import { checkDeepSeekApiKey, testDeepSeekConnection } from "../deepseek";

/**
 * Performs a comprehensive diagnostic of the DeepSeek API configuration and connection
 */
export async function deepseekDiagnostic(): Promise<Record<string, unknown>> {
  logger.info("Running DeepSeek API diagnostic");
  configService.reloadConfigsFromFile(true); // Ensure fresh state
  
  // Get configuration from ConfigService
  const currentConfig = {
    DEEPSEEK_API_KEY: configService.DEEPSEEK_API_KEY ? `Set (length: ${configService.DEEPSEEK_API_KEY.length})` : "Not set",
    DEEPSEEK_API_URL: configService.DEEPSEEK_API_URL,
    DEEPSEEK_MODEL: configService.DEEPSEEK_MODEL,
    SUGGESTION_PROVIDER: configService.SUGGESTION_PROVIDER,
    SUGGESTION_MODEL: configService.SUGGESTION_MODEL,
  };
  
  // Check API key (checkDeepSeekApiKey internally uses configService)
  let apiKeyStatus = "Not configured";
  try {
    const hasApiKey = await checkDeepSeekApiKey();
    apiKeyStatus = hasApiKey ? "Configured" : "Not configured";
  } catch (error: unknown) {
    const err = error instanceof Error ? error : new Error(String(error));
    apiKeyStatus = `Error: ${err.message}`;
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
  } catch (error: unknown) {
    const err = error instanceof Error ? error : new Error(String(error));
    connectionStatus = `Error: ${err.message}`;
  }
  
  return {
    configuration: currentConfig,
    apiKeyStatus: apiKeyStatus, // This reflects the check based on configService's key
    connectionStatus: connectionStatus, // This reflects the test based on configService's settings
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
