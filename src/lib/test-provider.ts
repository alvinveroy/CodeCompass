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
  } catch (error: unknown) {
    const err = error instanceof Error ? error : new Error(String(error));
    logger.error(`LLM provider test failed: ${err.message}`);
    return false;
  }
}

/**
 * Get information about the current LLM provider
 * Returns the provider name and any relevant configuration
 */
export async function getCurrentProviderInfo(): Promise<Record<string, unknown>> {
  // Get model information
  const suggestionModel = global.CURRENT_SUGGESTION_MODEL || 
                          process.env.SUGGESTION_MODEL || 
                          "llama3.1:8b";
  
  // Determine provider based on model
  const isDeepSeekModel = suggestionModel.toLowerCase().includes('deepseek');
  
  // Prioritize suggestion provider settings
  const suggestionProvider = global.CURRENT_SUGGESTION_PROVIDER || 
                             process.env.SUGGESTION_PROVIDER || 
                             (isDeepSeekModel ? "deepseek" : process.env.LLM_PROVIDER || "ollama");
  
  const embeddingProvider = global.CURRENT_EMBEDDING_PROVIDER || 
                            process.env.EMBEDDING_PROVIDER || 
                            "ollama";
  
  const info: Record<string, unknown> = {
    provider: suggestionProvider, // For backward compatibility
    suggestionModel: suggestionModel,
    suggestionProvider: suggestionProvider,
    embeddingProvider: embeddingProvider,
    timestamp: new Date().toISOString()
  };
  
  // Add provider-specific information
  if (suggestionProvider === "deepseek") {
    const apiKey = process.env.DEEPSEEK_API_KEY;
    info.apiUrl = process.env.DEEPSEEK_API_URL || "https://api.deepseek.com/chat/completions";
    info.model = suggestionModel;
    info.hasApiKey = !!apiKey;
    info.apiKeyConfigured = !!apiKey;
    info.apiEndpointConfigured = !!process.env.DEEPSEEK_API_URL;
    
    // Log the API key status for debugging (without revealing it)
    logger.info(`DeepSeek API key configured: ${!!apiKey}, length: ${apiKey ? apiKey.length : 0}, value: ${apiKey ? apiKey.substring(0, 5) + '...' : 'none'}`);
  } else {
    info.host = process.env.OLLAMA_HOST || "http://127.0.0.1:11434";
    info.embeddingModel = process.env.EMBEDDING_MODEL || "nomic-embed-text:v1.5";
    info.suggestionModel = suggestionModel;
  }
  
  return info;
}
