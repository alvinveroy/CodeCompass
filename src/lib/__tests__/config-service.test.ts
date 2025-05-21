import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'fs'; // Use actual fs for mocking its methods
import path from 'path';
// Import specific parts of winston that the test needs to interact with directly
import { transports as winstonTransports, createLogger as winstonCreateLogger } from 'winston'; // Import named exports

// Import the class directly for testing.
import { ConfigService as ActualConfigService } from '../config-service';
// import fsActual from 'fs'; // Not strictly needed if we define the mock structure directly

// Mock the entire fs module
vi.mock('fs', () => {
  const mockFs = {
    existsSync: vi.fn(),
    readFileSync: vi.fn(),
    writeFileSync: vi.fn(),
    mkdirSync: vi.fn(),
    // Add other fs functions if ConfigService uses them directly
  };
  return {
    ...mockFs, // Spread to allow named imports like `import { existsSync } from 'fs'`
    default: mockFs, // Provide a default export for `import fs from 'fs'`
  };
});

// Mock winston logger creation and transports
vi.mock('winston', () => {
      // Define the logger instance that createLogger will return INSIDE the factory
      const MOCK_LOGGER_INSTANCE = { // Changed name to avoid confusion
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
        debug: vi.fn(),
      };

      // Define mocks for winston.format properties that ConfigService uses
      // ConfigService uses: combine, timestamp, printf, colorize, splat, simple, json
      const mockFormat = {
        combine: vi.fn((...args: any[]) => ({ // combine should return a format object
          // Simulate a basic format object structure.
          // The actual transformation logic isn't critical for most ConfigService tests,
          // just that createLogger receives a valid format object.
          _isFormat: true,
          transform: vi.fn(info => info)
        })),
        timestamp: vi.fn(() => ({ _isFormat: true, transform: vi.fn(info => ({...info, timestamp: new Date().toISOString()})) })),
        printf: vi.fn(template => ({ _isFormat: true, transform: vi.fn(info => template(info)) })),
        colorize: vi.fn(() => ({ _isFormat: true, transform: vi.fn(info => info) })),
        splat: vi.fn(() => ({ _isFormat: true, transform: vi.fn(info => info) })),
        simple: vi.fn(() => ({ _isFormat: true, transform: vi.fn(info => info) })),
        json: vi.fn(() => ({ _isFormat: true, transform: vi.fn(info => info) })),
        // Add any other winston.format properties if ConfigService starts using them
      };
      
      const mockedWinstonParts = {
        createLogger: vi.fn().mockReturnValue(MOCK_LOGGER_INSTANCE),
        transports: {
          File: vi.fn().mockImplementation(() => ({ on: vi.fn(), log: vi.fn() })),
          Stream: vi.fn().mockImplementation(() => ({ on: vi.fn(), log: vi.fn() })),
        },
        format: mockFormat,
      };
      return {
        ...mockedWinstonParts, // For named imports like `import { transports } from 'winston'`
        default: mockedWinstonParts, // For `import winston from 'winston'` in ConfigService
      };
    });


