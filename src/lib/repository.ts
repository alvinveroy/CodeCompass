import git from "isomorphic-git";
import fs from "fs/promises";
import path from "path";
import { v4 as uuidv4 } from "uuid";
import { QdrantClient } from "@qdrant/js-client-rest";
import { configService, logger } from "./config-service";
import { generateEmbedding } from "./ollama";

export async function validateGitRepository(repoPath: string): Promise<boolean> {
  try {
    const gitdir = path.join(repoPath, ".git");
    await fs.access(gitdir);
    await git.resolveRef({ fs, dir: repoPath, gitdir, ref: "HEAD" });
    logger.info(`Valid Git repository at: ${repoPath}`);
    return true;
  } catch (error: unknown) {
    const err = error instanceof Error ? error : new Error(String(error));
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

  const files = await git.listFiles({ fs, dir: repoPath, gitdir: path.join(repoPath, ".git"), ref: "HEAD" });
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

  for (const filepath of filteredFiles) {
    try {
      const fullPath = path.join(repoPath, filepath);
      const content = await fs.readFile(fullPath, "utf8");
      
      if (!content.trim() || content.length > configService.MAX_SNIPPET_LENGTH * 10) {
        logger.info(`Skipping ${filepath}: ${!content.trim() ? 'empty file' : 'file too large'}`);
        continue;
      }
      
      const embedding = await generateEmbedding(content);
      const pointId = uuidv4();
      logger.info(`Upserting to Qdrant: ${filepath} (ID: ${pointId})`);
      await qdrantClient.upsert(configService.COLLECTION_NAME, {
        points: [{ id: pointId, vector: embedding, payload: { filepath, content, last_modified: (await fs.stat(fullPath)).mtime.toISOString() } }],
      });
      logger.info(`Indexed: ${filepath}`);
      successCount++;
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
export async function getRepositoryDiff(repoPath: string): Promise<string> {
  const isGitRepo = await validateGitRepository(repoPath);
  if (!isGitRepo) {
    logger.warn(`Cannot get repository diff: ${repoPath} is not a valid Git repository`);
    return "No Git repository found";
  }

  try {
    const commits = await git.log({ fs, dir: repoPath, depth: 2 });
    if (commits.length < 2) return "No previous commits to compare";
    const [latest, previous] = commits;
    const changes: string[] = [];
    await git.walk({
      fs,
      dir: repoPath,
      trees: [git.TREE({ ref: previous.oid }), git.TREE({ ref: latest.oid })],
      map: (filepath, [a, b]) => { 
        if (!a && !b) return Promise.resolve(null);
        const change = !a ? 'added' : !b ? 'removed' : 'modified';
        changes.push(`${change}: ${filepath}`);
        return Promise.resolve(null);
      },
    });
    return changes.join('\n') || "No changes since last commit";
  } catch (error: unknown) {
    const err = error instanceof Error ? error : new Error(String(error));
    logger.error("Diff error", { message: err.message });
    return "Failed to retrieve diff";
  }
}
