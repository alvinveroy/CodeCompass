import { logger } from "./config";
import { MAX_RETRIES, RETRY_DELAY, MAX_INPUT_LENGTH } from "./config";

// Utility: Retry logic
export async function withRetry<T>(fn: () => Promise<T>, retries = MAX_RETRIES): Promise<T> {
  for (let i = 0; i < retries; i++) {
    try {
      return await fn();
    } catch (error: any) {
      if (i === retries - 1) throw error;
      logger.warn(`Retry ${i + 1}/${retries} after error: ${error.message}`);
      await new Promise(resolve => setTimeout(resolve, RETRY_DELAY));
    }
  }
  throw new Error("Unreachable");
}

// Utility: Preprocess input text
export function preprocessText(text: string): string {
  text = text.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, "");
  text = text.replace(/\s+/g, (match) => {
    if (match.includes("\n")) return "\n";
    if (match.includes("\t")) return "\t";
    return " ";
  });
  return text.trim();
}