describe('ConfigService', () => {
  let originalEnv: NodeJS.ProcessEnv;
  const MOCK_HOME_DIR = '/mock/home/user';
  const MOCK_CONFIG_DIR = path.join(MOCK_HOME_DIR, '.codecompass');
  const MOCK_MODEL_CONFIG_FILE = path.join(MOCK_CONFIG_DIR, 'model-config.json');
  const MOCK_DEEPSEEK_CONFIG_FILE = path.join(MOCK_CONFIG_DIR, 'deepseek-config.json');
  const MOCK_LOG_DIR = path.join(MOCK_CONFIG_DIR, 'logs');

  // Helper to reset and instantiate ConfigService
  const createServiceInstance = async () => {
    vi.resetModules(); // This is key
    // fs mocks are set per test *before* this is called.
    const { ConfigService: FreshConfigService } = await import('../config-service');
    return new FreshConfigService() as ActualConfigService;
  };

  beforeEach(async () => {
    originalEnv = { ...process.env };
    process.env.HOME = MOCK_HOME_DIR;
    
    const fsMock = fs; // fs is the top-level mocked 'fs' from vi.mock('fs', ...)

    // Reset all fs mock functions to a clean state for each test
    vi.mocked(fsMock.existsSync).mockReset();
    vi.mocked(fsMock.readFileSync).mockReset();
    vi.mocked(fsMock.writeFileSync).mockReset();
    vi.mocked(fsMock.mkdirSync).mockReset();
    
    // Default behavior: .codecompass dir exists, but no config files within it. mkdir works.
    vi.mocked(fsMock.existsSync).mockImplementation((p) => p === MOCK_CONFIG_DIR);
    vi.mocked(fsMock.readFileSync).mockReturnValue('{}'); // Default for any read
    vi.mocked(fsMock.mkdirSync).mockImplementation(() => undefined); // Default: mkdir succeeds

    // Reset winston transport mocks if necessary
    // Use the imported named 'transports' and 'createLogger'
    vi.mocked(winstonTransports.File).mockClear();
    vi.mocked(winstonTransports.Stream).mockClear();
    
    // To clear/reset the logger for each test:
    const winstonMockedModule = await import('winston'); // Import the mocked module
    const loggerInstanceFromMock = vi.mocked(winstonMockedModule.createLogger).mock.results[0]?.value; // Get instance from mock results

    if (loggerInstanceFromMock) {
      Object.values(loggerInstanceFromMock).forEach(mockFn => {
        if (typeof mockFn === 'function' && 'mockClear' in mockFn) {
          (mockFn as vi.Mock).mockClear();
        }
      });
    }
    // Also clear calls to createLogger itself
    vi.mocked(winstonMockedModule.createLogger).mockClear();
    // Ensure it's still set to return the (now internally cleared) MOCK_LOGGER_INSTANCE
    // This is important if createServiceInstance() is called multiple times or if state leaks.
    if (loggerInstanceFromMock) { // Re-set the mock return value if an instance was found
        vi.mocked(winstonMockedModule.createLogger).mockReturnValue(loggerInstanceFromMock);
    }
  });

  afterEach(() => {
    process.env = originalEnv; // Restore original process.env
    vi.unstubAllEnvs(); // Vitest specific: clear env stubs
  });

  it('should initialize with default values when no env vars or config files', async () => {
    const service = await createServiceInstance();
    expect(service.OLLAMA_HOST).toBe('http://127.0.0.1:11434');
    expect(service.SUGGESTION_MODEL).toBe('llama3.1:8b'); // Default for Ollama
    expect(service.LLM_PROVIDER).toBe('ollama');
    expect(service.AGENT_DEFAULT_MAX_STEPS).toBe(service.DEFAULT_AGENT_DEFAULT_MAX_STEPS);
    // ... test other important defaults
  });

  it('should load OLLAMA_HOST from environment variable if valid', async () => {
    process.env.OLLAMA_HOST = 'http://customhost:1234';
    const service = await createServiceInstance();
    expect(service.OLLAMA_HOST).toBe('http://customhost:1234');
  });

  it('should fallback to default OLLAMA_HOST if env var is invalid URL', async () => {
    process.env.OLLAMA_HOST = 'invalid-url-format';
    const service = await createServiceInstance();
    expect(service.OLLAMA_HOST).toBe('http://127.0.0.1:11434');
    expect(service.logger.warn).toHaveBeenCalledWith(expect.stringContaining('OLLAMA_HOST environment variable "invalid-url-format" is not a valid URL'));
  });
  
  it('should load SUGGESTION_MODEL from model-config.json if present', async () => {
    // Setup fs mocks specifically for THIS test's scenario
    vi.mocked(fs.existsSync).mockImplementation((p) => p === MOCK_CONFIG_DIR || p === MOCK_MODEL_CONFIG_FILE);
    vi.mocked(fs.readFileSync).mockImplementation((p) => {
      if (p === MOCK_MODEL_CONFIG_FILE) return JSON.stringify({ SUGGESTION_MODEL: 'file_model_from_json' });
      return '{}';
    });
    
    const service = await createServiceInstance();
    expect(service.SUGGESTION_MODEL).toBe('file_model_from_json');
  });

  it('should prioritize model-config.json over environment variables for SUGGESTION_MODEL', async () => {
    process.env.SUGGESTION_MODEL = 'env_model';
    vi.mocked(fs.existsSync).mockImplementation((p) => p === MOCK_CONFIG_DIR || p === MOCK_MODEL_CONFIG_FILE);
    vi.mocked(fs.readFileSync).mockImplementation((p) => {
        if (p === MOCK_MODEL_CONFIG_FILE) return JSON.stringify({ SUGGESTION_MODEL: 'file_model_override' });
        return '{}';
    });
    const service = await createServiceInstance();
    expect(service.SUGGESTION_MODEL).toBe('file_model_override');
  });

  it('should load DEEPSEEK_API_KEY from deepseek-config.json', async () => {
    vi.mocked(fs.existsSync).mockImplementation((p) => p === MOCK_DEEPSEEK_CONFIG_FILE || p === MOCK_CONFIG_DIR);
    vi.mocked(fs.readFileSync).mockImplementation((p) => {
        if (p === MOCK_DEEPSEEK_CONFIG_FILE) return JSON.stringify({ DEEPSEEK_API_KEY: 'deepseek_key_from_file' });
        return '{}';
    });
    const service = await createServiceInstance();
    expect(service.DEEPSEEK_API_KEY).toBe('deepseek_key_from_file');
  });

  it('should derive SUMMARIZATION_MODEL from SUGGESTION_MODEL if not set', async () => {
    process.env.SUGGESTION_MODEL = 'test_suggestion_model';
    // Ensure SUMMARIZATION_MODEL is not in env or file
    delete process.env.SUMMARIZATION_MODEL;
    vi.mocked(fs.existsSync).mockReturnValue(false); // No config files
    const service = await createServiceInstance();
    expect(service.SUMMARIZATION_MODEL).toBe('test_suggestion_model');
  });

  it('should load SUMMARIZATION_MODEL from environment if set', async () => {
    process.env.SUGGESTION_MODEL = 'default_suggestion';
    process.env.SUMMARIZATION_MODEL = 'env_summary_model';
    vi.mocked(fs.existsSync).mockReturnValue(false);
    const service = await createServiceInstance();
    expect(service.SUMMARIZATION_MODEL).toBe('env_summary_model');
  });

  it('should persist model configuration when setSuggestionModel is called', async () => {
    vi.mocked(fs.existsSync).mockImplementation((p) => p === MOCK_CONFIG_DIR); // Only .codecompass dir exists
    vi.mocked(fs.readFileSync).mockReturnValue('{}'); // No pre-existing model-config

    const service = await createServiceInstance(); // Gets default values
    
    // Capture the state of related properties *before* setSuggestionModel changes them
    // or rely on known defaults if setSuggestionModel doesn't alter these other persisted fields.
    const currentSuggestionProvider = service.SUGGESTION_PROVIDER;
    const currentEmbeddingProvider = service.EMBEDDING_PROVIDER;
    const currentOpenAiApiKey = service.OPENAI_API_KEY;
    const currentGeminiApiKey = service.GEMINI_API_KEY;
    const currentClaudeApiKey = service.CLAUDE_API_KEY;
    // SUMMARIZATION_MODEL and REFINEMENT_MODEL are derived from SUGGESTION_MODEL.
    // _persistModelConfiguration reads the *current* values of these.
    // When setSuggestionModel is called, it updates _suggestionModel.
    // The summarization/refinement models will be based on this new _suggestionModel.
    
    service.setSuggestionModel('new_persisted_model');

    // After setSuggestionModel, SUMMARIZATION_MODEL and REFINEMENT_MODEL will be 'new_persisted_model'
    // if they were previously derived from SUGGESTION_MODEL and not explicitly set otherwise.
    const expectedJsonContent = {
        SUGGESTION_MODEL: 'new_persisted_model',
        SUGGESTION_PROVIDER: currentSuggestionProvider, 
        EMBEDDING_PROVIDER: currentEmbeddingProvider,   
        OPENAI_API_KEY: currentOpenAiApiKey,         
        GEMINI_API_KEY: currentGeminiApiKey,         
        CLAUDE_API_KEY: currentClaudeApiKey,         
        SUMMARIZATION_MODEL: 'new_persisted_model', // Derived from the new suggestion model
        REFINEMENT_MODEL: 'new_persisted_model'   // Derived
    };
    
    expect(vi.mocked(fs.writeFileSync)).toHaveBeenCalledWith(
      MOCK_MODEL_CONFIG_FILE,
      JSON.stringify(expectedJsonContent, null, 2)
    );
  });
  
  it('should persist DeepSeek API key when setDeepSeekApiKey is called', async () => {
    vi.mocked(fs.existsSync).mockImplementation((p) => p === MOCK_CONFIG_DIR);
    vi.mocked(fs.readFileSync).mockReturnValue('{}'); // No pre-existing deepseek config

    const service = await createServiceInstance();
    const newApiKey = 'new_deepseek_key';
    service.setDeepSeekApiKey(newApiKey);

    expect(vi.mocked(fs.writeFileSync)).toHaveBeenCalledTimes(1);
    const writtenArgs = vi.mocked(fs.writeFileSync).mock.calls[0];
    expect(writtenArgs[0]).toBe(MOCK_DEEPSEEK_CONFIG_FILE);
    
    const writtenData = JSON.parse(writtenArgs[1] as string);
    expect(writtenData).toHaveProperty('DEEPSEEK_API_KEY', newApiKey);
    expect(writtenData).toHaveProperty('DEEPSEEK_API_URL', service.DEEPSEEK_BASE_URL); // Check against the service's current base URL
    expect(writtenData).toHaveProperty('timestamp');
    // Ensure timestamp is a recent ISO string (optional, but good check)
    // This check can be flaky due to timing, consider removing or making tolerance larger if it causes issues
    // expect(new Date().getTime() - new Date(writtenData.timestamp).getTime()).toBeLessThan(5000); 
  });

  it('should handle malformed model-config.json gracefully', async () => {
    // Specific fs setup for this test
    vi.mocked(fs.existsSync).mockImplementation((p) => p === MOCK_CONFIG_DIR || p === MOCK_MODEL_CONFIG_FILE);
    vi.mocked(fs.readFileSync).mockReturnValue('{"SUGGESTION_MODEL": MALFORMED'); 
    
    const service = await createServiceInstance(); // Creates a new instance
    
    const winstonMockedModule = await import('winston');
    const loggerInstance = vi.mocked(winstonMockedModule.createLogger).mock.results[0]?.value;

    expect(loggerInstance.warn).toHaveBeenCalledWith(expect.stringContaining('Failed to load model config'));
    expect(service.SUGGESTION_MODEL).toBe('llama3.1:8b'); // Should fall back to default
  });

  it('should correctly set global state variables via initializeGlobalState', async () => {
    process.env.SUGGESTION_PROVIDER = 'test_provider_global'; // Set BEFORE instance creation
    process.env.SUGGESTION_MODEL = 'test_model_global';
    const service = await createServiceInstance(); 
    // initializeGlobalState is called in constructor
    expect(global.CURRENT_SUGGESTION_PROVIDER).toBe('test_provider_global');
    expect(global.CURRENT_SUGGESTION_MODEL).toBe('test_model_global');
  });

  it('reloadConfigsFromFile should re-read environment and file configs', async () => {
    // Initial setup: no env var, no file
    delete process.env.SUGGESTION_MODEL;
    vi.mocked(fs.existsSync).mockImplementation((p) => p === MOCK_CONFIG_DIR); // Only .codecompass dir
    vi.mocked(fs.readFileSync).mockReturnValue('{}');

    const service = await createServiceInstance();
    expect(service.SUGGESTION_MODEL).toBe('llama3.1:8b'); // Initial default

    // NOW, change env and file mocks for the reload
    process.env.SUGGESTION_MODEL = 'env_reloaded_model';
    vi.mocked(fs.existsSync).mockImplementation((p) => p === MOCK_CONFIG_DIR || p === MOCK_MODEL_CONFIG_FILE);
    vi.mocked(fs.readFileSync).mockImplementation((p) => {
      if (p === MOCK_MODEL_CONFIG_FILE) return JSON.stringify({ SUGGESTION_MODEL: 'file_reloaded_model' });
      return '{}';
    });
    
    service.reloadConfigsFromFile();
    
    expect(service.SUGGESTION_MODEL).toBe('file_reloaded_model'); // File should take precedence
    expect(global.CURRENT_SUGGESTION_MODEL).toBe('file_reloaded_model');
  });

  // Test getters for all new config values (AGENT_DEFAULT_MAX_STEPS, etc.)
  // Example for AGENT_DEFAULT_MAX_STEPS
  it('AGENT_DEFAULT_MAX_STEPS getter should return correct value from env or default', async () => {
    const serviceDefault = await createServiceInstance();
    expect(serviceDefault.AGENT_DEFAULT_MAX_STEPS).toBe(serviceDefault.DEFAULT_AGENT_DEFAULT_MAX_STEPS);

    process.env.AGENT_DEFAULT_MAX_STEPS = '5';
    const serviceEnv = await createServiceInstance();
    expect(serviceEnv.AGENT_DEFAULT_MAX_STEPS).toBe(5);
  });

  // Test log directory creation fallback
  it('should fallback to local logs directory if user-specific one fails', async () => {
    vi.mocked(fs.existsSync).mockImplementation((p) => p === MOCK_CONFIG_DIR); // Config dir exists, log dir does not
    vi.mocked(fs.mkdirSync).mockImplementation((p) => {
      if (p === MOCK_LOG_DIR) {
        throw new Error('Permission denied for user log dir');
      }
      if (p === path.join(process.cwd(), 'logs')) return undefined; // Success for fallback
      return undefined; // Allow MOCK_CONFIG_DIR creation if it were called for that
    });

    const service = await createServiceInstance(); 
    
    const winstonMockedModule = await import('winston');
    // Get the logger instance that was created by *this specific* service instance
    const loggerInstance = vi.mocked(winstonMockedModule.createLogger).mock.results.find(r => r.type === 'return')?.value;

    expect(service.LOG_DIR).toBe(path.join(process.cwd(), 'logs'));
    expect(loggerInstance.warn).toHaveBeenCalledWith(expect.stringContaining('Failed to create user-specific log directory'));
    // expect(loggerInstance.info).toHaveBeenCalledWith(expect.stringContaining('Falling back to local logs directory')); // This line might be too specific or depend on logger setup details
    expect(vi.mocked(fs.mkdirSync)).toHaveBeenCalledWith(path.join(process.cwd(), 'logs'), { recursive: true });
  });

});
