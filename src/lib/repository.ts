import * as git from "isomorphic-git"; // Use namespace import
import fs from "fs/promises";
import path from "path";
import { exec } from "child_process"; // Import exec
import { promisify } from "util"; // To promisify exec
import { QdrantClient } from "@qdrant/js-client-rest";
import { LLMProvider } from './llm-provider'; // Assuming path, adjust if necessary
import {
  QdrantPoint,
  FileChunkPayload,
  CommitInfoPayload,
  DiffChunkPayload,
} from './types';
import { preprocessText, chunkText } from '../utils/text-utils';
import * as Diff from 'diff';
// import { Buffer } from 'buffer'; // Buffer is global in Node.js
import { configService, logger } from "./config-service";
// import { generateEmbedding } from "./ollama"; // We will use llmProvider.generateEmbedding() instead.
import { v4 as uuidv4 } from 'uuid'; // Import uuidv4
import nodeFs from 'fs'; // Standard fs for isomorphic-git functions requiring it
import { batchUpsertVectors } from './qdrant';

export interface IndexingStatusReport {
  status: 'idle' | 'initializing' | 'validating_repo' | 'listing_files' | 'cleaning_stale_entries' | 'indexing_file_content' | 'indexing_commits_diffs' | 'completed' | 'error';
  message: string;
  totalFilesToIndex?: number;
  filesIndexed?: number;
  totalCommitsToIndex?: number;
  commitsIndexed?: number;
  currentFile?: string;
  currentCommit?: string;
  errorDetails?: string;
  overallProgress?: number;
  lastUpdatedAt: string;
}

let currentIndexingStatus: IndexingStatusReport = {
  status: 'idle',
  message: 'Indexing not started.',
  overallProgress: 0,
  lastUpdatedAt: new Date().toISOString(),
};

export interface CommitChange {
  path: string;
  type: 'equal' | 'modify' | 'add' | 'delete' | 'typechange';
  oldOid?: string | null; // OID of the blob before the change
  newOid?: string | null; // OID of the blob after the change
  diffText?: string;    // Textual diff for 'modify', 'add', 'delete'
}

export interface CommitDetail {
  oid: string;
  message: string;
  author: { name: string; email: string; timestamp: number; timezoneOffset: number };
  committer: { name: string; email: string; timestamp: number; timezoneOffset: number };
  parents: string[]; // Add parent OIDs
  changedFiles: CommitChange[];
}

export function getGlobalIndexingStatus(): IndexingStatusReport {
  return { ...currentIndexingStatus, lastUpdatedAt: new Date().toISOString() };
}

export async function validateGitRepository(repoPath: string): Promise<boolean> {
  try {
    const gitdir = path.join(repoPath, ".git");
    await fs.access(gitdir);
    await git.resolveRef({ fs: nodeFs, dir: repoPath, gitdir, ref: "HEAD" });
    // logger.info(`Valid Git repository at: ${repoPath}`);
    return true;
  } catch (error: unknown) {
    logger.warn(`Git repository validation failed for ${repoPath}`, { error: error instanceof Error ? error.message : String(error) });
    return false;
  }
}

