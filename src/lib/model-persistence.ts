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
    // First try to load DeepSeek API key from config
    const deepseekConfigFile = path.join(CONFIG_DIR, 'deepseek-config.json');
    if (fs.existsSync(deepseekConfigFile)) {
      try {
        const deepseekConfig = JSON.parse(fs.readFileSync(deepseekConfigFile, 'utf8'));
        if (deepseekConfig.DEEPSEEK_API_KEY) {
          process.env.DEEPSEEK_API_KEY = deepseekConfig.DEEPSEEK_API_KEY;
          logger.info(`Loaded DeepSeek API key from ${deepseekConfigFile}`);
          
          if (deepseekConfig.DEEPSEEK_API_URL) {
            process.env.DEEPSEEK_API_URL = deepseekConfig.DEEPSEEK_API_URL;
            logger.info(`Loaded DeepSeek API URL from config: ${deepseekConfig.DEEPSEEK_API_URL}`);
          }
        }
      } catch (error: any) {
        logger.warn(`Failed to load DeepSeek config: ${error.message}`);
      }
    }
    
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
  const isDeepSeekModel = model.toLowerCase().includes('deepseek');
  
  // Set global variables
  global.CURRENT_SUGGESTION_MODEL = model.toLowerCase();
  global.CURRENT_SUGGESTION_PROVIDER = isDeepSeekModel ? 'deepseek' : 'ollama';
  
  // Set environment variables
  process.env.SUGGESTION_MODEL = model.toLowerCase();
  process.env.SUGGESTION_PROVIDER = isDeepSeekModel ? 'deepseek' : 'ollama';
  
  // Save to persistent storage
  saveModelConfig();
  
  logger.info(`Forced model to ${model.toLowerCase()} and provider to ${global.CURRENT_SUGGESTION_PROVIDER}`);
}
