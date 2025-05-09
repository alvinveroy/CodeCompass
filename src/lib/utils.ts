import { configService, logger } from "./config-service";

// Utility: Retry logic
export async function withRetry<T>(fn: () => Promise<T>, retries = configService.MAX_RETRIES): Promise<T> {
  let lastError: Error | undefined;
  
  for (let i = 0; i < retries; i++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
      logger.warn(`Retry ${i + 1}/${retries} after error: ${lastError.message}`);
      
      if (i < retries - 1) {
        // Use exponential backoff for retries
        await new Promise(resolve => setTimeout(resolve, configService.RETRY_DELAY * Math.pow(2, i)));
      }
    }
  }
  
  throw lastError || new Error("All retries failed");
}

// Utility: Preprocess input text
export function preprocessText(text: string): string {
  // eslint-disable-next-line no-control-regex
  text = text.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, "");
  text = text.replace(/\s+/g, (match) => {
    if (match.includes("\n")) return "\n";
    return " ";
  });
  return text.trim();
}