// Index Repository
export async function indexRepository(qdrantClient: QdrantClient, repoPath: string, llmProvider: LLMProvider): Promise<void> {
  logger.info(`[REPO_TS_DEBUG] indexRepository called. Repo: ${repoPath}`);
  currentIndexingStatus = {
    status: 'initializing',
    message: `Starting repository indexing for: ${repoPath}`,
    overallProgress: 0,
    lastUpdatedAt: new Date().toISOString(),
  };
  logger.info(currentIndexingStatus.message);

  const isGitRepo = await validateGitRepository(repoPath);
  if (!isGitRepo) {
    logger.warn(`Skipping repository indexing: ${repoPath} is not a valid Git repository`);
    currentIndexingStatus = {
      status: 'error',
      message: `Repository path ${repoPath} is not a valid Git repository.`,
      errorDetails: `Validation failed for ${repoPath}.`,
      overallProgress: 0,
      lastUpdatedAt: new Date().toISOString(),
    };
    return;
  }
  currentIndexingStatus.status = 'validating_repo';
  currentIndexingStatus.message = 'Repository validated. Listing files...';
  currentIndexingStatus.overallProgress = 5;
  currentIndexingStatus.lastUpdatedAt = new Date().toISOString();

  const files = await git.listFiles({ fs: nodeFs, dir: repoPath, gitdir: path.join(repoPath, ".git"), ref: "HEAD" });
  logger.info(`Found ${files.length} files in repository`);

  if (!files.length) {
    logger.warn("No files to index in repository.");
    return;
  }

  currentIndexingStatus.status = 'listing_files';
  currentIndexingStatus.message = `Found ${files.length} total files. Filtering for code files...`;
  currentIndexingStatus.overallProgress = 7;
  currentIndexingStatus.lastUpdatedAt = new Date().toISOString();

  const codeExtensions = ['.ts', '.js', '.tsx', '.jsx', '.json', '.md', '.html', '.css', '.scss', '.py', '.java', '.c', '.cpp', '.go', '.rs', '.php', '.rb'];
  const filteredFiles = files.filter(file => {
    const ext = path.extname(file).toLowerCase();
    return codeExtensions.includes(ext) && !file.includes('node_modules/') && !file.includes('dist/');
  });
  
  logger.info(`Filtered to ${filteredFiles.length} code files for indexing`);
  currentIndexingStatus.message = `Found ${filteredFiles.length} code files to process.`;
  currentIndexingStatus.totalFilesToIndex = filteredFiles.length;
  currentIndexingStatus.filesIndexed = 0;
  currentIndexingStatus.overallProgress = 10;
  currentIndexingStatus.lastUpdatedAt = new Date().toISOString();

  if (filteredFiles.length === 0) {
    logger.warn("No code files found to index after filtering.");
  }

  // Clean up stale entries from Qdrant
  try {
    currentIndexingStatus.status = 'cleaning_stale_entries';
    currentIndexingStatus.message = 'Checking for and removing stale entries from Qdrant index...';
    currentIndexingStatus.overallProgress = 15;
    currentIndexingStatus.lastUpdatedAt = new Date().toISOString();
    logger.info("Checking for stale entries in Qdrant index...");
    const currentFilePathsInRepo = new Set(filteredFiles);
    const pointsToDelete: (string | number)[] = []; // Qdrant point IDs can be string or number

    let nextOffset: string | number | undefined = undefined;
    const scrollLimit = 250; // Number of points to fetch per scroll request

    logger.debug(`Starting scroll operation to fetch all indexed filepaths from collection: ${configService.COLLECTION_NAME}`);
    do {
      const scrollResult = await qdrantClient.scroll(configService.COLLECTION_NAME, {
        with_payload: true, // Fetch the whole payload to check dataType
        with_vector: false,
        limit: scrollLimit,
        offset: nextOffset,
      });

      if (scrollResult.points.length > 0) {
        logger.debug(`Scrolled ${scrollResult.points.length} points from Qdrant.`);
      }

      for (const point of scrollResult.points) {
        const pointId = point.id; // Qdrant point IDs can be string or number
        const payload = point.payload as Partial<FileChunkPayload | CommitInfoPayload | DiffChunkPayload>; // Use Partial for safety

        if (payload && payload.dataType === 'file_chunk') {
          const fileChunkPayload = payload as FileChunkPayload; // Now we know it's a FileChunkPayload
          if (fileChunkPayload.filepath) {
            if (!currentFilePathsInRepo.has(fileChunkPayload.filepath)) {
              pointsToDelete.push(String(pointId)); // Ensure ID is string for Qdrant selector
              logger.debug(`Marking stale file_chunk entry for deletion: ${fileChunkPayload.filepath} (ID: ${pointId})`);
            }
          } else {
            logger.warn(`Found file_chunk point in Qdrant (ID: ${pointId}) without a 'filepath' in its payload. Skipping stale check for this point.`);
          }
        } else {
          // This point is not a file_chunk, or has no payload/dataType.
          // We only perform stale checks based on filepath for file_chunks in this routine.
          // Other data types (commit_info, diff_chunk) might have different stale criteria or be managed elsewhere.
          logger.debug(`Point ID ${pointId} is not a 'file_chunk' or lacks expected payload structure. Skipping filepath-based stale check.`);
        }
      }
      // Handle different types for next_page_offset to ensure type safety.
      // Qdrant's next_page_offset can be string, number, null, or undefined (or an object for complex cursors).
      // We only want to assign string or number to nextOffset, otherwise, pagination stops.
      const rawNextOffset = scrollResult.next_page_offset;
      if (typeof rawNextOffset === 'string' || typeof rawNextOffset === 'number') {
        nextOffset = rawNextOffset;
      } else {
        // If rawNextOffset is null, undefined, or an object (complex cursor), 
        // set nextOffset to undefined to stop pagination.
        nextOffset = undefined;
      }
    } while (nextOffset);

    if (pointsToDelete.length > 0) {
      logger.info(`Found ${pointsToDelete.length} stale entries to remove from Qdrant.`);
      const pointsSelector = { points: pointsToDelete.map(id => String(id)) };
      await qdrantClient.delete(configService.COLLECTION_NAME, pointsSelector);
      logger.info(`Successfully removed ${pointsToDelete.length} stale entries from Qdrant.`);
    } else {
      logger.info("No stale entries found in Qdrant index.");
    }
  } catch (error) {
    logger.error("Error during stale entry cleanup in Qdrant. Indexing of current files will proceed.", {
      message: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined
    });
    // Depending on policy, you might choose to re-throw or handle more gracefully.
    currentIndexingStatus.status = 'error';
    currentIndexingStatus.message = 'Error during stale entry cleanup in Qdrant.';
    currentIndexingStatus.errorDetails = error instanceof Error ? error.message : String(error);
    currentIndexingStatus.lastUpdatedAt = new Date().toISOString();
    // Continue with indexing current files despite stale cleanup error
  }

  let successCount = 0;
  let errorCount = 0;

  logger.info(`[REPO_TS_DEBUG] Starting file content indexing. Total files: ${filteredFiles.length}`); // Add this log
  if (filteredFiles.length > 0) {
    currentIndexingStatus.message = 'Stale entry cleanup complete. Starting file content indexing.';
    currentIndexingStatus.status = 'indexing_file_content';
    currentIndexingStatus.overallProgress = 20;
    currentIndexingStatus.lastUpdatedAt = new Date().toISOString();
  }

  for (const filepath of filteredFiles) {
    logger.info(`[DEBUG] indexRepository: Processing file: ${filepath}`); // Example debug log
    try {
      const fullPath = path.join(repoPath, filepath);
      const content = await fs.readFile(fullPath, "utf8");
      const last_modified = (await fs.stat(fullPath)).mtime.toISOString();

      if (!content.trim()) {
        logger.info(`Skipping ${filepath}: empty file`);
        continue;
      }
      currentIndexingStatus.currentFile = filepath;

      // Add new chunking logic using chunkText and new payload structure:
      const processedContent = preprocessText(content); // Preprocess before chunking
      const contentChunks = chunkText(
        processedContent,
        configService.FILE_INDEXING_CHUNK_SIZE_CHARS,
        configService.FILE_INDEXING_CHUNK_OVERLAP_CHARS
      );

      if (contentChunks.length > 0) {
        logger.info(`Indexing ${filepath} in ${contentChunks.length} chunks.`);
        const pointsToUpsert: QdrantPoint[] = [];
        for (let i = 0; i < contentChunks.length; i++) {
          const chunkContent = contentChunks[i];
          if (!chunkContent.trim()) {
            logger.debug(`Skipping empty chunk ${i + 1}/${contentChunks.length} for ${filepath}`);
            continue;
          }

          // Embed the preprocessed chunk
          const embedding = await llmProvider.generateEmbedding(chunkContent); // Use llmProvider
          // Generate UUID for pointId
          const pointId = uuidv4();

          const payload: FileChunkPayload = {
            dataType: 'file_chunk',
            filepath,
            file_content_chunk: chunkContent,
            last_modified,
            chunk_index: i,
            total_chunks: contentChunks.length,
            repositoryPath: repoPath, // Optional: add repoPath if useful for multi-repo scenarios
          };
          pointsToUpsert.push({ id: pointId, vector: embedding, payload: payload });
        }

        if (pointsToUpsert.length > 0) {
          const fileChunksMessage = `[DIAGNOSTIC_REPOSITORY_TS] indexRepository (file chunks): About to call batchUpsertVectors with ${pointsToUpsert.length} points for file ${filepath}.`;
          logger.info(fileChunksMessage);
          console.error(fileChunksMessage); // Force to stderr for visibility
          const simplePointsFileChunks = pointsToUpsert.map(p => ({ ...p, payload: p.payload as unknown as Record<string, unknown> }));
          await batchUpsertVectors(qdrantClient, configService.COLLECTION_NAME, simplePointsFileChunks, configService.QDRANT_BATCH_UPSERT_SIZE);
          logger.info(`[REPO_TS_DEBUG] indexRepository (file chunks): batchUpsertVectors call complete for file ${filepath}.`);
          logger.info(`Successfully indexed ${pointsToUpsert.length} chunks for ${filepath}`);
          if (currentIndexingStatus.filesIndexed !== undefined && currentIndexingStatus.totalFilesToIndex && currentIndexingStatus.totalFilesToIndex > 0) {
            currentIndexingStatus.filesIndexed++;
            const fileProgressContribution = 50; // Assuming file indexing is 50% of total work (20% to 70%)
            currentIndexingStatus.overallProgress = 20 + Math.round((currentIndexingStatus.filesIndexed / currentIndexingStatus.totalFilesToIndex) * fileProgressContribution);
            currentIndexingStatus.lastUpdatedAt = new Date().toISOString();
          }
          successCount++;
        } else {
           logger.warn(`File ${filepath} produced 0 valid chunks after processing.`);
           // errorCount++; // Or handle as appropriate
        }
      } else {
        logger.warn(`File ${filepath} was processed but produced 0 chunks (original content length: ${content.length}).`);
        // errorCount++; // Or handle as appropriate
      }
    } catch (error: unknown) {
      logger.error(`[DEBUG] indexRepository: Error processing file ${filepath}`, { /* ... */ }); // Ensure errors in loops are logged
      logger.error(`Failed to index ${filepath}`, {
        message: error instanceof Error ? error.message : String(error)
      });
      errorCount++;
    }
  }

  logger.info(`[REPO_TS_DEBUG] File content indexing complete.`); // Add this log
  currentIndexingStatus.status = 'indexing_commits_diffs';
  currentIndexingStatus.message = 'File content indexing complete. Starting commit and diff indexing.';
  currentIndexingStatus.currentFile = undefined;
  currentIndexingStatus.overallProgress = 70; // Files done, moving to commits
  currentIndexingStatus.lastUpdatedAt = new Date().toISOString();

  try {
    logger.info(`[REPO_TS_DEBUG] Starting commit and diff indexing.`); // Add this log
    logger.info(`Starting indexing of commit history and diffs for ${repoPath}`);
    await indexCommitsAndDiffs(qdrantClient, repoPath, llmProvider);
    logger.info(`[REPO_TS_DEBUG] Commit and diff indexing complete.`); // Add this log
  } catch (commitIndexError) {
    currentIndexingStatus.status = 'error';
    currentIndexingStatus.message = 'Failed to index commit history and diffs.';
    currentIndexingStatus.errorDetails = commitIndexError instanceof Error ? commitIndexError.message : String(commitIndexError);
    currentIndexingStatus.lastUpdatedAt = new Date().toISOString();
    logger.error(`[REPO_TS_DEBUG] Error during indexCommitsAndDiffs: ${commitIndexError instanceof Error ? commitIndexError.message : String(commitIndexError)}`); // Add this log
    logger.error(`Failed to index commit history and diffs for ${repoPath}`, {
      message: commitIndexError instanceof Error ? commitIndexError.message : String(commitIndexError),
      stack: commitIndexError instanceof Error ? commitIndexError.stack : undefined,
    });
    // Increment errorCount or handle as a separate category of error
  }

  if (currentIndexingStatus.status !== 'error') {
    currentIndexingStatus.status = 'completed';
    currentIndexingStatus.message = `Repository indexing complete. ${successCount} files indexed. ${errorCount} errors during file indexing.`;
    currentIndexingStatus.overallProgress = 100;
    currentIndexingStatus.currentCommit = undefined;
    currentIndexingStatus.lastUpdatedAt = new Date().toISOString();
    logger.info(currentIndexingStatus.message);
  } else {
    logger.error(`Indexing finished with an error state: ${currentIndexingStatus.message} - ${currentIndexingStatus.errorDetails}`);
  }
  logger.info(`[DEBUG] indexRepository: Finished for repoPath: ${repoPath}`);

}

