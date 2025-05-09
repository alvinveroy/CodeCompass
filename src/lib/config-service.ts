import winston from "winston";
import * as fs from 'fs';
import * as path from 'path';

// Define a type for the model configuration loaded from file
interface ModelConfigFile {
  SUGGESTION_MODEL?: string;
  SUGGESTION_PROVIDER?: string;
  EMBEDDING_PROVIDER?: string;
  DEEPSEEK_API_KEY?: string;
  DEEPSEEK_API_URL?: string;
}

class ConfigService {
  private static instance: ConfigService;
  public readonly logger: winston.Logger;

  // Configuration values with defaults
  public readonly OLLAMA_HOST: string;
  public readonly QDRANT_HOST: string;
  public readonly COLLECTION_NAME: string;
  
  private _llmProvider: string;
  private _suggestionModel: string;
  private _embeddingModel: string;
  private _deepSeekApiKey: string;
  private _deepSeekApiUrl: string;
  private _deepSeekModel: string;
  private _deepSeekRpmLimit: number; // Requests Per Minute

  private _useMixedProviders: boolean;
  private _suggestionProvider: string;
  private _embeddingProvider: string;

  public readonly MAX_INPUT_LENGTH: number;
  public readonly MAX_SNIPPET_LENGTH: number;
  public readonly REQUEST_TIMEOUT: number;
  public readonly MAX_RETRIES: number;
  public readonly RETRY_DELAY: number;

  public readonly DEEPSEEK_RPM_LIMIT_DEFAULT = 60; // Default RPM for DeepSeek

  public readonly CONFIG_DIR: string;
  public readonly MODEL_CONFIG_FILE: string;
  public readonly DEEPSEEK_CONFIG_FILE: string;
  public readonly LOG_DIR: string;

  private constructor() {
    this.CONFIG_DIR = path.join(process.env.HOME || process.env.USERPROFILE || '', '.codecompass');
    this.MODEL_CONFIG_FILE = path.join(this.CONFIG_DIR, 'model-config.json');
    this.DEEPSEEK_CONFIG_FILE = path.join(this.CONFIG_DIR, 'deepseek-config.json');
    this.LOG_DIR = path.join(this.CONFIG_DIR, 'logs');

    // Ensure log directory exists
    try {
      if (!fs.existsSync(this.LOG_DIR)) {
        fs.mkdirSync(this.LOG_DIR, { recursive: true });
      }
    } catch (error) {
      // Fallback to local logs directory if user-specific one fails
      console.error(`Failed to create user-specific log directory: ${(error as Error).message}. Falling back to local logs dir.`);
      this.LOG_DIR = path.join(process.cwd(), 'logs');
      if (!fs.existsSync(this.LOG_DIR)) {
        fs.mkdirSync(this.LOG_DIR, { recursive: true });
      }
    }
    
    this.logger = winston.createLogger({
      level: process.env.NODE_ENV === "test" ? "error" : "info",
      format: winston.format.combine(
        winston.format.timestamp(),
        winston.format.json()
      ),
      transports: [
        new winston.transports.File({ filename: path.join(this.LOG_DIR, "codecompass.log") }),
        new winston.transports.Console({
          format: winston.format.simple(),
          silent: process.env.NODE_ENV === "test"
        }),
      ],
    });

    this.OLLAMA_HOST = process.env.OLLAMA_HOST || "http://127.0.0.1:11434";
    this.QDRANT_HOST = process.env.QDRANT_HOST || "http://127.0.0.1:6333";
    this.COLLECTION_NAME = "codecompass"; // Default, not typically changed by user config
    
    this.MAX_INPUT_LENGTH = 4096;
    this.MAX_SNIPPET_LENGTH = 500;
    this.REQUEST_TIMEOUT = 120000; 
    this.MAX_RETRIES = 3;
    this.RETRY_DELAY = 2000;

    // CONFIG_DIR, MODEL_CONFIG_FILE, DEEPSEEK_CONFIG_FILE, LOG_DIR are initialized earlier

    // Initialize with environment variables or hardcoded defaults first
    this._llmProvider = process.env.LLM_PROVIDER || "ollama";
    this._suggestionModel = process.env.SUGGESTION_MODEL || "llama3.1:8b";
    this._embeddingModel = process.env.EMBEDDING_MODEL || "nomic-embed-text:v1.5"; // Ollama default
    this._deepSeekApiKey = process.env.DEEPSEEK_API_KEY || "";
    this._deepSeekApiUrl = process.env.DEEPSEEK_API_URL || "https://api.deepseek.com/chat/completions";
    this._deepSeekModel = process.env.DEEPSEEK_MODEL || "deepseek-coder";
    this._deepSeekRpmLimit = parseInt(process.env.DEEPSEEK_RPM_LIMIT || '', 10) || this.DEEPSEEK_RPM_LIMIT_DEFAULT;

    this._useMixedProviders = process.env.USE_MIXED_PROVIDERS === "true" || false;
    this._suggestionProvider = process.env.SUGGESTION_PROVIDER || this._llmProvider;
    // Default embedding provider to ollama, can be overridden by file/env
    this._embeddingProvider = process.env.EMBEDDING_PROVIDER || "ollama"; 

    this.loadConfigurationsFromFile(); // Load persisted configs, which can override env/defaults
    this.initializeGlobalState(); // Set global vars based on the final effective configuration
  }

