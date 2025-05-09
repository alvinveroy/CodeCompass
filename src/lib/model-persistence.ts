import * as fs from 'fs';
// path is available from configService if needed for local operations
import { configService, logger } from './config-service';

// CONFIG_DIR and MODEL_CONFIG_FILE are now sourced from configService
export const CONFIG_DIR = configService.CONFIG_DIR;
export const MODEL_CONFIG_FILE = configService.MODEL_CONFIG_FILE;

/**
 * Save the current model configuration to persistent storage
 */
export function saveModelConfig(): void {
  try {
    // Create directory if it doesn't exist
    if (!fs.existsSync(CONFIG_DIR)) {
      fs.mkdirSync(CONFIG_DIR, { recursive: true });
    }
    
    // Delegate persistence to ConfigService
    configService.persistModelConfiguration();
    // Logging is handled within configService.persistModelConfiguration()
  } catch (error: unknown) {
    const err = error instanceof Error ? error : new Error(String(error));
    logger.warn(`Failed to save model configuration: ${err.message}`);
  }
}

/**
 * Load the model configuration from persistent storage
 * @param forceSet Whether to force set the configuration even if already set
 */
export function loadModelConfig(forceSet = false): void {
  try {
    // Delegate loading to ConfigService
    configService.reloadConfigsFromFile(forceSet);
    // Logging is handled within configService.reloadConfigsFromFile()
  } catch (error: unknown) {
    const err = error instanceof Error ? error : new Error(String(error));
    logger.warn(`Failed to load model configuration via configService: ${err.message}`);
  }
}

/**
 * Force update the model configuration based on the model name
 * @param model The model name to set
 */
export function forceUpdateModelConfig(model: string): void {
  const normalizedModel = model.toLowerCase();
  const isDeepSeekModel = normalizedModel.includes('deepseek');
  const provider = isDeepSeekModel ? 'deepseek' : 'ollama';
  
  // Set model configuration via ConfigService
  configService.setSuggestionModel(normalizedModel);
  configService.setSuggestionProvider(provider);
  configService.setEmbeddingProvider("ollama"); // Policy: embeddings always Ollama
  
  // configService setters call persistModelConfiguration internally.
  
  logger.info(`Forced model to ${configService.SUGGESTION_MODEL} and provider to ${configService.SUGGESTION_PROVIDER}`);
}