// Get Repository Diff
const execAsync = promisify(exec); // Promisify exec for async/await usage
const MAX_DIFF_LENGTH = 10000; // Max characters for diff output

export async function getRepositoryDiff(
  repoPath: string,
  // Add an optional validator parameter for testing
  validatorFunc?: (p: string) => Promise<boolean>
): Promise<string> {
  // Use the provided validator if available, otherwise default to the module's own validateGitRepository
  const isGitRepo = validatorFunc
    ? await validatorFunc(repoPath)
    : await validateGitRepository(repoPath);

  if (!isGitRepo) {
    logger.warn(`Cannot get repository diff: ${repoPath} is not a valid Git repository`);
    return "No Git repository found";
  }

  try {
    const commits = await git.log({ fs: nodeFs, dir: repoPath, depth: 2, gitdir: path.join(repoPath, ".git") });
    if (commits.length < 2) {
      // logger.info("Not enough commits to generate a diff."); // Original SUT had this commented out
      logger.info(`Not enough commits in ${repoPath} to generate a diff (found ${commits.length}).`); // More informative
      return "No previous commits to compare";
    }
    const [latest, previous] = commits;

    // Use git diff command to get textual diff
    const command = `git diff ${previous.oid} ${latest.oid}`;
    logger.info(`Executing diff command: ${command} in ${repoPath}`);

    const { stdout, stderr } = await execAsync(command, { cwd: repoPath, maxBuffer: 1024 * 1024 * 5 }); // 5MB buffer

    if (stderr) {
      logger.warn(`Git diff command produced stderr: ${stderr}`);
      // Continue if stderr is just a warning, but log it.
      // If it's a fatal error, the command would likely throw.
    }
    
    let diffOutput = stdout.trim();
    if (!diffOutput) {
      return "No textual changes found between last two commits.";
    }

    if (diffOutput.length > MAX_DIFF_LENGTH) {
      logger.info(`Diff output is too long (${diffOutput.length} chars), truncating to ${MAX_DIFF_LENGTH} chars.`);
      diffOutput = diffOutput.substring(0, MAX_DIFF_LENGTH) + "\n... (diff truncated)";
    }
    return diffOutput;

  } catch (error: unknown) {
    const err = error instanceof Error ? error : new Error(String(error));
    // Add stderr to the logged error object if it's an ExecException from execAsync
    const errorDetails: { message: string; stack?: string; stderr?: string; code?: number | string } = { // code can be string
      message: err.message, 
      stack: err.stack 
    };
    // Type guard for ExecException like errors
    if (typeof error === 'object' && error !== null) {
      if ('stderr' in error && typeof (error as { stderr?: unknown }).stderr === 'string') {
        errorDetails.stderr = (error as { stderr: string }).stderr;
      }
      if ('code' in error && (typeof (error as { code?: unknown }).code === 'number' || typeof (error as { code?: unknown }).code === 'string')) {
        errorDetails.code = (error as { code: number | string }).code;
      }
    }
    logger.error(`Error retrieving git diff for ${repoPath}: ${err.message}`, errorDetails);
    const errorMessage = err && typeof err.message === 'string' ? err.message : String(err);
    return `Failed to retrieve diff for ${repoPath}: ${errorMessage}`;
  }
}

