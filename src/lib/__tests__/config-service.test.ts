import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'fs'; // Use actual fs for mocking its methods
import path from 'path';
import winston from 'winston';

// Import the class directly for testing.
import { ConfigService as ActualConfigService } from '../config-service';
// import fsActual from 'fs'; // Not strictly needed if we define the mock structure directly

// Define a clearable mock logger instance for Winston that can be controlled in tests
const clearableMockWinstonLogger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
  // Add other logger methods if used by ConfigService directly
};

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
vi.mock('winston', async (importOriginal) => {
  const originalWinston = await importOriginal<typeof winston>();
  return {
    ...originalWinston,
    createLogger: vi.fn().mockReturnValue(clearableMockWinstonLogger), // Use the clearable instance
    transports: {
      File: vi.fn().mockImplementation(() => ({ // Mock the File transport constructor
        // Mock any methods on the transport instance if ConfigService calls them
        on: vi.fn(),
        log: vi.fn(),
      })),
      Stream: vi.fn().mockImplementation(() => ({ // Mock Stream transport too
        on: vi.fn(),
        log: vi.fn(),
      })),
    },
    format: originalWinston.format, // Keep original format or mock if needed
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
    // Reset modules to ensure a fresh instance and re-evaluation of process.env
    vi.resetModules();

    // Re-import fs and get the mock after resetModules
    const fsMockModule = await import('fs');
    const fsMock = fsMockModule.default;

    // Basic fs mocks needed by ConfigService directly (not for Winston's internals)
    vi.mocked(fsMock.existsSync).mockImplementation((pathArg) => {
      if (pathArg === MOCK_MODEL_CONFIG_FILE || pathArg === MOCK_DEEPSEEK_CONFIG_FILE) {
        // Let specific tests control if config files exist by re-mocking readFileSync
        return !!vi.mocked(fsMock.readFileSync).getMockImplementation()?.(pathArg as string, 'utf8');
      }
      if (pathArg === MOCK_CONFIG_DIR) return true; // Assume .codecompass dir "exists" for writes
      // For LOG_DIR, Winston's File transport is now mocked, so it won't try to create it.
      // ConfigService itself might still try to create LOG_DIR.
      if (pathArg === MOCK_LOG_DIR) return false; // ConfigService will try to create it
      return false;
    });

    vi.mocked(fsMock.mkdirSync).mockImplementation((pathArg) => {
      // This mock is for ConfigService's own attempts to create LOG_DIR or CONFIG_DIR
      if (pathArg === MOCK_LOG_DIR || pathArg === MOCK_CONFIG_DIR) {
        // Simulate successful creation
        vi.mocked(fsMock.existsSync).mockImplementation((p) => p === pathArg || p === MOCK_CONFIG_DIR);
        return undefined;
      }
      // Fallback for process.cwd() + 'logs'
      if (pathArg === path.join(process.cwd(), 'logs')) {
         vi.mocked(fsMock.existsSync).mockImplementation((p) => p === pathArg || p === MOCK_CONFIG_DIR);
        return undefined;
      }
      // console.warn(`[createServiceInstance] fsMock.mkdirSync called with unhandled path: ${pathArg}`);
      return undefined;
    });
    vi.mocked(fsMock.readFileSync).mockReturnValue('{}'); // Default for config files

    // Winston is already mocked at the top level.
    // When ConfigService is imported, it will use the mocked createLogger and transports.

    const { ConfigService: FreshConfigService } = await import('../config-service');
    return new FreshConfigService() as ActualConfigService;
  };

  beforeEach(async () => {
    originalEnv = { ...process.env }; // Backup original process.env
    process.env.HOME = MOCK_HOME_DIR; // Mock HOME directory

    // fs is already mocked at the top level. Get the mocked instance.
    const fsMock = fs; // fs here refers to the default export of the mocked 'fs' module.

    // Reset fs mocks before each test
    vi.mocked(fsMock.existsSync).mockReset();
    vi.mocked(fsMock.readFileSync).mockReset();
    vi.mocked(fsMock.writeFileSync).mockReset();
    vi.mocked(fsMock.mkdirSync).mockReset();
    
    // Default behavior for fs mocks in beforeEach
    vi.mocked(fsMock.existsSync).mockReturnValue(false); // Default to not existing
    vi.mocked(fsMock.mkdirSync).mockImplementation((p) => {
        // Simulate success for expected paths
        if (p === MOCK_CONFIG_DIR || p === MOCK_LOG_DIR || p === path.join(process.cwd(), 'logs')) {
            return undefined;
        }
        // console.warn(`[beforeEach] fsMock.mkdirSync called with unhandled path: ${p}`);
        return undefined;
    });
    vi.mocked(fsMock.readFileSync).mockReturnValue('{}');

    // Reset winston transport mocks if necessary
    vi.mocked(winston.transports.File).mockClear();
    vi.mocked(winston.transports.Stream).mockClear();
    // Clear the createLogger mock itself and ensure it returns the clearableMockWinstonLogger
    vi.mocked(winston.createLogger).mockClear().mockReturnValue(clearableMockWinstonLogger);
    // Clear methods of the clearableMockWinstonLogger
    Object.values(clearableMockWinstonLogger).forEach(mockFn => mockFn.mockClear());

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
    vi.mocked(fs.existsSync).mockImplementation((p) => p === MOCK_MODEL_CONFIG_FILE);
    vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify({ SUGGESTION_MODEL: 'file_model_from_json' }));
    const service = await createServiceInstance();
    expect(service.SUGGESTION_MODEL).toBe('file_model_from_json');
  });

  it('should prioritize model-config.json over environment variables for SUGGESTION_MODEL', async () => {
    process.env.SUGGESTION_MODEL = 'env_model';
    vi.mocked(fs.existsSync).mockImplementation((p) => p === MOCK_MODEL_CONFIG_FILE);
    vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify({ SUGGESTION_MODEL: 'file_model_override' }));
    const service = await createServiceInstance();
    expect(service.SUGGESTION_MODEL).toBe('file_model_override');
  });

  it('should load DEEPSEEK_API_KEY from deepseek-config.json', async () => {
    vi.mocked(fs.existsSync).mockImplementation((p) => p === MOCK_DEEPSEEK_CONFIG_FILE);
    vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify({ DEEPSEEK_API_KEY: 'deepseek_key_from_file' }));
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
    const service = await createServiceInstance();
    service.setSuggestionModel('new_persisted_model');
    expect(vi.mocked(fs.writeFileSync)).toHaveBeenCalledWith(
      MOCK_MODEL_CONFIG_FILE,
      expect.stringContaining('"SUGGESTION_MODEL":"new_persisted_model"')
    );
  });
  
  it('should persist DeepSeek API key when setDeepSeekApiKey is called', async () => {
    const service = await createServiceInstance();
    service.setDeepSeekApiKey('new_deepseek_key');
    expect(vi.mocked(fs.writeFileSync)).toHaveBeenCalledWith(
      MOCK_DEEPSEEK_CONFIG_FILE,
      expect.stringContaining('"DEEPSEEK_API_KEY":"new_deepseek_key"')
    );
  });

  it('should handle malformed model-config.json gracefully', async () => {
    vi.mocked(fs.existsSync).mockImplementation((p) => p === MOCK_MODEL_CONFIG_FILE);
    vi.mocked(fs.readFileSync).mockReturnValue('{"SUGGESTION_MODEL": "bad_json_no_closing_brace'); // Malformed
    const service = await createServiceInstance();
    expect(service.logger.warn).toHaveBeenCalledWith(expect.stringContaining('Failed to load model config'));
    expect(service.SUGGESTION_MODEL).toBe('llama3.1:8b'); // Falls back to default
  });

  it('should correctly set global state variables via initializeGlobalState', async () => {
    process.env.SUGGESTION_PROVIDER = 'test_provider_global';
    process.env.SUGGESTION_MODEL = 'test_model_global';
    const service = await createServiceInstance(); // Constructor calls initializeGlobalState
    
    // Access global directly for verification (this is what the code does)
    expect(global.CURRENT_SUGGESTION_PROVIDER).toBe('test_provider_global');
    expect(global.CURRENT_SUGGESTION_MODEL).toBe('test_model_global');
  });

  it('reloadConfigsFromFile should re-read environment and file configs', async () => {
    const service = await createServiceInstance();
    // Initial state
    expect(service.SUGGESTION_MODEL).toBe('llama3.1:8b');

    // Simulate change in env and file
    process.env.SUGGESTION_MODEL = 'env_reloaded_model';
    vi.mocked(fs.existsSync).mockImplementation((p) => p === MOCK_MODEL_CONFIG_FILE);
    vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify({ SUGGESTION_MODEL: 'file_reloaded_model' }));
    
    service.reloadConfigsFromFile();
    
    expect(service.SUGGESTION_MODEL).toBe('file_reloaded_model'); // File should override env
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
    vi.mocked(fs.existsSync).mockImplementation((p) => p === MOCK_LOG_DIR); // Simulate log dir exists check
    vi.mocked(fs.mkdirSync).mockImplementation((p) => {
      if (p === MOCK_LOG_DIR) {
        throw new Error('Permission denied'); // Simulate failure for user-specific dir
      }
      return undefined;
    });
    const service = await createServiceInstance();
    // Check if logger.warn was called about fallback (difficult without direct access to logger instance used by constructor)
    // Check if the final LOG_DIR is the fallback path
    expect(service.LOG_DIR).toBe(path.join(process.cwd(), 'logs'));
    expect(vi.mocked(fs.mkdirSync)).toHaveBeenCalledWith(path.join(process.cwd(), 'logs'), { recursive: true });
  });

});
