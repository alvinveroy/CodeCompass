import { logger } from "../config";

/**
 * Debug function to help diagnose model switching issues
 */
export async function debugModelSwitch(model: string): Promise<Record<string, any>> {
  logger.info(`Debug model switch for: ${model}`);
  
  // Get environment variables before switch
  const beforeEnv = {
    SUGGESTION_MODEL: process.env.SUGGESTION_MODEL,
    SUGGESTION_PROVIDER: process.env.SUGGESTION_PROVIDER,
    EMBEDDING_PROVIDER: process.env.EMBEDDING_PROVIDER,
    DEEPSEEK_API_KEY: process.env.DEEPSEEK_API_KEY ? "Set" : "Not set",
  };
  
  // Get global variables before switch
  const beforeGlobals = {
    CURRENT_SUGGESTION_MODEL: global.CURRENT_SUGGESTION_MODEL,
    CURRENT_SUGGESTION_PROVIDER: global.CURRENT_SUGGESTION_PROVIDER,
    CURRENT_EMBEDDING_PROVIDER: global.CURRENT_EMBEDDING_PROVIDER,
  };
  
  // Determine provider based on model name
  const isDeepSeekModel = model.toLowerCase().includes('deepseek');
  const provider = isDeepSeekModel ? 'deepseek' : 'ollama';
  
  // Set variables directly for testing
  process.env.SUGGESTION_MODEL = model.toLowerCase();
  global.CURRENT_SUGGESTION_MODEL = model.toLowerCase();
  process.env.SUGGESTION_PROVIDER = provider;
  global.CURRENT_SUGGESTION_PROVIDER = provider;
  
  // Get environment variables after direct setting
  const afterEnv = {
    SUGGESTION_MODEL: process.env.SUGGESTION_MODEL,
    SUGGESTION_PROVIDER: process.env.SUGGESTION_PROVIDER,
    EMBEDDING_PROVIDER: process.env.EMBEDDING_PROVIDER,
    DEEPSEEK_API_KEY: process.env.DEEPSEEK_API_KEY ? "Set" : "Not set",
  };
  
  // Get global variables after direct setting
  const afterGlobals = {
    CURRENT_SUGGESTION_MODEL: global.CURRENT_SUGGESTION_MODEL,
    CURRENT_SUGGESTION_PROVIDER: global.CURRENT_SUGGESTION_PROVIDER,
    CURRENT_EMBEDDING_PROVIDER: global.CURRENT_EMBEDDING_PROVIDER,
  };
  
  return {
    requestedModel: model,
    normalizedModel: model.toLowerCase(),
    provider: provider,
    before: {
      environment: beforeEnv,
      globals: beforeGlobals
    },
    after: {
      environment: afterEnv,
      globals: afterGlobals
    },
    timestamp: new Date().toISOString()
  };
}