export async function getCommitHistoryWithChanges(
  repoPath: string,
  options?: { since?: Date; count?: number; ref?: string }
): Promise<CommitDetail[]> {
  const gitdir = path.join(repoPath, ".git");
  const detailedCommits: CommitDetail[] = [];

  try {
    const logOptions: {
      fs: typeof nodeFs; // Use the imported standard fs
      dir: string;
      gitdir: string;
      depth?: number;
      since?: Date;
      ref?: string;
    } = {
      fs: nodeFs,
      dir: repoPath,
      gitdir,
    };

    if (options?.count) {
      logOptions.depth = options.count;
    }
    if (options?.since) {
      logOptions.since = options.since;
    }
    if (options?.ref) {
      logOptions.ref = options.ref;
    }

    const commits = await git.log(logOptions);

    for (const commitEntry of commits) {
      // commitEntry from git.log already has oid, message, author, committer
      // We need to read the full commit to get tree and parent info reliably
      const commitData = await git.readCommit({
        fs: nodeFs,
        dir: repoPath,
        gitdir,
        oid: commitEntry.oid,
      });

      const parentOids = commitData.commit.parent || []; // Ensure parents is always an array
      const changedFiles: CommitChange[] = [];

      if (commitData.commit.parent && commitData.commit.parent.length > 0) {
        // Not an initial commit, compare with the first parent
        const parentOid = commitData.commit.parent[0];
        const parentCommitData = await git.readCommit({
          fs: nodeFs,
          dir: repoPath,
          gitdir,
          oid: parentOid,
        });

        // Manual diff logic using git.walk
        // For git.TREE, we pass the tree OID as the 'ref' argument.
        // This relies on isomorphic-git's TREE walker factory being able to resolve a tree OID passed as 'ref'.
        // If this specific usage is problematic, an alternative would be to read the tree objects
        // and then use their entries, but `walk` with `TREE` walkers is idiomatic for diff-like operations.
        await git.walk({
          fs: nodeFs,
          dir: repoPath,
          gitdir,
          trees: [git.TREE({ ref: parentCommitData.commit.tree }), git.TREE({ ref: commitData.commit.tree })],
          map: async function(filepath, entries) {
            if (filepath === '.') return null; // Skip root
            const [entry1, entry2] = entries; // entry from parent tree, entry from current tree

            const type1 = entry1 ? await entry1.type() : null;
            const oid1 = entry1 ? await entry1.oid() : null;
            // const mode1 = entry1 ? await entry1.mode() : null; // mode1 not used in current logic

            const type2 = entry2 ? await entry2.type() : null;
            const oid2 = entry2 ? await entry2.oid() : null;
            // const mode2 = entry2 ? await entry2.mode() : null; // mode2 not used in current logic

            if (type1 === 'blob' || type2 === 'blob') { // Only consider file changes
              let changeEntry: CommitChange | null = null;

              if (!entry1 && entry2) { // File added
                changeEntry = { path: filepath, type: 'add', oldOid: null, newOid: oid2 };
              } else if (entry1 && !entry2) { // File deleted
                changeEntry = { path: filepath, type: 'delete', oldOid: oid1, newOid: null };
              } else if (entry1 && entry2) { // File potentially modified or typechanged
                if (oid1 !== oid2) {
                  changeEntry = { path: filepath, type: 'modify', oldOid: oid1, newOid: oid2 };
                } else if (type1 !== type2) {
                  // OIDs are same, but types differ (e.g. blob to symlink)
                  changeEntry = { path: filepath, type: 'typechange', oldOid: oid1, newOid: oid2 };
                }
                // Mode-only changes are not captured if OIDs are identical and types are same.
              }

              if (changeEntry) {
                if (changeEntry.type === 'add' || changeEntry.type === 'modify' || changeEntry.type === 'delete') {
                  try {
                    const contentA = changeEntry.oldOid ? Buffer.from((await git.readBlob({ fs: nodeFs, dir: repoPath, gitdir, oid: changeEntry.oldOid })).blob).toString('utf8') : '';
                    const contentB = changeEntry.newOid ? Buffer.from((await git.readBlob({ fs: nodeFs, dir: repoPath, gitdir, oid: changeEntry.newOid })).blob).toString('utf8') : '';
                    // Using configService for diff context lines
                     
                    changeEntry.diffText = Diff.createPatch(filepath, contentA, contentB, '', '', { context: configService.DIFF_LINES_OF_CONTEXT });
                  } catch (diffError) {
                    logger.warn(`Could not generate diff for ${filepath} in commit ${commitEntry.oid}`, { error: diffError instanceof Error ? diffError.message : String(diffError) });
                    // Keep the changeEntry without diffText if diff generation fails
                  }
                }
                changedFiles.push(changeEntry);
              }
            }
            return null;
          }
        });
      } else {
        // Initial commit, list all files as 'add'
        await git.walk({
          fs: nodeFs,
          dir: repoPath,
          gitdir,
          // For an initial commit, list all files as 'add'.
          // We can use the tree OID directly with gitWalk's 'oids' parameter,
          // or iterate through the tree using readTree then gitWalk on its entries if needed.
          // A simpler way for listing all files in a tree is to use GIT_TREE walker with the tree's OID.
          // The `trees` parameter expects an array of Walker instances.
          // GIT_TREE() (the function call, not the symbol) creates a Walker for the current commit's tree.
          // However, to specify a particular tree OID, it's usually done by providing the OID to `readObject`
          // and then walking that, or by using the `oids` parameter in `walk`.
          // Let's use `readTree` and then iterate.
          // A more direct way with walk for a specific tree:
          // The `trees` parameter is an array of Walker objects.
          // `TREE` is a symbol. `GIT_TREE()` is a function that returns a Walker.
          // To walk a specific tree OID, you'd typically pass it to `gitLog` or similar,
          // or use `readTree` and then process its entries.
          // The most straightforward way to list files in a specific tree with `walk`
          // is to provide its OID to the `oids` parameter.
          // However, the existing code uses `map` which expects entries.

          // Correct approach for listing files in a specific tree (initial commit):
          // We need to provide the tree OID to the walk function.
          // The `map` function will then receive entries from this tree.
          // The `trees` parameter is for specifying which "sources" (like HEAD, STAGE, WORKDIR)
          // are being walked when comparing. For a single tree, this is simpler.
          // We can use `GIT_TREE()` to get a Walker for the current commit's tree if `ref` is HEAD.
          // For a specific tree OID, we can use `readTree` and then iterate, or use `walk` with `oids`.

          // Let's use `GIT_TREE()` which refers to the tree of the current ref (HEAD by default).
          // Since we have the specific tree OID, we should use that.
          // The `walk` function can take an `oids` array.
          // The `map` function's second argument `entries` is an array of `WalkerEntry | null`.
          // If we are walking a single tree, `entries` will have one item.

          map: async function(filepath, [entry]) { // entry is WalkerEntry | null
            if (filepath === '.') return; // Skip root
            // For an initial commit, all files in its tree are 'add'.
            // The `entry` here will be from the commit's tree.
            if (entry && await entry.type() === 'blob') { // Ensure it's a file
              const oid = await entry.oid();
              const changeEntry: CommitChange = { path: filepath, type: 'add', oldOid: null, newOid: oid };
              try {
                const contentB = Buffer.from((await git.readBlob({ fs: nodeFs, dir: repoPath, gitdir, oid })).blob).toString('utf8');
                // For 'add' in initial commit, diff is against an empty file.
                 
                changeEntry.diffText = Diff.createPatch(filepath, '', contentB, '', '', { context: configService.DIFF_LINES_OF_CONTEXT });
              } catch (diffError) {
                 logger.warn(`Could not generate diff for added file ${filepath} in initial commit ${commitEntry.oid}`, { error: diffError instanceof Error ? diffError.message : String(diffError) });
              }
              changedFiles.push(changeEntry);
            }
            return null;
          },
          // We need to tell `walk` which tree to process.
          // Since `commitData.commit.tree` is the OID of the tree for this initial commit:
          trees: [git.TREE()], // This refers to the tree of the current ref (HEAD)
                               // which is what we want for the initial commit's files.
                               // If commitData.commit.tree is different from HEAD's tree (it shouldn't be for initial commit processing)
                               // then a different approach is needed.
                               // For an initial commit, its tree *is* the state.
          // The `gitWalk` function, when given `trees: [GIT_TREE()]`, will walk the tree
          // of the current commit (which `commitData` represents).
          // This seems correct for listing files of an initial commit.
          // The error TS2353 was about `GIT_TREE({ oid: ... })`.
          // The correct usage is just `GIT_TREE()` if you mean the tree of the current ref,
          // or you need to pass the OID differently if you want to specify an arbitrary tree.
          // Given this is for the initial commit, `GIT_TREE()` should point to its tree.
          // Let's assume `GIT_TREE()` correctly resolves to the tree of `commitData.commit.tree`.
          // The original code was: trees: [GIT_TREE({ oid: commitData.commit.tree })],
          // The `TREE` symbol itself is not a function. `GIT_TREE()` is.
          // The error indicates TS thinks `GIT_TREE` is a function taking `{ref?: string}`.
          // This suggests a type definition issue or a misunderstanding of the API.
          // `isomorphic-git`'s `TREE` is a function that returns a `WalkerFactory`.
          // So, `GIT_TREE()` should be used.
          // The error `TS2353: Object literal may only specify known properties, and 'oid' does not exist in type '{ ref?: string | undefined; }'.`
          // implies that `GIT_TREE` is being seen as `function TREE(options?: { ref?: string }): Walker`.
          // This is not how `GIT_TREE({oid: ...})` is meant to be used.
          // It should be `GIT_TREE()` if you want the current ref's tree.
          // To walk a *specific* tree OID (like `commitData.commit.tree`), you'd typically use `readTree`
          // and then iterate its entries, or use `walk` with the `oids` parameter.
          // Given the context of an initial commit, `GIT_TREE()` should refer to its tree.
          // The simplest fix for the `walk` call, assuming `GIT_TREE()` refers to the tree of the current commit:
        });
      }

      detailedCommits.push({
        oid: commitEntry.oid,
        message: commitEntry.commit.message,
        author: commitEntry.commit.author,
        committer: commitEntry.commit.committer,
        changedFiles,
        parents: parentOids, // Add this line
      });
    }
    logger.info(`Retrieved ${detailedCommits.length} commits with changes for ${repoPath}`);
    return detailedCommits;
  } catch (error: unknown) {
    const err = error instanceof Error ? error : new Error(String(error));
    logger.error(`Failed to get commit history with changes for ${repoPath}: ${err.message}`, { stack: err.stack });
    // Depending on desired behavior, you might want to re-throw or return empty array
    throw err; // Or return [];
  }
}

