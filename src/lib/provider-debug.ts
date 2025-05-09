import { configService, logger } from "./config-service";
import { getLLMProvider, clearProviderCache } from "./llm-provider";

/**
 * Debug function to verify the current provider is working correctly
 * @returns Object with debug information
 */
export async function debugProvider(): Promise<Record<string, unknown>> {
  logger.info("Running provider debug");
  
  // Clear module cache for provider-related modules
  Object.keys(require.cache).forEach(key => {
    if (key.includes('llm-provider') || key.includes('deepseek') || key.includes('ollama')) {
      delete require.cache[key];
    }
  });
  
  // Clear provider cache
  clearProviderCache();
  
  // Get current environment and global variables from ConfigService
  configService.reloadConfigsFromFile(true); // Ensure it's fresh
  const environment = {
    SUGGESTION_MODEL: configService.SUGGESTION_MODEL,
    SUGGESTION_PROVIDER: configService.SUGGESTION_PROVIDER,
    EMBEDDING_PROVIDER: configService.EMBEDDING_PROVIDER,
    DEEPSEEK_API_KEY: configService.DEEPSEEK_API_KEY ? "Set" : "Not set",
    DEEPSEEK_API_URL: configService.DEEPSEEK_API_URL,
    OLLAMA_HOST: configService.OLLAMA_HOST,
  };
  
  const globals = { // These globals are set by ConfigService, reflecting its state
    CURRENT_SUGGESTION_MODEL: configService.SUGGESTION_MODEL,
    CURRENT_SUGGESTION_PROVIDER: configService.SUGGESTION_PROVIDER,
    CURRENT_EMBEDDING_PROVIDER: configService.EMBEDDING_PROVIDER,
  };
  
  // Get the current provider
  const llmProvider = await getLLMProvider();
  
  // Test connection
  const connectionTest = await llmProvider.checkConnection();
  
  // Test text generation
  let generationTest = false;
  let generationError: string | null = null;
  try {
    const result = await llmProvider.generateText("Test message for provider debug");
    generationTest = result.length > 0;
  } catch (error: unknown) {
    const err = error instanceof Error ? error : new Error(String(error));
    generationError = err.message;
  }
  
  return {
    timestamp: new Date().toISOString(),
    environment,
    globals,
    provider: {
      type: configService.SUGGESTION_PROVIDER, // Use getter from configService
      model: configService.SUGGESTION_MODEL,   // Use getter from configService
      connectionTest,
      generationTest,
      generationError,
    }
  };
}

/**
 * Force reset all provider settings and cache
 */
export async function resetProvider(): Promise<void> {
  logger.info("Resetting provider");
  
  // Clear module cache
  Object.keys(require.cache).forEach(key => {
    if (key.includes('llm-provider') || key.includes('deepseek') || key.includes('ollama')) {
      delete require.cache[key];
    }
  });
  
  // Clear provider cache
  clearProviderCache();
  
  // Reset configuration via ConfigService to defaults
  // This involves setting them to typical defaults and persisting.
  configService.setSuggestionModel("llama3.1:8b"); // A common default
  configService.setSuggestionProvider("ollama");    // A common default
  configService.setEmbeddingProvider("ollama");   // A common default
  // configService setters will update globals and process.env, and persist.
  
  logger.info("Provider reset complete");
}
