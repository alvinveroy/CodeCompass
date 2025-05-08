import { logger } from "../config";

/**
 * Performs a comprehensive diagnostic on model switching
 */
export async function modelSwitchDiagnostic(): Promise<Record<string, any>> {
  logger.info("Running comprehensive model switch diagnostic");
  
  // Get current state
  const currentState = {
    environment: {
      SUGGESTION_MODEL: process.env.SUGGESTION_MODEL,
      SUGGESTION_PROVIDER: process.env.SUGGESTION_PROVIDER,
      EMBEDDING_PROVIDER: process.env.EMBEDDING_PROVIDER,
      DEEPSEEK_API_KEY: process.env.DEEPSEEK_API_KEY ? "Set" : "Not set",
      DEEPSEEK_API_URL: process.env.DEEPSEEK_API_URL,
      OLLAMA_HOST: process.env.OLLAMA_HOST,
      NODE_ENV: process.env.NODE_ENV,
      VITEST: process.env.VITEST,
    },
    globals: {
      CURRENT_SUGGESTION_MODEL: global.CURRENT_SUGGESTION_MODEL,
      CURRENT_SUGGESTION_PROVIDER: global.CURRENT_SUGGESTION_PROVIDER,
      CURRENT_EMBEDDING_PROVIDER: global.CURRENT_EMBEDDING_PROVIDER,
    }
  };
  
  // Test direct setting of globals
  const testDeepseek = "deepseek-coder";
  const testOllama = "llama3.1:8b";
  
  // Test setting deepseek
  global.CURRENT_SUGGESTION_MODEL = testDeepseek;
  process.env.SUGGESTION_MODEL = testDeepseek;
  global.CURRENT_SUGGESTION_PROVIDER = "deepseek";
  process.env.SUGGESTION_PROVIDER = "deepseek";
  
  const deepseekTest = {
    expected: {
      model: testDeepseek,
      provider: "deepseek"
    },
    actual: {
      model: global.CURRENT_SUGGESTION_MODEL,
      provider: global.CURRENT_SUGGESTION_PROVIDER
    },
    success: global.CURRENT_SUGGESTION_MODEL === testDeepseek && global.CURRENT_SUGGESTION_PROVIDER === "deepseek"
  };
  
  // Test setting ollama
  global.CURRENT_SUGGESTION_MODEL = testOllama;
  process.env.SUGGESTION_MODEL = testOllama;
  global.CURRENT_SUGGESTION_PROVIDER = "ollama";
  process.env.SUGGESTION_PROVIDER = "ollama";
  
  const ollamaTest = {
    expected: {
      model: testOllama,
      provider: "ollama"
    },
    actual: {
      model: global.CURRENT_SUGGESTION_MODEL,
      provider: global.CURRENT_SUGGESTION_PROVIDER
    },
    success: global.CURRENT_SUGGESTION_MODEL === testOllama && global.CURRENT_SUGGESTION_PROVIDER === "ollama"
  };
  
  // Restore original state
  global.CURRENT_SUGGESTION_MODEL = currentState.globals.CURRENT_SUGGESTION_MODEL;
  process.env.SUGGESTION_MODEL = currentState.environment.SUGGESTION_MODEL;
  global.CURRENT_SUGGESTION_PROVIDER = currentState.globals.CURRENT_SUGGESTION_PROVIDER;
  process.env.SUGGESTION_PROVIDER = currentState.environment.SUGGESTION_PROVIDER;
  
  return {
    currentState,
    tests: {
      deepseek: deepseekTest,
      ollama: ollamaTest
    },
    timestamp: new Date().toISOString()
  };
}
