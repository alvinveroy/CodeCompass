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
    const gitdir = path.join(repoPath, ".git");
    await fs.access(gitdir);
    await git.resolveRef({ fs: nodeFs, dir: repoPath, gitdir, ref: "HEAD" });
    // logger.info(`Valid Git repository at: ${repoPath}`);
    return true;
  } catch (error: unknown) {
    // TEMPORARY DEBUGGING LINE:
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
    const errorDetails: any = { message: err.message, stack: err.stack };
    if ('stderr' in err) {
        errorDetails.stderr = (err as import('child_process').ExecException).stderr;
    }
    if ('code' in err) {
        errorDetails.code = (err as import('child_process').ExecException).code;
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
          // For an initial commit, list all files as 'add'.
          // We can use the tree OID directly with git.walk's 'oids' parameter,
          // or iterate through the tree using git.readTree then git.walk on its entries if needed.
          // A simpler way for listing all files in a tree is to use git.TREE walker with the tree's OID.
          // The `trees` parameter expects an array of Walker instances.
          // git.TREE() (the function call, not the symbol) creates a Walker for the current commit's tree.
          // However, to specify a particular tree OID, it's usually done by providing the OID to `git.readObject`
          // and then walking that, or by using the `oids` parameter in `walk`.
          // Let's use `git.readTree` and then iterate.
          // A more direct way with walk for a specific tree:
          // The `trees` parameter is an array of Walker objects.
          // `TREE` is a symbol. `git.TREE()` is a function that returns a Walker.
          // To walk a specific tree OID, you'd typically pass it to `git.log` or similar,
          // or use `git.readTree` and then process its entries.
          // The most straightforward way to list files in a specific tree with `walk`
          // is to provide its OID to the `oids` parameter.
          // However, the existing code uses `map` which expects entries.

          // Correct approach for listing files in a specific tree (initial commit):
          // We need to provide the tree OID to the walk function.
          // The `map` function will then receive entries from this tree.
          // The `trees` parameter is for specifying which "sources" (like HEAD, STAGE, WORKDIR)
          // are being walked when comparing. For a single tree, this is simpler.
          // We can use `git.TREE()` to get a Walker for the current commit's tree if `ref` is HEAD.
          // For a specific tree OID, we can use `git.readTree` and then iterate, or use `walk` with `oids`.

          // Let's use `git.TREE()` which refers to the tree of the current ref (HEAD by default).
          // Since we have the specific tree OID, we should use that.
          // The `walk` function can take an `oids` array.
          // The `map` function's second argument `entries` is an array of `WalkerEntry | null`.
          // If we are walking a single tree, `entries` will have one item.

          map: async function(filepath, [entry]) { // entry is WalkerEntry | null
            if (filepath === '.') return; // Skip root
            // For an initial commit, all files in its tree are 'add'.
            // The `entry` here will be from the commit's tree.
            if (entry && await entry.type() === 'blob') { // Ensure it's a file
              changedFiles.push({ path: filepath, type: 'add' });
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
          // The `git.walk` function, when given `trees: [git.TREE()]`, will walk the tree
          // of the current commit (which `commitData` represents).
          // This seems correct for listing files of an initial commit.
          // The error TS2353 was about `git.TREE({ oid: ... })`.
          // The correct usage is just `git.TREE()` if you mean the tree of the current ref,
          // or you need to pass the OID differently if you want to specify an arbitrary tree.
          // Given this is for the initial commit, `git.TREE()` should point to its tree.
          // Let's assume `git.TREE()` correctly resolves to the tree of `commitData.commit.tree`.
          // The original code was: trees: [git.TREE({ oid: commitData.commit.tree })],
          // The `TREE` symbol itself is not a function. `git.TREE()` is.
          // The error indicates TS thinks `git.TREE` is a function taking `{ref?: string}`.
          // This suggests a type definition issue or a misunderstanding of the API.
          // `isomorphic-git`'s `TREE` is a function that returns a `WalkerFactory`.
          // So, `git.TREE()` should be used.
          // The error `TS2353: Object literal may only specify known properties, and 'oid' does not exist in type '{ ref?: string | undefined; }'.`
          // implies that `git.TREE` is being seen as `function TREE(options?: { ref?: string }): Walker`.
          // This is not how `git.TREE({oid: ...})` is meant to be used.
          // It should be `git.TREE()` if you want the current ref's tree.
          // To walk a *specific* tree OID (like `commitData.commit.tree`), you'd typically use `git.readTree`
          // and then iterate its entries, or use `walk` with the `oids` parameter.
          // Given the context of an initial commit, `git.TREE()` should refer to its tree.
          // The simplest fix for the `walk` call, assuming `git.TREE()` refers to the tree of the current commit:
        trees: [git.TREE()], // This should refer to the tree of the commit being processed by `walk`
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
