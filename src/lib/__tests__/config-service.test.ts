import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'fs'; // Use actual fs for mocking its methods
import path from 'path';
import winston from 'winston';

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

// Mock winston logger creation
vi.mock('winston', async (importOriginal) => {
  const originalWinston = await importOriginal<typeof winston>();
  return {
    ...originalWinston,
    createLogger: vi.fn().mockReturnValue({
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
      // Add other logger methods if used by ConfigService directly
    }),
    transports: { // Mock transports as well if ConfigService interacts with them directly
        File: vi.fn(),
        Stream: vi.fn(),
    },
    format: { // Mock format if needed
        combine: vi.fn(),
        timestamp: vi.fn(),
        json: vi.fn(),
        simple: vi.fn(),
    }
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

    // After vi.resetModules(), fs is unmocked. We need to re-apply the mock behavior
    // for the new ConfigService instance. The top-level vi.mock('fs', factory)
    // defines the structure. Here, we ensure the functions within that structure are set up.
    const fsMockModule = await import('fs'); 
    const fsMock = fsMockModule.default; // Access the default export which holds the mock functions

    // This mock setup is critical for Winston's File transport initialization.
    // When `new winston.transports.File({ filename: path.join(this.LOG_DIR, "codecompass.log") })` is called:
    // 1. Winston checks if this.LOG_DIR exists.
    // 2. If not, it tries to create it using mkdirSync with { recursive: true }.
    vi.mocked(fsMock.existsSync).mockImplementation((pathArg) => {
      // console.log(`[createServiceInstance] fsMock.existsSync called with: ${pathArg}`);
      if (pathArg === MOCK_CONFIG_DIR) return true; // Assume .codecompass dir exists
      if (pathArg === MOCK_LOG_DIR) return false;  // Log dir does not exist, Winston will try to create it
      return false; // Default for other paths
    });

    vi.mocked(fsMock.mkdirSync).mockImplementation((pathArg, options) => {
      // console.log(`[createServiceInstance] fsMock.mkdirSync called with: ${pathArg}, options: ${JSON.stringify(options)}`);
      // This must successfully "create" MOCK_LOG_DIR when Winston calls it.
      if (pathArg === MOCK_LOG_DIR) {
        // Simulate successful creation of the log directory
        // To make it more robust, we can also update our existsSync mock to reflect this "creation"
        // for subsequent calls within the same ConfigService instantiation, though Winston might not re-check.
        vi.mocked(fsMock.existsSync).mockImplementation((p) => {
            if (p === MOCK_CONFIG_DIR) return true;
            if (p === MOCK_LOG_DIR) return true; // Now it "exists"
            return false;
        });
        return undefined; 
      }
      // Handle creation of MOCK_CONFIG_DIR if it's part of a recursive call, though less likely to be the direct issue here.
      if (pathArg === MOCK_CONFIG_DIR && options && (options as { recursive?: boolean }).recursive) {
        return undefined;
      }
      // If any other path is attempted, it might indicate an unexpected call.
      // For the ENOENT error, the primary concern is MOCK_LOG_DIR.
      // console.warn(`[createServiceInstance] fsMock.mkdirSync called with unhandled path: ${pathArg}`);
      // To prevent unexpected errors, simulate success for other paths too, or make it stricter.
      return undefined;
    });

    vi.mocked(fsMock.readFileSync).mockReturnValue('{}'); // Default for config files

    // Re-mock winston for the new ConfigService instance
    vi.mock('winston', async (importOriginal) => {
      const originalWinston = await importOriginal<typeof winston>();
      return {
        ...originalWinston,
        createLogger: vi.fn().mockReturnValue({
          info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(),
        }),
        transports: { File: vi.fn(), Stream: vi.fn() },
        format: { combine: vi.fn(), timestamp: vi.fn(), json: vi.fn(), simple: vi.fn() }
      };
    });
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
    
    // Default behavior for existsSync and mkdirSync for each test
    // This setup is for the general test case, createServiceInstance will override for its specific needs.
    vi.mocked(fsMock.existsSync).mockImplementation((pathArg) => {
        // console.log(`[beforeEach] fsMock.existsSync called with: ${pathArg}`);
        if (pathArg === MOCK_CONFIG_DIR) return true;
        if (pathArg === MOCK_LOG_DIR) return false; 
        return false;
    });
     vi.mocked(fsMock.mkdirSync).mockImplementation((pathArg, options) => {
      // console.log(`[beforeEach] fsMock.mkdirSync called with: ${pathArg}, options: ${JSON.stringify(options)}`);
      if (pathArg === MOCK_LOG_DIR || pathArg === MOCK_CONFIG_DIR || (typeof pathArg === 'string' && pathArg.startsWith(MOCK_CONFIG_DIR))) {
        return undefined; 
      }
      return undefined; 
    });
    vi.mocked(fsMock.readFileSync).mockReturnValue('{}'); // Default for config files
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