  public static getInstance(): ConfigService {
    if (!ConfigService.instance) {
      ConfigService.instance = new ConfigService();
    }
    return ConfigService.instance;
  }

  private loadDeepSeekConfigFromFile(): Partial<ModelConfigFile> {
    try {
      if (fs.existsSync(this.DEEPSEEK_CONFIG_FILE)) {
        const fileContent = fs.readFileSync(this.DEEPSEEK_CONFIG_FILE, 'utf8');
        const config = JSON.parse(fileContent) as Partial<ModelConfigFile>;
        this.logger.info(`Loaded DeepSeek config from ${this.DEEPSEEK_CONFIG_FILE}`);
        return config;
      }
    } catch (error) {
      this.logger.warn(`Failed to load DeepSeek config from ${this.DEEPSEEK_CONFIG_FILE}: ${(error as Error).message}`);
    }
    return {};
  }
  
  private loadModelConfigFromFile(): Partial<ModelConfigFile> {
    try {
      if (fs.existsSync(this.MODEL_CONFIG_FILE)) {
        const fileContent = fs.readFileSync(this.MODEL_CONFIG_FILE, 'utf8');
        const config = JSON.parse(fileContent) as Partial<ModelConfigFile>;
        this.logger.info(`Loaded model config from ${this.MODEL_CONFIG_FILE}`);
        return config;
      }
    } catch (error) {
      this.logger.warn(`Failed to load model config from ${this.MODEL_CONFIG_FILE}: ${(error as Error).message}`);
    }
    return {};
  }

