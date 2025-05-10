# CodeCompass Project TODOs

This file tracks pending tasks for the CodeCompass project.

## Phase 2: Documentation Generation (In Progress)

The following source files still need to be documented in the `docs/source-files/` directory. The list reflects files that have been added to the chat for this purpose.

### Pending Documentation:
-   [ ] `docs/source-files/src_lib_agent.md` (for `src/lib/agent.ts`)
-   [ ] `docs/source-files/src_lib_provider-cli.md` (for `src/lib/provider-cli.ts`)
-   [ ] `docs/source-files/src_lib_query-refinement.md` (for `src/lib/query-refinement.ts`)
-   [ ] `docs/source-files/src_lib_repository.md` (for `src/lib/repository.ts`)
-   [ ] `docs/source-files/src_lib_server.md` (for `src/lib/server.ts`)
-   [ ] `docs/source-files/src_lib_state.md` (for `src/lib/state.ts`)
-   [ ] `docs/source-files/src_lib_suggestion-service.md` (for `src/lib/suggestion-service.ts`)
-   [ ] `docs/source-files/src_lib_types.md` (for `src/lib/types.ts`)
-   [ ] `docs/source-files/src_lib_utils.md` (for `src/lib/utils.ts`)
-   [ ] `docs/source-files/src_lib_version.md` (for `src/lib/version.ts`)
-   [ ] `docs/source-files/src_utils_retry-utils.md` (for `src/utils/retry-utils.ts`)

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
-   [ ] Investigate and resolve indexing error for removed file `src/lib/model-persistence.ts`.
-   [ ] Further analysis of test coverage report to identify and remove dead/unreachable code (this step was skipped by user request).
-   [ ] Review directory structure for potential improvements (not yet started).

## Future Considerations (Beyond Current Scope)

-   Address `@typescript-eslint/no-explicit-any` warnings.
-   Improve test coverage for files with low coverage percentages.
-   Review and potentially refactor complex functions for better maintainability.
