# CodeCompass Context Improvement TODO List

This document outlines the tasks required to enhance CodeCompass's ability to provide comprehensive context to its AI agent, especially when dealing with large and complex git repositories.

## Prioritization Notes

The following prioritization aims to tackle foundational improvements first, building a solid base for more advanced features.

**Phase 1: Core Context Retrieval Enhancements (Highest Priority)**
1.  **P1 - Task Group 1 (Formerly Task 1): Increase Qdrant Search Result Limit.** (Focus: Get more raw data from existing index)
2.  **P2 - Task Group 2 (Formerly Task 3): Index Large Files (Chunking Strategy).** (Focus: Ensure all relevant code is indexed)
3.  **P3 - Task Group 3 (Formerly Task 2): Improve "Recent Changes" (Diff) Context.** (Focus: Provide meaningful change history)

**Phase 2: Smarter Agent Processing & Control**
*   Tasks related to how the agent uses and requests the improved context. (Formerly Section II)

**Phase 3: Configuration & Advanced Features**
*   Tasks related to making the system more flexible and adding sophisticated enhancements. (Formerly Section III and advanced items from Section II)

---

## Phase 1: Core Context Retrieval Enhancements

### P1 - Task Group 1: Increase Qdrant Search Result Limit
*Goal: Allow retrieval of more potential context from the vector store.*

*   [x] **Task 1.1:** Modify `src/lib/query-refinement.ts`:
    *   [x] Make the `limit` parameter in `qdrantClient.search()` calls configurable (e.g., read from `configService`).
    *   [ ] **Consider (Advanced):** Explore logic for the agent or refinement process to dynamically request a higher search limit if initial results are insufficient.
*   [x] **Task 1.2:** Update `src/lib/config-service.ts` (and potentially `src/lib/config.ts` or `.env` examples):
    *   [x] Add a new configuration variable for the default Qdrant search result limit (e.g., `QDRANT_SEARCH_LIMIT_DEFAULT`).

### P2 - Task Group 2: Index Large Files (Chunking Strategy)
*Goal: Ensure content from very large files is searchable.*

*   [x] **Task 2.1 (Formerly Task 3.1):** Modify `src/lib/repository.ts` (`indexRepository` function):
    *   [x] Instead of skipping files larger than `configService.MAX_SNIPPET_LENGTH * 10`, implement a file chunking mechanism.
    *   [x] Define a chunk size (e.g., `configService.MAX_SNIPPET_LENGTH`) with some overlap between chunks.
    *   [x] For each chunk, generate an embedding and upsert it to Qdrant.
    *   [x] The payload for each chunk should include:
        *   Original `filepath`.
        *   Chunk content.
        *   Chunk number / position within the original file.
        *   `last_modified` timestamp of the original file.
*   [x] **Task 2.2 (Formerly Task 3.2):** Modify `src/lib/agent.ts` and `src/lib/query-refinement.ts`:
    *   [x] When processing search results, if results are from chunked files, ensure the agent is aware (e.g., "This snippet is part of a larger file: [filename], chunk X of Y").
    *   [ ] Consider if query refinement or result presentation needs adjustment for chunked results (e.g., retrieving adjacent chunks if one is highly relevant).

### P3 - Task Group 3: Improve "Recent Changes" (Diff) Context
*Goal: Provide meaningful, content-based diff information.*

