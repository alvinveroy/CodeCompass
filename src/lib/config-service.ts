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
  OPENAI_API_KEY?: string;
  GEMINI_API_KEY?: string;
  CLAUDE_API_KEY?: string;
  // Add other provider-specific keys here as needed
  SUMMARIZATION_MODEL?: string; // New
  REFINEMENT_MODEL?: string;   // New
}

class ConfigService {
  private static instance: ConfigService;
  public readonly logger: winston.Logger;

  // Configuration values with defaults
  public readonly OLLAMA_HOST: string;
  public readonly QDRANT_HOST: string;
  public readonly COLLECTION_NAME: string;
  private readonly _httpPortFallback: number;
  
  private _llmProvider: string;
  private _suggestionModel: string;
  private _embeddingModel: string;
  private _embeddingDimension: number; // New
  private _deepSeekApiKey: string;
  private _deepSeekApiUrl: string;
  private _deepSeekModel: string;
  private _deepSeekRpmLimit: number; // Requests Per Minute
  private _agentQueryTimeout: number;
  private _openAIApiKey: string;
  private _geminiApiKey: string;
  private _claudeApiKey: string;

  private _qdrantSearchLimitDefault: number; // Added for Qdrant search limit
  private _maxDiffLengthForContextTool: number;
  private _agentDefaultMaxSteps: number;
  private _agentAbsoluteMaxSteps: number;
  private _maxRefinementIterations: number;
  private _fileIndexingChunkSizeChars: number;
  private _fileIndexingChunkOverlapChars: number;
  private _summarizationModel: string;
  private _refinementModel: string;
  private _requestAdditionalContextMaxSearchResults: number;
  private _maxFilesForSuggestionContextNoSummary: number;
  private _maxSnippetLengthForContextNoSummary: number;
  private _diffChunkSizeChars: number;
  private _diffChunkOverlapChars: number;
  private _commitHistoryMaxCountForIndexing: number; // 0 for all
  private _qdrantBatchUpsertSize: number;
  private _agentMaxContextItems: number;
  private _diffLinesOfContext: number;
  private _maxFileContentLengthForCapability: number;
  private _maxDirListingEntriesForCapability: number;
  private _httpPort: number; // Added
  
  public IS_UTILITY_SERVER_DISABLED = false;
  public RELAY_TARGET_UTILITY_PORT?: number;

  private _useMixedProviders: boolean;
  private _suggestionProvider: string;
  private _embeddingProvider: string;

  public readonly MAX_INPUT_LENGTH: number;
  public readonly MAX_SNIPPET_LENGTH: number;
  public readonly REQUEST_TIMEOUT: number;
  public readonly MAX_RETRIES: number;
  public readonly RETRY_DELAY: number;
  public readonly AGENT_QUERY_TIMEOUT_DEFAULT = 180000; // Default 3 minutes for agent queries
  public readonly DEFAULT_QDRANT_SEARCH_LIMIT = 10; // Default Qdrant search limit
  public readonly DEFAULT_MAX_FILES_FOR_SUGGESTION_CONTEXT_NO_SUMMARY = 15; // Default max files before summarizing
  public readonly DEFAULT_MAX_SNIPPET_LENGTH_FOR_CONTEXT_NO_SUMMARY = 1500; // Default 1500 chars
  public readonly DEFAULT_AGENT_DEFAULT_MAX_STEPS = 10;
  public readonly DEFAULT_AGENT_ABSOLUTE_MAX_STEPS = 15;
  public readonly DEFAULT_MAX_REFINEMENT_ITERATIONS = 3;
  public readonly DEFAULT_FILE_INDEXING_CHUNK_SIZE_CHARS = 1000;
  public readonly DEFAULT_FILE_INDEXING_CHUNK_OVERLAP_CHARS = 200;
  // For SUMMARIZATION_MODEL and REFINEMENT_MODEL, default will be SUGGESTION_MODEL if empty string.
  public readonly DEFAULT_REQUEST_ADDITIONAL_CONTEXT_MAX_SEARCH_RESULTS = 20;
  public readonly DEFAULT_DIFF_CHUNK_SIZE_CHARS = 1000;
  public readonly DEFAULT_DIFF_CHUNK_OVERLAP_CHARS = 100;
  public readonly DEFAULT_COMMIT_HISTORY_MAX_COUNT_FOR_INDEXING = 0; // 0 means all commits
  public readonly DEFAULT_QDRANT_BATCH_UPSERT_SIZE = 100;
  public readonly DEFAULT_AGENT_MAX_CONTEXT_ITEMS = 10;
  public readonly DEFAULT_DIFF_LINES_OF_CONTEXT = 3;
  public readonly DEFAULT_MAX_FILE_CONTENT_LENGTH_FOR_CAPABILITY = 10000;
  public readonly DEFAULT_EMBEDDING_DIMENSION = 768; // For nomic-embed-text
  public readonly DEFAULT_MAX_DIR_LISTING_ENTRIES_FOR_CAPABILITY = 50;

  // DEFAULT_HTTP_PORT removed, _httpPortFallback is used instead

  public readonly DEEPSEEK_RPM_LIMIT_DEFAULT = 60; // Default RPM for DeepSeek

  public readonly CONFIG_DIR: string;
  public readonly MODEL_CONFIG_FILE: string;
  public readonly DEEPSEEK_CONFIG_FILE: string;
  public readonly LOG_DIR: string;

