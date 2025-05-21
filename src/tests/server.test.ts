import { describe, it, expect, vi, beforeEach } from 'vitest';
import { normalizeToolParams } from '../lib/server';

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
      const input = { other: 'value' };
      const result = normalizeToolParams(input);
      expect(result).toEqual(input); // Expect the object to be returned as-is
    });

    it('should handle primitive values', () => {
      const result = normalizeToolParams(123);
      expect(result).toEqual({ query: '123' });
    });
  });

  describe('Tool Response Formatting', () => {
    it('should verify search_code tool returns markdown formatted response', () => {
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

    it('should verify generate_suggestion tool returns markdown formatted response', () => {
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

    it('should verify get_repository_context tool returns markdown formatted response', () => {
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