  private loadConfigurationsFromFile(): void {
    const modelConfig = this.loadModelConfigFromFile();
    const deepSeekConfig = this.loadDeepSeekConfigFromFile();

    // Apply loaded configurations, file values take precedence over initial env/defaults
    // DEEPSEEK_API_KEY: file > env > default
    if (deepSeekConfig.DEEPSEEK_API_KEY) {
        this._deepSeekApiKey = deepSeekConfig.DEEPSEEK_API_KEY;
    } // If not in file, _deepSeekApiKey retains its env/default value

    // DEEPSEEK_API_URL: file > env > default
    if (deepSeekConfig.DEEPSEEK_API_URL) {
        this._deepSeekApiUrl = deepSeekConfig.DEEPSEEK_API_URL;
    }

    // SUGGESTION_MODEL: file > env > default
    if (modelConfig.SUGGESTION_MODEL) {
      this._suggestionModel = modelConfig.SUGGESTION_MODEL;
    }
    
    // SUGGESTION_PROVIDER: file > env > default (where default for SUGGESTION_PROVIDER is LLM_PROVIDER)
    if (modelConfig.SUGGESTION_PROVIDER) {
      this._suggestionProvider = modelConfig.SUGGESTION_PROVIDER;
      this._llmProvider = modelConfig.SUGGESTION_PROVIDER; // SUGGESTION_PROVIDER from file also dictates LLM_PROVIDER
    }
    // If not in modelConfig, _suggestionProvider and _llmProvider retain their env/default values

    // EMBEDDING_PROVIDER: file > env > default
    if (modelConfig.EMBEDDING_PROVIDER) {
      this._embeddingProvider = modelConfig.EMBEDDING_PROVIDER;
    }
    
    // Ensure process.env reflects the final state. This is crucial for any part of the code
    // or external libraries that might still read from process.env directly.
    process.env.DEEPSEEK_API_KEY = this._deepSeekApiKey;
    process.env.DEEPSEEK_API_URL = this._deepSeekApiUrl;
    process.env.DEEPSEEK_MODEL = this._deepSeekModel; 
    process.env.DEEPSEEK_RPM_LIMIT = String(this._deepSeekRpmLimit);
    process.env.SUGGESTION_MODEL = this._suggestionModel;
    process.env.SUGGESTION_PROVIDER = this._suggestionProvider;
    process.env.EMBEDDING_PROVIDER = this._embeddingProvider;
    process.env.EMBEDDING_MODEL = this._embeddingModel; // EMBEDDING_MODEL is usually from env or default
    process.env.LLM_PROVIDER = this._llmProvider;
    process.env.OLLAMA_HOST = this.OLLAMA_HOST; // Ensure OLLAMA_HOST from env/default is in process.env
    process.env.QDRANT_HOST = this.QDRANT_HOST; // Ensure QDRANT_HOST from env/default is in process.env
  }
  
  public reloadConfigsFromFile(forceSet = true): void {
      // Re-initialize from env/defaults
    this._llmProvider = process.env.LLM_PROVIDER || "ollama";
    this._suggestionModel = process.env.SUGGESTION_MODEL || "llama3.1:8b";
    this._embeddingModel = process.env.EMBEDDING_MODEL || "nomic-embed-text:v1.5";
    this._deepSeekApiKey = process.env.DEEPSEEK_API_KEY || "";
    this._deepSeekApiUrl = process.env.DEEPSEEK_API_URL || "https://api.deepseek.com/chat/completions";
    this._deepSeekModel = process.env.DEEPSEEK_MODEL || "deepseek-coder";
    this._deepSeekRpmLimit = parseInt(process.env.DEEPSEEK_RPM_LIMIT || '', 10) || this.DEEPSEEK_RPM_LIMIT_DEFAULT;
    this._suggestionProvider = process.env.SUGGESTION_PROVIDER || this._llmProvider;
    this._embeddingProvider = process.env.EMBEDDING_PROVIDER || "ollama";
      
      this.loadConfigurationsFromFile(); // Then load from files, overriding if values exist
      this.initializeGlobalState(); // Finally, update globals
  }

  private initializeGlobalState(): void {
    global.CURRENT_LLM_PROVIDER = this.LLM_PROVIDER;
    global.CURRENT_SUGGESTION_PROVIDER = this.SUGGESTION_PROVIDER;
    global.CURRENT_EMBEDDING_PROVIDER = this.EMBEDDING_PROVIDER;
    global.CURRENT_SUGGESTION_MODEL = this.SUGGESTION_MODEL;
  }

  // Getters use global first (as they might be changed dynamically), then internal state.
  // Internal state (_variable) reflects config file/env/default precedence.
  // process.env is updated by loadConfigurationsFromFile to reflect the effective config.
  get LLM_PROVIDER(): string { return global.CURRENT_LLM_PROVIDER || this._llmProvider; }
  get SUGGESTION_MODEL(): string { return global.CURRENT_SUGGESTION_MODEL || this._suggestionModel; }
  get EMBEDDING_MODEL(): string { return process.env.EMBEDDING_MODEL || this._embeddingModel; } 
  get DEEPSEEK_API_KEY(): string { return process.env.DEEPSEEK_API_KEY || this._deepSeekApiKey; }
  get DEEPSEEK_API_URL(): string { return process.env.DEEPSEEK_API_URL || this._deepSeekApiUrl; }
  get DEEPSEEK_MODEL(): string { return process.env.DEEPSEEK_MODEL || this._deepSeekModel; }
  get DEEPSEEK_RPM_LIMIT(): number { return parseInt(process.env.DEEPSEEK_RPM_LIMIT || '', 10) || this._deepSeekRpmLimit; }

