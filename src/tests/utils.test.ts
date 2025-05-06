import { describe, it, expect, vi } from 'vitest';
import { withRetry, preprocessText } from '../lib/utils';

describe('Utils Module', () => {
  describe('withRetry', () => {
    it('should return the result if the function succeeds', async () => {
      const fn = vi.fn().mockResolvedValue('success');
      const result = await withRetry(fn);
      expect(result).toBe('success');
      expect(fn).toHaveBeenCalledTimes(1);
    });

    it('should retry the function if it fails', async () => {
      const fn = vi.fn()
        .mockRejectedValueOnce(new Error('fail'))
        .mockResolvedValueOnce('success');
      
      const result = await withRetry(fn, 2);
      expect(result).toBe('success');
      expect(fn).toHaveBeenCalledTimes(2);
    });

    it('should throw an error if all retries fail', async () => {
      const fn = vi.fn().mockRejectedValue(new Error('fail'));
      await expect(withRetry(fn, 2)).rejects.toThrow('fail');
      expect(fn).toHaveBeenCalledTimes(2);
    });
  });

  describe('preprocessText', () => {
    it('should trim whitespace', () => {
      expect(preprocessText('  hello  ')).toBe('hello');
    });

    it('should replace multiple spaces with a single space', () => {
      expect(preprocessText('hello    world')).toBe('hello world');
    });

    it('should preserve newlines', () => {
      expect(preprocessText('hello\nworld')).toBe('hello\nworld');
    });

    it('should remove control characters', () => {
      expect(preprocessText('hello\x00world')).toBe('helloworld');
    });
  });
});
