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
 * @returns JSON formatted log string
 */
function formatLogAsJson(level: string, message: unknown): string {
  const logObject = {
    type: "log",
    level,
    message: typeof message === 'object' ? JSON.stringify(message) : String(message),
    timestamp: new Date().toISOString()
  };
  return JSON.stringify(logObject);
}

/**
 * Initialize MCP-safe logging
 * Redirects all console output to the logger to avoid interfering with MCP protocol
 */
export function initMcpSafeLogging(): void {
  // Create logs directory if it doesn't exist
  const logsDir = path.join(process.cwd(), 'logs');
  try {
    if (!fs.existsSync(logsDir)) {
      fs.mkdirSync(logsDir, { recursive: true });
    }
  } catch (error) {
    // Silent fail - we'll try to log to file but won't crash if we can't
  }

  // Replace console methods to write directly to stdout as JSON
  console.log = (...args: unknown[]) => {
    const jsonStr = formatLogAsJson("debug", args[0] || {});
    process.stdout.write(jsonStr + '\n');
    
    // Also log to file
    try {
      const logStream = fs.createWriteStream(path.join(logsDir, 'codecompass.log'), { flags: 'a' });
      logStream.write(`${new Date().toISOString()} [DEBUG] ${args.map(arg => typeof arg === 'object' ? JSON.stringify(arg) : arg).join(' ')}\n`);
      logStream.end();
    } catch (error) {
      // Silent fail for file logging
    }
  };
  
  console.info = (...args: unknown[]) => {
    const jsonStr = formatLogAsJson("info", args[0] || {});
    process.stdout.write(jsonStr + '\n');
    
    // Also log to file
    try {
      const logStream = fs.createWriteStream(path.join(logsDir, 'codecompass.log'), { flags: 'a' });
      logStream.write(`${new Date().toISOString()} [INFO] ${args.map(arg => typeof arg === 'object' ? JSON.stringify(arg) : arg).join(' ')}\n`);
      logStream.end();
    } catch (error) {
      // Silent fail for file logging
    }
  };
  
  console.warn = (...args: unknown[]) => {
    const jsonStr = formatLogAsJson("warn", args[0] || {});
    process.stdout.write(jsonStr + '\n');
    
    // Also log to file
    try {
      const logStream = fs.createWriteStream(path.join(logsDir, 'codecompass.log'), { flags: 'a' });
      logStream.write(`${new Date().toISOString()} [WARN] ${args.map(arg => typeof arg === 'object' ? JSON.stringify(arg) : arg).join(' ')}\n`);
      logStream.end();
    } catch (error) {
      // Silent fail for file logging
    }
  };
  
  console.error = (...args: unknown[]) => {
    const jsonStr = formatLogAsJson("error", args[0] || {});
    process.stdout.write(jsonStr + '\n');
    
    // Also log to file
    try {
      const logStream = fs.createWriteStream(path.join(logsDir, 'codecompass.log'), { flags: 'a' });
      logStream.write(`${new Date().toISOString()} [ERROR] ${args.map(arg => typeof arg === 'object' ? JSON.stringify(arg) : arg).join(' ')}\n`);
      logStream.end();
    } catch (error) {
      // Silent fail for file logging
    }
  };
  
  console.debug = (...args: unknown[]) => {
    const jsonStr = formatLogAsJson("debug", args[0] || {});
    process.stdout.write(jsonStr + '\n');
    
    // Also log to file
    try {
      const logStream = fs.createWriteStream(path.join(logsDir, 'codecompass.log'), { flags: 'a' });
      logStream.write(`${new Date().toISOString()} [DEBUG] ${args.map(arg => typeof arg === 'object' ? JSON.stringify(arg) : arg).join(' ')}\n`);
      logStream.end();
    } catch (error) {
      // Silent fail for file logging
    }
  };
  
  // Redirect logging to a file instead of stdout
  // Note: We can't use logger.configure as it's not available
  // Instead, we'll use a custom file logger implementation
  
  // Store original logger methods
  const originalLoggerMethods = {
    debug: logger.debug,
    info: logger.info,
    warn: logger.warn,
    error: logger.error
  };

  // Override logger methods to write directly to stdout as JSON
  // We need to use any type here to bypass TypeScript's type checking
  // as we're doing something unconventional with the logger
  (logger.debug as any) = function(...args: any[]) {
    const jsonStr = formatLogAsJson("debug", args[0] || {});
    process.stdout.write(jsonStr + '\n');
    
    // Also log to file
    try {
      const logStream = fs.createWriteStream(path.join(process.cwd(), 'logs', 'codecompass.log'), { flags: 'a' });
      logStream.write(`${new Date().toISOString()} [DEBUG] ${args.map(arg => typeof arg === 'object' ? JSON.stringify(arg) : arg).join(' ')}\n`);
      logStream.end();
    } catch (error) {
      // Silent fail for file logging
    }
    
    return logger;
  };
  
  (logger.info as any) = function(...args: any[]) {
    const jsonStr = formatLogAsJson("info", args[0] || {});
    process.stdout.write(jsonStr + '\n');
    
    // Also log to file
    try {
      const logStream = fs.createWriteStream(path.join(process.cwd(), 'logs', 'codecompass.log'), { flags: 'a' });
      logStream.write(`${new Date().toISOString()} [INFO] ${args.map(arg => typeof arg === 'object' ? JSON.stringify(arg) : arg).join(' ')}\n`);
      logStream.end();
    } catch (error) {
      // Silent fail for file logging
    }
    
    return logger;
  };
  
  (logger.warn as any) = function(...args: any[]) {
    const jsonStr = formatLogAsJson("warn", args[0] || {});
    process.stdout.write(jsonStr + '\n');
    
    // Also log to file
    try {
      const logStream = fs.createWriteStream(path.join(process.cwd(), 'logs', 'codecompass.log'), { flags: 'a' });
      logStream.write(`${new Date().toISOString()} [WARN] ${args.map(arg => typeof arg === 'object' ? JSON.stringify(arg) : arg).join(' ')}\n`);
      logStream.end();
    } catch (error) {
      // Silent fail for file logging
    }
    
    return logger;
  };
  
  (logger.error as any) = function(...args: any[]) {
    const jsonStr = formatLogAsJson("error", args[0] || {});
    process.stdout.write(jsonStr + '\n');
    
    // Also log to file
    try {
      const logStream = fs.createWriteStream(path.join(process.cwd(), 'logs', 'codecompass.log'), { flags: 'a' });
      logStream.write(`${new Date().toISOString()} [ERROR] ${args.map(arg => typeof arg === 'object' ? JSON.stringify(arg) : arg).join(' ')}\n`);
      logStream.end();
    } catch (error) {
      // Silent fail for file logging
    }
    
    return logger;
  };
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
  
  // Write to file log
  const logStream = fs.createWriteStream(path.join(process.cwd(), 'logs', 'codecompass.log'), { flags: 'a' });
  logStream.write(`${new Date().toISOString()} [DEBUG] MCP ${direction}: ${JSON.stringify(logObject)}\n`);
  logStream.end();
  
  // Send properly formatted JSON to console
  console.log(JSON.stringify(logObject));
}
