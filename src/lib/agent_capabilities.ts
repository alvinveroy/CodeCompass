import { QdrantClient } from "@qdrant/js-client-rest";
import { configService, logger } from "./config-service"; // Added configService
// getLLMProvider is not used, so the lint warning was correct. Let's remove it.
// import { getLLMProvider } from "./llm-provider";
import {
  FormattedSearchResult,
  CapabilitySearchCodeSnippetsParams,
  CapabilityGetRepositoryOverviewParams,
  CapabilityGetChangelogParams,
  CapabilityFetchMoreSearchResultsParams,
  CapabilityGetFullFileContentParams,
  CapabilityListDirectoryParams,
  CapabilityGetAdjacentFileChunksParams,
  CapabilityGenerateSuggestionWithContextParams,
  CapabilityAnalyzeCodeProblemWithContextParams
} from "./agent"; // Import types from agent.ts
import { searchWithRefinement } from "./query-refinement"; // Assuming this is where it is
import { processSnippet, getProcessedDiff as getAgentProcessedDiff } from "./agent"; // Import existing helpers from agent.ts
                                                               // We might move these later if it makes sense.
import { DetailedQdrantSearchResult, FileChunkPayload, CommitInfoPayload, DiffChunkPayload } from "./types"; // Import specific payload types
import fs from "fs/promises"; // For getChangelog, getFullFileContent, listDirectory
import path from "path"; // For getChangelog, getFullFileContent, listDirectory
import { getLLMProvider as getProviderForLLMDependentCaps } from "./llm-provider"; // Alias for LLM-dependent caps

// Define the context that will be passed to all capability functions
export interface CapabilityContext {
  qdrantClient: QdrantClient;
  repoPath: string;
  suggestionModelAvailable: boolean;
}

// capability_searchCodeSnippets
export async function capability_searchCodeSnippets(
  context: CapabilityContext,
  params: CapabilitySearchCodeSnippetsParams
): Promise<FormattedSearchResult[]> {
  const { qdrantClient, suggestionModelAvailable } = context; // repoPath not directly used if files list is empty
  const { query } = params;

  logger.info(`Executing capability_searchCodeSnippets with query: ${params.query}`);

  // Assuming validateGitRepository and git.listFiles are handled by the orchestrator
  // or are not strictly needed for the capability if files list is passed or search is global.
  // For now, let's assume searchWithRefinement can handle an empty files array if repo context isn't pre-filtered.
  const { results: qdrantResults } = await searchWithRefinement(
    qdrantClient,
    query,
    [] // Pass empty array for files, or orchestrator needs to provide this.
  );

  const formattedResultsPromises = qdrantResults.map(async (r: DetailedQdrantSearchResult) => {
    const payload = r.payload;
    let filepathDisplay = "N/A";
    let snippetContent = "Content not available";
    let isChunked = false;
    let originalFilepath: string | undefined = undefined;
    let chunkIndex: number | undefined = undefined;
    let totalChunks: number | undefined = undefined;
    let lastModified: string | undefined = undefined;

    if (payload?.dataType === 'file_chunk') {
      filepathDisplay = payload.filepath;
      snippetContent = payload.file_content_chunk;
      isChunked = true;
      originalFilepath = payload.filepath;
      chunkIndex = payload.chunk_index;
      totalChunks = payload.total_chunks;
      lastModified = payload.last_modified;
      if (isChunked) {
        filepathDisplay = `${payload.filepath} (Chunk ${(chunkIndex ?? 0) + 1}/${totalChunks ?? 'N/A'})`;
      }
    } else if (payload) {
      // Handle other types or log a warning if only file_chunk is expected here
      logger.warn(`capability_searchCodeSnippets: Received non-file_chunk payload type: ${payload.dataType} for result ID ${r.id}`);
      // Provide default/fallback values for FormattedSearchResult
      filepathDisplay = (payload as { filepath?: string }).filepath || `Unknown path (ID: ${r.id})`;
      snippetContent = `Non-file content (type: ${payload.dataType})`;
    }

    const processedSnippetContent = await processSnippet(
      snippetContent,
      query,
      filepathDisplay,
      suggestionModelAvailable
    );

    return {
      filepath: filepathDisplay,
      snippet: processedSnippetContent,
      last_modified: lastModified,
      relevance: r.score,
      is_chunked: isChunked,
      original_filepath: originalFilepath,
      chunk_index: chunkIndex,
      total_chunks: totalChunks,
    };
  });
  return Promise.all(formattedResultsPromises);
}

