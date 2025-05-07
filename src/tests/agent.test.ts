import { describe, it, expect, vi, beforeEach } from 'vitest';
import { parseToolCalls, createAgentState } from '../lib/agent';

// Mock dependencies
vi.mock('../lib/metrics', () => ({
  incrementCounter: vi.fn(),
  recordTiming: vi.fn(),
  timeExecution: vi.fn((name, fn) => fn()),
  trackAgentRun: vi.fn(),
  trackAgentCompletion: vi.fn(),
  trackAgentToolUsage: vi.fn()
}));

describe('Agent', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('parseToolCalls', () => {
    it('should parse valid tool calls', () => {
      const output = `
        I'll use the search_code tool to find relevant files.
        
        TOOL_CALL: {"tool": "search_code", "parameters": {"query": "authentication"}}
        
        Now I'll get repository context.
        
        TOOL_CALL: {"tool": "get_repository_context", "parameters": {"query": "project structure"}}
      `;
      
      const result = parseToolCalls(output);
      
      expect(result).toHaveLength(2);
      expect(result[0]).toEqual({
        tool: 'search_code',
        parameters: { query: 'authentication' }
      });
      expect(result[1]).toEqual({
        tool: 'get_repository_context',
        parameters: { query: 'project structure' }
      });
    });
    
    it('should handle malformed JSON', () => {
      const output = `
        I'll use the search_code tool.
        
        TOOL_CALL: {"tool": "search_code", "parameters": {"query": "authentication}
        
        This JSON is malformed.
      `;
      
      const result = parseToolCalls(output);
      
      expect(result).toHaveLength(0);
    });
    
    it('should return empty array when no tool calls are found', () => {
      const output = 'This response has no tool calls.';
      
      const result = parseToolCalls(output);
      
      expect(result).toHaveLength(0);
    });
  });
  
  describe('createAgentState', () => {
    it('should create a new agent state with the correct structure', () => {
      const sessionId = 'test_session';
      const query = 'Find authentication code';
      
      const result = createAgentState(sessionId, query);
      
      expect(result).toEqual({
        sessionId,
        query,
        steps: [],
        context: [],
        isComplete: false
      });
    });
  });
});
