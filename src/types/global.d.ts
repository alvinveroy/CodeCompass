declare global {
  namespace NodeJS {
    interface Global {
      CURRENT_LLM_PROVIDER: string;
      CURRENT_SUGGESTION_PROVIDER: string;
      CURRENT_EMBEDDING_PROVIDER: string;
      CURRENT_SUGGESTION_MODEL?: string;
    }
  }
  // eslint-disable-next-line no-var
  var CURRENT_LLM_PROVIDER: string;
  // eslint-disable-next-line no-var
  var CURRENT_SUGGESTION_PROVIDER: string;
  // eslint-disable-next-line no-var
  var CURRENT_EMBEDDING_PROVIDER: string;
  // eslint-disable-next-line no-var
  var CURRENT_SUGGESTION_MODEL: string | undefined;
}

// This file needs to be a module
export {};