  private constructor() {
    // Initialize logger first
    this.logger = winston.createLogger({
      level: process.env.NODE_ENV === "test" ? "error" : "info",
      format: winston.format.combine(
        winston.format.timestamp(),
        winston.format.json()
      ),
      transports: [
        // Log file transport will be added after LOG_DIR is determined
        new winston.transports.Stream({
          stream: process.stderr,
          format: winston.format.simple(),
          level: 'error',
          silent: process.env.NODE_ENV === "test"
        }),
      ],
    });

    // ADD THIS LOG LINE IMMEDIATELY AFTER LOGGER INITIALIZATION:
    this.logger.debug(`[ConfigService constructor EARLY DEBUG] Initial process.env.HTTP_PORT: "${process.env.HTTP_PORT}", process.env.NODE_ENV: "${process.env.NODE_ENV}", MOCK_LLM: "${process.env.CODECOMPASS_INTEGRATION_TEST_MOCK_LLM}", MOCK_QDRANT: "${process.env.CODECOMPASS_INTEGRATION_TEST_MOCK_QDRANT}"`);

    // Initialize _httpPortFallback before it's used
    this._httpPortFallback = process.env.NODE_ENV === 'test' ? 0 : 3001;

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
      // Use logger if available, but console.error is safer here as logger might not be fully configured
      // Or, if logger is guaranteed to be partially working (e.g. stderr stream), use it.
      // For now, let's assume console.error is fine for this bootstrap phase.
      // If logger is used, it must be after its basic initialization.
      // this.logger.error(...) would be ideal if the stderr transport is already active.
      // Given the logger is initialized above, we can try using it.
      this.logger.error(`Failed to create user-specific log directory: ${(error as Error).message}. Falling back to local logs dir.`);
      this.LOG_DIR = path.join(process.cwd(), 'logs');
      if (!fs.existsSync(this.LOG_DIR)) {
        fs.mkdirSync(this.LOG_DIR, { recursive: true });
      }
    }
    
    // Add the file transport now that LOG_DIR is determined
    this.logger.add(new winston.transports.File({ filename: path.join(this.LOG_DIR, "codecompass.log") }));

    // QDRANT_HOST and COLLECTION_NAME were previously initialized directly from process.env or defaults
    // Let's align QDRANT_HOST with the validation pattern used for OLLAMA_HOST
    const defaultQdrantHost = "http://127.0.0.1:6333";
    const qdrantHostEnv = process.env.QDRANT_HOST;
    if (qdrantHostEnv && qdrantHostEnv.trim() !== "") {
      try {
        const parsedUrl = new URL(qdrantHostEnv);
        if (parsedUrl.protocol && (parsedUrl.protocol === 'http:' || parsedUrl.protocol === 'https:')) {
          this.QDRANT_HOST = qdrantHostEnv;
        } else {
          this.logger.warn(`QDRANT_HOST environment variable "${qdrantHostEnv}" has an invalid or missing protocol. Falling back to default: ${defaultQdrantHost}`);
          this.QDRANT_HOST = defaultQdrantHost;
        }
      } catch (e) {
        this.logger.warn(`QDRANT_HOST environment variable "${qdrantHostEnv}" is not a valid URL. Error: ${(e as Error).message}. Falling back to default: ${defaultQdrantHost}`);
        this.QDRANT_HOST = defaultQdrantHost;
      }
    } else {
      this.QDRANT_HOST = defaultQdrantHost; // Use default if env var is not set or is empty/whitespace
    }
    this.COLLECTION_NAME = process.env.COLLECTION_NAME || "codecompass_collection"; // Default, not typically changed by user config

    // Validate and set OLLAMA_HOST
    const defaultOllamaHost = "http://127.0.0.1:11434";
    const ollamaHostEnv = process.env.OLLAMA_HOST;
    if (ollamaHostEnv && ollamaHostEnv.trim() !== "") {
      try {
        const parsedUrl = new URL(ollamaHostEnv);
        if (parsedUrl.protocol && (parsedUrl.protocol === 'http:' || parsedUrl.protocol === 'https:')) {
          this.OLLAMA_HOST = ollamaHostEnv;
        } else {
          this.logger.warn(`OLLAMA_HOST environment variable "${ollamaHostEnv}" has an invalid or missing protocol. Falling back to default: ${defaultOllamaHost}`);
          this.OLLAMA_HOST = defaultOllamaHost;
        }
      } catch (e) {
        this.logger.warn(`OLLAMA_HOST environment variable "${ollamaHostEnv}" is not a valid URL. Error: ${(e as Error).message}. Falling back to default: ${defaultOllamaHost}`);
        this.OLLAMA_HOST = defaultOllamaHost;
      }
    } else {
      this.OLLAMA_HOST = defaultOllamaHost; // Use default if env var is not set or is empty/whitespace
    }

