import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { configService } from '../lib/config-service';

import * as fs from 'fs'; // Import fs for mocking

describe('Config Module', () => {
  // Save original environment variables
  const originalEnv = { ...process.env };
  
  beforeEach(() => {
    // Restore process.env to original state before each test
    process.env = { ...originalEnv };

    // Ensure OLLAMA_HOST and QDRANT_HOST are unset so ConfigService uses its internal defaults
    // for tests relying on those defaults (e.g., "Default Configuration" tests).
    // Tests that specifically override these variables will set them after this block.
    delete process.env.OLLAMA_HOST;
    delete process.env.QDRANT_HOST;
    
    // Explicitly reset global variables that ConfigService might use/set
    // These globals are set by ConfigService.initializeGlobalState()
    // Resetting them ensures a clean slate for each test's ConfigService instantiation.
    const g = global as any;
    g.CURRENT_LLM_PROVIDER = undefined;
    g.CURRENT_SUGGESTION_PROVIDER = undefined;
    g.CURRENT_EMBEDDING_PROVIDER = undefined;
    g.CURRENT_SUGGESTION_MODEL = undefined;
    
    vi.resetModules(); // This is key for re-importing and re-instantiating ConfigService
  });
  
  afterEach(() => {
    // Restore original environment variables fully after each test
    process.env = { ...originalEnv };
    vi.restoreAllMocks(); 
    vi.resetModules(); 
  });

  describe('Default Configuration', () => {
    it('should have default values for all required configuration', () => {
      expect(configService.OLLAMA_HOST).toBeDefined();
      expect(configService.QDRANT_HOST).toBeDefined();
      expect(configService.COLLECTION_NAME).toBeDefined();
      expect(configService.EMBEDDING_MODEL).toBeDefined();
      expect(configService.SUGGESTION_MODEL).toBeDefined();
      expect(configService.MAX_RETRIES).toBeGreaterThan(0);
      expect(configService.RETRY_DELAY).toBeGreaterThan(0);
      expect(configService.MAX_INPUT_LENGTH).toBeGreaterThan(0);
    });
  
    it('should have valid URL formats for host configurations', () => {
      const urlPattern = /^https?:\/\/.+/;
      expect(configService.OLLAMA_HOST).toMatch(urlPattern);
      expect(configService.QDRANT_HOST).toMatch(urlPattern);
    });
  
    it('should have reasonable limits for MAX_INPUT_LENGTH', () => {
      expect(configService.MAX_INPUT_LENGTH).toBeGreaterThan(100);
      expect(configService.MAX_INPUT_LENGTH).toBeLessThan(100000); // Assuming there's some reasonable upper limit
    });
  
    it('should have reasonable values for retry configuration', () => {
      expect(configService.MAX_RETRIES).toBeGreaterThanOrEqual(1);
      expect(configService.MAX_RETRIES).toBeLessThanOrEqual(10); // Assuming there's some reasonable upper limit
      expect(configService.RETRY_DELAY).toBeGreaterThanOrEqual(100); // At least 100ms
      expect(configService.RETRY_DELAY).toBeLessThanOrEqual(30000); // Not more than 30 seconds
    });
  });

  describe('Logger Configuration', () => {
    it('should have a properly configured logger', () => {
      expect(configService.logger).toBeDefined();
      expect(typeof configService.logger.info).toBe('function');
      expect(typeof configService.logger.error).toBe('function');
      expect(typeof configService.logger.warn).toBe('function');
      expect(typeof configService.logger.debug).toBe('function');
    });
  
    it('should be able to log messages without throwing errors', () => {
      // Mock console methods to prevent actual logging during tests
      const originalInfo = console.info;
      const originalError = console.error;
      const originalWarn = console.warn;
      const originalDebug = console.debug;
      
      console.info = vi.fn();
      console.error = vi.fn();
      console.warn = vi.fn();
      console.debug = vi.fn();
      
      expect(() => configService.logger.info('Test info message')).not.toThrow();
      expect(() => configService.logger.error('Test error message')).not.toThrow();
      expect(() => configService.logger.warn('Test warning message')).not.toThrow();
      expect(() => configService.logger.debug('Test debug message')).not.toThrow();
      
      // Restore console methods
      console.info = originalInfo;
      console.error = originalError;
      console.warn = originalWarn;
      console.debug = originalDebug;
    });
  });

  describe('Environment Variable Overrides', () => {
    beforeEach(() => {
      // Mock 'fs' specifically for this suite.
      // This ensures that ConfigService does not load from actual config files during these tests.
      vi.doMock('fs', async () => {
        const actualFs = await vi.importActual('fs') as typeof fs; // Import actual fs to delegate calls
        return {
          ...actualFs, // Delegate all other fs calls to the actual module
          existsSync: vi.fn((pathToCheck: string) => {
            // Simulate config files not existing
            if (typeof pathToCheck === 'string' && (pathToCheck.endsWith('model-config.json') || pathToCheck.endsWith('deepseek-config.json'))) {
              return false;
            }
            // For other paths (like LOG_DIR check), use actual existsSync
            return actualFs.existsSync(pathToCheck);
          }),
          readFileSync: vi.fn((pathToCheck: string, options: any) => {
            // This should ideally not be called for config files if existsSync is false
            if (typeof pathToCheck === 'string' && (pathToCheck.endsWith('model-config.json') || pathToCheck.endsWith('deepseek-config.json'))) {
              const e = new Error(`ENOENT: no such file or directory, open '${pathToCheck}' (mocked)`);
              (e as any).code = 'ENOENT';
              throw e;
            }
            return actualFs.readFileSync(pathToCheck, options);
          }),
          // Let mkdirSync pass through for LOG_DIR creation by ConfigService constructor
          // If this causes issues in a restricted test environment, mock it as vi.fn()
          mkdirSync: actualFs.mkdirSync,
        };
      });
    });

    afterEach(() => {
      vi.doUnmock('fs'); // Clean up the 'fs' mock after this suite
    });

    it('should respect OLLAMA_HOST environment variable if set', async () => {
      const testUrl = 'http://test-ollama-host:11434';
      process.env.OLLAMA_HOST = testUrl;
      
      vi.resetModules(); // Ensure configService is re-initialized
      const mod = await import('../lib/config-service');
      const freshConfigService = mod.configService;
      // reloadConfigsFromFile is implicitly called by constructor if resetModules works as expected
      // or call it explicitly if needed after re-import
      freshConfigService.reloadConfigsFromFile(true); 
      expect(freshConfigService.OLLAMA_HOST).toBe(testUrl);
    });
    
    it('should respect QDRANT_HOST environment variable if set', async () => {
      const testUrl = 'http://test-qdrant-host:6333';
      process.env.QDRANT_HOST = testUrl;
      
      vi.resetModules();
      const mod = await import('../lib/config-service');
      const freshConfigService = mod.configService;
      freshConfigService.reloadConfigsFromFile(true);
      expect(freshConfigService.QDRANT_HOST).toBe(testUrl);
    });
    
    it('should respect custom model configurations if set via environment variables', async () => {
      const testModel = 'test-model-from-env';
      const testProvider = 'ollama';

      // Set environment variables *before* any potential module import or reset
      process.env.EMBEDDING_MODEL = testModel;
      process.env.SUGGESTION_MODEL = testModel;
      process.env.SUGGESTION_PROVIDER = testProvider;
      
      // Ensure a completely fresh import of config-service after env vars are set
      vi.resetModules(); 
      const { configService: freshConfigService } = await import('../lib/config-service');
      
      // The ConfigService constructor should have picked up these env vars.
      // reloadConfigsFromFile(true) is called by the constructor.
      // If we call it again, it re-initializes from env vars then attempts file load.
      // This should be redundant if vi.resetModules() + import works as expected.
      // However, to be absolutely sure it re-evaluates with current process.env:
      freshConfigService.reloadConfigsFromFile(true);

      expect(freshConfigService.EMBEDDING_MODEL).toBe(testModel);
      expect(freshConfigService.SUGGESTION_MODEL).toBe(testModel);
      expect(freshConfigService.SUGGESTION_PROVIDER).toBe(testProvider);
    });
  });
});
