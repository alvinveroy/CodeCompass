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
    // Clear ALL relevant process.env variables that ConfigService reads
    // to ensure a clean slate for each test, then set them as needed per test.
    delete process.env.HOME;
    delete process.env.OLLAMA_HOST;
    delete process.env.SUGGESTION_MODEL;
    delete process.env.SUGGESTION_PROVIDER;
    delete process.env.EMBEDDING_PROVIDER;
    delete process.env.DEEPSEEK_API_KEY;
    delete process.env.DEEPSEEK_API_URL;
    delete process.env.SUMMARIZATION_MODEL;
    delete process.env.REFINEMENT_MODEL;
    delete process.env.AGENT_DEFAULT_MAX_STEPS;
    // ... and any other env vars ConfigService uses.
    process.env.HOME = MOCK_HOME_DIR; // Now set the specific one for tests
    
    const fsMock = fs;
    vi.mocked(fsMock.existsSync).mockReset().mockImplementation((p) => p === MOCK_CONFIG_DIR);
    vi.mocked(fsMock.readFileSync).mockReset().mockReturnValue('{}');
    vi.mocked(fsMock.writeFileSync).mockReset();
    vi.mocked(fsMock.mkdirSync).mockReset().mockImplementation(() => undefined);

    // Reset winston mocks more thoroughly
    const winstonMockedModule = await import('winston');
    const createLoggerMock = vi.mocked(winstonMockedModule.createLogger);
    
    // Get the MOCK_LOGGER_INSTANCE that the factory for winston mock returns
    // This relies on the factory structure: vi.mock('winston', () => { const MOCK_LOGGER_INSTANCE = {...}; return { createLogger: vi.fn().mockReturnValue(MOCK_LOGGER_INSTANCE), ... } })
    const loggerInstanceFromMockFactory = createLoggerMock.getMockImplementation()?.(); // This calls the factory's createLogger mock impl if it exists
                                                                                      // or the factory itself if createLogger is the factory.
                                                                                      // More robust: access the MOCK_LOGGER_INSTANCE directly if it's exported by the mock factory.
                                                                                      // For now, assuming the factory returns it or createLogger returns it.

    if (loggerInstanceFromMockFactory) {
      Object.values(loggerInstanceFromMockFactory).forEach(fn => {
        if (typeof fn === 'function' && 'mockClear' in fn) (fn as vi.Mock).mockClear();
      });
    }
    createLoggerMock.mockClear(); // Clear calls to createLogger itself
    if (loggerInstanceFromMockFactory) { // If we got an instance, ensure createLogger continues to return it
      createLoggerMock.mockReturnValue(loggerInstanceFromMockFactory);
    }
    
    // Ensure transports are also cleared
    vi.mocked(winstonTransports.File).mockClear();
    vi.mocked(winstonTransports.Stream).mockClear();
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
    vi.mocked(fs.existsSync).mockImplementation((p) =>
      p === MOCK_CONFIG_DIR || p === MOCK_MODEL_CONFIG_FILE // <<< THIS IS KEY
    );
    vi.mocked(fs.readFileSync).mockImplementation((p) => {
      if (p === MOCK_MODEL_CONFIG_FILE) return JSON.stringify({ SUGGESTION_MODEL: 'file_model_from_json' });
      return '{}'; // Default for other files like deepseek-config.json
    });
    
    const service = await createServiceInstance();
    expect(service.SUGGESTION_MODEL).toBe('file_model_from_json');
  });

  it('should prioritize model-config.json over environment variables for SUGGESTION_MODEL', async () => {
    process.env.SUGGESTION_MODEL = 'env_model_should_be_ignored';
    // Setup fs mocks specifically for THIS test's scenario
    vi.mocked(fs.existsSync).mockImplementation((p) =>
      p === MOCK_CONFIG_DIR || p === MOCK_MODEL_CONFIG_FILE
    );
    vi.mocked(fs.readFileSync).mockImplementation((p) => {
        if (p === MOCK_MODEL_CONFIG_FILE) return JSON.stringify({ SUGGESTION_MODEL: 'file_model_override' });
        return '{}'; // Default for other files
    });
    const service = await createServiceInstance();
    expect(service.SUGGESTION_MODEL).toBe('file_model_override');
  });

  it('should load DEEPSEEK_API_KEY from deepseek-config.json', async () => {
    vi.mocked(fs.existsSync).mockImplementation((p) => 
      p === MOCK_CONFIG_DIR || p === MOCK_DEEPSEEK_CONFIG_FILE
    );
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
    vi.mocked(fs.existsSync).mockReset().mockImplementation((p) => p === MOCK_CONFIG_DIR); // Only .codecompass dir exists
    vi.mocked(fs.readFileSync).mockReset().mockReturnValue('{}'); // No pre-existing model-config

    const service = await createServiceInstance(); // Initializes with defaults
    
    // Capture default/initial state that will be part of the persisted object
    // These are the values that ConfigService._persistModelConfiguration will read from the service instance
    const initialSuggestionProvider = service.SUGGESTION_PROVIDER; 
    const initialEmbeddingProvider = service.EMBEDDING_PROVIDER;   
    const initialOpenAiApiKey = service.OPENAI_API_KEY;         
    const initialGeminiApiKey = service.GEMINI_API_KEY;         
    const initialClaudeApiKey = service.CLAUDE_API_KEY;         
    // When setSuggestionModel is called, _suggestionModel is updated.
    // _summarizationModel and _refinementModel are getters that derive from _suggestionModel
    // if their specific env vars are not set.
    
    service.setSuggestionModel('new_persisted_model');

    // After setSuggestionModel, the getters for SUMMARIZATION_MODEL and REFINEMENT_MODEL
    // should reflect 'new_persisted_model' IF no specific env vars for them are set.
    // The _persistModelConfiguration method reads these current getter values.
    const expectedJsonContent = {
        SUGGESTION_MODEL: 'new_persisted_model', // Directly set
        SUGGESTION_PROVIDER: initialSuggestionProvider, // Persisted from initial state
        EMBEDDING_PROVIDER: initialEmbeddingProvider,   // Persisted from initial state
        OPENAI_API_KEY: initialOpenAiApiKey,            // Persisted from initial state
        GEMINI_API_KEY: initialGeminiApiKey,            // Persisted from initial state
        CLAUDE_API_KEY: initialClaudeApiKey,            // Persisted from initial state
        SUMMARIZATION_MODEL: 'new_persisted_model',     // Derived from the new suggestion model
        REFINEMENT_MODEL: 'new_persisted_model'         // Derived from the new suggestion model
    };
    
    expect(vi.mocked(fs.writeFileSync)).toHaveBeenCalledWith(
      MOCK_MODEL_CONFIG_FILE,
      JSON.stringify(expectedJsonContent, null, 2)
    );
  });
  
  it('should persist DeepSeek API key when setDeepSeekApiKey is called', async () => {
    vi.mocked(fs.existsSync).mockReset().mockImplementation((p) => p === MOCK_CONFIG_DIR);
    vi.mocked(fs.readFileSync).mockReset().mockReturnValue('{}'); // No pre-existing deepseek config

    const service = await createServiceInstance();
    const newApiKey = 'new_deepseek_key';
    // Capture the DEEPSEEK_API_URL that the service instance has *before* calling setDeepSeekApiKey,
    // as this is what _persistDeepSeekConfiguration will use.
    const expectedApiUrl = service.DEEPSEEK_API_URL; 

    service.setDeepSeekApiKey(newApiKey);

    expect(vi.mocked(fs.writeFileSync)).toHaveBeenCalledTimes(1);
    const writtenArgs = vi.mocked(fs.writeFileSync).mock.calls[0];
    expect(writtenArgs[0]).toBe(MOCK_DEEPSEEK_CONFIG_FILE);
    
    const writtenData = JSON.parse(writtenArgs[1] as string);
    expect(writtenData).toHaveProperty('DEEPSEEK_API_KEY', newApiKey);
    expect(writtenData).toHaveProperty('DEEPSEEK_API_URL', service.DEEPSEEK_API_URL); // Use the getter
    expect(writtenData).toHaveProperty('timestamp');
    // Ensure timestamp is a recent ISO string (optional, but good check)
    // This check can be flaky due to timing, consider removing or making tolerance larger if it causes issues
    // expect(new Date().getTime() - new Date(writtenData.timestamp).getTime()).toBeLessThan(5000); 
  });

  it('should handle malformed model-config.json gracefully', async () => {
    delete process.env.SUGGESTION_MODEL; // Ensure no env override for this test
    // Specific fs setup for this test
    vi.mocked(fs.existsSync).mockImplementation((p) => 
      p === MOCK_CONFIG_DIR || p === MOCK_MODEL_CONFIG_FILE
    );
    vi.mocked(fs.readFileSync).mockImplementation((p) => {
        if (p === MOCK_MODEL_CONFIG_FILE) return '{"SUGGESTION_MODEL": MALFORMED';
        return '{}'; // For deepseek-config.json
    });
    
    const service = await createServiceInstance(); // Creates a new instance
    
    const winstonMockedModule = await import('winston');
    // Ensure we get the logger instance associated with *this* service instance
    const loggerInstance = vi.mocked(winstonMockedModule.createLogger).mock.results.find(r => r.type === 'return')?.value;

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
    vi.mocked(fs.existsSync).mockReset().mockImplementation((p) => p === MOCK_CONFIG_DIR); // Only .codecompass dir
    vi.mocked(fs.readFileSync).mockReset().mockReturnValue('{}'); // No config files initially

    const service = await createServiceInstance();
    expect(service.SUGGESTION_MODEL).toBe('llama3.1:8b'); // Initial default

    // NOW, change env and file mocks for the reload
    process.env.SUGGESTION_MODEL = 'env_reloaded_model_should_be_overridden_by_file';
    // Ensure readFileSync and existsSync are specifically mocked for model-config.json for the reload
    vi.mocked(fs.existsSync).mockImplementation((p) => 
      p === MOCK_CONFIG_DIR || p === MOCK_MODEL_CONFIG_FILE
    );
    vi.mocked(fs.readFileSync).mockImplementation((p) => {
      if (p === MOCK_MODEL_CONFIG_FILE) return JSON.stringify({ SUGGESTION_MODEL: 'file_reloaded_model' });
      return '{}'; // For deepseek-config.json
    });
    
    service.reloadConfigsFromFile();
    
    expect(service.SUGGESTION_MODEL).toBe('file_reloaded_model'); // File should take precedence
    expect(global.CURRENT_SUGGESTION_MODEL).toBe('file_reloaded_model'); // Global state should also update
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
    vi.mocked(fs.existsSync).mockReset().mockImplementation((p) => {
      if (p === MOCK_CONFIG_DIR) return true; // .codecompass dir exists
      // MOCK_LOG_DIR and fallback log dir do not exist initially
      return false;
    });
    // Specific mock for mkdirSync for this test
    vi.mocked(fs.mkdirSync).mockImplementation((p) => {
      if (p === MOCK_LOG_DIR) {
        throw new Error('Permission denied for user log dir');
      }
      if (p === path.join(process.cwd(), 'logs')) return undefined; // Success for fallback
      if (p === MOCK_CONFIG_DIR) return undefined; // Allow .codecompass creation if needed
      // For any other path, default behavior from beforeEach was: .mockReset().mockImplementation(() => undefined);
      // So, if not matched above, it will return undefined.
      return undefined;
    });

    const service = await createServiceInstance();
    
    const winstonMockedModule = await import('winston');
    // Get the logger instance that was created by *this specific* service instance
    const loggerInstance = vi.mocked(winstonMockedModule.createLogger).mock.results.find(r => r.type === 'return')?.value;

    expect(service.LOG_DIR).toBe(path.join(process.cwd(), 'logs'));
    expect(loggerInstance.warn).toHaveBeenCalledWith(expect.stringContaining('Failed to create user-specific log directory: Permission denied for user log dir. Falling back to local logs dir.'));
    expect(vi.mocked(fs.mkdirSync)).toHaveBeenCalledWith(path.join(process.cwd(), 'logs'), { recursive: true });
  });

});
