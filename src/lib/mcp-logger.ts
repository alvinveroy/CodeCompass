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
  
  // Redirect logging to a file instead of stdout
  // Note: We can't use logger.configure as it's not available
  // Instead, we'll use a custom file logger implementation
  
  // Create logs directory if it doesn't exist
  import * as fs from 'fs';
  import * as path from 'path';
  const logsDir = path.join(process.cwd(), 'logs');
  
  try {
    if (!fs.existsSync(logsDir)) {
      fs.mkdirSync(logsDir, { recursive: true });
    }
    
    // Set up file logging
    const logFile = path.join(logsDir, 'codecompass.log');
    const logStream = fs.createWriteStream(logFile, { flags: 'a' });
    
    // Override logger methods to write to file
    const originalDebug = logger.debug;
    const originalInfo = logger.info;
    const originalWarn = logger.warn;
    const originalError = logger.error;
    
    logger.debug = (...args) => {
      const message = args.map(arg => typeof arg === 'object' ? JSON.stringify(arg) : arg).join(' ');
      logStream.write(`${new Date().toISOString()} [DEBUG] ${message}\n`);
      // Call the original function with the first argument or an empty object
      return originalDebug.call(logger, args[0] || {});
    };
    
    logger.info = (...args) => {
      const message = args.map(arg => typeof arg === 'object' ? JSON.stringify(arg) : arg).join(' ');
      logStream.write(`${new Date().toISOString()} [INFO] ${message}\n`);
      // Call the original function with the first argument or an empty object
      return originalInfo.call(logger, args[0] || {});
    };
    
    logger.warn = (...args) => {
      const message = args.map(arg => typeof arg === 'object' ? JSON.stringify(arg) : arg).join(' ');
      logStream.write(`${new Date().toISOString()} [WARN] ${message}\n`);
      // Call the original function with the first argument or an empty object
      return originalWarn.call(logger, args[0] || {});
    };
    
    logger.error = (...args) => {
      const message = args.map(arg => typeof arg === 'object' ? JSON.stringify(arg) : arg).join(' ');
      logStream.write(`${new Date().toISOString()} [ERROR] ${message}\n`);
      // Call the original function with the first argument or an empty object
      return originalError.call(logger, args[0] || {});
    };
  } catch (error) {
    console.error("Failed to set up file logging:", error);
  }
}

/**
 * Restore original console methods
 */
export function _restoreConsole(): void {
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
export function logMcpMessage(direction: 'sent' | 'received', message: unknown): void {
  logger.debug(`MCP ${direction}: ${typeof message === 'string' ? message : JSON.stringify(message)}`);
}
