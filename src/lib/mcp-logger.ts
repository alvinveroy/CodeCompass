import { configService, logger } from "./config-service";
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
 * Format log message as JSON for MCP protocol using JSON-RPC 2.0 format
 * @param level Log level
 * @param message Message to log
 * @returns JSON formatted log string in JSON-RPC 2.0 format
 */
function formatLogAsJson(level: string, message: unknown): string {
  // Use JSON-RPC 2.0 format for compatibility with Claude Desktop
  const logObject = {
    jsonrpc: "2.0",
    method: "log",
    id: Date.now().toString(),
    params: {
      level,
      message: typeof message === 'object' ? JSON.stringify(message) : String(message),
      timestamp: new Date().toISOString()
    }
  };
  return JSON.stringify(logObject);
}

/**
 * Initialize MCP-safe logging
 * Redirects all console output to the logger to avoid interfering with MCP protocol
 */
export function initMcpSafeLogging(): void {
  // Create logs directory if it doesn't exist
  const logsDir = getLogsDir();

  // Replace console methods to write directly to stdout as JSON
  console.log = (...args: unknown[]) => {
    const jsonStr = formatLogAsJson("debug", args[0] || {});
    process.stdout.write(jsonStr + '\n');
    
    // Also log to file
    safeWriteToLog(`${new Date().toISOString()} [DEBUG] ${args.map(arg => typeof arg === 'object' ? JSON.stringify(arg) : arg).join(' ')}\n`);
  };
  
  console.info = (...args: unknown[]) => {
    const jsonStr = formatLogAsJson("info", args[0] || {});
    process.stdout.write(jsonStr + '\n');
    
    // Also log to file
    safeWriteToLog(`${new Date().toISOString()} [INFO] ${args.map(arg => typeof arg === 'object' ? JSON.stringify(arg) : arg).join(' ')}\n`);
  };
  
  console.warn = (...args: unknown[]) => {
    const jsonStr = formatLogAsJson("warn", args[0] || {});
    process.stdout.write(jsonStr + '\n');
    
    // Also log to file
    safeWriteToLog(`${new Date().toISOString()} [WARN] ${args.map(arg => typeof arg === 'object' ? JSON.stringify(arg) : arg).join(' ')}\n`);
  };
  
  console.error = (...args: unknown[]) => {
    const jsonStr = formatLogAsJson("error", args[0] || {});
    process.stdout.write(jsonStr + '\n');
    
    // Also log to file
    safeWriteToLog(`${new Date().toISOString()} [ERROR] ${args.map(arg => typeof arg === 'object' ? JSON.stringify(arg) : arg).join(' ')}\n`);
  };
  
  console.debug = (...args: unknown[]) => {
    const jsonStr = formatLogAsJson("debug", args[0] || {});
    process.stdout.write(jsonStr + '\n');
    
    // Also log to file
    safeWriteToLog(`${new Date().toISOString()} [DEBUG] ${args.map(arg => typeof arg === 'object' ? JSON.stringify(arg) : arg).join(' ')}\n`);
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
    safeWriteToLog(`${new Date().toISOString()} [DEBUG] ${args.map(arg => typeof arg === 'object' ? JSON.stringify(arg) : arg).join(' ')}\n`);
    
    return logger;
  };
  
  (logger.info as any) = function(...args: any[]) {
    const jsonStr = formatLogAsJson("info", args[0] || {});
    process.stdout.write(jsonStr + '\n');
    
    // Also log to file
    safeWriteToLog(`${new Date().toISOString()} [INFO] ${args.map(arg => typeof arg === 'object' ? JSON.stringify(arg) : arg).join(' ')}\n`);
    
    return logger;
  };
  
  (logger.warn as any) = function(...args: any[]) {
    const jsonStr = formatLogAsJson("warn", args[0] || {});
    process.stdout.write(jsonStr + '\n');
    
    // Also log to file
    safeWriteToLog(`${new Date().toISOString()} [WARN] ${args.map(arg => typeof arg === 'object' ? JSON.stringify(arg) : arg).join(' ')}\n`);
    
    return logger;
  };
  
  (logger.error as any) = function(...args: any[]) {
    const jsonStr = formatLogAsJson("error", args[0] || {});
    process.stdout.write(jsonStr + '\n');
    
    // Also log to file
    safeWriteToLog(`${new Date().toISOString()} [ERROR] ${args.map(arg => typeof arg === 'object' ? JSON.stringify(arg) : arg).join(' ')}\n`);
    
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
 * Get the logs directory path
 * @returns The logs directory path
 */
function getLogsDir(): string {
  // Use the LOG_DIR from ConfigService
  const logsDir = configService.LOG_DIR;
  
  // ConfigService constructor already ensures the directory exists.
  // We can add a check here for robustness if desired, but it might be redundant.
  try {
    if (!fs.existsSync(logsDir)) {
      // This case should ideally not be hit if ConfigService initialized correctly.
      fs.mkdirSync(logsDir, { recursive: true });
      logger.warn(`mcp-logger had to create LOG_DIR: ${logsDir}. This should have been done by ConfigService.`);
    }
  } catch (error) {
    // Fallback if something went wrong with the ConfigService LOG_DIR
    const fallbackDir = path.join(process.cwd(), 'logs_fallback_mcp');
    console.error(`Failed to ensure logs directory ${logsDir}: ${(error as Error).message}. Using fallback: ${fallbackDir}`);
    if (!fs.existsSync(fallbackDir)) {
      fs.mkdirSync(fallbackDir, { recursive: true });
    }
    return fallbackDir;
  }
  
  return logsDir;
}

/**
 * Safely write to log file
 * @param content Content to write to log file
 */
function safeWriteToLog(content: string): void {
  try {
    const logsDir = getLogsDir();
    const logPath = path.join(logsDir, 'codecompass.log');
    
    // Ensure we're not trying to write to an absolute path starting with /logs
    if (logPath.startsWith('/logs/')) {
      throw new Error(`Invalid log path: ${logPath}`);
    }
    
    const logStream = fs.createWriteStream(logPath, { flags: 'a' });
    logStream.write(content);
    logStream.end();
  } catch (error) {
    // Silent fail for file logging
    console.error(`Failed to write to log file: ${error}`);
  }
}

/**
 * Log MCP protocol messages for debugging
 * @param direction 'sent' or 'received'
 * @param message The message content
 */
export function logMcpMessage(direction: 'sent' | 'received', message: unknown): void {
  // Use JSON-RPC 2.0 format for compatibility with Claude Desktop
  const logObject = {
    jsonrpc: "2.0",
    method: "mcp_message",
    id: Date.now().toString(),
    params: {
      direction,
      content: typeof message === 'string' ? message : JSON.stringify(message),
      timestamp: new Date().toISOString()
    }
  };
  
  // Write to file log
  safeWriteToLog(`${new Date().toISOString()} [DEBUG] MCP ${direction}: ${JSON.stringify(logObject)}\n`);
  
  // Send properly formatted JSON to console
  console.log(JSON.stringify(logObject));
}
