import { configService, logger } from "../config-service";
import { getLLMProvider } from "../llm-provider";
import * as deepseek from "../deepseek";

/**
 * Checks the current LLM provider status in detail
 */
export async function checkProviderDetailed(): Promise<Record<string, unknown>> {
  logger.info("Checking LLM provider status in detail");
  configService.reloadConfigsFromFile(true); // Ensure config is fresh

  const apiKey = configService.DEEPSEEK_API_KEY;
  
  logger.info(`DEEPSEEK_API_KEY from ConfigService: ${apiKey ? `Present (length: ${apiKey.length})` : "Not present"}`);
  logger.info(`DEEPSEEK_API_KEY first 5 chars: ${apiKey ? apiKey.substring(0, 5) : "N/A"}`);
  
  const envVars = { // These reflect ConfigService's view of the effective configuration
    SUGGESTION_MODEL: configService.SUGGESTION_MODEL,
    SUGGESTION_PROVIDER: configService.SUGGESTION_PROVIDER,
    EMBEDDING_PROVIDER: configService.EMBEDDING_PROVIDER,
    DEEPSEEK_API_KEY: apiKey ? `Set (length: ${apiKey.length})` : "Not set",
    DEEPSEEK_API_URL: configService.DEEPSEEK_API_URL,
    OLLAMA_HOST: configService.OLLAMA_HOST,
  };
  
  // Globals are set by ConfigService, so they should align
  const globals = {
    CURRENT_SUGGESTION_MODEL: configService.SUGGESTION_MODEL,
    CURRENT_SUGGESTION_PROVIDER: configService.SUGGESTION_PROVIDER,
    CURRENT_EMBEDDING_PROVIDER: configService.EMBEDDING_PROVIDER,
  };
  
  // Test provider connection
  let connectionStatus = "Unknown";
  let hasApiKey = false;
  let apiKeyConfigured = false;
  
  // deepseek.checkDeepSeekApiKey() is part of deepseek module, which now uses configService.
  // We rely on configService.DEEPSEEK_API_KEY for the effective key.
  apiKeyConfigured = !!configService.DEEPSEEK_API_KEY;
  hasApiKey = apiKeyConfigured;

  if (apiKeyConfigured) {
    logger.info(`DeepSeek API key is available (via ConfigService) with length: ${configService.DEEPSEEK_API_KEY.length}`);
  } else {
    logger.warn("DeepSeek API key not configured (via ConfigService).");
  }
  
  try {
    // Test based on the provider determined by ConfigService
    if (configService.SUGGESTION_PROVIDER === 'deepseek') {
      logger.info("Testing DeepSeek connection directly");
      const connected = await deepseek.testDeepSeekConnection(); // Uses configService
      connectionStatus = connected ? "Connected" : "Failed";
      
      if (connected) {
        // apiKeyConfigured and hasApiKey are already set based on configService
        logger.info("DeepSeek connection test successful");
      } else {
        logger.warn("Direct DeepSeek connection test failed");
      }
    } else {
      // For non-DeepSeek providers, use the standard provider interface
      const provider = await getLLMProvider();
      const connected = await provider.checkConnection();
      connectionStatus = connected ? "Connected" : "Failed";
    }
    
    // If connection failed but we have an API key, log more details
    if (connectionStatus === "Failed" && hasApiKey) {
      logger.warn("Connection failed despite having API key. Check API URL and network connectivity.");
    }
  } catch (error: unknown) {
    const err = error instanceof Error ? error : new Error(String(error));
    connectionStatus = `Error: ${err.message}`;
    logger.error(`Provider connection error: ${err.message}`);
  }
  
  return {
    environment: envVars,
    globals: globals, // Reflects ConfigService state
    connectionStatus: connectionStatus,
    timestamp: new Date().toISOString(),
    apiUrl: configService.DEEPSEEK_API_URL,
    model: configService.SUGGESTION_MODEL,
    hasApiKey: hasApiKey, // Based on configService.DEEPSEEK_API_KEY
    apiKeyConfigured: apiKeyConfigured, // Based on configService.DEEPSEEK_API_KEY
    apiEndpointConfigured: !!configService.DEEPSEEK_API_URL, // Based on configService
    noteText: `Note: For DeepSeek models, ensure you have set the DEEPSEEK_API_KEY environment variable.
You can also set DEEPSEEK_API_URL to use a custom endpoint (defaults to https://api.deepseek.com/chat/completions).
To set your API key permanently, run: npm run set-deepseek-key YOUR_API_KEY
If you're still having issues, try running 'npm run test:deepseek' to test the DeepSeek connection directly.`
  };
}
