import { describe, it, expect, vi, beforeEach, afterEach, type Mock } from 'vitest';
import fs from 'fs'; // Use actual fs for mocking its methods
import path from 'path';
// Import specific parts of winston that the test needs to interact with directly
import { transports as winstonTransports, createLogger as _winstonCreateLogger } from 'winston'; // Import named exports
import type { Format, TransformableInfo } from 'logform'; // Import types from logform

// Import the class directly for testing.
import { ConfigService as _ConfigService } from '../../lib/config-service'; // Import ConfigService class itself
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
        info: vi.fn((_message?: unknown, ..._meta: unknown[]) => undefined),
        warn: vi.fn((_message?: unknown, ..._meta: unknown[]) => undefined),
        error: vi.fn((_message?: unknown, ..._meta: unknown[]) => undefined),
        debug: vi.fn((_message?: unknown, ..._meta: unknown[]) => undefined),
        add: vi.fn((_transport: unknown) => MOCK_LOGGER_INSTANCE), 
        remove: vi.fn((_transport: unknown) => MOCK_LOGGER_INSTANCE), 
      };

      // Define mocks for winston.format properties that ConfigService uses
      // ConfigService uses: combine, timestamp, printf, colorize, splat, simple, json
      const mockFormat = {
        combine: vi.fn((..._args: Format[]): Format => ({ // combine should return a format object
          // Simulate a basic format object structure.
          _isFormat: true, // Custom property to identify it as a mock format object
          transform: vi.fn((info: TransformableInfo) => info) as unknown as Format['transform'],
        } as Format)),
        timestamp: vi.fn((): Format => ({ _isFormat: true, transform: vi.fn((info: TransformableInfo) => ({...info, timestamp: new Date().toISOString()})) as unknown as Format['transform'] } as Format)),
        printf: vi.fn((template: (info: TransformableInfo) => string): Format => ({ _isFormat: true, transform: vi.fn((info: TransformableInfo) => template(info)) as unknown as Format['transform'] } as Format)),
        colorize: vi.fn((): Format => ({ _isFormat: true, transform: vi.fn((info: TransformableInfo) => info) as unknown as Format['transform'] } as Format)),
        splat: vi.fn((): Format => ({ _isFormat: true, transform: vi.fn((info: TransformableInfo) => info) as unknown as Format['transform'] } as Format)),
        simple: vi.fn((): Format => ({ _isFormat: true, transform: vi.fn((info: TransformableInfo) => info) as unknown as Format['transform'] } as Format)),
        json: vi.fn((): Format => ({ _isFormat: true, transform: vi.fn((info: TransformableInfo) => info) as unknown as Format['transform'] } as Format)),
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
    // Import the ConfigService class directly for instance manipulation
    const { ConfigService: ImportedConfigServiceClass } = await import('../../lib/config-service.js');
    // Reset the private static instance variable
    ((ImportedConfigServiceClass as any) as { instance?: any }).instance = undefined; // eslint-disable-line @typescript-eslint/no-explicit-any
    // Call the public static getter to create/get the new instance
    return ImportedConfigServiceClass.getInstance();
  };

  beforeEach(async () => {
    originalEnv = { ...process.env };
    // Clear ALL relevant process.env variables
    const keysToClear: string[] = [
      'HOME', 'OLLAMA_HOST', 'QDRANT_HOST', 'COLLECTION_NAME',
      'LLM_PROVIDER', 'SUGGESTION_MODEL', 'SUGGESTION_PROVIDER',
      'EMBEDDING_PROVIDER', 'SUMMARIZATION_MODEL', 'REFINEMENT_MODEL',
      'DEEPSEEK_API_KEY', 'DEEPSEEK_API_URL', 'OPENAI_API_KEY',
      'GEMINI_API_KEY', 'CLAUDE_API_KEY', 'AGENT_DEFAULT_MAX_STEPS',
      // Add any other env vars ConfigService might read
    ];
    for (const key of keysToClear) {
      delete process.env[key];
    }
    process.env.HOME = MOCK_HOME_DIR;
    // Clear global state potentially set by ConfigService
    // Assign undefined instead of using delete
    const g = globalThis as NodeJS.Global & typeof globalThis & { [key: string]: unknown };
    g.CURRENT_LLM_PROVIDER = undefined;
    g.CURRENT_SUGGESTION_PROVIDER = undefined;
    g.CURRENT_EMBEDDING_PROVIDER = undefined;
    g.CURRENT_SUGGESTION_MODEL = undefined;
    
    const fsMock = fs;
    // Default: only .codecompass dir exists, config files don't unless specified by a test
    vi.mocked(fsMock.existsSync).mockReset().mockImplementation((p) => p === MOCK_CONFIG_DIR);
    // Default: config files are empty JSON unless specified by a test
    vi.mocked(fsMock.readFileSync).mockReset().mockReturnValue('{}');
    vi.mocked(fsMock.writeFileSync).mockReset();
    vi.mocked(fsMock.mkdirSync).mockReset().mockImplementation(() => undefined);

    // Reset winston mocks more thoroughly
    const _winstonMockedModule = await import('winston');
    const createLoggerMock = vi.mocked(_winstonMockedModule.createLogger);
    
    // Get the MOCK_LOGGER_INSTANCE that the factory for winston mock returns
    // This relies on the factory structure: vi.mock('winston', () => { const MOCK_LOGGER_INSTANCE = {...}; return { createLogger: vi.fn().mockReturnValue(MOCK_LOGGER_INSTANCE), ... } })
    // Access the mock logger instance directly from the mock setup
    // eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call
    const loggerInstanceFromMockFactory = (_winstonMockedModule as any).default.createLogger() as import('winston').Logger;


    if (loggerInstanceFromMockFactory) {
      Object.values(loggerInstanceFromMockFactory).forEach(fn => {
        if (typeof fn === 'function' && 'mockClear' in fn) (fn as Mock).mockClear();
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
    vi.stubEnv('OLLAMA_HOST', 'http://customhost:1234');
    const service = await createServiceInstance();
    expect(service.OLLAMA_HOST).toBe('http://customhost:1234');
  });

  it('should fallback to default OLLAMA_HOST if env var is invalid URL', async () => {
    vi.stubEnv('OLLAMA_HOST', 'invalid-url-format');
    const service = await createServiceInstance();
    expect(service.OLLAMA_HOST).toBe('http://127.0.0.1:11434');
    expect(service.logger.warn).toHaveBeenCalledWith(expect.stringContaining('OLLAMA_HOST environment variable "invalid-url-format" is not a valid URL'));
  });
  
  it('should load SUGGESTION_MODEL from model-config.json if present', async () => {
    // Setup fs mocks specifically for THIS test's scenario
    vi.mocked(fs.existsSync).mockImplementation((p) => 
      String(p) === MOCK_CONFIG_DIR || String(p) === MOCK_MODEL_CONFIG_FILE
    );
    vi.mocked(fs.readFileSync).mockImplementation((p) => {
      if (String(p) === MOCK_MODEL_CONFIG_FILE) return JSON.stringify({ SUGGESTION_MODEL: 'file_model_from_json' });
      if (String(p) === MOCK_DEEPSEEK_CONFIG_FILE) return JSON.stringify({}); // Handle other expected reads
      return '{}'; 
    });
    
    const service = await createServiceInstance();
    expect(service.SUGGESTION_MODEL).toBe('file_model_from_json');
  });

  it('should prioritize model-config.json over environment variables for SUGGESTION_MODEL', async () => {
    vi.stubEnv('SUGGESTION_MODEL', 'env_model_should_be_ignored');
    // Setup fs mocks specifically for THIS test's scenario
    vi.mocked(fs.existsSync).mockImplementation((p) => 
      String(p) === MOCK_CONFIG_DIR || String(p) === MOCK_MODEL_CONFIG_FILE
    );
    vi.mocked(fs.readFileSync).mockImplementation((p) => {
        if (String(p) === MOCK_MODEL_CONFIG_FILE) return JSON.stringify({ SUGGESTION_MODEL: 'file_model_override' });
        if (String(p) === MOCK_DEEPSEEK_CONFIG_FILE) return JSON.stringify({});
        return '{}'; 
    });
    const service = await createServiceInstance();
    expect(service.SUGGESTION_MODEL).toBe('file_model_override');
  });

  it('should load DEEPSEEK_API_KEY from deepseek-config.json', async () => {
    // Setup fs mocks specifically for THIS test's scenario
    vi.mocked(fs.existsSync).mockImplementation((p) => 
      String(p) === MOCK_CONFIG_DIR || String(p) === MOCK_DEEPSEEK_CONFIG_FILE
    );
    vi.mocked(fs.readFileSync).mockImplementation((p) => {
        if (String(p) === MOCK_DEEPSEEK_CONFIG_FILE) return JSON.stringify({ DEEPSEEK_API_KEY: 'deepseek_key_from_file' });
        if (String(p) === MOCK_MODEL_CONFIG_FILE) return JSON.stringify({});
        return '{}';
    });
    const service = await createServiceInstance();
    expect(service.DEEPSEEK_API_KEY).toBe('deepseek_key_from_file');
  });

  it('should derive SUMMARIZATION_MODEL from SUGGESTION_MODEL if not set', async () => {
    // Ensure SUMMARIZATION_MODEL is not in env or file for this specific test
    vi.stubEnv('SUMMARIZATION_MODEL', undefined as string | undefined); 
    vi.stubEnv('SUGGESTION_MODEL', 'test_suggestion_model');
    // fs.existsSync will default to only MOCK_CONFIG_DIR existing from beforeEach, so no model-config.json
    // fs.readFileSync will default to '{}'
    const service = await createServiceInstance();
    expect(service.SUMMARIZATION_MODEL).toBe('test_suggestion_model');
  });

  it('should load SUMMARIZATION_MODEL from environment if set', async () => {
    vi.stubEnv('SUGGESTION_MODEL', 'default_suggestion');
    vi.stubEnv('SUMMARIZATION_MODEL', 'env_summary_model');
    // fs.existsSync will default to only MOCK_CONFIG_DIR existing from beforeEach
    const service = await createServiceInstance();
    expect(service.SUMMARIZATION_MODEL).toBe('env_summary_model');
  });

  it('should persist model configuration when setSuggestionModel is called', async () => {
    // Ensure env vars for derived models are clear for this specific test
    vi.stubEnv('SUMMARIZATION_MODEL', undefined as string | undefined); 
    vi.stubEnv('REFINEMENT_MODEL', undefined as string | undefined); 
    // Also clear any potential top-level model env vars that might interfere with defaults
    vi.stubEnv('SUGGESTION_MODEL', undefined as string | undefined); 
    vi.stubEnv('SUGGESTION_PROVIDER', undefined as string | undefined); 
    vi.stubEnv('EMBEDDING_PROVIDER', undefined as string | undefined); 
    vi.stubEnv('OPENAI_API_KEY', undefined as string | undefined); 
    vi.stubEnv('GEMINI_API_KEY', undefined as string | undefined); 
    vi.stubEnv('CLAUDE_API_KEY', undefined as string | undefined); 


    // Setup fs mocks: .codecompass dir exists, but model-config.json does not yet.
    vi.mocked(fs.existsSync).mockImplementation((p) => p === MOCK_CONFIG_DIR); // Only .codecompass dir exists
    vi.mocked(fs.readFileSync).mockImplementation(() => '{}'); // model-config.json would be empty if read

    const service = await createServiceInstance(); // Initializes with defaults
    
    // Capture default/initial state that will be part of the persisted object
    // These are the values that ConfigService._persistModelConfiguration will read from the service instance
    const initialSuggestionProvider = service.SUGGESTION_PROVIDER; 
    const initialEmbeddingProvider = service.EMBEDDING_PROVIDER;   
    const initialOpenAiApiKey = service.OPENAI_API_KEY;         
    const initialGeminiApiKey = service.GEMINI_API_KEY;         
    const initialClaudeApiKey = service.CLAUDE_API_KEY;         
    // HTTP_PORT is no longer part of the persisted model config
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
    // Specific fs setup for this test
    vi.mocked(fs.existsSync).mockImplementation((p) => p === MOCK_CONFIG_DIR); // Only .codecompass dir exists
    vi.mocked(fs.readFileSync).mockImplementation(() => '{}'); // No pre-existing deepseek config

    const service = await createServiceInstance();
    const newApiKey = 'new_deepseek_key';
    // Capture the DEEPSEEK_API_URL that the service instance has *before* calling setDeepSeekApiKey,
    // as this is what _persistDeepSeekConfiguration will use.
    const _expectedApiUrl = service.DEEPSEEK_API_URL; 

    service.setDeepSeekApiKey(newApiKey);

    expect(vi.mocked(fs.writeFileSync)).toHaveBeenCalledTimes(1);
    const writtenArgs = vi.mocked(fs.writeFileSync).mock.calls[0];
    expect(writtenArgs[0]).toBe(MOCK_DEEPSEEK_CONFIG_FILE);
    
    const writtenData = JSON.parse(writtenArgs[1] as string) as Record<string, unknown>;
    expect(writtenData).toHaveProperty('DEEPSEEK_API_KEY', newApiKey);
    expect(writtenData).toHaveProperty('DEEPSEEK_API_URL', service.DEEPSEEK_API_URL); // Use the getter
    expect(writtenData).toHaveProperty('timestamp');
    // Ensure timestamp is a recent ISO string (optional, but good check)
    // This check can be flaky due to timing, consider removing or making tolerance larger if it causes issues
    // expect(new Date().getTime() - new Date(writtenData.timestamp).getTime()).toBeLessThan(5000); 
  });

  it('should handle malformed model-config.json gracefully', async () => {
    // Ensure SUGGESTION_MODEL is not set in env for this specific test
    vi.stubEnv('SUGGESTION_MODEL', undefined as string | undefined); 
    // Specific fs setup for this test
    vi.mocked(fs.existsSync).mockImplementation((p) => 
      String(p) === MOCK_CONFIG_DIR || String(p) === MOCK_MODEL_CONFIG_FILE // model-config.json "exists"
    );
    vi.mocked(fs.readFileSync).mockImplementation((p) => {
        if (String(p) === MOCK_MODEL_CONFIG_FILE) return '{"SUGGESTION_MODEL": MALFORMED'; // Malformed JSON
        if (String(p) === MOCK_DEEPSEEK_CONFIG_FILE) return JSON.stringify({});
        return '{}';
    });

    const _service = await createServiceInstance(); // Creates a new instance
    
    const _winstonMockedModule = await import('winston');
    // Ensure we get the logger instance associated with *this* service instance
    // Retrieve the logger instance associated with *this* service instance
    // This should be the instance returned by the mocked createLogger
    const loggerInstance = _service.logger; // Access the logger from the service instance itself

    expect(loggerInstance.warn).toHaveBeenCalledWith(expect.stringContaining('Failed to load model config'));
    expect(_service.SUGGESTION_MODEL).toBe('llama3.1:8b'); // Should fall back to default
  });

  it('should correctly set global state variables via initializeGlobalState', async () => {
    // Set env vars specifically for this test BEFORE instance creation
    vi.stubEnv('SUGGESTION_PROVIDER', 'test_provider_global');
    vi.stubEnv('SUGGESTION_MODEL', 'test_model_global');
    // Ensure other potentially interfering env vars are clear if necessary
    vi.stubEnv('OLLAMA_HOST', undefined as string | undefined); // Example, if it affects global state indirectly

    const _service_global_state = await createServiceInstance();
    // initializeGlobalState is called in constructor
    expect(global.CURRENT_SUGGESTION_PROVIDER).toBe('test_provider_global');
    expect(global.CURRENT_SUGGESTION_MODEL).toBe('test_model_global');
  });

  it('reloadConfigsFromFile should re-read environment and file configs', async () => {
    // Initial setup: no env var, no file for SUGGESTION_MODEL
    vi.stubEnv('SUGGESTION_MODEL', undefined as string | undefined); 
    vi.mocked(fs.existsSync).mockImplementation((p) => String(p) === MOCK_CONFIG_DIR); // Only .codecompass dir
    vi.mocked(fs.readFileSync).mockReturnValue('{}'); // No config files initially

    const service_reload = await createServiceInstance();
    expect(service_reload.SUGGESTION_MODEL).toBe('llama3.1:8b'); // Initial default

    // NOW, change env and file mocks for the reload
    vi.stubEnv('SUGGESTION_MODEL', 'env_reloaded_model_should_be_overridden_by_file');
    vi.mocked(fs.existsSync).mockImplementation((p) => 
      String(p) === MOCK_CONFIG_DIR || String(p) === MOCK_MODEL_CONFIG_FILE // model-config.json now "exists"
    );
    vi.mocked(fs.readFileSync).mockImplementation((p) => {
      if (String(p) === MOCK_MODEL_CONFIG_FILE) return JSON.stringify({ SUGGESTION_MODEL: 'file_reloaded_model' });
      if (String(p) === MOCK_DEEPSEEK_CONFIG_FILE) return JSON.stringify({});
      return '{}';
    });

    service_reload.reloadConfigsFromFile();
    
    expect(service_reload.SUGGESTION_MODEL).toBe('file_reloaded_model'); // File should take precedence
    expect(global.CURRENT_SUGGESTION_MODEL).toBe('file_reloaded_model'); // Global state should also update
  });

  // Test getters for all new config values (AGENT_DEFAULT_MAX_STEPS, etc.)
  // Example for AGENT_DEFAULT_MAX_STEPS
  it('AGENT_DEFAULT_MAX_STEPS getter should return correct value from env or default', async () => {
    const serviceDefault = await createServiceInstance();
    expect(serviceDefault.AGENT_DEFAULT_MAX_STEPS).toBe(serviceDefault.DEFAULT_AGENT_DEFAULT_MAX_STEPS);

    vi.stubEnv('AGENT_DEFAULT_MAX_STEPS', '5');
    const serviceEnv = await createServiceInstance();
    expect(serviceEnv.AGENT_DEFAULT_MAX_STEPS).toBe(5);
  });

  // Test log directory creation fallback
  it('should fallback to local logs directory if user-specific one fails', async () => {
    const _consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    // Specific fs setup for this test
    vi.mocked(fs.existsSync).mockReset().mockImplementation((p) => {
        const pathStr = String(p);
        if (pathStr === MOCK_CONFIG_DIR) return true; // .codecompass exists
        // MOCK_LOG_DIR and fallback log dir do not exist initially for this test's purpose
        if (pathStr === MOCK_LOG_DIR) return false; 
        if (pathStr === path.join(process.cwd(), 'logs')) return false;
        return false; 
    });

    // Specific mock for mkdirSync for this test
    vi.mocked(fs.mkdirSync).mockReset().mockImplementation((pathToMkdir) => {
      if (String(pathToMkdir) === MOCK_LOG_DIR) { 
        throw new Error('Permission denied for user log dir'); 
      }
      return undefined;
    });

    const service = await createServiceInstance(); // This will trigger logger setup and dir creation attempts
    
    expect(service.LOG_DIR).toBe(path.join(process.cwd(), 'logs')); // Check it fell back
    
    // The SUT calls service.logger.error, not console.error directly in this path.
    // The _consoleErrorSpy was for a different potential logging path, or can be removed if not needed.
    // _consoleErrorSpy.mockRestore(); // Restore if it was spied on for other reasons in this test.

    // Check that the service's logger was called with the expected error message.
    // The logger instance on `service` is the MOCK_LOGGER_INSTANCE.
    expect(service.logger.error).toHaveBeenCalledWith(
      expect.stringContaining('Failed to create user-specific log directory: Permission denied for user log dir. Falling back to local logs dir.')
    );
    // Check that mkdirSync was called for the fallback directory
    expect(vi.mocked(fs.mkdirSync)).toHaveBeenCalledWith(path.join(process.cwd(), 'logs'), { recursive: true });
    // consoleErrorSpy.mockRestore(); // This line was commented out, ensure it's removed or handled.
  });

});
