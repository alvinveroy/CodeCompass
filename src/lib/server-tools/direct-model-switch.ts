import { logger } from "../config";

/**
 * Directly switches the model without going through the regular switchSuggestionModel function
 * This is a last resort for when the normal switching mechanism fails
 */
export async function directModelSwitch(model: string): Promise<Record<string, any>> {
  logger.info(`Direct model switch for: ${model}`);
  
  const normalizedModel = model.toLowerCase();
  const isDeepSeekModel = normalizedModel.includes('deepseek');
  const provider = isDeepSeekModel ? 'deepseek' : 'ollama';
  
  // Get current state before switch
  const beforeState = {
    model: global.CURRENT_SUGGESTION_MODEL,
    provider: global.CURRENT_SUGGESTION_PROVIDER,
    embedding: global.CURRENT_EMBEDDING_PROVIDER
  };
  
  try {
    // Clear all existing values
    delete process.env.SUGGESTION_MODEL;
    delete process.env.SUGGESTION_PROVIDER;
    delete process.env.EMBEDDING_PROVIDER;
    
    // Force set the new values directly
    global.CURRENT_SUGGESTION_MODEL = normalizedModel;
    global.CURRENT_SUGGESTION_PROVIDER = provider;
    global.CURRENT_EMBEDDING_PROVIDER = "ollama";
    
    // Also set environment variables
    process.env.SUGGESTION_MODEL = normalizedModel;
    process.env.SUGGESTION_PROVIDER = provider;
    process.env.EMBEDDING_PROVIDER = "ollama";
    
    logger.info(`Directly set model to ${normalizedModel} and provider to ${provider}`);
  } catch (error: any) {
    logger.error(`Error in direct model switch: ${error.message}`);
    return {
      success: false,
      error: error.message,
      before: beforeState,
      after: {
        model: global.CURRENT_SUGGESTION_MODEL,
        provider: global.CURRENT_SUGGESTION_PROVIDER,
        embedding: global.CURRENT_EMBEDDING_PROVIDER
      }
    };
  }
  
  // Verify the switch was successful
  const success = global.CURRENT_SUGGESTION_MODEL === normalizedModel && 
                  global.CURRENT_SUGGESTION_PROVIDER === provider;
  
  return {
    success,
    before: beforeState,
    after: {
      model: global.CURRENT_SUGGESTION_MODEL,
      provider: global.CURRENT_SUGGESTION_PROVIDER,
      embedding: global.CURRENT_EMBEDDING_PROVIDER
    },
    timestamp: new Date().toISOString()
  };
}