  get USE_MIXED_PROVIDERS(): boolean { return this._useMixedProviders; } // Typically from env or default
  get SUGGESTION_PROVIDER(): string { return global.CURRENT_SUGGESTION_PROVIDER || this._suggestionProvider; }
  get EMBEDDING_PROVIDER(): string { return global.CURRENT_EMBEDDING_PROVIDER || this._embeddingProvider; }

  public setSuggestionModel(model: string): void {
    this._suggestionModel = model;
    process.env.SUGGESTION_MODEL = model;
    global.CURRENT_SUGGESTION_MODEL = model;
    this.persistModelConfiguration();
  }

  public setSuggestionProvider(provider: string): void {
    this._suggestionProvider = provider;
    process.env.SUGGESTION_PROVIDER = provider;
    global.CURRENT_SUGGESTION_PROVIDER = provider;
    
    this._llmProvider = provider; 
    process.env.LLM_PROVIDER = provider;
    global.CURRENT_LLM_PROVIDER = provider;
    this.persistModelConfiguration();
  }
  
  public setEmbeddingProvider(provider: string): void {
    this._embeddingProvider = provider;
    process.env.EMBEDDING_PROVIDER = provider;
    global.CURRENT_EMBEDDING_PROVIDER = provider;
    this.persistModelConfiguration();
  }

  public setDeepSeekApiKey(key: string): void {
    this._deepSeekApiKey = key;
    process.env.DEEPSEEK_API_KEY = key;
    this.persistDeepSeekConfiguration();
  }
  
  public setDeepSeekApiUrl(url: string): void {
    this._deepSeekApiUrl = url;
    process.env.DEEPSEEK_API_URL = url;
    this.persistDeepSeekConfiguration();
  }
  
  public setDeepSeekModel(model: string): void {
      this._deepSeekModel = model;
      process.env.DEEPSEEK_MODEL = model;
      // Not persisted in model-config.json or deepseek-config.json by default
  }

  public persistModelConfiguration(): void {
    try {
      if (!fs.existsSync(this.CONFIG_DIR)) {
        fs.mkdirSync(this.CONFIG_DIR, { recursive: true });
      }
      const configToSave: ModelConfigFile = {
        SUGGESTION_MODEL: this.SUGGESTION_MODEL, // Use getter to ensure current value
        SUGGESTION_PROVIDER: this.SUGGESTION_PROVIDER, // Use getter
        EMBEDDING_PROVIDER: this.EMBEDDING_PROVIDER, // Use getter
      };
      fs.writeFileSync(this.MODEL_CONFIG_FILE, JSON.stringify(configToSave, null, 2));
      this.logger.info(`Saved model configuration to ${this.MODEL_CONFIG_FILE}`);
    } catch (error) {
      this.logger.warn(`Failed to save model configuration: ${(error as Error).message}`);
    }
  }

  public persistDeepSeekConfiguration(): void {
    try {
      if (!fs.existsSync(this.CONFIG_DIR)) {
        fs.mkdirSync(this.CONFIG_DIR, { recursive: true });
      }
      const configToSave = { 
        DEEPSEEK_API_KEY: this.DEEPSEEK_API_KEY, 
        DEEPSEEK_API_URL: this.DEEPSEEK_API_URL, 
        timestamp: new Date().toISOString() 
      };
      fs.writeFileSync(this.DEEPSEEK_CONFIG_FILE, JSON.stringify(configToSave, null, 2));
      this.logger.info(`Saved DeepSeek configuration to ${this.DEEPSEEK_CONFIG_FILE}`);
    } catch (error) {
      this.logger.warn(`Failed to save DeepSeek configuration: ${(error as Error).message}`);
    }
  }
}

export const configService = ConfigService.getInstance();
export const logger = configService.logger;
