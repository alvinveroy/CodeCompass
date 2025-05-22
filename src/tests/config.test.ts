import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { ConfigService as ConfigServiceType } from '../lib/config-service'; // Import the type

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
    const g = globalThis as NodeJS.Global & typeof globalThis & { [key: string]: unknown };
    g.CURRENT_LLM_PROVIDER = undefined; // Assign undefined directly
    g.CURRENT_SUGGESTION_PROVIDER = undefined; // Assign undefined directly
    g.CURRENT_EMBEDDING_PROVIDER = undefined; // Assign undefined directly
    g.CURRENT_SUGGESTION_MODEL = undefined; // Assign undefined directly
    
    vi.resetModules(); // This is key for re-importing and re-instantiating ConfigService
  });
  
  afterEach(() => {
    // Restore original environment variables fully after each test
    process.env = { ...originalEnv };
    vi.restoreAllMocks(); 
    vi.resetModules(); 
  });

  describe('Default Configuration', () => {
    let currentConfigService: ConfigServiceType; // Use the imported type

    beforeEach(async () => {
      // Dynamically import configService to ensure a fresh instance for each test
      // after vi.resetModules() in the outer beforeEach has run,
      // and after OLLAMA_HOST/QDRANT_HOST env vars have been deleted.
      const mod = await import('../lib/config-service.js');
      currentConfigService = mod.configService;
    });

    it('should have default values for all required configuration', () => {
      expect(currentConfigService.OLLAMA_HOST).toBeDefined();
      expect(currentConfigService.QDRANT_HOST).toBeDefined();
      expect(currentConfigService.COLLECTION_NAME).toBeDefined();
      expect(currentConfigService.EMBEDDING_MODEL).toBeDefined();
      expect(currentConfigService.SUGGESTION_MODEL).toBeDefined();
      expect(currentConfigService.MAX_RETRIES).toBeGreaterThan(0);
      expect(currentConfigService.RETRY_DELAY).toBeGreaterThan(0);
      expect(currentConfigService.MAX_INPUT_LENGTH).toBeGreaterThan(0);
    });
  
    it('should have valid URL formats for host configurations', () => {
      const urlPattern = /^https?:\/\/.+/;
      expect(currentConfigService.OLLAMA_HOST).toMatch(urlPattern);
      expect(currentConfigService.QDRANT_HOST).toMatch(urlPattern);
    });
  
    it('should have reasonable limits for MAX_INPUT_LENGTH', () => {
      expect(currentConfigService.MAX_INPUT_LENGTH).toBeGreaterThan(100);
      expect(currentConfigService.MAX_INPUT_LENGTH).toBeLessThan(100000); // Assuming there's some reasonable upper limit
    });
  
    it('should have reasonable values for retry configuration', () => {
      expect(currentConfigService.MAX_RETRIES).toBeGreaterThanOrEqual(1);
      expect(currentConfigService.MAX_RETRIES).toBeLessThanOrEqual(10); // Assuming there's some reasonable upper limit
      expect(currentConfigService.RETRY_DELAY).toBeGreaterThanOrEqual(100); // At least 100ms
      expect(currentConfigService.RETRY_DELAY).toBeLessThanOrEqual(30000); // Not more than 30 seconds
    });
  });

  describe('Logger Configuration', () => {
    let currentConfigService: ConfigServiceType; // Use the imported type

    beforeEach(async () => {
      // Dynamically import for a fresh instance
      const mod = await import('../lib/config-service.js');
      currentConfigService = mod.configService;
    });

    it('should have a properly configured logger', () => {
      expect(currentConfigService.logger).toBeDefined();
      expect(typeof currentConfigService.logger.info).toBe('function');
      expect(typeof currentConfigService.logger.error).toBe('function');
      expect(typeof currentConfigService.logger.warn).toBe('function');
      expect(typeof currentConfigService.logger.debug).toBe('function');
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
      
      expect(() => currentConfigService.logger.info('Test info message')).not.toThrow();
      expect(() => currentConfigService.logger.error('Test error message')).not.toThrow();
      expect(() => currentConfigService.logger.warn('Test warning message')).not.toThrow();
      expect(() => currentConfigService.logger.debug('Test debug message')).not.toThrow();
      
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
        // Explicitly type actualFs to match the 'fs' module's structure
        const actualFs = await vi.importActual('fs'); // Use the imported fs namespace
        return {
          ...actualFs, // Delegate all other fs calls to the actual module
          existsSync: vi.fn((pathToCheck: string) => {
            // Simulate config files not existing
            if (typeof pathToCheck === 'string' && (pathToCheck.endsWith('model-config.json') || pathToCheck.endsWith('deepseek-config.json'))) {
              return false;
            }
            // For other paths (like LOG_DIR check), use actual existsSync
            return actualFs.existsSync(pathToCheck); // Now actualFs.existsSync is correctly typed
          }),
          readFileSync: vi.fn((pathToCheck: string, options?: fs.WriteFileOptions) => {
            // This should ideally not be called for config files if existsSync is false
            if (typeof pathToCheck === 'string' && (pathToCheck.endsWith('model-config.json') || pathToCheck.endsWith('deepseek-config.json'))) {
              const e = new Error(`ENOENT: no such file or directory, open '${pathToCheck}' (mocked)`);
              const errorWithCode = e as Error & { code?: string | number };
              errorWithCode.code = 'ENOENT';
              throw e; 
            }
            return actualFs.readFileSync(pathToCheck, options as fs.WriteFileOptions); // Now actualFs.readFileSync is correctly typed
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
      const mod = await import('../lib/config-service.js');
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
      const mod = await import('../lib/config-service.js');
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
      const { configService: freshConfigService } = await import('../lib/config-service.js');
      
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
