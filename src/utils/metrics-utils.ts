import { performance } from 'perf_hooks';
import { logger } from "../lib/config-service";

/**
 * A higher-order function that wraps an asynchronous function to measure its execution time.
 * It logs the start, end (or failure), and duration of the wrapped function's execution.
 *
 * @template T - The type of the asynchronous function to wrap.
 * @param {T} fn - The asynchronous function to be wrapped with metrics logging.
 *                 It's expected to be a function that returns a Promise.
 * @returns A new asynchronous function that, when called, will execute the original function
 *          `fn` and log its performance metrics. The returned function has the same
 *          signature (parameters and return type) as `fn`.
 */
export function withMetrics<Args extends unknown[], Res>(
  fn: (...args: Args) => Promise<Res>
): (...args: Args) => Promise<Res> {
  return async (...args: Args): Promise<Res> => {
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