*   [x] **Task 3.1 (Formerly Task 2.1):** Modify `src/lib/repository.ts` (`getRepositoryDiff` function):
    *   [x] Change the implementation to fetch actual `git diff` content between the last two commits (e.g., using `isomorphic-git`'s diff capabilities or by shelling out to a `git diff` command). Ensure it returns the textual diff.
*   [x] **Task 3.2 (Formerly Task 2.2):** Modify `src/lib/agent.ts` (where `getRepositoryDiff` is called, likely within tool execution like `get_repository_context` or `generate_suggestion`):
    *   [x] If the fetched diff content is large, implement LLM-based summarization to create a concise overview of key changes.
    *   [x] Pass either the full diff (if manageable) or the summary to the agent's main prompt.
    *   [x] Update prompt assembly logic to correctly incorporate this richer diff information.

---

## Phase 2: Smarter Agent Processing & Control
*(Formerly Section II - Tasks renumbered for clarity within this phase)*

1.  **Task P2.1 (Formerly Task 4.1): Dynamic Context Presentation in Prompts:**
    *   [x] Modify `src/lib/agent.ts` (prompt generation logic for tools like `generate_suggestion` and the main agent loop):
        *   [x] For file lists: If the list of relevant files is long, use an LLM to summarize the list or select the N most relevant based on the query, instead of simple truncation (`files.slice(0, 10)`).
        *   [ ] For code snippets: If a retrieved snippet is very long (even after Qdrant retrieval, before being passed to the agent's reasoning LLM), consider an LLM call to summarize its essence in relation to the query.
        *   [ ] **Consider:** Allow the agent to explicitly request "more detail" or "full content" for a summarized item if it deems it necessary.

2.  **Task P2.2 (Formerly Task 5.1): Context-Aware Agent System Prompt:**
    *   [ ] Modify `src/lib/agent.ts` (`generateAgentSystemPrompt` function):
        *   [ ] Add instructions for the agent to self-assess the sufficiency of retrieved context relative to the query's scope.
        *   [ ] Guide the agent on how to react to insufficient context (e.g., "If initial search results are sparse or low-relevance for a broad query, consider using `get_repository_context` with a broader query, or explicitly request a wider search using `request_broader_context` tool if available.").

3.  **Task P2.3 (Advanced - Formerly Task 6.1): LLM-Powered Query Refinement:**
    *   [ ] Modify `src/lib/query-refinement.ts`:
        *   [ ] Design a new prompt for an LLM to perform query refinement. Input: original query, initial (poor) search results, (optional) high-level repository summary. Output: a refined query string.
        *   [ ] Integrate this LLM call into the `searchWithRefinement` loop as an alternative or supplement to the current rule-based refinement.
        *   [ ] Add necessary configuration for this LLM call (e.g., specific model, prompt template).

4.  **Task P2.4 (Advanced - Formerly Task 7.1-7.3): Explicit "Request More Context" Agent Tool:**
    *   [ ] Define a new tool in `src/lib/agent.ts` (in `toolRegistry` and `executeToolCall`):
        *   Name: e.g., `request_broader_context`.
        *   Parameters: e.g., `current_query: string`, `desired_context_type: enum("wider_search_results", "file_listing_for_module", "full_content_of_file", "dependencies_of_symbol")`, `target_identifier: string (e.g., module name, file path, symbol name)`.
    *   [ ] Implement the logic for `executeToolCall` for this new tool. This might involve:
        *   Re-running `searchWithRefinement` with an adjusted original query or increased search limit.
        *   Using `isomorphic-git` or file system operations to list files in a directory.
        *   Reading full file content.
        *   (More advanced) Integrating with a code analysis library to find dependencies.
    *   [ ] Update `generateAgentSystemPrompt` to inform the agent about this new tool and when to use it.

---

## Phase 3: Configuration, Flexibility & Validation
*(Formerly Section III and IV - Tasks renumbered)*

1.  **Task P3.1 (Formerly Task 8.1-8.3): Expose Key Parameters via `configService`:**
    *   [ ] Identify and list all new and existing parameters that should be user-configurable (e.g., Qdrant search limits, default/max agent steps, max refinement iterations, chunk sizes for large file indexing, LLM models for summarization/refinement).
    *   [ ] Add these to `src/lib/config.ts` (with defaults) and `src/lib/config-service.ts` to load them from environment variables or a config file.
    *   [ ] Update `README.md` and any example `.env` files with these new configuration options.

2.  **Task P3.2 (Formerly Task 9.1): Flexible Agent Loop Steps:**
    *   [ ] Modify `src/lib/agent.ts` (`runAgentLoop` function):
        *   [ ] Implement a mechanism for the agent's LLM to output a special token or instruction if it determines it needs more processing steps beyond the current `maxSteps`.
        *   [ ] If this instruction is received, and a global maximum hasn't been hit, allow the loop to continue for a few more iterations.

3.  **Task P3.3 (Formerly Task 10.1-10.3): Testing and Validation:**
    *   [ ] Develop test cases specifically for large repositories with diverse query types.
    *   [ ] Evaluate the impact of each implemented improvement on context quality and agent performance.
    *   [ ] Profile performance, especially for indexing large files and LLM-heavy operations (summarization, LLM-based refinement).

---

This list should provide a clear roadmap for these enhancements.
