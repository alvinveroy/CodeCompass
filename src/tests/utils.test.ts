import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { withRetry, preprocessText } from '../lib/utils';
// Import the original configService to get its actual default values for resetting
import { configService as originalConfigServiceInstance } from '../lib/config-service';

// Mock the config-service module
vi.mock('../lib/config-service', async () => {
  const originalModule = await vi.importActual('../lib/config-service') as any;
  // Create the mock values inside the factory to avoid hoisting issues
  const mockValues = {
    MAX_RETRIES: originalConfigServiceInstance.MAX_RETRIES,
    RETRY_DELAY: originalConfigServiceInstance.RETRY_DELAY,
    logger: {
      warn: vi.fn(),
      error: vi.fn(),
      info: vi.fn(),
      debug: vi.fn(),
    },
    // Include other properties/methods from original configService if they are used by the SUT
    // and don't need to be mocked, or provide simple mocks for them.
    // For example, if OLLAMA_HOST was used by withRetry, it should be here.
    OLLAMA_HOST: originalConfigServiceInstance.OLLAMA_HOST, 
    // Add any other properties that might be accessed by the SUT (utils.ts)
  };
  return {
    ...originalModule, // Spread original exports to keep non-mocked parts
    configService: mockValues, // Override configService with our mock
    logger: mockValues.logger, // Override logger export with our mock logger
  };
});

