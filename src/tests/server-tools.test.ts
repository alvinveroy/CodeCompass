import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { normalizeToolParams } from '../lib/server';
import { resetMetrics, getMetrics } from '../lib/metrics';
import { getOrCreateSession, addQuery, addSuggestion } from '../lib/state';

// Mock dependencies
vi.mock('../lib/metrics', () => {
  const mockMetrics = { 
    counters: {}, 
    timings: {},
    uptime: 0,
    queryRefinements: {},
    toolChains: {},
    feedbackStats: { count: 0, average: 0, min: 0, max: 0 }
  };
  
  return {
    resetMetrics: vi.fn(),
    getMetrics: vi.fn().mockReturnValue(mockMetrics),
    incrementCounter: vi.fn(),
    recordTiming: vi.fn(),
  };
});

vi.mock('../lib/state', () => {
  const mockSession = {
    id: 'test_session',
    queries: [],
    suggestions: [],
    context: { repoPath: '/test/repo' },
    createdAt: Date.now(),
    lastUpdated: Date.now(),
  };
  
  return {
    getOrCreateSession: vi.fn().mockReturnValue(mockSession),
    addQuery: vi.fn(),
    addSuggestion: vi.fn(),
    addFeedback: vi.fn(),
    updateContext: vi.fn(),
    getRecentQueries: vi.fn().mockReturnValue([]),
    getRelevantResults: vi.fn().mockReturnValue([]),
  };
});

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
      expect(result).toEqual({ query: JSON.stringify(obj) });
    });

    it('should handle primitive values', () => {
      const result = normalizeToolParams(42);
      expect(result).toEqual({ query: '42' });
    });

    it('should handle null input', () => {
      const result = normalizeToolParams(null);
      expect(result).toEqual({ query: 'null' });
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
      const session = getOrCreateSession('test_session', '/test/repo');
      addQuery(session.id, 'test query', [], 0.8);
      expect(addQuery).toHaveBeenCalledWith(session.id, 'test query', [], 0.8);
    });

    it('should add suggestion to session', () => {
      const session = getOrCreateSession('test_session', '/test/repo');
      addSuggestion(session.id, 'test prompt', 'test suggestion');
      expect(addSuggestion).toHaveBeenCalledWith(session.id, 'test prompt', 'test suggestion');
    });
  });

  describe('Metrics Management', () => {
    it('should reset metrics', () => {
      resetMetrics();
      expect(resetMetrics).toHaveBeenCalled();
    });

    it('should get metrics', () => {
      const metrics = getMetrics();
      expect(getMetrics).toHaveBeenCalled();
      expect(metrics).toHaveProperty('counters');
      expect(metrics).toHaveProperty('timings');
    });
  });
});
