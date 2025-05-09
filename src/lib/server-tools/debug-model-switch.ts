import { configService, logger } from "../config-service";

/**
 * Debug function to help diagnose model switching issues
 */
export async function debugModelSwitch(model: string): Promise<Record<string, unknown>> {
  logger.info(`Debug model switch for: ${model}`);
  configService.reloadConfigsFromFile(true); // Ensure fresh state

  // Get state from ConfigService before switch
  const beforeState = {
    SUGGESTION_MODEL: configService.SUGGESTION_MODEL,
    SUGGESTION_PROVIDER: configService.SUGGESTION_PROVIDER,
    EMBEDDING_PROVIDER: configService.EMBEDDING_PROVIDER,
    DEEPSEEK_API_KEY: configService.DEEPSEEK_API_KEY ? "Set" : "Not set",
    LLM_PROVIDER: configService.LLM_PROVIDER,
  };
  
  // Determine provider based on model name
  const normalizedModel = model.toLowerCase();
  const isDeepSeekModel = normalizedModel.includes('deepseek');
  const providerToSet = isDeepSeekModel ? 'deepseek' : 'ollama';
  
  // Set variables using ConfigService
  // This will also update globals and process.env internally and persist
  configService.setSuggestionModel(normalizedModel);
  configService.setSuggestionProvider(providerToSet);
  // Embedding provider is typically set to 'ollama' by default by setSuggestionProvider or can be set explicitly if needed
  // configService.setEmbeddingProvider("ollama"); 
  
  // Get state from ConfigService after setting
  const afterState = {
    SUGGESTION_MODEL: configService.SUGGESTION_MODEL,
    SUGGESTION_PROVIDER: configService.SUGGESTION_PROVIDER,
    EMBEDDING_PROVIDER: configService.EMBEDDING_PROVIDER,
    DEEPSEEK_API_KEY: configService.DEEPSEEK_API_KEY ? "Set" : "Not set",
    LLM_PROVIDER: configService.LLM_PROVIDER,
  };
  
  return {
    requestedModel: model,
    normalizedModel: normalizedModel,
    determinedProvider: providerToSet,
    beforeSwitch: beforeState,
    afterSwitch: afterState,
    timestamp: new Date().toISOString()
  };
}
