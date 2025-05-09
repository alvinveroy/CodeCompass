import { configService, logger } from "../config-service";

/**
 * Performs a comprehensive diagnostic on model switching
 */
export async function modelSwitchDiagnostic(): Promise<Record<string, unknown>> {
  logger.info("Running comprehensive model switch diagnostic");
  configService.reloadConfigsFromFile(true); // Ensure fresh state

  // Get current state from ConfigService
  const originalState = {
    SUGGESTION_MODEL: configService.SUGGESTION_MODEL,
    SUGGESTION_PROVIDER: configService.SUGGESTION_PROVIDER,
    EMBEDDING_PROVIDER: configService.EMBEDDING_PROVIDER,
    DEEPSEEK_API_KEY: configService.DEEPSEEK_API_KEY ? "Set" : "Not set",
    DEEPSEEK_API_URL: configService.DEEPSEEK_API_URL,
    OLLAMA_HOST: configService.OLLAMA_HOST,
    NODE_ENV: process.env.NODE_ENV, // NODE_ENV is not managed by ConfigService but useful for diagnostics
    VITEST: process.env.VITEST,     // VITEST is not managed by ConfigService
  };
  
  const testDeepseekModel = "deepseek-coder";
  const testOllamaModel = "llama3.1:8b";
  
  // Test setting DeepSeek model via ConfigService
  configService.setSuggestionModel(testDeepseekModel);
  configService.setSuggestionProvider("deepseek");
  
  const deepseekTest = {
    expected: {
      model: testDeepseekModel,
      provider: "deepseek"
    },
    actual: {
      model: configService.SUGGESTION_MODEL,
      provider: configService.SUGGESTION_PROVIDER
    },
    success: configService.SUGGESTION_MODEL === testDeepseekModel && configService.SUGGESTION_PROVIDER === "deepseek"
  };
  
  // Test setting Ollama model via ConfigService
  configService.setSuggestionModel(testOllamaModel);
  configService.setSuggestionProvider("ollama");
  
  const ollamaTest = {
    expected: {
      model: testOllamaModel,
      provider: "ollama"
    },
    actual: {
      model: configService.SUGGESTION_MODEL,
      provider: configService.SUGGESTION_PROVIDER
    },
    success: configService.SUGGESTION_MODEL === testOllamaModel && configService.SUGGESTION_PROVIDER === "ollama"
  };
  
  // Restore original state using ConfigService
  configService.setSuggestionModel(originalState.SUGGESTION_MODEL);
  configService.setSuggestionProvider(originalState.SUGGESTION_PROVIDER);
  if (originalState.EMBEDDING_PROVIDER) { // EMBEDDING_PROVIDER might not always be in originalState if it was default
      configService.setEmbeddingProvider(originalState.EMBEDDING_PROVIDER);
  }
  // API key, URL, OLLAMA_HOST are not changed by these setters, they are loaded from file/env by configService
  
  // Re-fetch the restored state to report
  const restoredState = {
    SUGGESTION_MODEL: configService.SUGGESTION_MODEL,
    SUGGESTION_PROVIDER: configService.SUGGESTION_PROVIDER,
    EMBEDDING_PROVIDER: configService.EMBEDDING_PROVIDER,
    DEEPSEEK_API_KEY: configService.DEEPSEEK_API_KEY ? "Set" : "Not set",
    DEEPSEEK_API_URL: configService.DEEPSEEK_API_URL,
    OLLAMA_HOST: configService.OLLAMA_HOST,
    NODE_ENV: process.env.NODE_ENV,
    VITEST: process.env.VITEST,
  };

  return {
    originalStateReported: originalState, // State at the beginning of the diagnostic
    tests: {
      deepseek: deepseekTest,
      ollama: ollamaTest
    },
    finalRestoredState: restoredState, // State after attempting to restore
    timestamp: new Date().toISOString()
  };
}
