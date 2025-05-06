import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { 
  incrementCounter, 
  recordTiming, 
  timeExecution, 
  getMetrics, 
  resetMetrics,
  logMetrics,
  startMetricsLogging
} from '../lib/metrics';

describe('Metrics Module', () => {
  beforeEach(() => {
    // Reset metrics before each test
    resetMetrics();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  describe('incrementCounter', () => {
    it('should initialize and increment a counter', () => {
      incrementCounter('test_counter');
      expect(getMetrics().counters.test_counter).toBe(1);
      
      incrementCounter('test_counter');
      expect(getMetrics().counters.test_counter).toBe(2);
    });

    it('should increment by the specified value', () => {
      incrementCounter('test_counter', 5);
      expect(getMetrics().counters.test_counter).toBe(5);
      
      incrementCounter('test_counter', 3);
      expect(getMetrics().counters.test_counter).toBe(8);
    });

    it('should handle multiple counters independently', () => {
      incrementCounter('counter1');
      incrementCounter('counter2', 2);
      incrementCounter('counter1');
      
      const metrics = getMetrics();
      expect(metrics.counters.counter1).toBe(2);
      expect(metrics.counters.counter2).toBe(2);
    });

    it('should handle negative increments', () => {
      incrementCounter('test_counter', 5);
      incrementCounter('test_counter', -2);
      expect(getMetrics().counters.test_counter).toBe(3);
    });
  });

  describe('recordTiming', () => {
    it('should initialize and record a timing metric', () => {
      recordTiming('test_timing', 100);
      
      const metrics = getMetrics();
      expect(metrics.timings.test_timing.count).toBe(1);
      expect(metrics.timings.test_timing.totalMs).toBe(100);
      expect(metrics.timings.test_timing.avgMs).toBe(100);
      expect(metrics.timings.test_timing.minMs).toBe(100);
      expect(metrics.timings.test_timing.maxMs).toBe(100);
    });

    it('should update timing statistics correctly', () => {
      recordTiming('test_timing', 100);
      recordTiming('test_timing', 200);
      recordTiming('test_timing', 50);
      
      const metrics = getMetrics();
      expect(metrics.timings.test_timing.count).toBe(3);
      expect(metrics.timings.test_timing.totalMs).toBe(350);
      expect(metrics.timings.test_timing.avgMs).toBe(350/3);
      expect(metrics.timings.test_timing.minMs).toBe(50);
      expect(metrics.timings.test_timing.maxMs).toBe(200);
    });

    it('should handle multiple timing metrics independently', () => {
      recordTiming('timing1', 100);
      recordTiming('timing2', 200);
      
      const metrics = getMetrics();
      expect(metrics.timings.timing1.count).toBe(1);
      expect(metrics.timings.timing1.totalMs).toBe(100);
      expect(metrics.timings.timing2.count).toBe(1);
      expect(metrics.timings.timing2.totalMs).toBe(200);
    });
  });

  describe('timeExecution', () => {
    it('should time successful function execution', async () => {
      vi.spyOn(global.Date, 'now')
        .mockReturnValueOnce(1000) // Start time
        .mockReturnValueOnce(1100); // End time
      
      const fn = vi.fn().mockResolvedValue('result');
      const result = await timeExecution('test_execution', fn);
      
      expect(result).toBe('result');
      expect(fn).toHaveBeenCalledTimes(1);
      
      const metrics = getMetrics();
      expect(metrics.timings.test_execution.count).toBe(1);
      expect(metrics.timings.test_execution.totalMs).toBe(100);
    });

    it('should time function execution even if it throws', async () => {
      vi.spyOn(global.Date, 'now')
        .mockReturnValueOnce(1000) // Start time
        .mockReturnValueOnce(1200); // End time
      
      const error = new Error('test error');
      const fn = vi.fn().mockRejectedValue(error);
      
      await expect(timeExecution('test_execution', fn)).rejects.toThrow('test error');
      
      const metrics = getMetrics();
      expect(metrics.timings.test_execution.count).toBe(1);
      expect(metrics.timings.test_execution.totalMs).toBe(200);
    });
  });

  describe('getMetrics', () => {
    it('should return the current state of all metrics', () => {
      incrementCounter('counter1', 5);
      recordTiming('timing1', 100);
      
      const metrics = getMetrics();
      expect(metrics.counters.counter1).toBe(5);
      expect(metrics.timings.timing1.count).toBe(1);
      expect(metrics.uptime).toBeGreaterThanOrEqual(0);
    });

    it('should include uptime in the metrics', () => {
      vi.spyOn(global.Date, 'now')
        .mockReturnValueOnce(1000) // Reset time
        .mockReturnValueOnce(5000); // Current time when getMetrics is called
      
      resetMetrics(); // This will set lastResetTime to 1000
      const metrics = getMetrics(); // This will calculate uptime as 5000 - 1000 = 4000
      
      expect(metrics.uptime).toBe(4000);
    });
  });

  describe('resetMetrics', () => {
    it('should clear all counters and timings', () => {
      incrementCounter('counter1');
      recordTiming('timing1', 100);
      
      resetMetrics();
      
      const metrics = getMetrics();
      expect(Object.keys(metrics.counters).length).toBe(0);
      expect(Object.keys(metrics.timings).length).toBe(0);
    });

    it('should reset the uptime counter', () => {
      vi.spyOn(global.Date, 'now')
        .mockReturnValueOnce(1000) // Initial time
        .mockReturnValueOnce(2000) // Reset time
        .mockReturnValueOnce(3000); // Get metrics time
      
      // Set some initial metrics
      incrementCounter('test');
      
      // Reset metrics at time 2000
      resetMetrics();
      
      // Get metrics at time 3000
      const metrics = getMetrics();
      
      // Uptime should be 3000 - 2000 = 1000
      expect(metrics.uptime).toBe(1000);
    });
  });

  describe('logMetrics', () => {
    it('should log the current metrics', () => {
      // Import the logger directly from metrics module
      const metricsModule = require('../lib/metrics');
      const loggerSpy = vi.spyOn(metricsModule.logger, 'info');
      
      incrementCounter('test_counter');
      recordTiming('test_timing', 100);
      
      logMetrics();
      
      expect(loggerSpy).toHaveBeenCalledWith('Current metrics', expect.objectContaining({
        counters: expect.objectContaining({ test_counter: 1 }),
        timings: expect.objectContaining({ 
          test_timing: expect.objectContaining({ count: 1, totalMs: 100 }) 
        }),
        uptime: expect.any(Number)
      }));
    });
  });

  describe('startMetricsLogging', () => {
    it('should start a timer that logs metrics at the specified interval', () => {
      // Import the logger directly from metrics module
      const metricsModule = require('../lib/metrics');
      const loggerSpy = vi.spyOn(metricsModule.logger, 'info');
      
      // Spy on logMetrics function
      const logMetricsSpy = vi.spyOn(metricsModule, 'logMetrics');
      
      // Mock setInterval
      vi.spyOn(global, 'setInterval');
      
      const interval = 60000; // 1 minute
      const timer = startMetricsLogging(interval);
      
      expect(loggerSpy).toHaveBeenCalledWith(`Starting metrics logging every ${interval}ms`);
      expect(global.setInterval).toHaveBeenCalledWith(expect.any(Function), interval);
      
      // Fast-forward time to trigger the interval
      vi.advanceTimersByTime(interval);
      
      expect(logMetricsSpy).toHaveBeenCalledTimes(1);
      
      // Clean up
      clearInterval(timer);
    });

    it('should use the default interval if none is specified', () => {
      const defaultInterval = 300000; // 5 minutes
      
      // Mock setInterval
      vi.spyOn(global, 'setInterval');
      
      const timer = startMetricsLogging();
      
      expect(global.setInterval).toHaveBeenCalledWith(expect.any(Function), defaultInterval);
      
      // Clean up
      clearInterval(timer);
    });
  });
});