    // QDRANT_HOST and COLLECTION_NAME are now initialized above, before logger.
    // The previous direct assignment of this.QDRANT_HOST and this.COLLECTION_NAME is removed from here.
    
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
    this._embeddingDimension = parseInt(process.env.EMBEDDING_DIMENSION || '', 10) || this.DEFAULT_EMBEDDING_DIMENSION;
    this._deepSeekApiKey = process.env.DEEPSEEK_API_KEY || "";
    this._deepSeekApiUrl = process.env.DEEPSEEK_API_URL || "https://api.deepseek.com/chat/completions";
    this._deepSeekModel = process.env.DEEPSEEK_MODEL || "deepseek-coder";
    this._deepSeekRpmLimit = parseInt(process.env.DEEPSEEK_RPM_LIMIT || '', 10) || this.DEEPSEEK_RPM_LIMIT_DEFAULT;
    this._agentQueryTimeout = parseInt(process.env.AGENT_QUERY_TIMEOUT || '', 10) || this.AGENT_QUERY_TIMEOUT_DEFAULT;
    this._qdrantSearchLimitDefault = parseInt(process.env.QDRANT_SEARCH_LIMIT_DEFAULT || '', 10) || this.DEFAULT_QDRANT_SEARCH_LIMIT; // Initialize Qdrant search limit
    this._maxDiffLengthForContextTool = parseInt(process.env.MAX_DIFF_LENGTH_FOR_CONTEXT_TOOL || '', 10) || 3000; // Default 3000 chars
    this._maxFilesForSuggestionContextNoSummary = parseInt(process.env.MAX_FILES_FOR_SUGGESTION_CONTEXT_NO_SUMMARY || '', 10) || this.DEFAULT_MAX_FILES_FOR_SUGGESTION_CONTEXT_NO_SUMMARY;
    this._maxSnippetLengthForContextNoSummary = parseInt(process.env.MAX_SNIPPET_LENGTH_FOR_CONTEXT_NO_SUMMARY || '', 10) || this.DEFAULT_MAX_SNIPPET_LENGTH_FOR_CONTEXT_NO_SUMMARY;
    this._openAIApiKey = process.env.OPENAI_API_KEY || "";
    this._geminiApiKey = process.env.GEMINI_API_KEY || "";
    this._claudeApiKey = process.env.CLAUDE_API_KEY || "";

    this._agentDefaultMaxSteps = parseInt(process.env.AGENT_DEFAULT_MAX_STEPS || '', 10) || this.DEFAULT_AGENT_DEFAULT_MAX_STEPS;
    this._agentAbsoluteMaxSteps = parseInt(process.env.AGENT_ABSOLUTE_MAX_STEPS || '', 10) || this.DEFAULT_AGENT_ABSOLUTE_MAX_STEPS;
    this._maxRefinementIterations = parseInt(process.env.MAX_REFINEMENT_ITERATIONS || '', 10) || this.DEFAULT_MAX_REFINEMENT_ITERATIONS;
    this._fileIndexingChunkSizeChars = parseInt(process.env.FILE_INDEXING_CHUNK_SIZE_CHARS || '', 10) || this.DEFAULT_FILE_INDEXING_CHUNK_SIZE_CHARS;
    this._fileIndexingChunkOverlapChars = parseInt(process.env.FILE_INDEXING_CHUNK_OVERLAP_CHARS || '', 10) || this.DEFAULT_FILE_INDEXING_CHUNK_OVERLAP_CHARS;
    this._requestAdditionalContextMaxSearchResults = parseInt(process.env.REQUEST_ADDITIONAL_CONTEXT_MAX_SEARCH_RESULTS || '', 10) || this.DEFAULT_REQUEST_ADDITIONAL_CONTEXT_MAX_SEARCH_RESULTS;
    this._diffChunkSizeChars = parseInt(process.env.DIFF_CHUNK_SIZE_CHARS || '', 10) || this.DEFAULT_DIFF_CHUNK_SIZE_CHARS;
    this._diffChunkOverlapChars = parseInt(process.env.DIFF_CHUNK_OVERLAP_CHARS || '', 10) || this.DEFAULT_DIFF_CHUNK_OVERLAP_CHARS;
    this._commitHistoryMaxCountForIndexing = parseInt(process.env.COMMIT_HISTORY_MAX_COUNT_FOR_INDEXING || '', 10) || this.DEFAULT_COMMIT_HISTORY_MAX_COUNT_FOR_INDEXING;
    this._qdrantBatchUpsertSize = parseInt(process.env.QDRANT_BATCH_UPSERT_SIZE || '', 10) || this.DEFAULT_QDRANT_BATCH_UPSERT_SIZE;
    this._agentMaxContextItems = parseInt(process.env.AGENT_MAX_CONTEXT_ITEMS || '', 10) || this.DEFAULT_AGENT_MAX_CONTEXT_ITEMS;
    this._diffLinesOfContext = parseInt(process.env.DIFF_LINES_OF_CONTEXT || '', 10) || this.DEFAULT_DIFF_LINES_OF_CONTEXT;
    this._maxFileContentLengthForCapability = parseInt(process.env.MAX_FILE_CONTENT_LENGTH_FOR_CAPABILITY || '', 10) || this.DEFAULT_MAX_FILE_CONTENT_LENGTH_FOR_CAPABILITY;
    this._maxDirListingEntriesForCapability = parseInt(process.env.MAX_DIR_LISTING_ENTRIES_FOR_CAPABILITY || '', 10) || this.DEFAULT_MAX_DIR_LISTING_ENTRIES_FOR_CAPABILITY;
    // this._httpPort = parseInt(process.env.HTTP_PORT || '', 10) || this.DEFAULT_HTTP_PORT; // Original
    // Change to use _httpPortFallback:
    const httpPortEnv = process.env.HTTP_PORT;
    if (httpPortEnv !== undefined && httpPortEnv !== null && httpPortEnv.trim() !== "") {
      const parsedPort = parseInt(httpPortEnv, 10);
      // Ensure that if HTTP_PORT is "0", it's respected and not overridden by _httpPortFallback.
      if (!isNaN(parsedPort) && parsedPort >= 0 && parsedPort <= 65535) { 
        this._httpPort = parsedPort;
      } else {
        this.logger.warn(`Invalid HTTP_PORT environment variable: "${httpPortEnv}". Falling back to default: ${this._httpPortFallback} (unless NODE_ENV is test and fallback is 0).`);
        this._httpPort = this._httpPortFallback; // Fallback if parsing fails or out of range
      }
    } else {
      // If HTTP_PORT is not set in env, use the fallback.
      this.logger.debug(`HTTP_PORT environment variable not set. Using fallback: ${this._httpPortFallback}`);
      this._httpPort = this._httpPortFallback;
    }
    this.logger.debug(`[ConfigService constructor] Initial process.env.HTTP_PORT: "${process.env.HTTP_PORT}", _httpPort set to: ${this._httpPort}, _httpPortFallback: ${this._httpPortFallback}`);

