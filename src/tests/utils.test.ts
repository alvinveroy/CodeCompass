import { describe, it, expect, vi, beforeEach, afterEach, Mock } from 'vitest'; // Added Mock
import { withRetry, preprocessText } from '../lib/utils';

// Define a type for the parts of configService we want to mock and make mutable
interface MockableConfigService {
  MAX_RETRIES: number;
  RETRY_DELAY: number;
  OLLAMA_HOST: string; // Assuming this is used or needed by the SUT directly or indirectly
  // Add other properties from the actual ConfigService if they are accessed by withRetry
  logger: { warn: Mock; error: Mock; info: Mock; debug: Mock };
}

vi.mock('../lib/config-service', async () => {
  // Import the original module to get default values *inside the factory*
  const originalModule = await vi.importActual('../lib/config-service') as { configService: any, logger: any };
  const originalInstance = originalModule.configService;

  const mockConfigServiceValues: MockableConfigService = {
    MAX_RETRIES: originalInstance.MAX_RETRIES,
    RETRY_DELAY: originalInstance.RETRY_DELAY,
    OLLAMA_HOST: originalInstance.OLLAMA_HOST,
    logger: {
      warn: vi.fn(),
      error: vi.fn(),
      info: vi.fn(),
      debug: vi.fn(),
    },
  };

  return {
    // Export the mocked configService and logger
    configService: mockConfigServiceValues,
    logger: mockConfigServiceValues.logger,
    // If there are other exports from config-service that utils.ts might use,
    // spread originalModule here, but be careful not to overwrite your mocks.
    // Example: ...originalModule (if other named exports are needed and not configService/logger)
  };
});

describe('Utils Module', () => {
  let mockedConfigService: MockableConfigService;
  let originalDefaultRetryValues: { MAX_RETRIES: number; RETRY_DELAY: number; };

  beforeEach(async () => {
    // Import the original config service to get its true default values for resetting retry logic.
    // We only need MAX_RETRIES and RETRY_DELAY from the original for resetting.
    const { configService: actualOriginalConfigService } = await vi.importActual('../lib/config-service') as { configService: { MAX_RETRIES: number, RETRY_DELAY: number } };
    originalDefaultRetryValues = {
      MAX_RETRIES: actualOriginalConfigService.MAX_RETRIES,
      RETRY_DELAY: actualOriginalConfigService.RETRY_DELAY,
    };
    
    // Dynamically import the mocked service to get the instance created by the mock factory.
    // This instance (mockedConfigService) will conform to MockableConfigService.
    const mockedModule = await import('../lib/config-service');
    mockedConfigService = mockedModule.configService as unknown as MockableConfigService;

    vi.useFakeTimers();
    // Reset the properties of the *actual mocked instance* before each test
    mockedConfigService.MAX_RETRIES = originalDefaultRetryValues.MAX_RETRIES;
    mockedConfigService.RETRY_DELAY = originalDefaultRetryValues.RETRY_DELAY;
    mockedConfigService.logger.warn.mockClear();
    mockedConfigService.logger.error.mockClear();
    mockedConfigService.logger.info.mockClear();
    mockedConfigService.logger.debug.mockClear();
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
