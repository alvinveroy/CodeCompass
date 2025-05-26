// This file is preloaded into the child process for integration tests.

// Ensure Vitest's 'vi' is available. If running in a plain Node.js child process
// without Vitest's test runner, 'vi' might not be globally available.
// However, StdioClientTransport spawns with node, and NODE_OPTIONS should make this work if Vitest's require hooks are active.
let vi;
try {
  vi = require('vitest').vi;
} catch (e) {
  console.error('[mock-llm-child-setup] Failed to require vitest.vi. Mocks may not apply.', e);
  // Fallback or throw if 'vi' is essential and not found
  // For now, proceed, and if mocks don't work, this log will be a clue.
  // A more robust solution might involve ensuring the child process runs under Vitest's environment if possible,
  // or using a different mocking strategy for child processes if 'vi' is unavailable.
  // For now, assume 'vi' will be available due to how Vitest likely instruments child processes via NODE_OPTIONS.
  if (!vi) vi = { mock: () => {}, fn: () => {}, importActual: async (mod) => require(mod), mocked: (fn) => fn }; // Basic fallback
}

// It's tricky to directly import mockLLMProviderInstance from the .ts test file here.
// A common pattern is to use an environment variable to signal the mock state or
// to have the child process itself initialize a simplified mock if a specific env var is set.

// For now, let's assume the child process will create its own mock instance
// if LLM_PROVIDER is 'mocked-for-test'. The key is that getLLMProvider in the child
// process needs to be mocked to return this.

const childMockLLMProviderInstance = {
  checkConnection: vi.fn().mockResolvedValue(true),
  generateText: vi.fn().mockResolvedValue('Mocked LLM Response from CHILD PROCESS'),
  generateEmbedding: vi.fn().mockResolvedValue([0.5, 0.6, 0.7, 0.8]),
  processFeedback: vi.fn().mockResolvedValue(undefined),
  mockId: 'child-process-mock-llm-instance' // Ensure this ID is unique and identifiable
};
console.log('[mock-llm-child-setup] Child process mock LLM instance created with ID:', childMockLLMProviderInstance.mockId); // Log the ID


// Mock llm-provider.js
try {
  const llmProviderPath = require.resolve('../../lib/llm-provider.js');
  console.log(`[mock-llm-child-setup] Mocking llm-provider at: ${llmProviderPath}`);
  vi.mock(llmProviderPath, () => {
    console.log('[mock-llm-child-setup] llm-provider.js mock factory EXECUTING in child.');
    return {
      getLLMProvider: vi.fn(async (providerName) => {
        console.log(`[mock-llm-child-setup] Mocked getLLMProvider in CHILD called with providerName: ${providerName}, process.env.LLM_PROVIDER: ${process.env.LLM_PROVIDER}`);
        if (providerName === 'mocked-for-test' || process.env.LLM_PROVIDER === 'mocked-for-test') {
          console.log('[mock-llm-child-setup] CHILD returning childMockLLMProviderInstance for "mocked-for-test"');
          return childMockLLMProviderInstance;
        }
        const actualLLMProvider = await vi.importActual(llmProviderPath);
        return actualLLMProvider.getLLMProvider(providerName);
      }),
      switchSuggestionModel: vi.fn().mockResolvedValue(true),
      clearProviderCache: vi.fn(),
    };
  });
} catch (e) {
  console.error('[mock-llm-child-setup] Error setting up llm-provider mock:', e);
}

// Mock deepseek.js
try {
  const deepseekPath = require.resolve('../../lib/deepseek.js');
  console.log(`[mock-llm-child-setup] Mocking deepseek.js at: ${deepseekPath}`);
  vi.mock(deepseekPath, () => {
    console.log('[mock-llm-child-setup] deepseek.js mock factory EXECUTING in child.');
    return ({
      testDeepSeekConnection: vi.fn().mockImplementation(async () => {
        console.log('[mock-llm-child-setup] Mocked testDeepSeekConnection in CHILD CALLED');
        return true;
      }),
      checkDeepSeekApiKey: vi.fn().mockReturnValue(true),
      generateWithDeepSeek: vi.fn().mockResolvedValue("Mocked DeepSeek Response from CHILD PROCESS"),
      generateEmbeddingWithDeepSeek: vi.fn().mockResolvedValue([0.5, 0.5, 0.5]),
    });
  });
} catch (e) {
  console.error('[mock-llm-child-setup] Error setting up deepseek.js mock:', e);
}

console.log('[mock-llm-child-setup] Preload script finished.');
