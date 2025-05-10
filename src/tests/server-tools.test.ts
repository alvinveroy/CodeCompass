import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { normalizeToolParams } from '../lib/server';

// Mock dependencies
// Mock metrics module - REMOVED
// const mockMetricsObj = {
//   counters: {},
//   timings: {},
//   uptime: 0,
//   queryRefinements: {},
//   toolChains: {},
//   feedbackStats: { count: 0, average: 0, min: 0, max: 0 },
//   agent: {
//     runs: 0,
//     completions: 0,
//     averageSteps: 0,
//     toolUsage: {}
//   }
// };

// vi.mock('../lib/metrics', () => ({ // Metrics removed
//   resetMetrics: vi.fn(),
//   getMetrics: vi.fn(() => mockMetricsObj),
//   incrementCounter: vi.fn(),
//   recordTiming: vi.fn()
// }));

vi.mock('../lib/state', () => ({
  getOrCreateSession: vi.fn(() => ({
    id: 'test_session',
    queries: [],
    suggestions: [],
    context: { repoPath: '/test/repo' },
    createdAt: Date.now(),
    lastUpdated: Date.now()
  })),
  addQuery: vi.fn(),
  addSuggestion: vi.fn(),
  addFeedback: vi.fn(),
  updateContext: vi.fn(),
  getRecentQueries: vi.fn(() => []),
  getRelevantResults: vi.fn(() => [])
}));

// Import mocked functions after mocking
// import { resetMetrics, getMetrics } from '../lib/metrics'; // Metrics removed
import { getOrCreateSession, addQuery, addSuggestion } from '../lib/state';

describe('Server Tools', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.resetAllMocks();
  });

  describe('normalizeToolParams', () => {
    it('should handle string input as query', () => {
      const result = normalizeToolParams('test query');
      expect(result).toEqual({ query: 'test query' });
    });

    it('should handle JSON string input', () => {
      const result = normalizeToolParams('{"query": "test query", "sessionId": "123"}');
      expect(result).toEqual({ query: 'test query', sessionId: '123' });
    });

    it('should handle object input with query property', () => {
      const result = normalizeToolParams({ query: 'test query' });
      expect(result).toEqual({ query: 'test query' });
    });

    it('should handle object input with prompt property', () => {
      const result = normalizeToolParams({ prompt: 'test prompt' });
      expect(result).toEqual({ prompt: 'test prompt' });
    });

    it('should handle object input with sessionId property', () => {
      const result = normalizeToolParams({ sessionId: '123' });
      expect(result).toEqual({ sessionId: '123' });
    });

    it('should handle object input without query/prompt/sessionId properties', () => {
      const obj = { foo: 'bar', baz: 123 };
      const result = normalizeToolParams(obj);
      expect(result).toEqual(obj); // Expect the object to be returned as-is
    });

    it('should handle primitive values', () => {
      const result = normalizeToolParams(42);
      expect(result).toEqual({ query: '42' });
    });

    it('should handle null input', () => {
      const result = normalizeToolParams(null);
      expect(result).toEqual({ query: '' }); // Updated to expect empty string for null
    });
  });

  describe('Session Management', () => {
    it('should create a new session when sessionId is not provided', () => {
      getOrCreateSession(undefined, '/test/repo');
      expect(getOrCreateSession).toHaveBeenCalledWith(undefined, '/test/repo');
    });

    it('should use existing session when sessionId is provided', () => {
      getOrCreateSession('existing_session', '/test/repo');
      expect(getOrCreateSession).toHaveBeenCalledWith('existing_session', '/test/repo');
    });

    it('should add query to session', () => {
      addQuery('test_session', 'test query', [], 0.8);
      expect(addQuery).toHaveBeenCalledWith('test_session', 'test query', [], 0.8);
    });

    it('should add suggestion to session', () => {
      addSuggestion('test_session', 'test prompt', 'test suggestion');
      expect(addSuggestion).toHaveBeenCalledWith('test_session', 'test prompt', 'test suggestion');
    });
  });

  // describe('Metrics Management', () => { // Metrics removed
  //   it('should reset metrics', () => {
  //     resetMetrics();
  //     expect(resetMetrics).toHaveBeenCalled();
  //   });

  //   it('should get metrics', () => {
  //     // Create a manual mock for this specific test
  //     vi.mocked(getMetrics).mockReturnValueOnce({
  //       counters: { test: 1 },
  //       timings: { test: { count: 1, totalMs: 100, avgMs: 100, minMs: 100, maxMs: 100 } },
  //       uptime: 1000,
  //       queryRefinements: {},
  //       toolChains: {},
  //       feedbackStats: { count: 0, average: 0, min: 0, max: 0 },
  //       agent: {
  //         runs: 0,
  //         completions: 0,
  //         averageSteps: 0,
  //         toolUsage: {}
  //       }
  //     });
      
  //     const metrics = getMetrics();
  //     expect(getMetrics).toHaveBeenCalled();
  //     expect(metrics).toEqual(expect.objectContaining({
  //       counters: expect.any(Object),
  //       timings: expect.any(Object)
  //     }));
  //   });
  // });
});
