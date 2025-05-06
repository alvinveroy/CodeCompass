import git from "isomorphic-git";
import fs from "fs/promises";
import path from "path";
import { v4 as uuidv4 } from "uuid";
import { QdrantClient } from "@qdrant/js-client-rest";
import { logger, COLLECTION_NAME, MAX_SNIPPET_LENGTH } from "./config";
import { generateEmbedding } from "./ollama";
import { QdrantSearchResult } from "./types";

// Validate Git Repository
export async function validateGitRepository(repoPath: string): Promise<boolean> {
  try {
    const gitdir = path.join(repoPath, ".git");
    await fs.access(gitdir);
    await git.resolveRef({ fs, dir: repoPath, gitdir, ref: "HEAD" });
    logger.info(`Valid Git repository at: ${repoPath}`);
    return true;
  } catch (error: any) {
    logger.warn(`Failed to validate Git repository at ${repoPath}: ${error.message}`);
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
  logger.info("Files to index:", { files });

  if (!files.length) {
    logger.warn("No files to index in repository.");
    return;
  }

  for (const filepath of files) {
    try {
      const fullPath = path.join(repoPath, filepath);
      const content = await fs.readFile(fullPath, "utf8");
      const embedding = await generateEmbedding(content);
      const pointId = uuidv4();
      logger.info(`Upserting to Qdrant: ${filepath} (ID: ${pointId})`);
      await qdrantClient.upsert(COLLECTION_NAME, {
        points: [{ id: pointId, vector: embedding, payload: { filepath, content, last_modified: (await fs.stat(fullPath)).mtime.toISOString() } }],
      });
      logger.info(`Indexed: ${filepath}`);
    } catch (error: any) {
      logger.error(`Failed to index ${filepath}`, {
        message: error.message,
        code: error.code,
        response: error.response
          ? {
              status: error.response.status,
              data: error.response.data,
            }
          : null,
      });
    }
  }
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
      map: async (filepath, [a, b]) => {
        if (!a && !b) return;
        const change = !a ? 'added' : !b ? 'removed' : 'modified';
        changes.push(`${change}: ${filepath}`);
      },
    });
    return changes.join('\n') || "No changes since last commit";
  } catch (error: any) {
    logger.error("Diff error", { message: error.message });
    return "Failed to retrieve diff";
  }
}