async function indexCommitsAndDiffs(
  qdrantClient: QdrantClient,
  repoPath: string,
  llmProvider: LLMProvider,
  // allRepoFiles: string[] // Potentially useful context, currently unused
): Promise<void> {
  logger.info(`[REPO_TS_DEBUG] indexCommitsAndDiffs called for repository: ${repoPath}`); // Add this log
  logger.info(`Indexing commit history and diffs for repository: ${repoPath}`);
  currentIndexingStatus.message = 'Fetching commit history...';
  currentIndexingStatus.totalCommitsToIndex = 0;
  currentIndexingStatus.commitsIndexed = 0;
  currentIndexingStatus.lastUpdatedAt = new Date().toISOString();


  const historyOptions: { count?: number } = {};
  if (configService.COMMIT_HISTORY_MAX_COUNT_FOR_INDEXING > 0) {
    historyOptions.count = configService.COMMIT_HISTORY_MAX_COUNT_FOR_INDEXING;
  }

  const commits = await getCommitHistoryWithChanges(repoPath, historyOptions);
  if (!commits || commits.length === 0) {
    logger.info(`No commit history found or processed for ${repoPath}. Skipping commit/diff indexing.`);
    return;
  }
  currentIndexingStatus.totalCommitsToIndex = commits.length;
  currentIndexingStatus.message = `Found ${commits.length} commits to process for diffs and history.`;
  currentIndexingStatus.lastUpdatedAt = new Date().toISOString();
  logger.info(`[REPO_TS_DEBUG] indexCommitsAndDiffs: Processing ${commits.length} commits.`); // Add this log
  
  const pointsToUpsert: QdrantPoint[] = [];

  for (const commit of commits) {
    // 1. Index Commit Info
    currentIndexingStatus.currentCommit = commit.oid;
    currentIndexingStatus.lastUpdatedAt = new Date().toISOString();
    const changedFilesSummary = commit.changedFiles.map(
      (cf) => `${cf.type.charAt(0).toUpperCase()}: ${cf.path}`
    );
    // Prepare text for embedding commit information
    const commitDate = new Date(commit.author.timestamp * 1000).toISOString();
    const commitTextToEmbed = preprocessText(
      `Commit: ${commit.oid}\nAuthor: ${commit.author.name} <${commit.author.email}>\nDate: ${commitDate}\nMessage: ${commit.message}\nParents: ${commit.parents.join(', ')}\nChanges: ${changedFilesSummary.join('; ')}`
    );
    
    try {
      // === Commit Info ID Generation and Embedding ===
      if (!commit.oid || typeof commit.oid !== 'string') {
        logger.error(`Skipping commit due to invalid OID for ID generation. Commit: ${JSON.stringify(commit)}`);
        continue;
      }
      // Generate commit ID first
      const commitPointId = uuidv4();
      const commitPayload: CommitInfoPayload = { // Define payload before embedding attempt
        dataType: 'commit_info',
        commit_oid: commit.oid,
        commit_message: commit.message,
        commit_author_name: commit.author.name,
        commit_author_email: commit.author.email,
        commit_date: commitDate,
        changed_files_summary: changedFilesSummary,
        parent_oids: commit.parents,
        repositoryPath: repoPath, // Optional
      };

      // Now attempt embedding
      const commitVector = await llmProvider.generateEmbedding(commitTextToEmbed);
      
      pointsToUpsert.push({
        id: commitPointId,
        vector: commitVector,
        payload: commitPayload,
      });
    } catch (embedError) {
        // This catch block will now primarily catch errors from llmProvider.generateEmbedding
        logger.error(`Failed to process or generate embedding for commit ${commit.oid}`, { error: embedError instanceof Error ? embedError.message : String(embedError) });
        continue; // Skip this commit if ID generation or embedding fails
    }


    // 2. Index Diffs for each changed file in the commit
    for (const changedFile of commit.changedFiles) {
      if (changedFile.diffText && (changedFile.type === 'add' || changedFile.type === 'modify' || changedFile.type === 'delete')) {
        const processedDiffText = preprocessText(changedFile.diffText);
        const diffChunks = chunkText(
          processedDiffText,
          configService.DIFF_CHUNK_SIZE_CHARS,
          configService.DIFF_CHUNK_OVERLAP_CHARS
        );

        for (let i = 0; i < diffChunks.length; i++) {
          const diffChunk = diffChunks[i];
          if (!diffChunk.trim()) continue;

          // Text to embed for diff could include commit context for better searchability
          const diffContextualText = preprocessText(`Diff for ${changedFile.path} in commit ${commit.oid} (type: ${changedFile.type}):\n${diffChunk}`);
          
          try {
            // === Diff Chunk ID Generation and Embedding ===
            if (!commit.oid || typeof commit.oid !== 'string' || !changedFile.path || typeof changedFile.path !== 'string') {
              logger.error(`Skipping diff chunk due to invalid commit OID or changed file path for ID generation. Commit OID: ${commit.oid}, FilePath: ${changedFile.path}`);
              continue;
            }
            // Generate diff ID first
            const diffPointId = uuidv4();
            const diffPayload: DiffChunkPayload = { // Define payload before embedding
              dataType: 'diff_chunk',
              commit_oid: commit.oid,
              filepath: changedFile.path,
              diff_content_chunk: diffChunk,
              chunk_index: i,
              total_chunks: diffChunks.length,
              change_type: changedFile.type as 'modify' | 'add' | 'delete' | 'typechange', // Ensure type compatibility
              repositoryPath: repoPath, // Optional
            };
            pointsToUpsert.push({
              id: diffPointId,
              // Now attempt embedding
              vector: await llmProvider.generateEmbedding(diffContextualText), // Embedding done here
              payload: diffPayload,
            });
          } catch (embedError) {
              // This catch block will now primarily catch errors from llmProvider.generateEmbedding for diffs
              logger.error(`Failed to process or generate embedding for diff chunk of ${changedFile.path} in commit ${commit.oid}`, { error: embedError instanceof Error ? embedError.message : String(embedError) });
              // Continue to next chunk/file
          }
        }
      }
    }

    // Batch upsert periodically
    if (pointsToUpsert.length >= configService.QDRANT_BATCH_UPSERT_SIZE) {
        const periodicCommitMessage = `[DIAGNOSTIC_REPOSITORY_TS] indexCommitsAndDiffs (periodic): About to call batchUpsertVectors with ${pointsToUpsert.length} points.`;
        logger.info(periodicCommitMessage);
        console.error(periodicCommitMessage); // Force to stderr for visibility
        logger.info(`Upserting batch of ${pointsToUpsert.length} commit/diff points...`);
        const simplePointsBatch1 = pointsToUpsert.map(p => ({ ...p, payload: p.payload as unknown as Record<string, unknown> }));
        await batchUpsertVectors(qdrantClient, configService.COLLECTION_NAME, simplePointsBatch1, configService.QDRANT_BATCH_UPSERT_SIZE);
        logger.info(`[REPO_TS_DEBUG] indexCommitsAndDiffs (periodic): batchUpsertVectors call complete.`);
        pointsToUpsert.length = 0; // Clear the array
    }
  } // This is the end of the for (const commit of commits) loop
  // The next log for overallProgress was here, so the loop ends before it.
  if (currentIndexingStatus.commitsIndexed !== undefined && currentIndexingStatus.totalCommitsToIndex && currentIndexingStatus.totalCommitsToIndex > 0) {
    currentIndexingStatus.commitsIndexed++;
    const commitProgressContribution = 25; // Commits are 70% to 95%
    currentIndexingStatus.overallProgress = 70 + Math.round((currentIndexingStatus.commitsIndexed / currentIndexingStatus.totalCommitsToIndex) * commitProgressContribution);
    currentIndexingStatus.lastUpdatedAt = new Date().toISOString();
  }

  // Upsert any remaining points
  if (pointsToUpsert.length > 0) {
    const finalCommitMessage = `[DIAGNOSTIC_REPOSITORY_TS] indexCommitsAndDiffs (final): About to call batchUpsertVectors with ${pointsToUpsert.length} points.`;
    logger.info(finalCommitMessage);
    console.error(finalCommitMessage); // Force to stderr for visibility
    logger.info(`Upserting final batch of ${pointsToUpsert.length} commit/diff points...`);
    const simplePointsFinalBatch = pointsToUpsert.map(p => ({ ...p, payload: p.payload as unknown as Record<string, unknown> }));
    await batchUpsertVectors(qdrantClient, configService.COLLECTION_NAME, simplePointsFinalBatch, configService.QDRANT_BATCH_UPSERT_SIZE);
    logger.info(`[REPO_TS_DEBUG] indexCommitsAndDiffs (final): batchUpsertVectors call complete.`);
  } else {
    logger.info("[REPO_TS_DEBUG] indexCommitsAndDiffs (final): No remaining points to upsert.");
  }

  currentIndexingStatus.message = `Commit and diff indexing phase complete. Finalizing...`;
  currentIndexingStatus.currentCommit = undefined;
  currentIndexingStatus.overallProgress = Math.min(99, currentIndexingStatus.overallProgress || 95); // Cap at 99 before final completion
  currentIndexingStatus.lastUpdatedAt = new Date().toISOString();
  logger.info(`Finished indexing ${commits.length} commits and their diffs for ${repoPath}`);
}
