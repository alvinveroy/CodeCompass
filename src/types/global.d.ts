declare global {
  namespace NodeJS {
    interface Global {
      CURRENT_LLM_PROVIDER: string;
      CURRENT_SUGGESTION_PROVIDER: string;
      CURRENT_EMBEDDING_PROVIDER: string;
      CURRENT_SUGGESTION_MODEL?: string;
    }
  }
  var CURRENT_LLM_PROVIDER: string;
  var CURRENT_SUGGESTION_PROVIDER: string;
  var CURRENT_EMBEDDING_PROVIDER: string;
  var CURRENT_SUGGESTION_MODEL: string | undefined;
}

export {};
