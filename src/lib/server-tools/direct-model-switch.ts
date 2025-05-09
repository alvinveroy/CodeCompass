import { configService, logger } from "../config-service";
// fs and path are no longer needed here as configService handles persistence.

/**
 * Directly switches the model without going through the regular switchSuggestionModel function
 * This is a last resort for when the normal switching mechanism fails
 */
export async function directModelSwitch(model: string): Promise<Record<string, unknown>> {
  logger.info(`Direct model switch for: ${model}`);
  
  const normalizedModel = model.toLowerCase();
  const isDeepSeekModel = normalizedModel.includes('deepseek');
  const provider = isDeepSeekModel ? 'deepseek' : 'ollama';
  
  configService.reloadConfigsFromFile(true); // Ensure fresh state

  // Get current state from ConfigService before switch
  const beforeState = {
    model: configService.SUGGESTION_MODEL,
    provider: configService.SUGGESTION_PROVIDER,
    embedding: configService.EMBEDDING_PROVIDER
  };
  
  try {
    // Set the new values using ConfigService
    // This handles updating globals, process.env, and persisting the configuration.
    configService.setSuggestionModel(normalizedModel);
    configService.setSuggestionProvider(provider);
    configService.setEmbeddingProvider("ollama"); // Policy for embedding provider
    
    logger.info(`Directly set model to ${normalizedModel} and provider to ${provider} via ConfigService.`);
  } catch (error: unknown) {
    const err = error instanceof Error ? error : new Error(String(error));
    logger.error(`Error in direct model switch using ConfigService: ${err.message}`);
    return {
      success: false,
      error: err.message,
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
