import { logger } from "./config";

interface MetricCounter {
  [key: string]: number;
}

interface TimingMetric {
  count: number;
  totalMs: number;
  avgMs: number;
  minMs: number;
  maxMs: number;
}

interface TimingMetrics {
  [key: string]: TimingMetric;
}

// Simple in-memory metrics storage
const counters: MetricCounter = {};
const timings: TimingMetrics = {};
let lastResetTime = Date.now();

// Increment a counter metric
export function incrementCounter(name: string, value = 1): void {
  counters[name] = (counters[name] || 0) + value;
}

// Record a timing metric
export function recordTiming(name: string, durationMs: number): void {
  if (!timings[name]) {
    timings[name] = {
      count: 0,
      totalMs: 0,
      avgMs: 0,
      minMs: Infinity,
      maxMs: 0
    };
  }
  
  const metric = timings[name];
  metric.count++;
  metric.totalMs += durationMs;
  metric.avgMs = metric.totalMs / metric.count;
  metric.minMs = Math.min(metric.minMs, durationMs);
  metric.maxMs = Math.max(metric.maxMs, durationMs);
}

// Time a function execution and record the metric
export async function timeExecution<T>(name: string, fn: () => Promise<T>): Promise<T> {
  const startTime = Date.now();
  try {
    return await fn();
  } finally {
    const duration = Date.now() - startTime;
    recordTiming(name, duration);
  }
}

// Get all metrics
export function getMetrics(): { counters: MetricCounter; timings: TimingMetrics; uptime: number } {
  const uptime = Date.now() - lastResetTime;
  return {
    counters,
    timings,
    uptime
  };
}

// Reset all metrics
export function resetMetrics(): void {
  Object.keys(counters).forEach(key => delete counters[key]);
  Object.keys(timings).forEach(key => delete timings[key]);
  lastResetTime = Date.now();
  logger.info("Metrics reset");
}

// Log current metrics
export function logMetrics(): void {
  const metrics = getMetrics();
  logger.info("Current metrics", metrics);
}

// Schedule periodic metrics logging
export function startMetricsLogging(intervalMs = 300000): NodeJS.Timeout {
  logger.info(`Starting metrics logging every ${intervalMs}ms`);
  return setInterval(logMetrics, intervalMs);
}
