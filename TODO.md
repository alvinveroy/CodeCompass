# CodeCompass Context Improvement TODO List

This document outlines the tasks required to enhance CodeCompass's ability to provide comprehensive context to its AI agent, especially when dealing with large and complex git repositories.

## Task: Update Documentation & Create Unit Tests for Recent Enhancements (Agent Orchestration, Background Indexing, Git Hooks)

The following tasks are aimed at ensuring comprehensive documentation and robust testing for the recent major features: `agent_query` orchestration, background repository indexing with status reporting, and Git hook integration.

**Prioritization Key:**
*   **[P0]**: Highest priority - Critical for feature stability and understanding.
*   **[P1]**: Medium priority - Important for comprehensive coverage and usability.
*   **[P2]**: Lower priority - Refinements, edge cases, and less critical components.

---

### I. Documentation Updates

**A. Agent Orchestration (`agent_query`)**

*   **[P0] `src/lib/agent.ts`**:
    *   [ ] Update documentation to thoroughly describe its role as the primary orchestrator for the `agent_query` tool.
    *   [ ] Detail the logic of `runAgentQueryOrchestrator`, including:
        *   LLM-based planning and multi-step execution.
        *   Internal capability selection and invocation.
        *   Management and evolution of `AgentState` throughout the orchestration.
        *   How `agent_query` replaces the previous granular agent tools.
    *   [ ] Explain error handling mechanisms within the orchestration loop.
*   **[P0] `src/lib/agent_capabilities.ts`**:
    *   [ ] Ensure all internal capabilities (e.g., `capability_searchCodeSnippets`, `capability_getRepositoryOverview`, `capability_getChangelog`, `capability_fetchMoreSearchResults`, `capability_getFullFileContent`, `capability_listDirectory`, `capability_getAdjacentFileChunks`, `capability_generateSuggestionWithContext`, `capability_analyzeCodeProblemWithContext`) are accurately documented.
    *   [ ] For each capability, verify descriptions of its purpose, parameters (linking to or embedding Zod schema definitions from `src/lib/agent.ts` if helpful, as noted in `RETROSPECTION.md`), and return types.
    *   [ ] Clarify the structure and usage of the shared `CapabilityContext`.
*   **[P1] `src/lib/server.ts` (Agent Aspects)**:
    *   [ ] Document the registration of the single `agent_query` tool.
    *   [ ] Clearly state the removal/deprecation of granular tool registrations previously exposed to the LLM.
*   **[P1] `src/lib/types.ts` (Agent Aspects)**:
    *   [ ] Review and update documentation for `AgentState`, `AgentStep`, `ParsedToolCall`, and any related types to ensure they accurately reflect the current agent orchestration model and state management.
*   **[P2] `src/lib/agent-service.ts`**:
    *   [ ] Update documentation to reflect its current, possibly simplified, role in the agent architecture. Explicitly state that complex orchestration logic now resides in `src/lib/agent.ts`.

**B. Background Indexing & Status Reporting**

*   **[P0] `src/lib/repository.ts`**:
    *   [ ] Provide a comprehensive overview of the background repository indexing process flow (file listing, content indexing, commit indexing, stale entry cleaning).
    *   [ ] Document the `IndexingStatusReport` interface in detail, explaining each field (status, message, progress metrics like `totalFilesToIndex`, `filesIndexed`, `overallProgress`, etc.).
    *   [ ] Explain the functionality and usage of `getGlobalIndexingStatus()`.
    *   [ ] Describe how errors during indexing are handled and reflected in the status report.
    *   [ ] Document how the system prevents concurrent indexing runs.
*   **[P1] `src/lib/server.ts` (Indexing Aspects)**:
    *   [ ] Document the `/api/indexing-status` HTTP endpoint: its purpose, request/response format, and how it uses `getGlobalIndexingStatus()`.
    *   [ ] Document the `get_indexing_status` MCP tool: its purpose, parameters (if any), and response format.
    *   [ ] Explain that `indexRepository` is initiated asynchronously upon server startup.
    *   [ ] Document the `/api/repository/notify-update` endpoint: its role in triggering re-indexing (e.g., via Git hooks) and its interaction with the global indexing status to prevent concurrent runs.

**C. Git Hooks & .gitignore Management**

*   **[P1] `src/scripts/install-git-hooks.ts`**:
    *   [ ] Document the script's purpose: to install client-side Git hooks, specifically the `post-commit` hook.
    *   [ ] Explain its usage (e.g., `npm run setup:hooks`).
    *   [ ] Detail what the script does (e.g., creates `.git/hooks`, copies template, sets permissions).
*   **[P1] `src/templates/hooks/post-commit` (or general Git Hook documentation)**:
    *   [ ] Explain the `post-commit` hook's functionality: automatically notifying the CodeCompass server to re-index the repository after a commit.
    *   [ ] Provide clear instructions for users on how to customize the `SERVER_URL` within their local `post-commit` hook file if their server runs on a non-default host/port (addressing point from `RETROSPECTION.md`).
*   **[P2] `src/scripts/update-gitignore.ts`**:
    *   [ ] Briefly document its purpose and usage (e.g., `npm run setup:gitignore`), especially if it's part of the recommended developer setup for managing project-specific ignores.