// capability_getRepositoryOverview
export async function capability_getRepositoryOverview(
  context: CapabilityContext,
  params: CapabilityGetRepositoryOverviewParams
): Promise<{ refinedQuery: string; diffSummary: string; searchResults: FormattedSearchResult[] }> {
  const { qdrantClient, repoPath, suggestionModelAvailable } = context;
  const { query } = params;
  logger.info(`Executing capability_getRepositoryOverview with query: ${params.query}`);

  const processedDiff = await getAgentProcessedDiff(repoPath, suggestionModelAvailable);

  const { results: qdrantResults, refinedQuery } = await searchWithRefinement(
    qdrantClient,
    query,
    [] // Assuming files list is not passed or handled by orchestrator
  );

  const searchResultsPromises = qdrantResults.map(async (r: DetailedQdrantSearchResult) => {
    const payload = r.payload;
    let filepathDisplay = "N/A";
    let snippetContent = "Content not available";
    let isChunked = false;
    let originalFilepath: string | undefined = undefined;
    let chunkIndex: number | undefined = undefined;
    let totalChunks: number | undefined = undefined;
    let lastModified: string | undefined = undefined;

    // Populate based on payload type
    if (payload?.dataType === 'file_chunk') {
      filepathDisplay = payload.filepath;
      snippetContent = payload.file_content_chunk;
      isChunked = true;
      originalFilepath = payload.filepath;
      chunkIndex = payload.chunk_index;
      totalChunks = payload.total_chunks;
      lastModified = payload.last_modified;
      if (isChunked) {
        filepathDisplay = `${payload.filepath} (Chunk ${(chunkIndex ?? 0) + 1}/${totalChunks ?? 'N/A'})`;
      }
    } else if (payload?.dataType === 'commit_info') {
      filepathDisplay = `Commit: ${payload.commit_oid.substring(0, 7)}`;
      snippetContent = `Message: ${payload.commit_message}`;
      lastModified = payload.commit_date;
    } else if (payload?.dataType === 'diff_chunk') {
      filepathDisplay = `Diff: ${payload.filepath} (Commit: ${payload.commit_oid.substring(0,7)})`;
      snippetContent = payload.diff_content_chunk;
      isChunked = true;
      originalFilepath = payload.filepath;
      chunkIndex = payload.chunk_index;
      totalChunks = payload.total_chunks;
    } else if (payload) {
      logger.warn(`capability_getRepositoryOverview: Unexpected payload type ${payload.dataType} for result ID ${r.id}`);
      filepathDisplay = (payload as { filepath?: string }).filepath || `Unknown path (ID: ${r.id})`;
      snippetContent = `Non-standard content (type: ${payload.dataType})`;
    }

    const processedSnippetContent = await processSnippet(
      snippetContent,
      query,
      filepathDisplay,
      suggestionModelAvailable
    );

    return {
      filepath: filepathDisplay,
      snippet: processedSnippetContent,
      last_modified: lastModified,
      relevance: r.score,
      is_chunked: isChunked,
      original_filepath: originalFilepath,
      chunk_index: chunkIndex,
      total_chunks: totalChunks,
    };
  });
  const searchResults = await Promise.all(searchResultsPromises);

  return {
    refinedQuery,
    diffSummary: processedDiff,
    searchResults,
  };
}

// capability_getChangelog
export async function capability_getChangelog(
  context: CapabilityContext,
  _params: CapabilityGetChangelogParams // No parameters
): Promise<{ changelog: string; error?: string }> { // Return type matches previous refactor
  const { repoPath } = context;
  logger.info("Executing capability_getChangelog");
  try {
    const changelogPath = path.join(repoPath, 'CHANGELOG.md');
    const changelogContent = await fs.readFile(changelogPath, 'utf8');
    return {
      changelog: changelogContent.substring(0, configService.MAX_FILE_CONTENT_LENGTH_FOR_CAPABILITY || 2000) // Use a config value
    };
  } catch (_error) {
    if ((_error as NodeJS.ErrnoException)?.code === 'ENOENT') {
         return { changelog: "No changelog found" };
    }
    return {
      changelog: "No changelog available",
      error: "Failed to read changelog"
    };
  }
}