    // For _summarizationModel and _refinementModel, we'll set them properly in loadConfigurationsFromFile
    // and reloadConfigsFromFile after _suggestionModel is definitively set.
    // For now, initialize them to empty strings or a placeholder that indicates they need to be derived.
    this._summarizationModel = process.env.SUMMARIZATION_MODEL || ""; 
    this._refinementModel = process.env.REFINEMENT_MODEL || "";

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

    // Load new model-specific configs
    if (modelConfig.SUMMARIZATION_MODEL) {
      this._summarizationModel = modelConfig.SUMMARIZATION_MODEL;
    }
    if (modelConfig.REFINEMENT_MODEL) {
      this._refinementModel = modelConfig.REFINEMENT_MODEL;
    }

    // Derive summarization and refinement models if they are empty (i.e., not set by env or file)
    // This ensures _suggestionModel is already finalized from env/file before being used as a fallback.
    if (!this._summarizationModel) {
      this._summarizationModel = this._suggestionModel;
    }
    if (!this._refinementModel) {
      this._refinementModel = this._suggestionModel;
    }
    
    // EMBEDDING_PROVIDER: file > env > default
    if (modelConfig.EMBEDDING_PROVIDER) {
      this._embeddingProvider = modelConfig.EMBEDDING_PROVIDER;
    }

    // API keys from model-config.json (these override env vars if present in file)
    if (modelConfig.OPENAI_API_KEY) {
      this._openAIApiKey = modelConfig.OPENAI_API_KEY;
    }
    if (modelConfig.GEMINI_API_KEY) {
      this._geminiApiKey = modelConfig.GEMINI_API_KEY;
    }
    if (modelConfig.CLAUDE_API_KEY) {
      this._claudeApiKey = modelConfig.CLAUDE_API_KEY;
    }
    
    // Ensure process.env reflects the final state. This is crucial for any part of the code
    // or external libraries that might still read from process.env directly.
    process.env.DEEPSEEK_API_KEY = this._deepSeekApiKey; // Still handle from its specific file or env
    process.env.DEEPSEEK_API_URL = this._deepSeekApiUrl; // Still handle from its specific file or env
    process.env.DEEPSEEK_MODEL = this._deepSeekModel;
    process.env.DEEPSEEK_RPM_LIMIT = String(this._deepSeekRpmLimit);
    process.env.AGENT_QUERY_TIMEOUT = String(this._agentQueryTimeout);
    process.env.SUGGESTION_MODEL = this._suggestionModel;
    process.env.SUGGESTION_PROVIDER = this._suggestionProvider;
    process.env.EMBEDDING_PROVIDER = this._embeddingProvider;
    process.env.EMBEDDING_MODEL = this._embeddingModel; // EMBEDDING_MODEL is usually from env or default
    process.env.EMBEDDING_DIMENSION = String(this._embeddingDimension);
    process.env.LLM_PROVIDER = this._llmProvider;
    process.env.OLLAMA_HOST = this.OLLAMA_HOST; // Ensure OLLAMA_HOST from env/default is in process.env
    process.env.QDRANT_HOST = this.QDRANT_HOST; // Ensure QDRANT_HOST from env/default is in process.env
    process.env.QDRANT_SEARCH_LIMIT_DEFAULT = String(this._qdrantSearchLimitDefault); // Ensure QDRANT_SEARCH_LIMIT_DEFAULT is in process.env
    process.env.MAX_DIFF_LENGTH_FOR_CONTEXT_TOOL = String(this._maxDiffLengthForContextTool);
    process.env.MAX_FILES_FOR_SUGGESTION_CONTEXT_NO_SUMMARY = String(this._maxFilesForSuggestionContextNoSummary);
    process.env.MAX_SNIPPET_LENGTH_FOR_CONTEXT_NO_SUMMARY = String(this._maxSnippetLengthForContextNoSummary);
    process.env.OPENAI_API_KEY = this._openAIApiKey;
    process.env.GEMINI_API_KEY = this._geminiApiKey;
    process.env.CLAUDE_API_KEY = this._claudeApiKey;

