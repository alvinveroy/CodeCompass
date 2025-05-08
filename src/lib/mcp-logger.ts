import { logger } from "./config";

/**
 * Utility to help debug MCP protocol issues
 * This file provides functions to safely log without interfering with the MCP protocol
 */

// Store original console methods
const originalConsole = {
  log: console.log,
  info: console.info,
  warn: console.warn,
  error: console.error,
  debug: console.debug
};

/**
 * Initialize MCP-safe logging
 * Redirects all console output to the logger to avoid interfering with MCP protocol
 */
export function initMcpSafeLogging(): void {
  // Replace console methods to prevent them from writing to stdout/stderr
  console.log = (...args) => logger.debug(...args);
  console.info = (...args) => logger.info(...args);
  console.warn = (...args) => logger.warn(...args);
  console.error = (...args) => logger.error(...args);
  console.debug = (...args) => logger.debug(...args);
  
  // Configure logger to use a file instead of stdout
  logger.configure({
    appenders: {
      file: { type: 'file', filename: 'codecompass.log' }
    },
    categories: {
      default: { appenders: ['file'], level: 'debug' }
    }
  });
}

/**
 * Restore original console methods
 */
export function restoreConsole(): void {
  console.log = originalConsole.log;
  console.info = originalConsole.info;
  console.warn = originalConsole.warn;
  console.error = originalConsole.error;
  console.debug = originalConsole.debug;
}

/**
 * Log MCP protocol messages for debugging
 * @param direction 'sent' or 'received'
 * @param message The message content
 */
export function logMcpMessage(direction: 'sent' | 'received', message: any): void {
  logger.debug(`MCP ${direction}: ${typeof message === 'string' ? message : JSON.stringify(message)}`);
}