// capability_fetchMoreSearchResults (similar to capability_searchCodeSnippets)
export async function capability_fetchMoreSearchResults(
  context: CapabilityContext,
  params: CapabilityFetchMoreSearchResultsParams
): Promise<FormattedSearchResult[]> {
  const { qdrantClient, suggestionModelAvailable } = context; // repoPath not directly used if files list is empty
  const { query } = params;
  logger.info(`Executing capability_fetchMoreSearchResults with query: ${params.query}`);

  const moreResultsLimit = configService.REQUEST_ADDITIONAL_CONTEXT_MAX_SEARCH_RESULTS;

  const { results: qdrantResults } = await searchWithRefinement(
    qdrantClient,
    query,
    [], // Assuming files list is not passed or handled by orchestrator
    moreResultsLimit
  );

  const formattedResultsPromises = qdrantResults.map(async (r: DetailedQdrantSearchResult) => {
    const payload = r.payload;
    let filepathDisplay = "N/A";
    let snippetContent = "Content not available";
    let isChunked = false;
    let originalFilepath: string | undefined = undefined;
    let chunkIndex: number | undefined = undefined;
    let totalChunks: number | undefined = undefined;
    let lastModified: string | undefined = undefined;

    if (payload?.dataType === 'file_chunk') {
      filepathDisplay = payload.filepath;
      snippetContent = payload.file_content_chunk;
      isChunked = true;
      originalFilepath = payload.filepath;
      chunkIndex = payload.chunk_index;
      totalChunks = payload.total_chunks;
      lastModified = payload.last_modified;
      if (isChunked) {
        filepathDisplay = `${payload.filepath} (Chunk ${(chunkIndex ?? 0) + 1}/${totalChunks ?? 'N/A'})`;
      }
    } else if (payload) {
      logger.warn(`capability_fetchMoreSearchResults: Received non-file_chunk payload type: ${payload.dataType} for result ID ${r.id}`);
      filepathDisplay = (payload as { filepath?: string }).filepath || `Unknown path (ID: ${r.id})`;
      snippetContent = `Non-file content (type: ${payload.dataType})`;
    }

    const processedSnippetContent = await processSnippet(
      snippetContent,
      query,
      filepathDisplay,
      suggestionModelAvailable
    );

    return {
      filepath: filepathDisplay,
      snippet: processedSnippetContent,
      last_modified: lastModified,
      relevance: r.score,
      is_chunked: isChunked,
      original_filepath: originalFilepath,
      chunk_index: chunkIndex,
      total_chunks: totalChunks,
    };
  });
  return Promise.all(formattedResultsPromises);
}

// capability_getFullFileContent
export async function capability_getFullFileContent(
  context: CapabilityContext,
  params: CapabilityGetFullFileContentParams
): Promise<{ filepath: string; content: string }> { // Return type matches previous refactor
  const { repoPath, suggestionModelAvailable } = context;
  const { filepath } = params;
  logger.info(`Executing capability_getFullFileContent for path: ${params.filepath}`);

  const targetFilePath = path.resolve(repoPath, filepath);
  if (!targetFilePath.startsWith(path.resolve(repoPath))) {
    throw new Error(`Access denied: Path "${filepath}" is outside the repository.`);
  }
  try {
    let fileContent = await fs.readFile(targetFilePath, 'utf8');
    const MAX_CONTENT_LENGTH = configService.MAX_FILE_CONTENT_LENGTH_FOR_CAPABILITY || 10000; // Use a config value

    if (fileContent.length > MAX_CONTENT_LENGTH) {
      if (suggestionModelAvailable) {
        try {
          const llmProvider = await getProviderForLLMDependentCaps();
          const summaryPrompt = `The user requested the full content of "${filepath}". The content is too long (${fileContent.length} characters). Summarize it concisely, focusing on its main purpose, key functions/classes, and overall structure. Keep the summary informative yet brief.\n\nFile Content (partial):\n${fileContent.substring(0, MAX_CONTENT_LENGTH * 2)}`; // Provide more for summary context
          fileContent = `Summary of ${filepath}:\n${await llmProvider.generateText(summaryPrompt)}`;
          logger.info(`Summarized large file content for ${filepath}`);
        } catch (summaryError) {
          const sErr = summaryError instanceof Error ? summaryError : new Error(String(summaryError));
          logger.warn(`Failed to summarize full file content for ${filepath}. Using truncated content. Error: ${sErr.message}`);
          fileContent = `Content of ${filepath} is too large. Summary attempt failed. Truncated content:\n${fileContent.substring(0, MAX_CONTENT_LENGTH)}...`;
        }
      } else {
        logger.warn(`Suggestion model not available to summarize large file ${filepath}. Using truncated content.`);
        fileContent = `Content of ${filepath} is too large. Full content omitted as suggestion model is offline. Truncated content:\n${fileContent.substring(0, MAX_CONTENT_LENGTH)}...`;
      }
    }
    return { filepath, content: fileContent };
  } catch (error) {
    const err = error instanceof Error ? error : new Error(String(error));
    logger.error(`Failed to read file "${filepath}": ${err.message}`);
    throw new Error(`Failed to read file "${filepath}": ${err.message}`);
  }
}