    // Update process.env with all new configurations
    process.env.AGENT_DEFAULT_MAX_STEPS = String(this._agentDefaultMaxSteps);
    process.env.AGENT_ABSOLUTE_MAX_STEPS = String(this._agentAbsoluteMaxSteps);
    process.env.MAX_REFINEMENT_ITERATIONS = String(this._maxRefinementIterations);
    process.env.FILE_INDEXING_CHUNK_SIZE_CHARS = String(this._fileIndexingChunkSizeChars);
    process.env.FILE_INDEXING_CHUNK_OVERLAP_CHARS = String(this._fileIndexingChunkOverlapChars);
    process.env.REQUEST_ADDITIONAL_CONTEXT_MAX_SEARCH_RESULTS = String(this._requestAdditionalContextMaxSearchResults);
    process.env.SUMMARIZATION_MODEL = this._summarizationModel;
    process.env.REFINEMENT_MODEL = this._refinementModel;
    process.env.DIFF_CHUNK_SIZE_CHARS = String(this._diffChunkSizeChars);
    process.env.DIFF_CHUNK_OVERLAP_CHARS = String(this._diffChunkOverlapChars);
    process.env.COMMIT_HISTORY_MAX_COUNT_FOR_INDEXING = String(this._commitHistoryMaxCountForIndexing);
    process.env.QDRANT_BATCH_UPSERT_SIZE = String(this._qdrantBatchUpsertSize);
    process.env.AGENT_MAX_CONTEXT_ITEMS = String(this._agentMaxContextItems);
    process.env.DIFF_LINES_OF_CONTEXT = String(this._diffLinesOfContext);
    process.env.MAX_FILE_CONTENT_LENGTH_FOR_CAPABILITY = String(this._maxFileContentLengthForCapability);
    process.env.MAX_DIR_LISTING_ENTRIES_FOR_CAPABILITY = String(this._maxDirListingEntriesForCapability);
    process.env.HTTP_PORT = String(this._httpPort); // Added
  }
  
  public reloadConfigsFromFile(_forceSet = true): void {
    this.logger.debug(`[ConfigService reload] Entry. process.env.HTTP_PORT: "${process.env.HTTP_PORT}"`);
      // Re-initialize from env/defaults
    this._llmProvider = process.env.LLM_PROVIDER || "ollama";
    this._suggestionModel = process.env.SUGGESTION_MODEL || "llama3.1:8b";
    this._embeddingDimension = parseInt(process.env.EMBEDDING_DIMENSION || '', 10) || this.DEFAULT_EMBEDDING_DIMENSION;
    this._embeddingModel = process.env.EMBEDDING_MODEL || "nomic-embed-text:v1.5";
    this._deepSeekApiKey = process.env.DEEPSEEK_API_KEY || "";
    this._deepSeekApiUrl = process.env.DEEPSEEK_API_URL || "https://api.deepseek.com/chat/completions";
    this._deepSeekModel = process.env.DEEPSEEK_MODEL || "deepseek-coder";
    this._deepSeekRpmLimit = parseInt(process.env.DEEPSEEK_RPM_LIMIT || '', 10) || this.DEEPSEEK_RPM_LIMIT_DEFAULT;
    this._agentQueryTimeout = parseInt(process.env.AGENT_QUERY_TIMEOUT || '', 10) || this.AGENT_QUERY_TIMEOUT_DEFAULT;
    this._qdrantSearchLimitDefault = parseInt(process.env.QDRANT_SEARCH_LIMIT_DEFAULT || '', 10) || this.DEFAULT_QDRANT_SEARCH_LIMIT; // Re-initialize Qdrant search limit
    this._maxDiffLengthForContextTool = parseInt(process.env.MAX_DIFF_LENGTH_FOR_CONTEXT_TOOL || '', 10) || 3000;
    this._maxFilesForSuggestionContextNoSummary = parseInt(process.env.MAX_FILES_FOR_SUGGESTION_CONTEXT_NO_SUMMARY || '', 10) || this.DEFAULT_MAX_FILES_FOR_SUGGESTION_CONTEXT_NO_SUMMARY;
    this._maxSnippetLengthForContextNoSummary = parseInt(process.env.MAX_SNIPPET_LENGTH_FOR_CONTEXT_NO_SUMMARY || '', 10) || this.DEFAULT_MAX_SNIPPET_LENGTH_FOR_CONTEXT_NO_SUMMARY;
    this._openAIApiKey = process.env.OPENAI_API_KEY || "";
    this._geminiApiKey = process.env.GEMINI_API_KEY || "";
    this._claudeApiKey = process.env.CLAUDE_API_KEY || "";
    this._agentDefaultMaxSteps = parseInt(process.env.AGENT_DEFAULT_MAX_STEPS || '', 10) || this.DEFAULT_AGENT_DEFAULT_MAX_STEPS;
    this._agentAbsoluteMaxSteps = parseInt(process.env.AGENT_ABSOLUTE_MAX_STEPS || '', 10) || this.DEFAULT_AGENT_ABSOLUTE_MAX_STEPS;
    this._maxRefinementIterations = parseInt(process.env.MAX_REFINEMENT_ITERATIONS || '', 10) || this.DEFAULT_MAX_REFINEMENT_ITERATIONS;
    this._fileIndexingChunkSizeChars = parseInt(process.env.FILE_INDEXING_CHUNK_SIZE_CHARS || '', 10) || this.DEFAULT_FILE_INDEXING_CHUNK_SIZE_CHARS;
    this._fileIndexingChunkOverlapChars = parseInt(process.env.FILE_INDEXING_CHUNK_OVERLAP_CHARS || '', 10) || this.DEFAULT_FILE_INDEXING_CHUNK_OVERLAP_CHARS;
    this._requestAdditionalContextMaxSearchResults = parseInt(process.env.REQUEST_ADDITIONAL_CONTEXT_MAX_SEARCH_RESULTS || '', 10) || this.DEFAULT_REQUEST_ADDITIONAL_CONTEXT_MAX_SEARCH_RESULTS;
    this._diffChunkSizeChars = parseInt(process.env.DIFF_CHUNK_SIZE_CHARS || '', 10) || this.DEFAULT_DIFF_CHUNK_SIZE_CHARS;
    this._diffChunkOverlapChars = parseInt(process.env.DIFF_CHUNK_OVERLAP_CHARS || '', 10) || this.DEFAULT_DIFF_CHUNK_OVERLAP_CHARS;
    this._commitHistoryMaxCountForIndexing = parseInt(process.env.COMMIT_HISTORY_MAX_COUNT_FOR_INDEXING || '', 10) || this.DEFAULT_COMMIT_HISTORY_MAX_COUNT_FOR_INDEXING;
    this._qdrantBatchUpsertSize = parseInt(process.env.QDRANT_BATCH_UPSERT_SIZE || '', 10) || this.DEFAULT_QDRANT_BATCH_UPSERT_SIZE;
    this._agentMaxContextItems = parseInt(process.env.AGENT_MAX_CONTEXT_ITEMS || '', 10) || this.DEFAULT_AGENT_MAX_CONTEXT_ITEMS;
    this._diffLinesOfContext = parseInt(process.env.DIFF_LINES_OF_CONTEXT || '', 10) || this.DEFAULT_DIFF_LINES_OF_CONTEXT;
    this._maxFileContentLengthForCapability = parseInt(process.env.MAX_FILE_CONTENT_LENGTH_FOR_CAPABILITY || '', 10) || this.DEFAULT_MAX_FILE_CONTENT_LENGTH_FOR_CAPABILITY;
    this._maxDirListingEntriesForCapability = parseInt(process.env.MAX_DIR_LISTING_ENTRIES_FOR_CAPABILITY || '', 10) || this.DEFAULT_MAX_DIR_LISTING_ENTRIES_FOR_CAPABILITY;
    // this._httpPort = parseInt(process.env.HTTP_PORT || '', 10) || this.DEFAULT_HTTP_PORT; // Original
    // Change to:
    this.logger.debug(`[config-service reload] process.env.HTTP_PORT before parsing: '${process.env.HTTP_PORT}' (type: ${typeof process.env.HTTP_PORT})`);
    const httpPortEnvReload = process.env.HTTP_PORT;
    if (httpPortEnvReload !== undefined && httpPortEnvReload !== null && httpPortEnvReload.trim() !== "") {
      const parsedPortReload = parseInt(httpPortEnvReload, 10);
      if (!isNaN(parsedPortReload) && parsedPortReload >= 0 && parsedPortReload <= 65535) {
        this._httpPort = parsedPortReload;
        this.logger.debug(`[ConfigService reload] _httpPort set to ${this._httpPort} from env var HTTP_PORT="${httpPortEnvReload}".`);
      } else {
        this.logger.warn(`Invalid HTTP_PORT environment variable during reload: "${httpPortEnvReload}". _httpPort (${this._httpPort}) will be retained if it was valid, or fallback to ${this._httpPortFallback} if it was not.`);
        // If current _httpPort is invalid (e.g. from a bad file load previously), consider fallback.
        // However, reloadConfigsFromFile's primary job is to apply env and then file.
        // If env is invalid, it shouldn't necessarily change _httpPort unless file also changes it.
        // For now, retain current _httpPort if env is invalid. File load will happen next.
      }
    } else {
      // If HTTP_PORT is not in env during reload, _httpPort retains its current value.
      // This value could be from constructor (which might have used _httpPortFallback) or from a previous file load.
      this.logger.debug(`HTTP_PORT environment variable is empty or not set during reload. _httpPort (${this._httpPort}) remains unchanged at this stage.`);
    }
    // File configurations will be loaded next by loadConfigurationsFromFile(), which can further update _httpPort.
    // Then, process.env.HTTP_PORT is updated to reflect the final _httpPort.
    this.logger.debug(`[ConfigService reload] After re-evaluating from env (if applicable), _httpPort is: ${this._httpPort}. File load follows.`);
    
    // Initialize from env, file loading will override if present, then derive.
    this._summarizationModel = process.env.SUMMARIZATION_MODEL || "";
    this._refinementModel = process.env.REFINEMENT_MODEL || "";
    this._suggestionProvider = process.env.SUGGESTION_PROVIDER || this._llmProvider;
    this._embeddingProvider = process.env.EMBEDDING_PROVIDER || "ollama";
      
      this.loadConfigurationsFromFile(); // This will load from files and derive _summarizationModel/_refinementModel
      this.initializeGlobalState(); 
  }

  private initializeGlobalState(): void {
    global.CURRENT_LLM_PROVIDER = this._llmProvider;
    global.CURRENT_SUGGESTION_PROVIDER = this._suggestionProvider;
    global.CURRENT_EMBEDDING_PROVIDER = this._embeddingProvider;
    global.CURRENT_SUGGESTION_MODEL = this._suggestionModel;
  }

  // Getters use global first (as they might be changed dynamically), then internal state.
  // Internal state (_variable) reflects config file/env/default precedence.
  // process.env is updated by loadConfigurationsFromFile to reflect the effective config.
  get LLM_PROVIDER(): string { return global.CURRENT_LLM_PROVIDER || this._llmProvider; }
  get SUGGESTION_MODEL(): string { return global.CURRENT_SUGGESTION_MODEL || this._suggestionModel; }
  get EMBEDDING_MODEL(): string { return process.env.EMBEDDING_MODEL || this._embeddingModel; } 
  get EMBEDDING_DIMENSION(): number { return parseInt(process.env.EMBEDDING_DIMENSION || '', 10) || this._embeddingDimension; }
  get DEEPSEEK_API_KEY(): string { return process.env.DEEPSEEK_API_KEY || this._deepSeekApiKey; }
  get DEEPSEEK_API_URL(): string { return process.env.DEEPSEEK_API_URL || this._deepSeekApiUrl; }
  get DEEPSEEK_MODEL(): string { return process.env.DEEPSEEK_MODEL || this._deepSeekModel; }
  get DEEPSEEK_RPM_LIMIT(): number { return parseInt(process.env.DEEPSEEK_RPM_LIMIT || '', 10) || this._deepSeekRpmLimit; }
  get AGENT_QUERY_TIMEOUT(): number { return parseInt(process.env.AGENT_QUERY_TIMEOUT || '', 10) || this._agentQueryTimeout; }
  get QDRANT_SEARCH_LIMIT_DEFAULT(): number { return parseInt(process.env.QDRANT_SEARCH_LIMIT_DEFAULT || '', 10) || this._qdrantSearchLimitDefault; } // Getter for Qdrant search limit
  get MAX_DIFF_LENGTH_FOR_CONTEXT_TOOL(): number { return this._maxDiffLengthForContextTool; }
  get MAX_FILES_FOR_SUGGESTION_CONTEXT_NO_SUMMARY(): number { return parseInt(process.env.MAX_FILES_FOR_SUGGESTION_CONTEXT_NO_SUMMARY || '', 10) || this._maxFilesForSuggestionContextNoSummary; }
  get MAX_SNIPPET_LENGTH_FOR_CONTEXT_NO_SUMMARY(): number { return this._maxSnippetLengthForContextNoSummary; }
  get OPENAI_API_KEY(): string { return process.env.OPENAI_API_KEY || this._openAIApiKey; }
  get GEMINI_API_KEY(): string { return process.env.GEMINI_API_KEY || this._geminiApiKey; }
  get CLAUDE_API_KEY(): string { return process.env.CLAUDE_API_KEY || this._claudeApiKey; }

  get USE_MIXED_PROVIDERS(): boolean { return this._useMixedProviders; } // Typically from env or default
  get SUGGESTION_PROVIDER(): string { return global.CURRENT_SUGGESTION_PROVIDER || this._suggestionProvider; }
  get EMBEDDING_PROVIDER(): string { return global.CURRENT_EMBEDDING_PROVIDER || this._embeddingProvider; }

  get AGENT_DEFAULT_MAX_STEPS(): number { return parseInt(process.env.AGENT_DEFAULT_MAX_STEPS || '', 10) || this._agentDefaultMaxSteps; }
  get AGENT_ABSOLUTE_MAX_STEPS(): number { return parseInt(process.env.AGENT_ABSOLUTE_MAX_STEPS || '', 10) || this._agentAbsoluteMaxSteps; }
  get MAX_REFINEMENT_ITERATIONS(): number { return parseInt(process.env.MAX_REFINEMENT_ITERATIONS || '', 10) || this._maxRefinementIterations; }
  get FILE_INDEXING_CHUNK_SIZE_CHARS(): number { return parseInt(process.env.FILE_INDEXING_CHUNK_SIZE_CHARS || '', 10) || this._fileIndexingChunkSizeChars; }
  get FILE_INDEXING_CHUNK_OVERLAP_CHARS(): number { return parseInt(process.env.FILE_INDEXING_CHUNK_OVERLAP_CHARS || '', 10) || this._fileIndexingChunkOverlapChars; }
  get REQUEST_ADDITIONAL_CONTEXT_MAX_SEARCH_RESULTS(): number { return parseInt(process.env.REQUEST_ADDITIONAL_CONTEXT_MAX_SEARCH_RESULTS || '', 10) || this._requestAdditionalContextMaxSearchResults; }
  get SUMMARIZATION_MODEL(): string { return process.env.SUMMARIZATION_MODEL || this._summarizationModel; }
  get REFINEMENT_MODEL(): string { return process.env.REFINEMENT_MODEL || this._refinementModel; }
  get DIFF_CHUNK_SIZE_CHARS(): number { return parseInt(process.env.DIFF_CHUNK_SIZE_CHARS || '', 10) || this._diffChunkSizeChars; }
  get DIFF_CHUNK_OVERLAP_CHARS(): number { return parseInt(process.env.DIFF_CHUNK_OVERLAP_CHARS || '', 10) || this._diffChunkOverlapChars; }
  get COMMIT_HISTORY_MAX_COUNT_FOR_INDEXING(): number { return parseInt(process.env.COMMIT_HISTORY_MAX_COUNT_FOR_INDEXING || '', 10) || this._commitHistoryMaxCountForIndexing; }
  get QDRANT_BATCH_UPSERT_SIZE(): number { return parseInt(process.env.QDRANT_BATCH_UPSERT_SIZE || '', 10) || this._qdrantBatchUpsertSize; }
  get AGENT_MAX_CONTEXT_ITEMS(): number { return parseInt(process.env.AGENT_MAX_CONTEXT_ITEMS || '', 10) || this._agentMaxContextItems; }
  get DIFF_LINES_OF_CONTEXT(): number { return parseInt(process.env.DIFF_LINES_OF_CONTEXT || '', 10) || this._diffLinesOfContext; }
  get MAX_FILE_CONTENT_LENGTH_FOR_CAPABILITY(): number { return this._maxFileContentLengthForCapability; }
  get MAX_DIR_LISTING_ENTRIES_FOR_CAPABILITY(): number { return this._maxDirListingEntriesForCapability; }
  // get HTTP_PORT(): number { return parseInt(process.env.HTTP_PORT || '', 10) || this._httpPort; } // Original
  // Change to:
  get HTTP_PORT(): number {
    this.logger.debug(`[ConfigService HTTP_PORT getter] global.CURRENT_HTTP_PORT: ${global.CURRENT_HTTP_PORT}, this._httpPort: ${this._httpPort}, process.env.HTTP_PORT: "${process.env.HTTP_PORT}"`);
    let resolvedPort: number;

    // Priority:
    // 1. global.CURRENT_HTTP_PORT (set by findFreePort if dynamic port was used)
    // 2. this._httpPort (from env var HTTP_PORT or config file, can be 0)
    // 3. this._httpPortFallback (default if nothing else is set or if _httpPort is invalid)

    if (global.CURRENT_HTTP_PORT !== undefined && !isNaN(global.CURRENT_HTTP_PORT)) {
      resolvedPort = global.CURRENT_HTTP_PORT;
    } else if (this._httpPort !== undefined && !isNaN(this._httpPort)) {
      // _httpPort can be 0, which is a valid setting for "dynamic port"
      resolvedPort = this._httpPort;
    } else {
      resolvedPort = this._httpPortFallback;
    }
    return resolvedPort;
  }

  // Method to get all relevant config for a provider (example for OpenAI)
  public getConfig(): { [key: string]: string | number | boolean | undefined } {
    return {
      DEEPSEEK_API_KEY: this.DEEPSEEK_API_KEY,
      DEEPSEEK_API_URL: this.DEEPSEEK_API_URL,
      DEEPSEEK_MODEL: this.DEEPSEEK_MODEL,
      OPENAI_API_KEY: this.OPENAI_API_KEY,
      GEMINI_API_KEY: this.GEMINI_API_KEY,
      CLAUDE_API_KEY: this.CLAUDE_API_KEY,
      // Add other keys as needed
    };
  }

  public setSuggestionModel(model: string): void {
    const oldSuggestionModel = this._suggestionModel; // Store the old value
    this._suggestionModel = model;
    process.env.SUGGESTION_MODEL = model;
    global.CURRENT_SUGGESTION_MODEL = model;

    // If summarization/refinement models were previously derived from suggestionModel or were empty, update them.
    if (this._summarizationModel === oldSuggestionModel || !this._summarizationModel) {
      this._summarizationModel = model;
      process.env.SUMMARIZATION_MODEL = model; 
    }
    if (this._refinementModel === oldSuggestionModel || !this._refinementModel) {
      this._refinementModel = model;
      process.env.REFINEMENT_MODEL = model;
    }
    
    // Ensure global state is fully updated before persisting.
    // initializeGlobalState updates all global.* variables based on current service state.
    this.initializeGlobalState(); 
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

  public setOpenAIApiKey(key: string): void {
    this._openAIApiKey = key;
    process.env.OPENAI_API_KEY = key;
    this.persistModelConfiguration(); // Persist to model-config.json
  }

  public setGeminiApiKey(key: string): void {
    this._geminiApiKey = key;
    process.env.GEMINI_API_KEY = key;
    this.persistModelConfiguration();
  }

  public setClaudeApiKey(key: string): void {
    this._claudeApiKey = key;
    process.env.CLAUDE_API_KEY = key;
    this.persistModelConfiguration();
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
        // Include other API keys that should be persisted in model-config.json
        OPENAI_API_KEY: this.OPENAI_API_KEY,
        GEMINI_API_KEY: this.GEMINI_API_KEY,
        CLAUDE_API_KEY: this.CLAUDE_API_KEY,
        SUMMARIZATION_MODEL: this.SUMMARIZATION_MODEL, // New
        REFINEMENT_MODEL: this.REFINEMENT_MODEL,     // New
      };
      // Remove undefined keys before saving
      Object.keys(configToSave).forEach(keyStr => {
        const key = keyStr as keyof ModelConfigFile;
        if (configToSave[key] === undefined) {
          delete configToSave[key];
        }
      });
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
export { ConfigService };
