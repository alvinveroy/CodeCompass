import { describe, it, expect } from 'vitest';
import * as config from '../lib/config';

describe('Config Module', () => {
  it('should have default values for configuration', () => {
    expect(config.OLLAMA_HOST).toBeDefined();
    expect(config.QDRANT_HOST).toBeDefined();
    expect(config.COLLECTION_NAME).toBeDefined();
    expect(config.EMBEDDING_MODEL).toBeDefined();
    expect(config.SUGGESTION_MODEL).toBeDefined();
    expect(config.MAX_RETRIES).toBeGreaterThan(0);
    expect(config.MAX_INPUT_LENGTH).toBeGreaterThan(0);
  });

  it('should have a configured logger', () => {
    expect(config.logger).toBeDefined();
    expect(typeof config.logger.info).toBe('function');
    expect(typeof config.logger.error).toBe('function');
  });
});
