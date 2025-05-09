import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { withRetry, preprocessText } from '../lib/utils';
// Import the original configService to get its actual default values for resetting
import { configService as originalConfigServiceInstance } from '../lib/config-service';

// Mock configService for the withRetry tests
// Define a function that returns the mock values to avoid hoisting issues with vi.mock
const getMockConfigValues = () => ({
  MAX_RETRIES: originalConfigServiceInstance.MAX_RETRIES,
  RETRY_DELAY: originalConfigServiceInstance.RETRY_DELAY,
  // Mock logger methods used by withRetry
  logger: {
    warn: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
    debug: vi.fn(),
  }
});

vi.mock('../lib/config-service', async () => {
  // Import original to ensure other exports from config-service are maintained if any
  const originalModule = await vi.importActual('../lib/config-service') as any;
  const mockConfig = getMockConfigValues();
  return {
    ...originalModule, // Spread original exports
    configService: mockConfig, // Override configService with our mock
    logger: mockConfig.logger, // Override logger export with our mock logger
  };
});

describe('Utils Module', () => {
  describe('withRetry', () => {
    // Mock setTimeout to speed up tests
    beforeEach(() => {
      vi.useFakeTimers();
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
      mutableMockConfigValues.MAX_RETRIES = 4; // Modify the mutable object
      
      const fn = vi.fn().mockRejectedValue(new Error('fail'));
      
      // Mock setTimeout to execute callback immediately
      vi.spyOn(global, 'setTimeout').mockImplementation((callback: () => void) => {
        callback();
        return 0 as unknown as NodeJS.Timeout;
      });
      
      await expect(withRetry(fn)).rejects.toThrow('fail');
      expect(fn).toHaveBeenCalledTimes(4); 
      
      // No need to restore, beforeEach will reset mutableMockConfigValues.MAX_RETRIES
    });

    it('should use the provided retry delay between attempts', async () => {
      mutableMockConfigValues.RETRY_DELAY = 1000; // Modify the mutable object
      
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
});
