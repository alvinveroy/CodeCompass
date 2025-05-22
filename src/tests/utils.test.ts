import { describe, it, expect, vi, beforeEach, afterEach, Mock } from 'vitest'; // Added Mock
import { withRetry } from '../utils/retry-utils';
import { preprocessText } from '../utils/text-utils';

// Define a type for the parts of configService we want to mock and make mutable
interface MockableConfigService {
  MAX_RETRIES: number;
  RETRY_DELAY: number;
  OLLAMA_HOST: string; // Assuming this is used or needed by the SUT directly or indirectly
  // Add other properties from the actual ConfigService if they are accessed by withRetry
  logger: { warn: Mock; error: Mock; info: Mock; debug: Mock };
}

// Define a partial type for what you expect from the original configService for this setup.
interface PartialOriginalConfig {
  MAX_RETRIES: number;
  RETRY_DELAY: number;
  OLLAMA_HOST: string;
  // Add other properties if accessed from originalInstance
}

vi.mock('../lib/config-service', async () => {
  // Import the original module to get default values *inside the factory*
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const originalModule = await vi.importActual('../lib/config-service') as any; 
  // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access
  const originalInstanceFromActual = originalModule.configService as PartialOriginalConfig;

  const mockConfigServiceValues: MockableConfigService = {
    MAX_RETRIES: originalInstanceFromActual.MAX_RETRIES,
    RETRY_DELAY: originalInstanceFromActual.RETRY_DELAY,
    OLLAMA_HOST: originalInstanceFromActual.OLLAMA_HOST,
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

// Import the mocked configService *after* vi.mock.
// This `configServiceInstanceFromMockFactory` is the instance that `withRetry` (the SUT) will use,
// and it's the one we want to manipulate in our tests.
// It will be typed as the original ConfigService by TypeScript's static analysis,
// but at runtime, it IS our MockableConfigService.
import { configService as configServiceInstanceFromMockFactory } from '../lib/config-service';

describe('Utils Module', () => {
  // This variable will hold the correctly typed reference to our mocked configService.
  let testSubjectMockedConfigService: MockableConfigService;
  let originalDefaultRetryValues: { MAX_RETRIES: number; RETRY_DELAY: number; };

  beforeEach(async () => {
    // Step 1: Get the actual module, casting to `any` because its precise type here is elusive.
    // The `eslint-disable` is justified because `vi.importActual` in a mocked context
    // doesn't always give TypeScript enough info for a precise type.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const originalModuleFromActualImport = await vi.importActual('../lib/config-service') as any; // eslint-disable-line @typescript-eslint/no-explicit-any
    
    // Step 2: Access the 'configService' property and explicitly cast it to 'PartialOriginalConfig'.
    // This is where we tell TypeScript the shape we expect for this specific property.
    // This assertion is necessary and correct.
    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access
    const originalInstance = originalModuleFromActualImport.configService as PartialOriginalConfig;

    // Step 3: Use the now correctly-typed 'originalInstance'
    originalDefaultRetryValues = {
      MAX_RETRIES: originalInstance.MAX_RETRIES,
      RETRY_DELAY: originalInstance.RETRY_DELAY,
    };
    
    // Assign the top-level imported mock to our test-scoped variable.
    // This is the crucial part: we cast the statically imported `configServiceInstanceFromMockFactory`
    // (which TS thinks is the original ConfigService) to our `MockableConfigService` type.
    // This is safe because our vi.mock factory ensures it *is* a MockableConfigService at runtime.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-assignment
    testSubjectMockedConfigService = configServiceInstanceFromMockFactory as unknown as MockableConfigService;

    vi.useFakeTimers();
    
    // Reset the properties of the *actual mocked instance* before each test
    // using the correctly typed testSubjectMockedConfigService.
    testSubjectMockedConfigService.MAX_RETRIES = originalDefaultRetryValues.MAX_RETRIES;
    testSubjectMockedConfigService.RETRY_DELAY = originalDefaultRetryValues.RETRY_DELAY;
    
    // Ensure logger and its methods exist before trying to clear mocks
    if (testSubjectMockedConfigService.logger) {
        testSubjectMockedConfigService.logger.warn?.mockClear();
        testSubjectMockedConfigService.logger.error?.mockClear();
        testSubjectMockedConfigService.logger.info?.mockClear();
        testSubjectMockedConfigService.logger.debug?.mockClear();
    }
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
      // Modify the properties of the correctly typed mocked configService instance
      testSubjectMockedConfigService.MAX_RETRIES = 4;
      
      const fn = vi.fn().mockRejectedValue(new Error('fail'));
      
      // Mock setTimeout to execute callback immediately
      vi.spyOn(global, 'setTimeout').mockImplementation((callback: () => void) => {
        callback();
        return 0 as unknown as NodeJS.Timeout;
      });
      
      await expect(withRetry(fn)).rejects.toThrow('fail');
      expect(fn).toHaveBeenCalledTimes(4);
    });

    it('should use the provided retry delay between attempts', async () => {
      // Modify the properties of the correctly typed mocked configService instance
      testSubjectMockedConfigService.RETRY_DELAY = 1000;
      
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
