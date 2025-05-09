import { logger } from "../lib/config";
import { MAX_RETRIES, RETRY_DELAY } from "../lib/config";

// Utility: Retry logic
export async function withRetry<T>(fn: () => Promise<T>, retries = MAX_RETRIES): Promise<T> {
  let lastError: Error | undefined;
  
  for (let i = 0; i < retries; i++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
      logger.warn(`Retry ${i + 1}/${retries} after error: ${lastError.message}`);
      
      if (i < retries - 1) {
        // Use exponential backoff for retries
        await new Promise(resolve => setTimeout(resolve, RETRY_DELAY * Math.pow(2, i)));
      }
    }
  }
  
  throw lastError || new Error("All retries failed");
}
