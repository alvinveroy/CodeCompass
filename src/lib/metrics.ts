import { logger as configLogger } from "./config";

// Export logger for easier mocking in tests
export const logger = configLogger;

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

// Advanced metrics for new features
const queryRefinements: { [queryId: string]: number } = {}; // Track number of refinements per query
const toolChains: { [chainId: string]: string[] } = {}; // Track tool chains
const feedbackScores: number[] = []; // Track feedback scores
const agentMetrics: {
  runs: number;
  completions: number;
  averageSteps: number;
  totalSteps: number;
  toolUsage: { [tool: string]: number };
} = {
  runs: 0,
  completions: 0,
  averageSteps: 0,
  totalSteps: 0,
  toolUsage: {}
};

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
export function getMetrics(): { 
  counters: MetricCounter; 
  timings: TimingMetrics; 
  uptime: number;
  queryRefinements: { [queryId: string]: number };
  toolChains: { [chainId: string]: string[] };
  feedbackStats: { 
    count: number; 
    average: number; 
    min: number; 
    max: number;
  };
  agent: {
    runs: number;
    completions: number;
    averageSteps: number;
    toolUsage: { [tool: string]: number };
  };
} {
  const uptime = Date.now() - lastResetTime;
  
  // Calculate feedback statistics
  const feedbackStats = {
    count: feedbackScores.length,
    average: feedbackScores.length ? 
      feedbackScores.reduce((a, b) => a + b, 0) / feedbackScores.length : 0,
    min: feedbackScores.length ? Math.min(...feedbackScores) : 0,
    max: feedbackScores.length ? Math.max(...feedbackScores) : 0,
  };
  
  // Calculate agent average steps
  agentMetrics.averageSteps = agentMetrics.runs > 0 ? 
    agentMetrics.totalSteps / agentMetrics.runs : 0;
  
  return {
    counters,
    timings,
    uptime,
    queryRefinements,
    toolChains,
    feedbackStats,
    agent: {
      runs: agentMetrics.runs,
      completions: agentMetrics.completions,
      averageSteps: agentMetrics.averageSteps,
      toolUsage: agentMetrics.toolUsage
    }
  };
}

// Reset all metrics
export function resetMetrics(): void {
  Object.keys(counters).forEach(key => delete counters[key]);
  Object.keys(timings).forEach(key => delete timings[key]);
  Object.keys(queryRefinements).forEach(key => delete queryRefinements[key]);
  Object.keys(toolChains).forEach(key => delete toolChains[key]);
  feedbackScores.length = 0;
  
  // Reset agent metrics
  agentMetrics.runs = 0;
  agentMetrics.completions = 0;
  agentMetrics.totalSteps = 0;
  agentMetrics.averageSteps = 0;
  Object.keys(agentMetrics.toolUsage).forEach(key => delete agentMetrics.toolUsage[key]);
  
  lastResetTime = Date.now();
  logger.info("Metrics reset");
}

// Log current metrics
export function logMetrics(): void {
  const metrics = getMetrics();
  logger.info("Current metrics", metrics);
}

// Track query refinement
export function trackQueryRefinement(queryId: string): void {
  if (!queryRefinements[queryId]) {
    queryRefinements[queryId] = 0;
  }
  queryRefinements[queryId]++;
}

// Track tool chain
export function trackToolChain(chainId: string, toolName: string): void {
  if (!toolChains[chainId]) {
    toolChains[chainId] = [];
  }
  toolChains[chainId].push(toolName);
}

// Track feedback score
export function trackFeedbackScore(score: number): void {
  feedbackScores.push(score);
}

// Track agent run
export function trackAgentRun(): void {
  agentMetrics.runs++;
  incrementCounter('agent_runs');
}

// Track agent completion
export function trackAgentCompletion(steps: number): void {
  agentMetrics.completions++;
  agentMetrics.totalSteps += steps;
  incrementCounter('agent_completions');
}

// Track agent tool usage
export function trackAgentToolUsage(tool: string): void {
  if (!agentMetrics.toolUsage[tool]) {
    agentMetrics.toolUsage[tool] = 0;
  }
  agentMetrics.toolUsage[tool]++;
  incrementCounter(`agent_tool_${tool}`);
}

// Schedule periodic metrics logging
export function startMetricsLogging(intervalMs = 300000): NodeJS.Timeout {
  logger.info(`Starting metrics logging every ${intervalMs}ms`);
  // Log metrics immediately on start
  logMetrics();
  return setInterval(logMetrics, intervalMs);
}
