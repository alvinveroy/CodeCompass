import winston from "winston";

// Configuration
export const OLLAMA_HOST = process.env.OLLAMA_HOST || "http://127.0.0.1:11434";
export const QDRANT_HOST = process.env.QDRANT_HOST || "http://127.0.0.1:6333";
export const _COLLECTION_NAME = "codecompass";
export const _EMBEDDING_MODEL = process.env.EMBEDDING_MODEL || "nomic-embed-text:v1.5";
export const SUGGESTION_MODEL = process.env.SUGGESTION_MODEL || "llama3.1:8b";

// LLM Provider Configuration
export const LLM_PROVIDER = process.env.LLM_PROVIDER || "ollama"; // "ollama" or "deepseek"
export const DEEPSEEK_API_KEY = process.env.DEEPSEEK_API_KEY || "";
export const DEEPSEEK_API_URL = process.env.DEEPSEEK_API_URL || "https://api.deepseek.com/chat/completions";
export const DEEPSEEK_MODEL = process.env.DEEPSEEK_MODEL || "deepseek-coder";

// Mixed Provider Configuration
export const USE_MIXED_PROVIDERS = process.env.USE_MIXED_PROVIDERS === "true" || false;
export const SUGGESTION_PROVIDER = process.env.SUGGESTION_PROVIDER || process.env.LLM_PROVIDER || "ollama";
export const EMBEDDING_PROVIDER = process.env.EMBEDDING_PROVIDER || "ollama";

// Declare global variables for TypeScript
// This interface is for type checking only
interface GlobalVars {
  CURRENT_LLM_PROVIDER: string;
  CURRENT_SUGGESTION_PROVIDER: string;
  CURRENT_EMBEDDING_PROVIDER: string;
  CURRENT_SUGGESTION_MODEL?: string;
}

declare global {
  // eslint-disable-next-line no-var
  var CURRENT_LLM_PROVIDER: string;
  // eslint-disable-next-line no-var
  var CURRENT_SUGGESTION_PROVIDER: string;
  // eslint-disable-next-line no-var
  var CURRENT_EMBEDDING_PROVIDER: string;
  // eslint-disable-next-line no-var
  var CURRENT_SUGGESTION_MODEL?: string;
  
  namespace NodeJS {
    interface Global {
      CURRENT_LLM_PROVIDER: string;
      CURRENT_SUGGESTION_PROVIDER: string;
      CURRENT_EMBEDDING_PROVIDER: string;
      CURRENT_SUGGESTION_MODEL?: string;
    }
  }
}

// Initialize global provider state
global.CURRENT_LLM_PROVIDER = process.env.LLM_PROVIDER || LLM_PROVIDER;
global.CURRENT_SUGGESTION_PROVIDER = process.env.SUGGESTION_PROVIDER || process.env.LLM_PROVIDER || LLM_PROVIDER;
global.CURRENT_EMBEDDING_PROVIDER = process.env.EMBEDDING_PROVIDER || "ollama";

// Request Configuration
export const MAX_INPUT_LENGTH = 4096;
export const MAX_SNIPPET_LENGTH = 500;
export const REQUEST_TIMEOUT = 120000; // 120 seconds timeout for API requests
export const MAX_RETRIES = 3; // Maximum number of retries for API requests
export const RETRY_DELAY = 2000; // Delay between retries in milliseconds

// Setup Winston logger
export const logger = winston.createLogger({
  level: process.env.NODE_ENV === "test" ? "error" : "info",
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.json()
  ),
  transports: [
    new winston.transports.File({ filename: "codecompass.log" }),
    new winston.transports.Console({
      format: winston.format.simple(),
      silent: process.env.NODE_ENV === "test"
    }),
  ],
});
