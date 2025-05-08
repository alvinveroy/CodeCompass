import { logger } from "./config";
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
  
  // Get current environment and global variables
  const environment = {
    SUGGESTION_MODEL: process.env.SUGGESTION_MODEL,
    SUGGESTION_PROVIDER: process.env.SUGGESTION_PROVIDER,
    EMBEDDING_PROVIDER: process.env.EMBEDDING_PROVIDER,
    DEEPSEEK_API_KEY: process.env.DEEPSEEK_API_KEY ? "Set" : "Not set",
    DEEPSEEK_API_URL: process.env.DEEPSEEK_API_URL,
    OLLAMA_HOST: process.env.OLLAMA_HOST,
  };
  
  const globals = {
    CURRENT_SUGGESTION_MODEL: global.CURRENT_SUGGESTION_MODEL,
    CURRENT_SUGGESTION_PROVIDER: global.CURRENT_SUGGESTION_PROVIDER,
    CURRENT_EMBEDDING_PROVIDER: global.CURRENT_EMBEDDING_PROVIDER,
  };
  
  // Get the current provider
  const llmProvider = await getLLMProvider();
  
  // Test connection
  const connectionTest = await llmProvider.checkConnection();
  
  // Test text generation
  let generationTest = false;
  let generationError = null;
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
      type: global.CURRENT_SUGGESTION_PROVIDER,
      model: global.CURRENT_SUGGESTION_MODEL,
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
  
  // Reset global variables
  global.CURRENT_SUGGESTION_MODEL = undefined;
  // Use empty string instead of undefined for string types
  global.CURRENT_SUGGESTION_PROVIDER = "";
  global.CURRENT_EMBEDDING_PROVIDER = "";
  
  // Reset environment variables
  delete process.env.SUGGESTION_MODEL;
  delete process.env.SUGGESTION_PROVIDER;
  delete process.env.EMBEDDING_PROVIDER;
  
  logger.info("Provider reset complete");
}
