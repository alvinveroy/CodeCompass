# CodeCompass Project TODOs

This file tracks pending tasks for the CodeCompass project.

## Phase 2: Documentation Generation (In Progress)

The following source files still need to be documented in the `docs/source-files/` directory. The list reflects files that have been added to the chat for this purpose.

### Pending Documentation:
-   [x] `docs/source-files/src_lib_agent.md` (for `src/lib/agent.ts`)
-   [x] `docs/source-files/src_lib_provider-cli.md` (for `src/lib/provider-cli.ts`)
-   [x] `docs/source-files/src_lib_query-refinement.md` (for `src/lib/query-refinement.ts`)
-   [x] `docs/source-files/src_lib_repository.md` (for `src/lib/repository.ts`)
-   [x] `docs/source-files/src_lib_server.md` (for `src/lib/server.ts`)
-   [x] `docs/source-files/src_lib_state.md` (for `src/lib/state.ts`)
-   [x] `docs/source-files/src_lib_suggestion-service.md` (for `src/lib/suggestion-service.ts`)
-   [x] `docs/source-files/src_lib_types.md` (for `src/lib/types.ts`)
-   [x] `docs/source-files/src_lib_version.md` (for `src/lib/version.ts`)
-   [x] `docs/source-files/src_utils_retry-utils.md` (for `src/utils/retry-utils.ts`)
-   [x] `docs/source-files/src_utils_metrics-utils.md` (for `src/utils/metrics-utils.ts`)
-   [x] `docs/source-files/src_scripts_set-deepseek-key.md` (for `src/scripts/set-deepseek-key.ts`)
-   [x] `docs/source-files/src_scripts_test-deepseek.md` (for `src/scripts/test-deepseek.ts`)
-   [x] `docs/source-files/src_scripts_version-bump.md` (for `src/scripts/version-bump.ts`)
-   [x] `docs/source-files/src_types_global.d.md` (for `src/types/global.d.ts`)
-   [x] `docs/source-files/src_tests_llm-provider.test.md` (for `src/tests/llm-provider.test.ts`)
-   [x] `docs/source-files/src_tests_utils.test.md` (for `src/tests/utils.test.ts`)
-   [x] `docs/source-files/src_tests_test-helpers.md` (for `src/tests/test-helpers.ts`)

### Completed Documentation (as of commit 8422802):
-   [x] `docs/source-files/README.md` (Overview of the documentation section)
-   [x] `docs/source-files/src_index.md`
-   [x] `docs/source-files/src_lib_config-service.md`
-   [x] `docs/source-files/src_lib_deepseek.md`
-   [x] `docs/source-files/src_lib_llm-provider.md`
-   [x] `docs/source-files/src_lib_ollama.md`
-   [x] `docs/source-files/src_lib_qdrant.md`
-   [x] `docs/source-files/src_utils_text-utils.md`

## Phase 1: Repository Cleanup (Partially Completed)

-   [x] Identified and removed unused dependencies (via `depcheck` - no issues found).
-   [x] Identified and removed/fixed unused variables and imports (via `eslint` and manual review - commit `d9da657`).
-   [x] Removed `src/lib/model-persistence.ts` (staged for commit).
-   [x] Investigate and resolve indexing error for removed file `src/lib/model-persistence.ts`. (Completed)
    -   [X] Initial investigation: Reviewed `indexRepository`. Hypothesis: error refers to stale data of `model-persistence.ts` in Qdrant index due to lack of deletion logic.
    -   [X] Implement deletion of stale entries from Qdrant in `indexRepository`. (Commit `fd79952`)
-   [x] Further analysis of test coverage report to identify and remove dead/unreachable code (this step was skipped by user request).
-   [x] Review directory structure for potential improvements (Analysis complete, see sub-task).
    -   [x] Consolidate utility functions: ensured `src/utils/` is the single source of truth for generic utilities (`withRetry` in `retry-utils.ts`, `preprocessText` in `text-utils.ts`, `withMetrics` in `metrics-utils.ts`). Removed `src/lib/utils.ts`. Imports across the codebase should be verified to point to these new locations.

## Future Considerations (Beyond Current Scope)

-   Address `@typescript-eslint/no-explicit-any` warnings.
-   Improve test coverage for files with low coverage percentages.
-   Review and potentially refactor complex functions for better maintainability.
