import * as git from "isomorphic-git";
import fs from "fs/promises";
import path from "path";
import { exec } from "child_process"; // Import exec
import { promisify } from "util"; // To promisify exec
import { v4 as uuidv4 } from "uuid";
import { QdrantClient } from "@qdrant/js-client-rest";
import { configService, logger } from "./config-service";
import { generateEmbedding } from "./ollama";
import nodeFs from 'fs'; // Standard fs for isomorphic-git functions requiring it

export interface CommitChange {
  path: string;
  type: 'equal' | 'modify' | 'add' | 'delete' | 'typechange';
}

export interface CommitDetail {
  oid: string;
  message: string;
  author: { name: string; email: string; timestamp: number; timezoneOffset: number };
  committer: { name: string; email: string; timestamp: number; timezoneOffset: number };
  changedFiles: CommitChange[];
}

export async function validateGitRepository(repoPath: string): Promise<boolean> {
  try {
    logger.debug(`[validateGitRepository] Validating path: ${repoPath}`);
    const gitdir = path.join(repoPath, ".git");
    logger.debug(`[validateGitRepository] Checking access to gitdir: ${gitdir}`);
    await fs.access(gitdir);
    logger.debug(`[validateGitRepository] gitdir access successful. Resolving HEAD ref...`);
    const resolvedRef = await git.resolveRef({ fs: nodeFs, dir: repoPath, gitdir, ref: "HEAD" });
    logger.debug(`[validateGitRepository] HEAD ref resolved to: ${resolvedRef}`);
    logger.info(`Valid Git repository at: ${repoPath}`);
    return true;
  } catch (error: unknown) {
    const err = error instanceof Error ? error : new Error(String(error));
    // Log the specific part that failed
    logger.warn(`[validateGitRepository] Validation failed for ${repoPath}. Error: ${err.message}`, { stack: err.stack });
    logger.warn(`Failed to validate Git repository at ${repoPath}: ${err.message}`);
    return false;
  }
}

