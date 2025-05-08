import { logger, LLM_PROVIDER } from "./config";
import * as ollama from "./ollama";
import * as deepseek from "./deepseek";

// Interface for LLM Provider
export interface LLMProvider {
  checkConnection(): Promise<boolean>;
  generateText(prompt: string): Promise<string>;
  generateEmbedding(text: string): Promise<number[]>;
  processFeedback(originalPrompt: string, suggestion: string, feedback: string, score: number): Promise<string>;
}

// Ollama Provider Implementation
class OllamaProvider implements LLMProvider {
  async checkConnection(): Promise<boolean> {
    return await ollama.checkOllama();
  }

  async generateText(prompt: string): Promise<string> {
    return await ollama.generateSuggestion(prompt);
  }

  async generateEmbedding(text: string): Promise<number[]> {
    return await ollama.generateEmbedding(text);
  }

  async processFeedback(originalPrompt: string, suggestion: string, feedback: string, score: number): Promise<string> {
    return await ollama.processFeedback(originalPrompt, suggestion, feedback, score);
  }
}

// DeepSeek Provider Implementation
class DeepSeekProvider implements LLMProvider {
  async checkConnection(): Promise<boolean> {
    return await deepseek.testDeepSeekConnection();
  }

  async generateText(prompt: string): Promise<string> {
    return await deepseek.generateWithDeepSeek(prompt);
  }

  async generateEmbedding(text: string): Promise<number[]> {
    return await deepseek.generateEmbeddingWithDeepSeek(text);
  }

  async processFeedback(originalPrompt: string, suggestion: string, feedback: string, score: number): Promise<string> {
    // For DeepSeek, we'll just generate a new response with the feedback included in the prompt
    const feedbackPrompt = `You previously provided this response to a request:
    
Request: ${originalPrompt}

Your response:
${suggestion}

The user provided the following feedback (score ${score}/10):
${feedback}

Please provide an improved response addressing the user's feedback.`;
    
    return await this.generateText(feedbackPrompt);
  }
}

// Factory function to get the current LLM provider
export async function getLLMProvider(): Promise<LLMProvider> {
  switch (LLM_PROVIDER.toLowerCase()) {
    case 'deepseek':
      logger.info("Using DeepSeek as LLM provider");
      return new DeepSeekProvider();
    case 'ollama':
    default:
      logger.info("Using Ollama as LLM provider");
      return new OllamaProvider();
  }
}

// Function to switch LLM provider
export async function switchLLMProvider(provider: string): Promise<boolean> {
  if (provider.toLowerCase() !== 'ollama' && provider.toLowerCase() !== 'deepseek') {
    logger.error(`Invalid LLM provider: ${provider}. Valid options are 'ollama' or 'deepseek'`);
    return false;
  }
  
  // We're not actually changing the environment variable here, just logging what would happen
  logger.info(`Switching LLM provider to ${provider}`);
  logger.info(`To make this change permanent, set the LLM_PROVIDER environment variable to '${provider}'`);
  
  // Check if the new provider is available
  let available = false;
  if (provider.toLowerCase() === 'ollama') {
    available = await ollama.checkOllama();
  } else {
    available = await deepseek.testDeepSeekConnection();
  }
  
  if (!available) {
    logger.error(`The ${provider} provider is not available. Please check your configuration.`);
    return false;
  }
  
  return true;
}
