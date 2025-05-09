import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { configService } from '../lib/config-service';

import * as fs from 'fs'; // Import fs for mocking

describe('Config Module', () => {
  // Save original environment variables
  const originalEnv = { ...process.env };
  
  beforeEach(() => {
    // Clear any mocked environment variables between tests
    vi.resetModules(); // This is important for re-importing config-service
    // Restore process.env to original state before each test in this suite
    process.env = { ...originalEnv };
  });
  
  afterEach(() => {
    // Restore original environment variables fully after each test
    process.env = { ...originalEnv };
    vi.restoreAllMocks(); // Restore any mocks like fs
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
      // Mock fs to prevent loading from actual config files
      vi.spyOn(fs, 'existsSync').mockReturnValue(false);
      // If readFileSync is still called (e.g. for LOG_DIR check), ensure it doesn't throw for config files
      vi.spyOn(fs, 'readFileSync').mockImplementation((path) => {
        if (typeof path === 'string' && (path.endsWith('model-config.json') || path.endsWith('deepseek-config.json'))) {
          throw new Error('File not found mock');
        }
        // For other paths (like LOG_DIR check if it uses readFileSync, though it uses mkdirSync),
        // we might need to return specific values or call original.
        // For now, this should prevent config file loading.
        return ''; // Default empty return
      });
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
      const testProvider = 'ollama'; // 'test-model-from-env' implies ollama unless 'deepseek' is in name

      process.env.EMBEDDING_MODEL = testModel; // This should be picked up
      process.env.SUGGESTION_MODEL = testModel; // This should be picked up
      // SUGGESTION_PROVIDER will be derived if not set, or can be set explicitly
      process.env.SUGGESTION_PROVIDER = testProvider;
      
      vi.resetModules(); // This is key to re-evaluate the module with new env vars
      const mod = await import('../lib/config-service');
      const freshConfigService = mod.configService;
      // The constructor of ConfigService already calls loadConfigurationsFromFile and initializes globals.
      // reloadConfigsFromFile(true) ensures it re-reads env vars and then files (which are mocked not to exist).
      freshConfigService.reloadConfigsFromFile(true); 

      expect(freshConfigService.EMBEDDING_MODEL).toBe(testModel);
      expect(freshConfigService.SUGGESTION_MODEL).toBe(testModel);
      expect(freshConfigService.SUGGESTION_PROVIDER).toBe(testProvider);
    });
  });
});