describe('Utils Module', () => {
  // This import will now get the mocked version of configService
  let mockedConfigService: typeof originalConfigServiceInstance;
  let mockedLogger: { warn: Mock; error: Mock; info: Mock; debug: Mock };

  beforeEach(async () => {
    // Dynamically import the mocked service here to get the instance used by the mock factory
    const mockedModule = await import('../lib/config-service');
    mockedConfigService = mockedModule.configService;
    mockedLogger = mockedModule.logger as any; // Cast as any to access mockClear on spies

    vi.useFakeTimers();
    // Reset the properties of the *actual mocked instance* before each test
    mockedConfigService.MAX_RETRIES = originalConfigServiceInstance.MAX_RETRIES;
    mockedConfigService.RETRY_DELAY = originalConfigServiceInstance.RETRY_DELAY;
    mockedLogger.warn.mockClear();
    mockedLogger.error.mockClear();
    mockedLogger.info.mockClear();
    mockedLogger.debug.mockClear();
  });

  afterEach(() => {
      vi.restoreAllMocks(); // This will also restore vi.spyOn(global, 'setTimeout')
      vi.useRealTimers();
    });

    it('should return the result if the function succeeds on first try', async () => {
      const fn = vi.fn().mockResolvedValue('success');
      const result = await withRetry(fn);
      
      expect(result).toBe('success');
      expect(fn).toHaveBeenCalledTimes(1);
    });

    it('should retry the function if it fails and succeed on retry', async () => {
      const fn = vi.fn()
        .mockRejectedValueOnce(new Error('fail'))
        .mockResolvedValueOnce('success');
      
      // Mock setTimeout to execute callback immediately
      vi.spyOn(global, 'setTimeout').mockImplementation((callback: () => void) => {
        callback();
        return 0 as unknown as NodeJS.Timeout;
      });
      
      const result = await withRetry(fn, 2);
      
      expect(result).toBe('success');
      expect(fn).toHaveBeenCalledTimes(2);
    });

    it('should retry multiple times before succeeding', async () => {
      const fn = vi.fn()
        .mockRejectedValueOnce(new Error('fail 1'))
        .mockRejectedValueOnce(new Error('fail 2'))
        .mockRejectedValueOnce(new Error('fail 3'))
        .mockResolvedValueOnce('success');
      
      // Mock setTimeout to execute callback immediately
      vi.spyOn(global, 'setTimeout').mockImplementation((callback: () => void) => {
        callback();
        return 0 as unknown as NodeJS.Timeout;
      });
      
      const result = await withRetry(fn, 4);
      
      expect(result).toBe('success');
      expect(fn).toHaveBeenCalledTimes(4);
    });

    it('should throw an error if all retries fail', async () => {
      const error = new Error('persistent failure');
      const fn = vi.fn().mockRejectedValue(error);
      
      // Mock setTimeout to execute callback immediately
      vi.spyOn(global, 'setTimeout').mockImplementation((callback: () => void) => {
        callback();
        return 0 as unknown as NodeJS.Timeout;
      });
      
      await expect(withRetry(fn, 3)).rejects.toThrow('persistent failure');
      expect(fn).toHaveBeenCalledTimes(3);
    });

    it('should respect the configured MAX_RETRIES when no retry count is provided', async () => {
      // Modify the properties of the *mocked* configService instance
      mockedConfigService.MAX_RETRIES = 4;
      
      const fn = vi.fn().mockRejectedValue(new Error('fail'));
      
      // Mock setTimeout to execute callback immediately
      vi.spyOn(global, 'setTimeout').mockImplementation((callback: () => void) => {
        callback();
        return 0 as unknown as NodeJS.Timeout;
      });
      
      await expect(withRetry(fn)).rejects.toThrow('fail');
      expect(fn).toHaveBeenCalledTimes(4); 
      
      // No need to restore, beforeEach will reset the mockedConfigService properties
    });

    it('should use the provided retry delay between attempts', async () => {
      // Modify the properties of the *mocked* configService instance
      mockedConfigService.RETRY_DELAY = 1000;
      
      // Spy on setTimeout
      const setTimeoutSpy = vi.spyOn(global, 'setTimeout').mockImplementation((callback: () => void) => {
        callback();
        return 0 as unknown as NodeJS.Timeout;
      });
      
      const fn = vi.fn()
        .mockRejectedValueOnce(new Error('fail'))
        .mockResolvedValueOnce('success');
      
      await withRetry(fn, 2);
      
      // Now verify setTimeout was called with the correct delay
      // withRetry uses exponential backoff: delay * Math.pow(2, i)
      // For the first retry (i=0), delay is 1000 * 2^0 = 1000
      expect(setTimeoutSpy).toHaveBeenCalledWith(expect.any(Function), 1000);
      
      // No need to restore, beforeEach will reset mockConfigValues.RETRY_DELAY
    });
  });

  describe('preprocessText', () => {
    it('should trim leading and trailing whitespace', () => {
      expect(preprocessText('  hello  ')).toBe('hello');
      expect(preprocessText('\n\nhello\n\n')).toBe('hello');
      expect(preprocessText('\t\thello\t\t')).toBe('hello');
    });

    it('should replace multiple spaces with a single space', () => {
      expect(preprocessText('hello    world')).toBe('hello world');
      expect(preprocessText('hello\t\t\tworld')).toBe('hello world');
    });

    it('should preserve newlines but normalize multiple newlines', () => {
      expect(preprocessText('hello\nworld')).toBe('hello\nworld');
      expect(preprocessText('hello\n\n\nworld')).toBe('hello\nworld');
    });

    it('should remove control characters', () => {
      expect(preprocessText('hello\x00world')).toBe('helloworld');
      expect(preprocessText('hello\x01\x02\x03world')).toBe('helloworld');
      expect(preprocessText('hello\x1Fworld')).toBe('helloworld');
    });

    it('should handle empty strings', () => {
      expect(preprocessText('')).toBe('');
      expect(preprocessText('   ')).toBe('');
      expect(preprocessText('\n\n\n')).toBe('');
    });

    it('should handle strings with only control characters', () => {
      expect(preprocessText('\x00\x01\x02')).toBe('');
    });

    it('should handle complex mixed input', () => {
      const input = '  Hello\x00\n\n  World\t\t\x01With\x02\x03Multiple    Spaces  ';
      const expected = 'Hello\nWorld WithMultiple Spaces';
      expect(preprocessText(input)).toBe(expected);
    });

    it('should handle non-ASCII characters correctly', () => {
      expect(preprocessText('  Héllö    Wörld  ')).toBe('Héllö Wörld');
      expect(preprocessText('你好\n世界')).toBe('你好\n世界');
    });
  });
// Removed extra closing });