// capability_listDirectory
export async function capability_listDirectory(
  context: CapabilityContext,
  params: CapabilityListDirectoryParams
): Promise<{ path: string; listing: Array<{ name: string; type: 'directory' | 'file' }>; note?: string }> { // Return type matches previous refactor
  const { repoPath } = context;
  const { dirPath } = params;
  logger.info(`Executing capability_listDirectory for path: ${params.dirPath}`);

  const targetDirPath = path.resolve(repoPath, dirPath);
  if (!targetDirPath.startsWith(path.resolve(repoPath))) {
    throw new Error(`Access denied: Path "${dirPath}" is outside the repository.`);
  }
  try {
    const entries = await fs.readdir(targetDirPath, { withFileTypes: true });
    const listing = entries.map(entry => ({
      name: entry.name,
      type: entry.isDirectory() ? 'directory' : 'file' as 'directory' | 'file'
    }));
    const MAX_DIR_ENTRIES = configService.MAX_DIR_LISTING_ENTRIES_FOR_CAPABILITY || 50; // Use a config value
    if (listing.length > MAX_DIR_ENTRIES) {
      return {
        path: dirPath,
        listing: listing.slice(0, MAX_DIR_ENTRIES),
        note: `Listing truncated. Showing first ${MAX_DIR_ENTRIES} of ${listing.length} entries.`
      };
    }
    return { path: dirPath, listing };
  } catch (error) {
    const err = error instanceof Error ? error : new Error(String(error));
    logger.error(`Failed to list directory "${dirPath}": ${err.message}`);
    throw new Error(`Failed to list directory "${dirPath}": ${err.message}`);
  }
}

// capability_getAdjacentFileChunks
export interface AdjacentChunkInfo { // This was defined in agent.ts, moved here for co-location
  filepath: string;
  chunk_index: number;
  snippet: string;
  note?: string;
}
export async function capability_getAdjacentFileChunks(
  context: CapabilityContext,
  params: CapabilityGetAdjacentFileChunksParams
): Promise<{ filepath: string; requested_chunk_index: number; retrieved_chunks: AdjacentChunkInfo[] }> { // Return type matches previous refactor
  const { qdrantClient } = context;
  const { filepath, currentChunkIndex } = params;
  logger.info(`Executing capability_getAdjacentFileChunks for file: "${filepath}", current chunk: ${currentChunkIndex}`);

  const adjacentChunksResult: AdjacentChunkInfo[] = [];
  const chunksToFetchIndices = [currentChunkIndex - 1, currentChunkIndex + 1].filter(idx => idx >= 0);

  for (const targetIndex of chunksToFetchIndices) {
    try {
      const scrollResponse = await qdrantClient.scroll(configService.COLLECTION_NAME, {
        filter: {
          must: [
            { key: "payload.dataType", match: { value: "file_chunk" } }, // Ensure we only get file_chunks
            { key: "payload.filepath", match: { value: filepath } },
            { key: "payload.chunk_index", match: { value: targetIndex } }
          ]
        },
        limit: 1,
        with_payload: true,
        with_vector: false,
      });

      if (scrollResponse.points.length > 0 && scrollResponse.points[0].payload) {
        const pointPayload = scrollResponse.points[0].payload; // Type is already narrowed by filter if Qdrant respects it fully
                                                              // Or, we can cast if confident, but better to check dataType if it could be mixed.
                                                              // Given the filter, it *should* be FileChunkPayload.
        if (pointPayload.dataType === 'file_chunk') { // Explicit check for safety
          adjacentChunksResult.push({
            filepath: pointPayload.filepath,
            chunk_index: pointPayload.chunk_index,
            snippet: pointPayload.file_content_chunk,
          });
        } else {
          // This case should ideally not be hit due to the Qdrant filter
          logger.warn(`capability_getAdjacentFileChunks: Expected file_chunk, got ${pointPayload.dataType} for ${filepath} chunk ${targetIndex}`);
          adjacentChunksResult.push({
            filepath: filepath,
            chunk_index: targetIndex,
            snippet: "",
            note: `Chunk ${targetIndex} for file ${filepath} had unexpected data type ${pointPayload.dataType}.`
          });
        }
      } else {
         adjacentChunksResult.push({
          filepath: filepath,
          chunk_index: targetIndex,
          snippet: payload.file_content_chunk,
        });
      } else {
         adjacentChunksResult.push({
          filepath: filepath,
          chunk_index: targetIndex,
          snippet: "",
          note: `Chunk ${targetIndex} not found for file ${filepath}.`
         });
      }
    } catch (searchError) {
      const sErr = searchError instanceof Error ? searchError : new Error(String(searchError));
      logger.warn(`Failed to fetch chunk ${targetIndex} for ${filepath}: ${sErr.message}`);
      adjacentChunksResult.push({
        filepath: filepath,
        chunk_index: targetIndex,
        snippet: "",
        note: `Error fetching chunk ${targetIndex} for file ${filepath}: ${sErr.message}`
      });
    }
  }
  return {
    filepath: filepath,
    requested_chunk_index: currentChunkIndex,
    retrieved_chunks: adjacentChunksResult
  };
}

