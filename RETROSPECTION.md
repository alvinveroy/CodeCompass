# Retrospection for Background Indexing & Status Reporting (Git Commit ID: [Previous Git Commit ID])

## What went well?
- The plan to centralize status management within `src/lib/repository.ts` and have `src/lib/server.ts` consume it is a good architectural improvement. It decouples status logic from the server's main operational code.
- Identifying the need for detailed progress points (e.g., `totalFilesToIndex`, `filesIndexed`) within the `IndexingStatusReport` will provide much better feedback to the user.
- The changes made `src/lib/repository.ts` more informative about its internal state during the long-running indexing process.

## What could be improved?
- The initial implementation in `src/lib/server.ts` used local global variables for status, which was a temporary measure. Directly implementing the more robust solution (status managed in `repository.ts`) from the start would have saved a refactoring step. This highlights the importance of thinking through state management for long-running background tasks early on.
- The progress calculation (e.g., `overallProgress`) is somewhat heuristic (e.g., file indexing 20-70%, commit indexing 70-95%). While acceptable for a first pass, a more precise calculation based on actual work units (e.g., bytes processed, number of embeddings generated) could be considered for future enhancements if finer-grained accuracy is needed.
- Error handling within `indexRepository` and `indexCommitsAndDiffs` now updates the global status. It's important to ensure that all critical failure paths correctly set an 'error' status with appropriate details.

## What did we learn?
- For long-running background tasks like repository indexing, providing clear status and progress is crucial for user experience and diagnosability, especially to avoid timeout perceptions.
- Encapsulating state management for such tasks within the module responsible for the task (e.g., `repository.ts` for indexing status) leads to cleaner code and better separation of concerns.
- When dealing with asynchronous operations that update a shared status, ensuring that status updates are atomic or at least consistently reflect the current state is important. The current approach of returning a copy of the status object in `getGlobalIndexingStatus` is a good practice.
- The `HTTP_PORT` configuration was correctly identified and added to `ConfigService`, demonstrating good attention to making server components configurable.

## Action Items / Follow-ups
- Thoroughly test the indexing process with various repository sizes to ensure progress reporting is accurate and responsive.
- Review all error handling paths within `indexRepository` and `indexCommitsAndDiffs` to confirm they correctly update `currentIndexingStatus` to an error state with meaningful `errorDetails`.
- Consider if the `overallProgress` calculation can be made more precise in future iterations.
- Ensure that the `CHANGELOG.md` and `RETROSPECTION.md` files are committed with the correct Git commit ID once these changes are finalized and committed.

# Retrospection for Git Hooks & .gitignore Management (Git Commit ID: [GIT_COMMIT_ID_PLACEHOLDER])

## What went well?
- The implementation of helper scripts (`update-gitignore.ts`, `install-git-hooks.ts`) provides a clean and maintainable way for users to set up these features.
- The `post-commit` hook is straightforward and effectively triggers server-side re-indexing via an HTTP POST request.
- Adding `CHANGELOG.md` and `RETROSPECTION.md` to `.gitignore` via the script ensures these developer-centric files are not accidentally committed by users of the project as a library, if they run the script in their own consuming project.
- The use of `fs-extra` simplifies file operations in `install-git-hooks.ts`.
- Standard output (`process.stdout.write`, `process.stderr.write`) is used in scripts for better control over output streams, which is good practice for CLI tools.

## What could be improved?
- The `post-commit` hook currently sends the notification in the background (`&`). While this prevents blocking the commit, it also means the user doesn't get immediate feedback on whether the notification was successfully *received* by the server. For local development, this is usually fine.
- The server URL in the `post-commit` hook is hardcoded. While `localhost:3001` is a reasonable default, a more advanced setup might allow users to configure this if their CodeCompass server runs on a different host or port. This could be managed via a local Git config setting, for example.
- The scripts assume a Node.js environment for execution. While this is consistent with the project, providing pure shell script alternatives for installing hooks might be beneficial for some users, though `ts-node` is already a project dependency.

## What did we learn?
- Providing clear setup scripts (`npm run setup:gitignore`, `npm run setup:hooks`) significantly improves the developer experience for optional features like Git hooks.
- Client-side Git hooks are a powerful way to automate interactions with a development server, but their setup needs to be as simple as possible for users.
- Managing `.gitignore` programmatically helps enforce project conventions and reduce clutter in repositories.

