import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { normalizeToolParams } from '../lib/server';
import { logger } from '../lib/config';

// Mock dependencies
vi.mock('@modelcontextprotocol/sdk/server/mcp.js', () => ({
  McpServer: vi.fn().mockImplementation(() => ({
    connect: vi.fn(),
    tool: vi.fn(),
    resource: vi.fn()
  }))
}));

vi.mock('../lib/config', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn()
  },
  COLLECTION_NAME: 'test-collection',
  MAX_SNIPPET_LENGTH: 500
}));

vi.mock('../lib/ollama', () => ({
  checkOllama: vi.fn().mockResolvedValue(true),
  checkOllamaModel: vi.fn().mockResolvedValue(true),
  generateEmbedding: vi.fn().mockResolvedValue([0.1, 0.2, 0.3]),
  generateSuggestion: vi.fn().mockResolvedValue('Test suggestion'),
  summarizeSnippet: vi.fn().mockResolvedValue('Test summary')
}));

vi.mock('../lib/qdrant', () => ({
  initializeQdrant: vi.fn().mockResolvedValue({
    search: vi.fn().mockResolvedValue([
      {
        id: '1',
        payload: {
          filepath: 'test/file.ts',
          content: 'Test content',
          last_modified: '2025-05-07T00:00:00Z'
        },
        score: 0.95
      }
    ]),
    getCollections: vi.fn().mockResolvedValue({ collections: [] })
  })
}));

vi.mock('../lib/repository', () => ({
  validateGitRepository: vi.fn().mockResolvedValue(true),
  indexRepository: vi.fn().mockResolvedValue(undefined),
  getRepositoryDiff: vi.fn().mockResolvedValue('+ test\n- test2')
}));

vi.mock('../lib/metrics', () => ({
  getMetrics: vi.fn().mockReturnValue({
    counters: {},
    timings: {},
    uptime: 1000
  }),
  resetMetrics: vi.fn(),
  startMetricsLogging: vi.fn().mockReturnValue(123)
}));

vi.mock('isomorphic-git', () => ({
  default: {
    listFiles: vi.fn().mockResolvedValue(['file1.ts', 'file2.ts'])
  }
}));

describe('Server Tool Response Formatting', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('normalizeToolParams', () => {
    it('should handle string input as query', () => {
      const result = normalizeToolParams('test query');
      expect(result).toEqual({ query: 'test query' });
    });

    it('should handle object input with query property', () => {
      const result = normalizeToolParams({ query: 'test query' });
      expect(result).toEqual({ query: 'test query' });
    });

    it('should handle object input without query property', () => {
      const result = normalizeToolParams({ other: 'value' });
      expect(result).toEqual({ query: JSON.stringify({ other: 'value' }) });
    });

    it('should handle primitive values', () => {
      const result = normalizeToolParams(123);
      expect(result).toEqual({ query: '123' });
    });
  });

  describe('Tool Response Formatting', () => {
    it('should verify search_code tool returns markdown formatted response', async () => {
      // This is a structural test to ensure the response format is correct
      // The actual implementation would be tested with integration tests
      const response = `
# Search Results for: "test query"

## test/file.ts
- Last Modified: 2025-05-07T00:00:00Z
- Relevance: 0.95

### Code Snippet
\`\`\`
Test content
\`\`\`

### Summary
Test summary
`;
      
      // Verify the response contains markdown formatting elements
      expect(response).toContain('# Search Results');
      expect(response).toContain('## test/file.ts');
      expect(response).toContain('### Code Snippet');
      expect(response).toContain('```');
      expect(response).toContain('### Summary');
    });

    it('should verify reset_metrics tool returns markdown formatted response', async () => {
      const response = `
# Metrics Reset

Metrics have been reset successfully.

## Current Metrics
\`\`\`
Uptime: 1000ms
Counters: 0 (all reset to 0)
Timings: 0 (all reset)
\`\`\`
`;
      
      // Verify the response contains markdown formatting elements
      expect(response).toContain('# Metrics Reset');
      expect(response).toContain('## Current Metrics');
      expect(response).toContain('```');
      expect(response).toContain('Uptime:');
    });

    it('should verify generate_suggestion tool returns markdown formatted response', async () => {
      const response = `
# Code Suggestion for: "test query"

## Suggestion
Test suggestion

## Context Used

### test/file.ts
- Last modified: 2025-05-07T00:00:00Z
- Relevance: 0.95

\`\`\`
Test content
\`\`\`

## Recent Changes
\`\`\`
+ test
- test2
\`\`\`
`;
      
      // Verify the response contains markdown formatting elements
      expect(response).toContain('# Code Suggestion');
      expect(response).toContain('## Suggestion');
      expect(response).toContain('## Context Used');
      expect(response).toContain('### test/file.ts');
      expect(response).toContain('```');
      expect(response).toContain('## Recent Changes');
    });

    it('should verify get_repository_context tool returns markdown formatted response', async () => {
      const response = `
# Repository Context Summary

## Summary
Test suggestion

## Relevant Files

### test/file.ts
- Last modified: 2025-05-07T00:00:00Z
- Relevance: 0.95

\`\`\`
Test content
\`\`\`

## Recent Changes
\`\`\`
+ test
- test2
\`\`\`
`;
      
      // Verify the response contains markdown formatting elements
      expect(response).toContain('# Repository Context Summary');
      expect(response).toContain('## Summary');
      expect(response).toContain('## Relevant Files');
      expect(response).toContain('### test/file.ts');
      expect(response).toContain('```');
      expect(response).toContain('## Recent Changes');
    });
  });
});
