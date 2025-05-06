import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { withRetry, preprocessText } from '../lib/utils';
import * as config from '../lib/config';

describe('Utils Module', () => {
  describe('withRetry', () => {
    // Mock setTimeout to speed up tests
    beforeEach(() => {
      vi.useFakeTimers();
    });

    afterEach(() => {
      vi.restoreAllMocks();
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
      
      const retryPromise = withRetry(fn, 2);
      // First attempt fails, then setTimeout is called
      await Promise.resolve();
      vi.runAllTimers(); // Fast-forward through delay
      const result = await retryPromise;
      
      expect(result).toBe('success');
      expect(fn).toHaveBeenCalledTimes(2);
    });

    it('should retry multiple times before succeeding', async () => {
      const fn = vi.fn()
        .mockRejectedValueOnce(new Error('fail 1'))
        .mockRejectedValueOnce(new Error('fail 2'))
        .mockRejectedValueOnce(new Error('fail 3'))
        .mockResolvedValueOnce('success');
      
      const retryPromise = withRetry(fn, 4);
      
      // First attempt fails
      await Promise.resolve();
      vi.runAllTimers(); // Run for first delay
      
      // Second attempt fails
      await Promise.resolve();
      vi.runAllTimers(); // Run for second delay
      
      // Third attempt fails
      await Promise.resolve();
      vi.runAllTimers(); // Run for third delay
      
      // Fourth attempt succeeds
      const result = await retryPromise;
      
      expect(result).toBe('success');
      expect(fn).toHaveBeenCalledTimes(4);
    });

    it('should throw an error if all retries fail', async () => {
      const error = new Error('persistent failure');
      const fn = vi.fn().mockRejectedValue(error);
      
      const retryPromise = withRetry(fn, 3);
      
      // First attempt fails
      await Promise.resolve();
      vi.runAllTimers(); // Run for first delay
      
      // Second attempt fails
      await Promise.resolve();
      vi.runAllTimers(); // Run for second delay
      
      // Third attempt fails and throws
      await Promise.resolve();
      
      await expect(retryPromise).rejects.toThrow('persistent failure');
      expect(fn).toHaveBeenCalledTimes(3);
    });

    it('should respect the configured MAX_RETRIES when no retry count is provided', async () => {
      // Save original and override for test
      const originalMaxRetries = config.MAX_RETRIES;
      Object.defineProperty(config, 'MAX_RETRIES', { value: 4 });
      
      const fn = vi.fn().mockRejectedValue(new Error('fail'));
      
      const retryPromise = withRetry(fn); // No retry count provided
      
      // First attempt fails
      await Promise.resolve();
      
      // Run through each retry
      for (let i = 0; i < config.MAX_RETRIES - 1; i++) {
        vi.runAllTimers();
        await Promise.resolve();
      }
      
      await expect(retryPromise).rejects.toThrow('fail');
      expect(fn).toHaveBeenCalledTimes(4);
      
      // Restore original
      Object.defineProperty(config, 'MAX_RETRIES', { value: originalMaxRetries });
    });

    it('should use the provided retry delay between attempts', async () => {
      const originalRetryDelay = config.RETRY_DELAY;
      Object.defineProperty(config, 'RETRY_DELAY', { value: 1000 });
      
      // Spy on setTimeout
      const setTimeoutSpy = vi.spyOn(global, 'setTimeout');
      
      const fn = vi.fn()
        .mockRejectedValueOnce(new Error('fail'))
        .mockResolvedValueOnce('success');
      
      const retryPromise = withRetry(fn, 2);
      
      // Run the first attempt which will fail and trigger setTimeout
      await Promise.resolve();
      
      // Now verify setTimeout was called with the correct delay
      expect(setTimeoutSpy).toHaveBeenLastCalledWith(expect.any(Function), 1000);
      
      vi.runAllTimers();
      await retryPromise;
      
      // Restore original
      Object.defineProperty(config, 'RETRY_DELAY', { value: originalRetryDelay });
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
