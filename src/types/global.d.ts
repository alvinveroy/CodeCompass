// Global type declarations
declare global {
  namespace NodeJS {
    interface Global {
      CURRENT_LLM_PROVIDER: string;
      CURRENT_SUGGESTION_PROVIDER: string;
      CURRENT_EMBEDDING_PROVIDER: string;
      CURRENT_SUGGESTION_MODEL?: string;
    }
  }
}

// This file needs to be a module
export {};
