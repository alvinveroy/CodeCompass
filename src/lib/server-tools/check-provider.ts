import { logger } from "../config";
import { getLLMProvider } from "../llm-provider";

/**
 * Checks the current LLM provider status in detail
 */
export async function checkProviderDetailed(): Promise<Record<string, any>> {
  logger.info("Checking LLM provider status in detail");
  
  // Get environment variables
  const envVars = {
    SUGGESTION_MODEL: process.env.SUGGESTION_MODEL,
    SUGGESTION_PROVIDER: process.env.SUGGESTION_PROVIDER,
    EMBEDDING_PROVIDER: process.env.EMBEDDING_PROVIDER,
    DEEPSEEK_API_KEY: process.env.DEEPSEEK_API_KEY ? "Set" : "Not set",
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
  try {
    const provider = await getLLMProvider();
    const connected = await provider.checkConnection();
    connectionStatus = connected ? "Connected" : "Failed";
  } catch (error: any) {
    connectionStatus = `Error: ${error.message}`;
  }
  
  return {
    environment: envVars,
    globals: globals,
    connectionStatus: connectionStatus,
    timestamp: new Date().toISOString()
  };
}
