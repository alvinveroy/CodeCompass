import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { withMetrics } from '../lib/utils';
import { logger as mockLogger } from '../lib/config-service';

// Define the spy for performance.now() at the top level
const mockPerformanceNow = vi.fn();

// Mock the 'perf_hooks' module to control performance.now()
vi.mock('perf_hooks', async (importOriginal) => {
  const originalModule = await importOriginal<typeof import('perf_hooks')>();
  return {
    ...originalModule,
    performance: {
      ...originalModule.performance,
      now: mockPerformanceNow,
    },
  };
});

// Mock the logger methods from config-service
vi.mock('../lib/config-service', async (importActual) => {
  const actual = await importActual() as any;
  return {
    ...actual,
    logger: {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    },
  };
});

describe('withMetrics', () => {
  beforeEach(() => {
    vi.clearAllMocks(); // Clears all mocks, including mockLogger
    mockPerformanceNow.mockReset(); // Specifically reset the performance.now spy
  });

  // afterEach is not strictly necessary here unless fake timers were used.

  it('should execute the function and log execution time on success', async () => {
    const mockFn = vi.fn(async (a: number, b: number) => {
      await new Promise(resolve => setTimeout(resolve, 5)); // Simulate async work
      return a + b;
    });
    Object.defineProperty(mockFn, 'name', { value: 'mockSumFunction', configurable: true });
    // mockFn.mockName('mockSumFunction'); // Retain for Vitest's own reporting if desired, but not for fn.name

    mockPerformanceNow.mockReturnValueOnce(100).mockReturnValueOnce(150); // Simulate 50ms duration

    const wrappedFn = withMetrics(mockFn);
    const result = await wrappedFn(2, 3);

    expect(result).toBe(5);
    expect(mockFn).toHaveBeenCalledWith(2, 3);
    expect(mockLogger.debug).toHaveBeenCalledWith('Starting execution of mockSumFunction');
    expect(mockLogger.info).toHaveBeenCalledWith('Function mockSumFunction executed in 50.00ms');
  });

  it('should execute the function, log execution time, and re-throw error on failure', async () => {
    const testError = new Error('Test error');
    const mockFn = vi.fn(async () => {
      await new Promise(resolve => setTimeout(resolve, 5)); // Simulate async work
      throw testError;
    });
    Object.defineProperty(mockFn, 'name', { value: 'mockErrorFunction', configurable: true });
    // mockFn.mockName('mockErrorFunction'); // Retain for Vitest's own reporting if desired

    mockPerformanceNow.mockReturnValueOnce(200).mockReturnValueOnce(275); // Simulate 75ms duration

    const wrappedFn = withMetrics(mockFn);

    await expect(wrappedFn()).rejects.toThrow(testError);
    expect(mockFn).toHaveBeenCalled();
    expect(mockLogger.debug).toHaveBeenCalledWith('Starting execution of mockErrorFunction');
    expect(mockLogger.error).toHaveBeenCalledWith(
      'Function mockErrorFunction failed after 75.00ms',
      { error: testError }
    );
  });

  it('should use "anonymousFunction" for unnamed functions in logs', async () => {
    const mockFn = vi.fn(async () => { // An anonymous function
      await new Promise(resolve => setTimeout(resolve, 1));
      return 'done';
    });
    // fn.name would be 'mockFn' here because it's assigned.
    // To test true anonymous, it'd be withMetrics(async () => {...})
    // However, withMetrics itself defaults to 'anonymousFunction' if fn.name is empty.
    // Let's test the fallback directly by overriding the name for the test.
    Object.defineProperty(mockFn, 'name', { value: '' });


    mockPerformanceNow.mockReturnValueOnce(300).mockReturnValueOnce(310); // Simulate 10ms duration

    const wrappedFn = withMetrics(mockFn);
    await wrappedFn();

    expect(mockLogger.debug).toHaveBeenCalledWith('Starting execution of anonymousFunction');
    expect(mockLogger.info).toHaveBeenCalledWith('Function anonymousFunction executed in 10.00ms');
  });
});
