import { logger } from "./config";
import { getLLMProvider } from "./llm-provider";

/**
 * Test the current LLM provider connection with a simple prompt
 * This is useful for verifying that the provider is working correctly
 */
export async function testCurrentProvider(): Promise<boolean> {
  try {
    logger.info("Testing current LLM provider connection...");
    
    // Get the current provider
    const provider = await getLLMProvider();
    
    // Try a simple prompt
    const result = await provider.generateText("Say hello world");
    
    logger.info(`LLM provider test result: ${result.substring(0, 50)}...`);
    return true;
  } catch (error: any) {
    logger.error(`LLM provider test failed: ${error.message}`);
    return false;
  }
}

/**
 * Get information about the current LLM provider
 * Returns the provider name and any relevant configuration
 */
export async function getCurrentProviderInfo(): Promise<Record<string, any>> {
  // Get the current provider from global state or environment
  const currentProvider = global.CURRENT_LLM_PROVIDER || 
                          process.env.LLM_PROVIDER || 
                          "ollama";
  
  const suggestionProvider = global.CURRENT_SUGGESTION_PROVIDER || 
                             process.env.SUGGESTION_PROVIDER || 
                             currentProvider;
  
  const embeddingProvider = global.CURRENT_EMBEDDING_PROVIDER || 
                            process.env.EMBEDDING_PROVIDER || 
                            "ollama";
  
  const info: Record<string, any> = {
    provider: currentProvider,
    suggestionProvider: suggestionProvider,
    embeddingProvider: embeddingProvider,
    timestamp: new Date().toISOString()
  };
  
  // Add provider-specific information
  if (currentProvider === "deepseek") {
    info.apiUrl = process.env.DEEPSEEK_API_URL || "https://api.deepseek.com/v1";
    info.model = process.env.DEEPSEEK_MODEL || "deepseek-coder";
    info.hasApiKey = !!process.env.DEEPSEEK_API_KEY;
  } else {
    info.host = process.env.OLLAMA_HOST || "http://127.0.0.1:11434";
    info.embeddingModel = process.env.EMBEDDING_MODEL || "nomic-embed-text:v1.5";
    info.suggestionModel = process.env.SUGGESTION_MODEL || "llama3.1:8b";
  }
  
  return info;
}
