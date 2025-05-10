import { performance } from 'perf_hooks';
import { logger } from "../lib/config-service";

// Utility: Performance metrics wrapper
export function withMetrics<T extends (...args: any[]) => Promise<any>>(fn: T): 
  (...args: Parameters<T>) => Promise<ReturnType<T>> {
  return async (...args: Parameters<T>): Promise<ReturnType<T>> => {
    const functionName = fn.name || 'anonymousFunction';
    logger.debug(`Starting execution of ${functionName}`);
    const start = performance.now();
    try {
      const result = await fn(...args);
      const duration = performance.now() - start;
      logger.info(`Function ${functionName} executed in ${duration.toFixed(2)}ms`);
      return result;
    } catch (error) {
      const duration = performance.now() - start;
      logger.error(`Function ${functionName} failed after ${duration.toFixed(2)}ms`, { error });
      throw error;
    }
  };
}