// Index Repository
export async function indexRepository(qdrantClient: QdrantClient, repoPath: string): Promise<void> {
  const isGitRepo = await validateGitRepository(repoPath);
  if (!isGitRepo) {
    logger.warn(`Skipping repository indexing: ${repoPath} is not a valid Git repository`);
    return;
  }

  const files = await git.listFiles({ fs: nodeFs, dir: repoPath, gitdir: path.join(repoPath, ".git"), ref: "HEAD" });
  logger.info(`Found ${files.length} files in repository`);

  if (!files.length) {
    logger.warn("No files to index in repository.");
    return;
  }

  const codeExtensions = ['.ts', '.js', '.tsx', '.jsx', '.json', '.md', '.html', '.css', '.scss', '.py', '.java', '.c', '.cpp', '.go', '.rs', '.php', '.rb'];
  const filteredFiles = files.filter(file => {
    const ext = path.extname(file).toLowerCase();
    return codeExtensions.includes(ext) && !file.includes('node_modules/') && !file.includes('dist/');
  });
  
  logger.info(`Filtered to ${filteredFiles.length} code files for indexing`);

  // Clean up stale entries from Qdrant
  try {
    logger.info("Checking for stale entries in Qdrant index...");
    const currentFilePathsInRepo = new Set(filteredFiles);
    const pointsToDelete: (string | number)[] = []; // Qdrant point IDs can be string or number

    let nextOffset: string | number | undefined = undefined;
    const scrollLimit = 250; // Number of points to fetch per scroll request

    logger.debug(`Starting scroll operation to fetch all indexed filepaths from collection: ${configService.COLLECTION_NAME}`);
    do {
      const scrollResult = await qdrantClient.scroll(configService.COLLECTION_NAME, {
        with_payload: ['filepath'],
        with_vector: false,
        limit: scrollLimit,
        offset: nextOffset,
      });

      if (scrollResult.points.length > 0) {
        logger.debug(`Scrolled ${scrollResult.points.length} points from Qdrant.`);
      }

      for (const point of scrollResult.points) {
        const indexedFilepath = point.payload?.filepath as string;
        // Ensure point.id is correctly typed; uuidv4 generates strings.
        const pointId = point.id; 

        if (indexedFilepath) {
          if (!currentFilePathsInRepo.has(indexedFilepath)) {
            pointsToDelete.push(pointId);
            logger.debug(`Marking stale entry for deletion: ${indexedFilepath} (ID: ${pointId})`);
          }
        } else {
          // This case could indicate an issue with how data is being indexed or a point without a filepath.
          logger.warn(`Found point in Qdrant (ID: ${pointId}) without a 'filepath' in its payload. Skipping stale check for this point.`);
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
    // For now, logging and continuing.
  }

  let successCount = 0;
  let errorCount = 0;
  const CHUNK_SIZE = configService.FILE_INDEXING_CHUNK_SIZE_CHARS;
  const CHUNK_OVERLAP = configService.FILE_INDEXING_CHUNK_OVERLAP_CHARS;

  for (const filepath of filteredFiles) {
    try {
      const fullPath = path.join(repoPath, filepath);
      const content = await fs.readFile(fullPath, "utf8");
      const last_modified = (await fs.stat(fullPath)).mtime.toISOString();

      if (!content.trim()) {
        logger.info(`Skipping ${filepath}: empty file`);
        continue;
      }

      // Check if file content is large enough to be chunked
      if (content.length > CHUNK_SIZE) {
        logger.info(`File ${filepath} is large, attempting to chunk.`);
        const chunks: string[] = [];
        for (let i = 0; i < content.length; i += CHUNK_SIZE - CHUNK_OVERLAP) {
          chunks.push(content.substring(i, i + CHUNK_SIZE));
        }

        if (chunks.length > 0) {
          logger.info(`Indexing ${filepath} in ${chunks.length} chunks.`);
          for (let i = 0; i < chunks.length; i++) {
            const chunkContent = chunks[i];
            if (!chunkContent.trim()) continue; // Skip empty chunks

            const embedding = await generateEmbedding(chunkContent);
            // Consider a more deterministic ID if needed for updates, e.g., hash(filepath + chunk_index)
            const pointId = uuidv4(); 
            const payload = {
              filepath,
              content: chunkContent,
              last_modified,
              is_chunked: true,
              chunk_index: i,
              total_chunks: chunks.length,
            };
            logger.info(`Upserting chunk ${i + 1}/${chunks.length} for ${filepath} (ID: ${pointId})`);
            await qdrantClient.upsert(configService.COLLECTION_NAME, {
              points: [{ id: pointId, vector: embedding, payload }],
            });
          }
          logger.info(`Successfully indexed ${chunks.length} chunks for ${filepath}`);
          successCount++;
        } else {
          logger.warn(`File ${filepath} was marked for chunking but produced 0 chunks.`);
          errorCount++; // Or handle as appropriate
        }
      } else {
        // File is not large enough for chunking, index as a whole
        const embedding = await generateEmbedding(content);
        const pointId = uuidv4();
        const payload = {
          filepath,
          content,
          last_modified,
          is_chunked: false,
        };
        logger.info(`Upserting whole file ${filepath} (ID: ${pointId})`);
        await qdrantClient.upsert(configService.COLLECTION_NAME, {
          points: [{ id: pointId, vector: embedding, payload }],
        });
        logger.info(`Indexed whole file: ${filepath}`);
        successCount++;
      }
    } catch (error: unknown) {
      logger.error(`Failed to index ${filepath}`, {
        message: error instanceof Error ? error.message : String(error)
      });
      errorCount++;
    }
  }
  
  logger.info(`Indexing complete: ${successCount} files indexed successfully, ${errorCount} errors`);
}

// Get Repository Diff
const execAsync = promisify(exec); // Promisify exec for async/await usage
const MAX_DIFF_LENGTH = 10000; // Max characters for diff output

export async function getRepositoryDiff(repoPath: string): Promise<string> {
  const isGitRepo = await validateGitRepository(repoPath);
  if (!isGitRepo) {
    logger.warn(`Cannot get repository diff: ${repoPath} is not a valid Git repository`);
    return "No Git repository found";
  }

  try {
    const commits = await git.log({ fs: nodeFs, dir: repoPath, depth: 2, gitdir: path.join(repoPath, ".git") });
    if (commits.length < 2) {
      logger.info("Not enough commits to generate a diff.");
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
    logger.error(`Error retrieving git diff for ${repoPath}: ${err.message}`, err); // Log the full error object
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

      let changedFiles: CommitChange[] = [];

      if (commitData.commit.parent && commitData.commit.parent.length > 0) {
        // Not an initial commit, compare with the first parent
        const parentOid = commitData.commit.parent[0];
        const parentCommitData = await git.readCommit({
          fs: nodeFs,
          dir: repoPath,
          gitdir,
          oid: parentOid,
        });

        const diffResult = await git.diffTrees({
          fs: nodeFs,
          dir: repoPath,
          gitdir,
          ref1: parentCommitData.commit.tree, // Parent's tree OID
          ref2: commitData.commit.tree,      // Current commit's tree OID
        });
        // diffResult is an array of [filepath, type, before-oid, after-oid, before-mode, after-mode]
        changedFiles = diffResult.map(d => ({
          path: d[0],
          type: d[1] as CommitChange['type'],
        }));
      } else {
        // Initial commit, list all files as 'add'
        await git.walk({
          fs: nodeFs,
          dir: repoPath,
          gitdir,
          trees: [git.TREE({ oid: commitData.commit.tree })],
          map: async function(filepath, [entry]) {
            if (filepath === '.') return; // Skip root
            if (entry && (await entry.type()) === 'blob') { // Ensure it's a file
              changedFiles.push({ path: filepath, type: 'add' });
            }
            return null;
          },
        });
      }

      detailedCommits.push({
        oid: commitEntry.oid,
        message: commitEntry.commit.message,
        author: commitEntry.commit.author,
        committer: commitEntry.commit.committer,
        changedFiles,
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
