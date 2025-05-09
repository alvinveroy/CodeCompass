import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { configService } from '../lib/config-service';

describe('Config Module', () => {
  // Save original environment variables
  const originalEnv = { ...process.env };
  
  beforeEach(() => {
    // Clear any mocked environment variables between tests
    vi.resetModules();
  });
  
  afterEach(() => {
    // Restore original environment variables
    process.env = { ...originalEnv };
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
    it('should respect OLLAMA_HOST environment variable if set', () => {
      // This test assumes the config module reads from process.env
      // If it doesn't, this test would need to be adjusted or removed
      const testUrl = 'http://test-ollama-host:11434';
      process.env.OLLAMA_HOST = testUrl;
      
      // We need to re-import the module to see the environment variable effect
      vi.resetModules();
      // Use dynamic import instead of require for TypeScript modules
      return import('../lib/config-service').then(mod => {
        // config-service exports configService instance
        const freshConfigService = mod.configService;
        freshConfigService.reloadConfigsFromFile(true); // Force reload to pick up env var
        expect(freshConfigService.OLLAMA_HOST).toBe(testUrl);
      });
    });
    
    it('should respect QDRANT_HOST environment variable if set', () => {
      const testUrl = 'http://test-qdrant-host:6333';
      process.env.QDRANT_HOST = testUrl;
      
      vi.resetModules();
      return import('../lib/config-service').then(mod => {
        const freshConfigService = mod.configService;
        freshConfigService.reloadConfigsFromFile(true);
        expect(freshConfigService.QDRANT_HOST).toBe(testUrl);
      });
    });
    
    it('should respect custom model configurations if set', () => {
      const testModel = 'test-model';
      process.env.EMBEDDING_MODEL = testModel;
      process.env.SUGGESTION_MODEL = testModel;
      
      vi.resetModules();
      return import('../lib/config-service').then(mod => {
        const freshConfigService = mod.configService;
        freshConfigService.reloadConfigsFromFile(true);
        expect(freshConfigService.EMBEDDING_MODEL).toBe(testModel);
        expect(freshConfigService.SUGGESTION_MODEL).toBe(testModel);
      });
    });
  });
});
