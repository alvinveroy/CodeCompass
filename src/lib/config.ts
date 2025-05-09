// This file is deprecated. Configuration is now managed by src/lib/config-service.ts
// Please update imports to use `configService` or `logger` from `config-service`.

// Global type declarations are still useful and can remain here or move to a .d.ts file.
// For now, keeping them here to avoid breaking existing global type checks.

// Declare global variables for TypeScript
// eslint-disable-next-line @typescript-eslint/no-unused-vars
interface _GlobalVars {
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
  var CURRENT_SUGGESTION_MODEL: string | undefined;
}
