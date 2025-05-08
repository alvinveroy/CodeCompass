import { describe, it, expect, beforeEach, afterEach, vi, Mock } from 'vitest';
import { switchLLMProvider, getLLMProvider } from '../lib/llm-provider';
import * as ollama from '../lib/ollama';
import * as deepseek from '../lib/deepseek';

// Mock the dependencies
vi.mock('../lib/ollama', () => ({
  checkOllama: vi.fn(),
  generateSuggestion: vi.fn(),
  generateEmbedding: vi.fn(),
  processFeedback: vi.fn()
}));

vi.mock('../lib/deepseek', () => ({
  testDeepSeekConnection: vi.fn(),
  generateWithDeepSeek: vi.fn(),
  generateEmbeddingWithDeepSeek: vi.fn()
}));

describe('LLM Provider', () => {
  const originalEnv = { ...process.env };
  
  beforeEach(() => {
    // Reset mocks before each test
    vi.resetAllMocks();
    
    // Reset environment variables
    process.env = { ...originalEnv };
    delete process.env.LLM_PROVIDER;
  });
  
  afterEach(() => {
    // Restore environment variables
    process.env = { ...originalEnv };
  });
  
  describe('switchLLMProvider', () => {
    it('should switch to deepseek provider and update environment variable', async () => {
      // Mock the DeepSeek connection test to return true
      (deepseek.testDeepSeekConnection as Mock).mockResolvedValue(true);
      
      // Call the function to switch to DeepSeek
      const result = await switchLLMProvider('deepseek');
      
      // Verify the result is true (success)
      expect(result).toBe(true);
      
      // Verify the environment variable was updated
      expect(process.env.LLM_PROVIDER).toBe('deepseek');
      
      // Verify the DeepSeek connection was tested
      expect(deepseek.testDeepSeekConnection).toHaveBeenCalled();
      
      // Verify Ollama connection was not tested
      expect(ollama.checkOllama).not.toHaveBeenCalled();
    });
    
    it('should switch to ollama provider and update environment variable', async () => {
      // Mock the Ollama connection test to return true
      (ollama.checkOllama as Mock).mockResolvedValue(true);
      
      // Call the function to switch to Ollama
      const result = await switchLLMProvider('ollama');
      
      // Verify the result is true (success)
      expect(result).toBe(true);
      
      // Verify the environment variable was updated
      expect(process.env.LLM_PROVIDER).toBe('ollama');
      
      // Verify the Ollama connection was tested
      expect(ollama.checkOllama).toHaveBeenCalled();
      
      // Verify DeepSeek connection was not tested
      expect(deepseek.testDeepSeekConnection).not.toHaveBeenCalled();
    });
    
    it('should return false for invalid provider', async () => {
      // Call the function with an invalid provider
      const result = await switchLLMProvider('invalid');
      
      // Verify the result is false (failure)
      expect(result).toBe(false);
      
      // Verify the environment variable was not updated
      expect(process.env.LLM_PROVIDER).toBeUndefined();
      
      // Verify no connection tests were called
      expect(ollama.checkOllama).not.toHaveBeenCalled();
      expect(deepseek.testDeepSeekConnection).not.toHaveBeenCalled();
    });
    
    it('should return false if provider is unavailable', async () => {
      // Mock the DeepSeek connection test to return false
      (deepseek.testDeepSeekConnection as Mock).mockResolvedValue(false);
      
      // Call the function to switch to DeepSeek
      const result = await switchLLMProvider('deepseek');
      
      // Verify the result is false (failure)
      expect(result).toBe(false);
      
      // Verify the environment variable was still updated
      expect(process.env.LLM_PROVIDER).toBe('deepseek');
      
      // Verify the DeepSeek connection was tested
      expect(deepseek.testDeepSeekConnection).toHaveBeenCalled();
    });
  });
  
  describe('getLLMProvider', () => {
    it('should return DeepSeek provider when LLM_PROVIDER is set to deepseek', async () => {
      // Set the environment variable
      process.env.LLM_PROVIDER = 'deepseek';
      
      // Mock the DeepSeek connection test
      (deepseek.testDeepSeekConnection as Mock).mockResolvedValue(true);
      
      // Get the provider
      const provider = await getLLMProvider();
      
      // Verify the provider is DeepSeek by checking its methods
      expect(provider).toBeDefined();
      expect(typeof provider.checkConnection).toBe('function');
      expect(typeof provider.generateText).toBe('function');
      expect(typeof provider.generateEmbedding).toBe('function');
      
      // Call a method to verify it uses DeepSeek
      await provider.checkConnection();
      expect(deepseek.testDeepSeekConnection).toHaveBeenCalled();
      expect(ollama.checkOllama).not.toHaveBeenCalled();
    });
    
    it('should return Ollama provider when LLM_PROVIDER is set to ollama', async () => {
      // Set the environment variable
      process.env.LLM_PROVIDER = 'ollama';
      
      // Mock the Ollama connection test
      (ollama.checkOllama as Mock).mockResolvedValue(true);
      
      // Get the provider
      const provider = await getLLMProvider();
      
      // Verify the provider is Ollama by checking its methods
      expect(provider).toBeDefined();
      expect(typeof provider.checkConnection).toBe('function');
      expect(typeof provider.generateText).toBe('function');
      expect(typeof provider.generateEmbedding).toBe('function');
      
      // Call a method to verify it uses Ollama
      await provider.checkConnection();
      expect(ollama.checkOllama).toHaveBeenCalled();
      expect(deepseek.testDeepSeekConnection).not.toHaveBeenCalled();
    });
    
    it('should use environment variable over imported constant', async () => {
      // Set the environment variable to deepseek
      process.env.LLM_PROVIDER = 'deepseek';
      
      // Mock the DeepSeek connection test
      (deepseek.testDeepSeekConnection as Mock).mockResolvedValue(true);
      
      // Get the provider
      const provider = await getLLMProvider();
      
      // Call a method to verify it uses DeepSeek
      await provider.checkConnection();
      expect(deepseek.testDeepSeekConnection).toHaveBeenCalled();
      expect(ollama.checkOllama).not.toHaveBeenCalled();
    });
  });
});