// capability_generateSuggestionWithContext
export async function capability_generateSuggestionWithContext(
  context: CapabilityContext, // _context was used, now context is used for suggestionModelAvailable
  params: CapabilityGenerateSuggestionWithContextParams
): Promise<{ suggestion: string }> { // Return type matches previous refactor
  const { query, repoPathName, filesContextString, diffSummary, recentQueriesStrings, relevantSnippets } = params;
  logger.info(`Executing capability_generateSuggestionWithContext for query: ${params.query}`);

  if (!context.suggestionModelAvailable) {
    return { suggestion: "Suggestion generation capability requires an LLM, which is currently not available." };
  }

  const prompt = `
**Context**:
Repository: ${repoPathName}
Files: ${filesContextString}
Recent Changes: ${diffSummary ? diffSummary.substring(0, 1000) : "Not available"}${diffSummary && diffSummary.length > 1000 ? "..." : ""}
${recentQueriesStrings.length > 0 ? `Recent Queries: ${recentQueriesStrings.join(", ")}` : ''}

**Relevant Snippets**:
${relevantSnippets.map(c => `File: ${c.filepath} (Last modified: ${c.last_modified || 'N/A'}, Relevance: ${(c.relevance || 0).toFixed(2)})${c.is_chunked ? ` [Chunk ${(c.chunk_index ?? 0) + 1}/${c.total_chunks ?? 'N/A'} of ${c.original_filepath}]` : ''}\n${(c.snippet || "").substring(0, 500)}${(c.snippet || "").length > 500 ? "..." : ""}`).join("\n\n")}

**Instruction**:
Based on the provided context and snippets, generate a detailed code suggestion for "${query}". Include:
- A suggested code implementation or improvement.
- An explanation of how it addresses the query.
- References to the provided snippets or context where applicable.
      `;
  const llmProvider = await getProviderForLLMDependentCaps();
  const suggestion = await llmProvider.generateText(prompt);
  return { suggestion: suggestion || "No suggestion generated." };
}

// capability_analyzeCodeProblemWithContext
export async function capability_analyzeCodeProblemWithContext(
  context: CapabilityContext, // _context was used, now context is used
  params: CapabilityAnalyzeCodeProblemWithContextParams
): Promise<{ analysis: string }> { // Return type matches previous refactor
  const { problemQuery, relevantSnippets } = params;
  logger.info(`Executing capability_analyzeCodeProblemWithContext for problem: ${params.problemQuery}`);

  if (!context.suggestionModelAvailable) {
    return { analysis: "Code problem analysis capability requires an LLM, which is currently not available." };
  }

  const analysisPrompt = `
**Code Problem Analysis**

Problem: ${problemQuery}

**Relevant Code**:
${relevantSnippets.map(c => `File: ${c.filepath}${c.is_chunked ? ` [Chunk ${(c.chunk_index ?? 0) + 1}/${c.total_chunks ?? 'N/A'} of ${c.original_filepath}]` : ''}\n\`\`\`\n${(c.snippet || "").substring(0, 500)}${(c.snippet || "").length > 500 ? "..." : ""}\n\`\`\``).join("\n\n")}

**Instructions**:
1. Analyze the problem described above.
2. Identify potential causes based on the code snippets.
3. List possible solutions.
4. Recommend the best approach.

Structure your analysis with these sections:
- Problem Understanding
- Root Cause Analysis
- Potential Solutions
- Recommended Approach
      `;
  const llmProvider = await getProviderForLLMDependentCaps();
  const analysis = await llmProvider.generateText(analysisPrompt);
  return { analysis };
}
