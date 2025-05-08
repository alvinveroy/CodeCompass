import { logger } from "../config";
import { getLLMProvider } from "../llm-provider";

/**
 * Checks the current LLM provider status in detail
 */
export async function checkProviderDetailed(): Promise<Record<string, any>> {
  logger.info("Checking LLM provider status in detail");
  
  // Get environment variables and force read from process.env
  const apiKey = process.env.DEEPSEEK_API_KEY || "";
  
  // Log API key details for debugging
  logger.info(`DEEPSEEK_API_KEY in environment: ${apiKey ? `Present (length: ${apiKey.length})` : "Not present"}`);
  logger.info(`DEEPSEEK_API_KEY first 5 chars: ${apiKey ? apiKey.substring(0, 5) : "N/A"}`);
  
  const envVars = {
    SUGGESTION_MODEL: process.env.SUGGESTION_MODEL,
    SUGGESTION_PROVIDER: process.env.SUGGESTION_PROVIDER,
    EMBEDDING_PROVIDER: process.env.EMBEDDING_PROVIDER,
    DEEPSEEK_API_KEY: apiKey ? `Set (length: ${apiKey.length})` : "Not set",
    DEEPSEEK_API_URL: process.env.DEEPSEEK_API_URL || "https://api.deepseek.com/chat/completions",
    OLLAMA_HOST: process.env.OLLAMA_HOST,
  };
  
  // Get global variables
  const globals = {
    CURRENT_SUGGESTION_MODEL: global.CURRENT_SUGGESTION_MODEL,
    CURRENT_SUGGESTION_PROVIDER: global.CURRENT_SUGGESTION_PROVIDER,
    CURRENT_EMBEDDING_PROVIDER: global.CURRENT_EMBEDDING_PROVIDER,
  };
  
  // Test provider connection
  let connectionStatus = "Unknown";
  let hasApiKey = false;
  let apiKeyConfigured = false;
  
  // Check if DeepSeek API key is available
  if (apiKey) {
    hasApiKey = true;
    apiKeyConfigured = true;
    logger.info(`DeepSeek API key is available with length: ${apiKey.length}`);
    
    // Force set the API key in the environment variable to ensure it's available to the provider
    process.env.DEEPSEEK_API_KEY = apiKey;
    logger.info("Forced set DEEPSEEK_API_KEY in environment");
  } else {
    logger.warn("DeepSeek API key is not available in environment");
  }
  
  try {
    const provider = await getLLMProvider();
    const connected = await provider.checkConnection();
    connectionStatus = connected ? "Connected" : "Failed";
    
    // If connection failed but we have an API key, log more details
    if (!connected && hasApiKey) {
      logger.warn("Connection failed despite having API key. Check API URL and network connectivity.");
    }
  } catch (error: any) {
    connectionStatus = `Error: ${error.message}`;
    logger.error(`Provider connection error: ${error.message}`);
  }
  
  return {
    environment: envVars,
    globals: globals,
    connectionStatus: connectionStatus,
    timestamp: new Date().toISOString(),
    apiUrl: process.env.DEEPSEEK_API_URL || "https://api.deepseek.com/chat/completions",
    model: process.env.SUGGESTION_MODEL || global.CURRENT_SUGGESTION_MODEL || "deepseek-coder",
    hasApiKey: hasApiKey,
    apiKeyConfigured: apiKeyConfigured,
    apiEndpointConfigured: !!process.env.DEEPSEEK_API_URL,
    noteText: `Note: For DeepSeek models, ensure you have set the DEEPSEEK_API_KEY environment variable.
You can also set DEEPSEEK_API_URL to use a custom endpoint (defaults to https://api.deepseek.com/chat/completions).`
  };
}
