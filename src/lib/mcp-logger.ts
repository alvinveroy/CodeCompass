import { logger } from "./config";
import fs from 'fs';
import path from 'path';

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
 * Format log message as JSON for MCP protocol
 * @param level Log level
 * @param message Message to log
 * @returns JSON formatted log object
 */
function formatLogAsJson(level: string, message: unknown): object {
  return {
    type: "log",
    level,
    message: typeof message === 'object' ? JSON.stringify(message) : String(message),
    timestamp: new Date().toISOString()
  };
}

/**
 * Initialize MCP-safe logging
 * Redirects all console output to the logger to avoid interfering with MCP protocol
 */
export function initMcpSafeLogging(): void {
  // Replace console methods to prevent them from writing to stdout/stderr
  // and ensure they output valid JSON
  console.log = (...args: unknown[]) => logger.debug(formatLogAsJson("debug", args[0] || {}));
  console.info = (...args: unknown[]) => logger.info(formatLogAsJson("info", args[0] || {}));
  console.warn = (...args: unknown[]) => logger.warn(formatLogAsJson("warn", args[0] || {}));
  console.error = (...args: unknown[]) => logger.error(formatLogAsJson("error", args[0] || {}));
  console.debug = (...args: unknown[]) => logger.debug(formatLogAsJson("debug", args[0] || {}));
  
  // Redirect logging to a file instead of stdout
  // Note: We can't use logger.configure as it's not available
  // Instead, we'll use a custom file logger implementation
  
  // Create logs directory if it doesn't exist
  const logsDir = path.join(process.cwd(), 'logs');
  
  try {
    if (!fs.existsSync(logsDir)) {
      fs.mkdirSync(logsDir, { recursive: true });
    }
    
    // Set up file logging
    const logFile = path.join(logsDir, 'codecompass.log');
    const logStream = fs.createWriteStream(logFile, { flags: 'a' });
    
    // Override logger methods to write to file and ensure proper JSON formatting for MCP
    const originalDebug = logger.debug;
    const originalInfo = logger.info;
    const originalWarn = logger.warn;
    const originalError = logger.error;
    
    logger.debug = (...args) => {
      const message = args.map(arg => typeof arg === 'object' ? JSON.stringify(arg) : arg).join(' ');
      logStream.write(`${new Date().toISOString()} [DEBUG] ${message}\n`);
      
      // Format as JSON for MCP protocol
      const jsonMessage = formatLogAsJson("debug", args[0] || {});
      return originalDebug.call(logger, jsonMessage);
    };
    
    logger.info = (...args) => {
      const message = args.map(arg => typeof arg === 'object' ? JSON.stringify(arg) : arg).join(' ');
      logStream.write(`${new Date().toISOString()} [INFO] ${message}\n`);
      
      // Format as JSON for MCP protocol
      const jsonMessage = formatLogAsJson("info", args[0] || {});
      return originalInfo.call(logger, jsonMessage);
    };
    
    logger.warn = (...args) => {
      const message = args.map(arg => typeof arg === 'object' ? JSON.stringify(arg) : arg).join(' ');
      logStream.write(`${new Date().toISOString()} [WARN] ${message}\n`);
      
      // Format as JSON for MCP protocol
      const jsonMessage = formatLogAsJson("warn", args[0] || {});
      return originalWarn.call(logger, jsonMessage);
    };
    
    logger.error = (...args) => {
      const message = args.map(arg => typeof arg === 'object' ? JSON.stringify(arg) : arg).join(' ');
      logStream.write(`${new Date().toISOString()} [ERROR] ${message}\n`);
      
      // Format as JSON for MCP protocol
      const jsonMessage = formatLogAsJson("error", args[0] || {});
      return originalError.call(logger, jsonMessage);
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
  const logObject = {
    type: "mcp_message",
    direction,
    content: typeof message === 'string' ? message : JSON.stringify(message),
    timestamp: new Date().toISOString()
  };
  logger.debug(logObject);
}