## Action Items / Follow-ups
- Consider adding an optional verbose mode to the `post-commit` hook that waits for the server's response and prints it, for users who want more feedback.
- Document how users can modify the `SERVER_URL` in their local `post-commit` hook if needed.
- Ensure the `fs-extra` dependency is clearly documented or handled if these scripts are intended to be run by end-users in diverse environments (though for this project, it's a dev dependency used by project scripts).

# Retrospection for Documentation Update (src_lib_types.md) (Git Commit ID: [GIT_COMMIT_ID_PLACEHOLDER])

## What went well?
- The review identified significant discrepancies between the existing documentation for `src/lib/types.ts` and its current implementation, particularly concerning Qdrant payload structures and agent types.
- The updated documentation now accurately reflects the new typed payloads (`FileChunkPayload`, `CommitInfoPayload`, `DiffChunkPayload`) and their usage in `QdrantPoint` and search result interfaces.
- Changes to agent-related Zod schemas and TypeScript interfaces are also correctly documented.

## What could be improved?
- Keeping documentation in sync with rapid code changes is challenging. A more automated or semi-automated approach to generating or validating type documentation from TSDoc comments or Zod schemas could be explored in the future to reduce manual effort and potential for staleness.

## What did we learn?
- Accurate type definitions are crucial for understanding data flow and ensuring correctness, and their documentation is equally important for developers using or maintaining the codebase.
- Refactoring data structures (like Qdrant payloads) has a cascading effect on documentation that needs to be managed proactively.

## Action Items / Follow-ups
- Continue reviewing and updating other documentation files to ensure they align with the latest code changes.
- Consider tools or processes for better documentation synchronization with code, especially for type definitions.

# Retrospection for Documentation (src_lib_agent-service.md) (Git Commit ID: 2a22fba)

## What went well?
- The documentation for `src/lib/agent-service.ts` was created, accurately reflecting its current, more focused role.
- The core logic of query processing (search -> context -> LLM) is clearly described.
- The `formatQdrantResultForContext` helper function's role in preparing context for the LLM is highlighted.

## What could be improved?
- The documentation could explicitly state that `agent-service.ts` is now a simpler component and that the complex orchestration logic resides in `agent.ts`. This would help developers understand the separation of concerns.

## What did we learn?
- As codebases evolve and responsibilities shift between modules (e.g., complex agent logic moving from `agent-service.ts` to `agent.ts`), documentation needs to be updated not just for the modified files but also for files whose roles have been simplified or changed.

## Action Items / Follow-ups
- Proceed with updating the documentation for `src/lib/agent.ts` to reflect its new role as the primary orchestrator.

# Retrospection for Documentation (src_lib_agent_capabilities.md) (Git Commit ID: [GIT_COMMIT_ID_PLACEHOLDER])

## What went well?
- Documentation for the new `src/lib/agent_capabilities.ts` module was successfully created.
- Each capability is described with its purpose, parameters, return type, and key operational details.
- The `CapabilityContext` interface, shared by all capabilities, is also documented.

## What could be improved?
- The parameter types for capabilities are defined in `src/lib/agent.ts`. The documentation for capabilities could directly link to or embed these Zod schema definitions for better clarity, rather than just naming the type.
- As capabilities are added or modified, this documentation will need to be kept in strict sync.

## What did we learn?
- Separating capabilities into their own module (`agent_capabilities.ts`) and documenting them individually improves the clarity of the agent's architecture.
- Consistent documentation structure for each capability makes it easier for developers to understand and use them.

## Action Items / Follow-ups
- Ensure that the parameter type names mentioned in `src_lib_agent_capabilities.md` exactly match the exported Zod schema types from `src/lib/agent.ts`.
- Review all other documentation files for consistency with the agent refactor and new capabilities.

# Retrospection for Documentation Update (src_lib_query-refinement.md) (Git Commit ID: [GIT_COMMIT_ID_PLACEHOLDER])

## What went well?
- The documentation for `src/lib/query-refinement.ts` was successfully updated to reflect how helper functions like `focusQueryBasedOnResults` and `tweakQuery` handle the new typed Qdrant payloads.
- The roles of `FileChunkPayload`, `CommitInfoPayload`, and `DiffChunkPayload` in providing content for keyword extraction or contextual tweaking are now clearer.

## What could be improved?
- The documentation could benefit from more explicit examples of how different payload types influence the query refinement process.

## What did we learn?
- When data structures change (like Qdrant payloads), it's important to trace their usage through dependent modules (like query refinement) and update documentation accordingly to maintain accuracy.

## Action Items / Follow-ups
- Continue reviewing other documentation files, particularly those related to data handling or LLM interaction, to ensure they are consistent with the new typed payloads.

# Retrospection for .gitignore Update and Meta-Documentation (Git Commit ID: [GIT_COMMIT_ID_PLACEHOLDER])

## What went well?
- The `update-gitignore.ts` script was reviewed and its logic for appending new entries and handling newlines was refined for better robustness and cleaner output.
- The script already correctly listed `CHANGELOG.md` and `RETROSPECTION.md` as files to be ignored, which is a good baseline.
- The process of documenting this refinement in both `CHANGELOG.md` and `RETROSPECTION.md` was followed.

## What could be improved?
- The initial observation of "build errors" potentially related to `.gitignore` highlights the importance of ensuring utility scripts are not only correct in their primary logic but also robust in handling edge cases (like file endings or empty files).
- If files are already tracked by Git, `.gitignore` updates alone won't suffice. Clearer instructions or automated checks for developers regarding `git rm --cached` for such files could be beneficial.

## What did we learn?
- Even for seemingly simple tasks like managing `.gitignore`, careful attention to details like newline handling contributes to script robustness and maintainability.
- When troubleshooting issues related to ignored files, it's important to consider the state of Git tracking (`git ls-files -ci --exclude-standard`) in addition to the `.gitignore` content itself.
- Continuous refinement of utility scripts based on observed behavior or potential improvements is a healthy development practice.

## Action Items / Follow-ups
- Ensure developers are aware of the need to use `git rm --cached <file>` if a file was tracked before being added to `.gitignore`. This could be part of project setup documentation.
- Consider adding more comprehensive automated tests for utility scripts like `update-gitignore.ts` to cover various scenarios of initial `.gitignore` file states.

# Retrospection for Build/Config Fixes & Tool Registration (Git Commit ID: e0b8ec0)

## What went well?
- The specific instructions for correcting `src/lib/config-service.ts` (removing `HTTP_PORT` from persistence) and `src/lib/server.ts` (fixing `get_changelog` tool registration) were clear and actionable.
- The `fs-extra` dependency was correctly identified as needing to be in `dependencies` for the `install-git-hooks.ts` script, and it was already correctly placed.
- The test `should persist model configuration when setSuggestionModel is called` in `src/tests/lib/config-service.test.ts` served as a good validation point for the `ConfigService` changes without needing modification itself.

## What could be improved?
- The issue with `HTTP_PORT` being persisted indicates a need for careful review of what settings are appropriate for user-level configuration files versus server operational parameters (which might be better suited for environment variables or internal defaults).
- The `get_changelog` tool registration issue highlights the importance of closely following SDK documentation and type definitions, especially when multiple overloads or registration methods exist.

## What did we learn?
- Persisting server operational parameters (like `HTTP_PORT`) in user-facing configuration files can lead to unexpected behavior if not carefully managed. It's generally better to keep such settings separate.
- SDKs often have subtle differences in method signatures or expected object structures; thorough testing and adherence to type definitions are crucial.
- Maintaining a clear separation between user-configurable settings and internal/operational settings improves robustness.

## Action Items / Follow-ups
- Review other persisted configurations to ensure only user-intended settings are saved to configuration files.
- When encountering SDK-related errors, double-check the specific SDK version's documentation for the exact method signatures and parameter requirements.
- Ensure that tests for configuration persistence cover all fields intended to be saved and explicitly exclude those that should not.

# Retrospection for Build Error Fixes (ConfigService & Server Tool Registration) (Git Commit ID: [GIT_COMMIT_ID_PLACEHOLDER])

## What went well?
- The TypeScript error messages were specific and pointed directly to the problematic code sections.
- The previous refactoring correctly identified that `HTTP_PORT` should not be part of `ModelConfigFile`, which simplified this fix.
- Understanding of the MCP SDK's `server.tool()` signature helped in correcting the `get_changelog` tool registration.

## What could be improved?
- **Configuration Loading Logic:** The `loadConfigurationsFromFile` method in `ConfigService` should be carefully reviewed whenever the structure of configuration files or the properties managed by them change. A mismatch between the interface (`ModelConfigFile`) and the loading logic caused the error.
- **SDK Method Signatures:** When switching between SDK methods (like attempting to use `addTool` instead of `tool`), it's crucial to verify the method's existence and signature in the specific SDK version being used. Assumptions can lead to build errors.

## What did we learn?
- Maintaining consistency between data structure definitions (interfaces like `ModelConfigFile`) and the code that interacts with them (loading/saving logic) is essential to prevent type errors.
- Server operational parameters (like `HTTP_PORT`) are best managed separately from user-facing model configuration files.
- Always refer to the specific SDK documentation or type definitions when using its API to ensure correct method usage.

## Action Items / Follow-ups
- Perform a quick review of `ConfigService` to ensure that all properties read from configuration files are actually defined in their respective interfaces.
- Double-check other tool registrations in `server.ts` to confirm they adhere to the correct `server.tool()` signature for the installed SDK version.

# Retrospection for Build Error Fix (get_changelog Tool Registration) (Git Commit ID: [GIT_COMMIT_ID_PLACEHOLDER])

## What went well?
- The TypeScript error message `TS2769: No overload matches this call` and the line number clearly indicated the problematic `server.tool` call.
- Comparing with other working tool registrations (like `get_indexing_status`) provided a clue that `paramsSchema` for parameter-less tools should be `{}` (a `ZodRawShape`) rather than a `z.object({})` instance when passed in certain argument positions.

## What could be improved?
- **SDK Signature Clarity:** The multiple overloads for `server.tool` in the MCP SDK can sometimes make it tricky to determine the exact expected signature without referring to documentation or examples. A more constrained API or clearer error messages from the SDK's types could help.
- **Consistency in Tool Registration:** Ensuring all tool registrations follow a consistent pattern (e.g., always using the 5-argument signature if description and annotations are present) can reduce confusion and errors.

## What did we learn?
- For parameter-less tools in the MCP SDK, using an empty object literal `{}` for the `paramsSchema` argument (when it expects a `ZodRawShape`) is often the correct approach.
- When encountering `No overload matches this call` errors with SDKs, it's crucial to carefully examine the available method signatures and ensure all arguments' types and order match one of them.
- Small differences in how Zod schemas are provided (e.g., `z.object({})` instance vs. `{}` shape) can matter depending on the SDK's type expectations.

## Action Items / Follow-ups
- Review other `server.tool` registrations in `src/lib/server.ts` to ensure they consistently use the correct signatures and argument types, especially for `paramsSchema`.
- If similar issues arise, consult the MCP SDK documentation or examples for the recommended `server.tool` usage patterns.

# Retrospection for ESLint Error Resolution (Server Express App) (Git Commit ID: [GIT_COMMIT_ID_PLACEHOLDER])

## What went well?
- The ESLint error messages pinpointed specific lines and rules, aiding in focused debugging.
- The previous fixes for `fs-extra` in `install-git-hooks.ts` and unused disables in `repository.ts` were successful.

## What could be improved?
- **ESLint's Type Understanding for Express:** The persistence of `no-unsafe-*` errors for standard Express.js API calls (e.g., `app.get`, `res.json`) suggests a deeper issue with how ESLint's TypeScript parser is interpreting the types from `@types/express` within this project's configuration. While `eslint-disable` comments are a pragmatic fix, ideally, the linter would correctly recognize these patterns as type-safe.
- **Clarity of `require-await` Error Location:** If the line number for `require-await` was slightly off or pointed to a wrapper function, it could make debugging harder. Ensuring the exact problematic `async` function is identified is key.

## What did we learn?
- When ESLint flags standard usage of well-typed popular libraries like Express.js with `no-unsafe-*` errors, and TypeScript itself is satisfied, it often points to:
    - A need for more explicit type annotations within the local code (e.g., for `req`, `res`).
    - A limitation or misconfiguration in ESLint's TypeScript parsing/type resolution for those specific library patterns.
    - In such cases, targeted `eslint-disable` comments with clear justifications are a necessary evil to maintain a clean lint pass without sacrificing correct and idiomatic library usage.
- The `require-await` rule is effective in highlighting potentially unnecessary `async` keywords, which can simplify code and avoid confusion about a function's behavior.

## Action Items / Follow-ups
- Consider a deeper investigation into the ESLint and TypeScript parser configuration (`.eslintrc.js`, `tsconfig.json` for ESLint) to understand why it struggles with Express types, potentially looking for plugin conflicts or outdated parser versions.
- Regularly review `eslint-disable` comments, especially those related to `no-unsafe-*` rules for library code, to see if updates to ESLint, its plugins, or type definitions allow for their removal.

# Retrospection for Build Error Fix (get_changelog Tool Registration - TS2345) (Git Commit ID: [GIT_COMMIT_ID_PLACEHOLDER])

## What went well?
- The TypeScript error message `TS2345`, although initially pointing to the `paramsSchema` argument line, clearly indicated that a function argument was being mismatched with an object parameter type. This guided the debugging towards an overload resolution issue.
- Comparison with other working tool registrations within `src/lib/server.ts` (e.g., `get_indexing_status`, `agent_query`) revealed a consistent and successful 4-argument pattern for `server.tool()`.

## What could be improved?
- **SDK Overload Clarity:** The MCP SDK's `server.tool` method has multiple overloads. When a specific overload (like a 5-argument version for annotations) is not working as expected, it can be time-consuming to debug. Clearer documentation or more specific TypeScript error messages from the SDK for overload mismatches could be beneficial.
- **Initial Debugging Path:** The error message pointing to the `paramsSchema` line initially led to re-verification of that argument, while the core issue was the overall argument structure not matching a preferred overload due to the 5th argument.

## What did we learn?
- When facing TypeScript overload resolution errors (`TS2345`), it's crucial to:
    1. Identify the exact argument TypeScript is complaining about and the type it expects for that parameter in the problematic overload.
    2. Review all arguments passed to the function.
    3. Compare the call structure with known working examples or SDK documentation for the intended signature.
- Sticking to simpler, well-established overload patterns (like the 4-argument `server.tool` signature) is often more robust than attempting to use less common or more complex ones, especially if the latter's exact typings are subtle.
- If annotations like a `title` are needed and a dedicated annotations argument causes issues, incorporating such information into the `description` string is a viable workaround.

## Action Items / Follow-ups
- If separate annotations are strongly desired for tools, further investigate the MCP SDK's specific requirements or recommended patterns for the 5-argument `server.tool` overload, or check if annotations should be part of an options object for the 4th argument.
- For now, maintain consistency by using the 4-argument `server.tool(name, description, paramsSchema, handler)` signature for new tools unless a clear need and verified pattern for other overloads arise.

# Retrospection for Final ESLint Fixes (Server Express Middleware & require-await) (Git Commit ID: a4eb7ac)

## What went well?
- The remaining ESLint errors were few and highly localized, making them easier to address.
- The `require-await` rule correctly identified a potentially unnecessary `async` keyword on the `get_session_history` handler.
- The previous strategy of using `eslint-disable` for standard library patterns that ESLint misinterprets (like Express middleware) proved effective.

## What could be improved?
- **ESLint Configuration for Express:** The fact that `express.json()` and its use with `app.use()` triggers `no-unsafe-*` rules points to a persistent, albeit minor, friction point with ESLint's understanding of Express types. While `eslint-disable` is a practical solution, a more ideal setup would have ESLint correctly recognizing these patterns. This might involve tweaking ESLint's TypeScript parser settings or specific rule configurations for `@types/express`.

## What did we learn?
- Synchronous functions should not be marked `async`. The `require-await` rule is a good safeguard for this.
- For widely-used libraries like Express.js, when TypeScript is satisfied with the types and the code follows standard practices, `eslint-disable` comments for `no-unsafe-*` rules can be a necessary measure if ESLint's type analysis is overly aggressive or slightly misaligned with the library's typings. The key is to provide clear justification.

## Action Items / Follow-ups
- If time permits in the future, a brief investigation into ESLint's parser options or rule configurations for `@typescript-eslint/parser` related to Express types could be beneficial to see if these `eslint-disable` comments can be eliminated without sacrificing linting quality elsewhere.
- Ensure all `async` functions in the codebase are reviewed for actual use of `await` to prevent unnecessary `async` declarations.

# Retrospection for no-misused-promises ESLint Fix (Git Commit ID: [GIT_COMMIT_ID_PLACEHOLDER])

## What went well?
- The ESLint error message `@typescript-eslint/no-misused-promises` was clear and pointed to the exact location of the issue.
- The fix was straightforward: identifying an unnecessary `async` keyword on a synchronous callback.

## What could be improved?
- Ensuring that `async` is only used on functions that genuinely perform `await` operations or are intended to return a Promise can prevent this class of error. A quick scan for `async` functions without `await` during development could be beneficial.

## What did we learn?
- The `no-misused-promises` ESLint rule is effective in catching cases where `async` functions are used in contexts expecting synchronous, void-returning functions (like many event listener callbacks or simple Node.js callbacks).
- Understanding that `async` functions always return a Promise is key to diagnosing this rule's violations.

## Action Items / Follow-ups
- Briefly review other simple callbacks in the codebase to ensure `async` is not used unnecessarily, particularly for those passed to Node.js core modules or external libraries that expect void-returning functions.

# Retrospection for Final ESLint Pass (no-misused-promises & Cleanup) (Git Commit ID: [GIT_COMMIT_ID_PLACEHOLDER])

## What went well?
- The `npm run lint:fix` command successfully cleaned up several unused `eslint-disable` directives, simplifying the codebase.
- The final `no-misused-promises` error was correctly identified as relating to an unnecessary `async` keyword on a synchronous callback.
- Installing `@types/express` was a good proactive step, even if it didn't directly fix all `no-unsafe-*` issues, it ensures better type safety for Express code.

## What could be improved?
- **Understanding `no-misused-promises`:** This rule can sometimes be subtle. It's important to remember that any `async` function returns a Promise, and if a callback signature expects `void` (or a non-Promise return), this rule will trigger.
- **Iterative Linting:** The process of linting, fixing, and re-linting (sometimes with `--fix`) is effective but can be iterative. Ensuring changes are saved and accurately reflected before each lint run is key.

## What did we learn?
- The `no-misused-promises` rule is valuable for ensuring that `async` functions are used appropriately, especially in contexts like callbacks where the calling function might not expect or handle a Promise.
- Regularly running `lint:fix` can help maintain code hygiene by removing redundant `eslint-disable` comments.
- Even after installing type definitions, some ESLint rules (especially `no-unsafe-*` ones) might require targeted `eslint-disable` comments for idiomatic library patterns if ESLint's type inference remains stricter than TypeScript's.

## Action Items / Follow-ups
- Perform a quick review of other callbacks in the codebase, especially those passed to third-party library functions, to ensure `async` is used only when necessary and that `no-misused-promises` is not being violated elsewhere.
- Continue to be precise with `eslint-disable` comments, targeting only the necessary rules and providing clear justifications.

# Retrospection for Final ESLint Fixes (Server Express Middleware & require-await) (Git Commit ID: [GIT_COMMIT_ID_PLACEHOLDER])

## What went well?
- The remaining ESLint errors were few and highly localized, making them easier to address.
- The `require-await` rule correctly identified a potentially unnecessary `async` keyword on the `get_session_history` handler.
- The previous strategy of using `eslint-disable` for standard library patterns that ESLint misinterprets (like Express middleware) proved effective.

## What could be improved?
- **ESLint Configuration for Express:** The fact that `express.json()` and its use with `app.use()` triggers `no-unsafe-*` rules points to a persistent, albeit minor, friction point with ESLint's understanding of Express types. While `eslint-disable` is a practical solution, a more ideal setup would have ESLint correctly recognizing these patterns. This might involve tweaking ESLint's TypeScript parser settings or specific rule configurations for `@types/express`.

## What did we learn?
- Synchronous functions should not be marked `async`. The `require-await` rule is a good safeguard for this.
- For widely-used libraries like Express.js, when TypeScript is satisfied with the types and the code follows standard practices, `eslint-disable` comments for `no-unsafe-*` rules can be a necessary measure if ESLint's type analysis is overly aggressive or slightly misaligned with the library's typings. The key is to provide clear justification.

## Action Items / Follow-ups
- If time permits in the future, a brief investigation into ESLint's parser options or rule configurations for `@typescript-eslint/parser` related to Express types could be beneficial to see if these `eslint-disable` comments can be eliminated without sacrificing linting quality elsewhere.
- Ensure all `async` functions in the codebase are reviewed for actual use of `await` to prevent unnecessary `async` declarations.
