# Documentation for `src/types/global.d.ts`

This document provides an overview and explanation of the `src/types/global.d.ts` file.

## Purpose

The `global.d.ts` file is a TypeScript declaration file used to extend the global scope. In the CodeCompass project, it augments the `NodeJS.Global` interface and also declares several variables directly under the `global` object (which is equivalent to `globalThis` in Node.js environments). This allows these variables to be accessed and modified anywhere in the application without needing explicit imports. They primarily serve to hold runtime-configurable aspects of the application's LLM provider and model settings.

## Global Declarations

The file uses `declare global { ... }` to introduce new properties to the global namespace.

```typescript
declare global {
  // Extends the NodeJS.Global interface, making these properties
  // available on `global` in a type-safe way for Node.js environments.
  namespace NodeJS {
    interface Global {
      CURRENT_LLM_PROVIDER: string;
      CURRENT_SUGGESTION_PROVIDER: string;
      CURRENT_EMBEDDING_PROVIDER: string;
      CURRENT_SUGGESTION_MODEL?: string; // Optional property
    }
  }

  // Directly declares these variables at the global scope.
  // This ensures they are recognized by TypeScript even outside
  // strict Node.js `global` object access, for example, if accessed via `globalThis`.
  var CURRENT_LLM_PROVIDER: string;
  var CURRENT_SUGGESTION_PROVIDER: string;
  var CURRENT_EMBEDDING_PROVIDER: string;
  var CURRENT_SUGGESTION_MODEL: string | undefined; // Type matches the optional nature
}

// `export {};` is necessary to ensure this file is treated as a module
// by TypeScript, which allows the `declare global` augmentation.
// Without it, the file would be treated as a script, and `declare global`
// would not have the intended effect of augmenting the global scope.
export {};
```

### Defined Global Variables:

These variables can be accessed via `global.VARIABLE_NAME` or `globalThis.VARIABLE_NAME`.

-   `CURRENT_LLM_PROVIDER: string`:
    Stores the identifier (e.g., 'ollama', 'deepseek', 'openai') for the LLM provider that is currently active for general LLM tasks. This can be dynamically changed at runtime.

-   `CURRENT_SUGGESTION_PROVIDER: string`:
    Stores the identifier for the LLM provider specifically designated for generating code suggestions. This allows using a different provider for suggestions than for other LLM tasks if desired.

-   `CURRENT_EMBEDDING_PROVIDER: string`:
    Stores the identifier for the LLM provider used for generating embeddings (e.g., 'ollama').

-   `CURRENT_SUGGESTION_MODEL?: string` (declared as `string | undefined` for the `var`):
    Stores the identifier for the specific language model to be used for suggestions (e.g., 'llama3.1:8b', 'deepseek-coder', 'gpt-4'). This is optional; if not set, a default model from the `CURRENT_SUGGESTION_PROVIDER` might be used.

## Usage Context

These global variables are primarily intended to be read and updated by the `ConfigService`. The `ConfigService` provides getter methods that first check if these global variables are set (e.g., `global.CURRENT_LLM_PROVIDER`). If they are, the global value is returned; otherwise, a default value from the service's internal configuration (potentially loaded from environment variables or a config file) is used.

This mechanism allows for dynamic, application-wide changes to the active LLM providers and models, for example, through an MCP tool like `switch_suggestion_model`. When such a tool is invoked, it updates these global variables, and subsequent calls to `ConfigService` for provider/model information will reflect these changes for the duration of the application's runtime or until changed again.

**Example from `ConfigService` (illustrative):**
```typescript
// Inside ConfigService class
public get LLM_PROVIDER(): string {
  return global.CURRENT_LLM_PROVIDER || this._llmProviderFromConfig; // _llmProviderFromConfig is an internal default
}

public get SUGGESTION_MODEL(): string | undefined {
  return global.CURRENT_SUGGESTION_MODEL || this._suggestionModelFromConfig; // _suggestionModelFromConfig is an internal default
}
```

Using global variables in this manner provides a flexible way to manage runtime configuration that can be altered dynamically without needing to restart the application or pass configuration objects through many layers of the codebase. The `export {}` ensures module context, which is standard practice for ambient declaration files that modify global scope.