*   **[P1] Project Setup Documentation (e.g., README.md)**:
    *   [ ] Add a dedicated section explaining how to set up and use the Git hooks for automatic repository synchronization.
    *   [ ] Mention the `npm run setup:hooks` command.

**D. General Documentation Review & Maintenance**

*   **[P1] Comprehensive Review**:
    *   [ ] Review all existing documentation files (especially those in `docs/source-files/` and any markdown files in the `src` tree) for consistency with the new agent orchestration, background indexing, and Git hook features.
    *   [ ] Pay special attention to `docs/source-files/src_lib_types.md`, `docs/source-files/src_lib_query-refinement.md`, and others mentioned in `RETROSPECTION.md` to ensure they align with current data structures and functionalities.
*   **[P1] Update Placeholders**:
    *   [ ] Systematically review `CHANGELOG.md` and `RETROSPECTION.md` to replace all `[GIT_COMMIT_ID_PLACEHOLDER]` or similar placeholders with actual Git commit IDs for the relevant changes.

---

### II. Unit Test Creation

**A. Agent Orchestration (`agent_query`)**

*   **[P0] `src/lib/agent.ts` (`agent_query` orchestrator - `runAgentQueryOrchestrator`)**:
    *   [ ] Test successful execution of a multi-step plan involving several capability calls.
    *   [ ] Test correct selection and invocation of internal capabilities (using mocks for actual capability logic).
    *   [ ] Verify accurate parameter construction and passing to mocked capabilities.
    *   [ ] Test proper accumulation and updating of context within `AgentState` across multiple steps.
    *   [ ] Test handling of various LLM responses (e.g., valid plan, request for capability call, final answer).
    *   [ ] Test error handling scenarios:
        *   An internal capability throws an error.
        *   The LLM returns an error or malformed response.
    *   [ ] Test enforcement of maximum agent loop steps (`AGENT_DEFAULT_MAX_STEPS`, `AGENT_ABSOLUTE_MAX_STEPS`).
*   **[P0] `src/lib/agent_capabilities.ts` (Individual Capabilities)**:
    *   [ ] For each internal capability (e.g., `capability_searchCodeSnippets`, `capability_getRepositoryOverview`, etc.):
        *   Create dedicated unit tests.
        *   Mock all external dependencies (LLM calls, Qdrant client, file system operations).
        *   Test with valid input parameters, verifying correct output/return values.
        *   Test with invalid or edge-case input parameters.
        *   Test internal error handling and reporting.
*   **[P1] `src/lib/server.ts` (Agent Tool Registration)**:
    *   [ ] Write a test to ensure the `agent_query` tool is correctly registered with the MCP server, including its schema and handler.

**B. Background Indexing & Status Reporting**

*   **[P0] `src/lib/repository.ts` (`indexRepository` and status management)**:
    *   [ ] Test that `indexRepository` correctly updates `currentIndexingStatus` through all its stages (mocking `git`, `qdrantClient`, `llmProvider`, and file system operations):
        *   `initializing`, `validating_repo`, `listing_files`, `cleaning_stale_entries`, `indexing_file_content`, `indexing_commits`, `completed`.
    *   [ ] Verify accurate calculation and reporting of progress metrics (`filesIndexed`, `totalFilesToIndex`, `commitsIndexed`, `totalCommitsToIndex`, `overallProgress`).
    *   [ ] Test behavior with an empty repository or a repository with no new changes to index.
    *   [ ] Test that errors encountered during any stage correctly set the status to `error` and populate `errorDetails`.
    *   [ ] Test `getGlobalIndexingStatus()` to ensure it returns an accurate copy of the current indexing status.
    *   [ ] Test the logic that prevents concurrent calls to `indexRepository` if it's managed within this module (e.g., by checking status before starting).
*   **[P1] `src/lib/server.ts` (Indexing API & Tool)**:
    *   [ ] Write integration tests for the `/api/indexing-status` HTTP endpoint (mocking `repository.getGlobalIndexingStatus`).
    *   [ ] Write integration tests for the `get_indexing_status` MCP tool (mocking `repository.getGlobalIndexingStatus`).
    *   [ ] Test the `/api/repository/notify-update` endpoint:
        *   Verify it successfully triggers `indexRepository` (mocked) when the system is idle.
        *   Verify it handles requests appropriately (e.g., logs a message, returns a specific status) when indexing is already in progress.

**C. Git Hooks & .gitignore Management**

*   **[P1] `src/scripts/install-git-hooks.ts`**:
    *   [ ] Test the script's core logic (mocking `fs-extra` and file system interactions):
        *   Ensures `.git/hooks` directory is created if it doesn't exist.
        *   Correctly copies hook template files to `.git/hooks`.
        *   Sets executable permissions on the copied hook files.
        *   Handles the scenario where the `.git` directory is not found gracefully.
*   **[P2] `post-commit` hook interaction (Conceptual/Partial Test)**:
    *   [ ] If feasible, unit test any core logic extracted from the `post-commit` shell script (e.g., if it were a Node.js script, or if parts of its notification logic could be isolated and tested).
    *   [ ] *Note: Full end-to-end testing of the shell-based `post-commit` hook is likely outside the scope of unit tests and may require manual or integration testing.*

---
