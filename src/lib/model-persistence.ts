import * as fs from 'fs';
import * as path from 'path';
import { logger } from './config';

/**
 * Configuration directory for CodeCompass
 */
export const CONFIG_DIR = path.join(process.env.HOME || process.env.USERPROFILE || '', '.codecompass');

/**
 * Configuration file for model settings
 */
export const MODEL_CONFIG_FILE = path.join(CONFIG_DIR, 'model-config.json');

/**
 * Save the current model configuration to persistent storage
 */
export function saveModelConfig(): void {
  try {
    // Create directory if it doesn't exist
    if (!fs.existsSync(CONFIG_DIR)) {
      fs.mkdirSync(CONFIG_DIR, { recursive: true });
    }
    
    // Get current settings
    const config = {
      SUGGESTION_MODEL: global.CURRENT_SUGGESTION_MODEL || process.env.SUGGESTION_MODEL,
      SUGGESTION_PROVIDER: global.CURRENT_SUGGESTION_PROVIDER || process.env.SUGGESTION_PROVIDER,
      EMBEDDING_PROVIDER: global.CURRENT_EMBEDDING_PROVIDER || process.env.EMBEDDING_PROVIDER,
      timestamp: new Date().toISOString()
    };
    
    // Write to file
    fs.writeFileSync(MODEL_CONFIG_FILE, JSON.stringify(config, null, 2));
    logger.info(`Saved model configuration to ${MODEL_CONFIG_FILE}`);
  } catch (error: any) {
    logger.warn(`Failed to save model configuration: ${error.message}`);
  }
}

/**
 * Load the model configuration from persistent storage
 * @param forceSet Whether to force set the configuration even if already set
 */
export function loadModelConfig(forceSet: boolean = false): void {
  try {
    // DeepSeek API key is loaded by the deepseek module directly
    
    // Then load model config
    if (!fs.existsSync(MODEL_CONFIG_FILE)) {
      logger.debug(`Model configuration file not found: ${MODEL_CONFIG_FILE}`);
      return;
    }
    
    const config = JSON.parse(fs.readFileSync(MODEL_CONFIG_FILE, 'utf8'));
    
    // Set global variables
    if (config.SUGGESTION_MODEL && (forceSet || !global.CURRENT_SUGGESTION_MODEL)) {
      global.CURRENT_SUGGESTION_MODEL = config.SUGGESTION_MODEL;
      process.env.SUGGESTION_MODEL = config.SUGGESTION_MODEL;
      logger.info(`Loaded suggestion model: ${config.SUGGESTION_MODEL}`);
    }
    
    if (config.SUGGESTION_PROVIDER && (forceSet || !global.CURRENT_SUGGESTION_PROVIDER)) {
      global.CURRENT_SUGGESTION_PROVIDER = config.SUGGESTION_PROVIDER;
      process.env.SUGGESTION_PROVIDER = config.SUGGESTION_PROVIDER;
      logger.info(`Loaded suggestion provider: ${config.SUGGESTION_PROVIDER}`);
    }
    
    if (config.EMBEDDING_PROVIDER && (forceSet || !global.CURRENT_EMBEDDING_PROVIDER)) {
      global.CURRENT_EMBEDDING_PROVIDER = config.EMBEDDING_PROVIDER;
      process.env.EMBEDDING_PROVIDER = config.EMBEDDING_PROVIDER;
      logger.info(`Loaded embedding provider: ${config.EMBEDDING_PROVIDER}`);
    }
    
    logger.info(`Successfully loaded model configuration from ${MODEL_CONFIG_FILE}`);
  } catch (error: any) {
    logger.warn(`Failed to load model configuration: ${error.message}`);
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
  
  // Set global variables
  global.CURRENT_SUGGESTION_MODEL = normalizedModel;
  global.CURRENT_SUGGESTION_PROVIDER = provider;
  
  // Set environment variables
  process.env.SUGGESTION_MODEL = normalizedModel;
  process.env.SUGGESTION_PROVIDER = provider;
  
  // Always use Ollama for embeddings
  global.CURRENT_EMBEDDING_PROVIDER = "ollama";
  process.env.EMBEDDING_PROVIDER = "ollama";
  
  // Save to persistent storage
  saveModelConfig();
  
  logger.info(`Forced model to ${normalizedModel} and provider to ${provider}`);
}
