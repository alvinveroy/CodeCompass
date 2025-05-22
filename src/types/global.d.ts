declare global {
  namespace NodeJS {
    interface Global {
      CURRENT_LLM_PROVIDER?: string; // Make optional
      CURRENT_SUGGESTION_PROVIDER?: string; // Make optional
      CURRENT_EMBEDDING_PROVIDER?: string; // Make optional
      CURRENT_SUGGESTION_MODEL?: string;
    }
  }
  var CURRENT_LLM_PROVIDER: string | undefined; // Make optional
  var CURRENT_SUGGESTION_PROVIDER: string | undefined; // Make optional
  var CURRENT_EMBEDDING_PROVIDER: string | undefined; // Make optional
  var CURRENT_SUGGESTION_MODEL: string | undefined;
}

export {};
