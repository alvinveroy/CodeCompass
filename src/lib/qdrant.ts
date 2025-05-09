import { QdrantClient } from "@qdrant/js-client-rest";
import { configService, logger } from "./config-service";
import { withRetry } from "../utils/retry-utils";
// preprocessText, generateEmbedding, trackQueryRefinement are used by query-refinement.ts
// DetailedQdrantSearchResult will be imported in files using searchWithRefinement

// Initialize Qdrant
export async function initializeQdrant(): Promise<QdrantClient> {
  const qdrantHost = configService.QDRANT_HOST;
  const collectionName = configService.COLLECTION_NAME;
  logger.info(`Checking Qdrant at ${qdrantHost}`);
  const client = new QdrantClient({ url: qdrantHost });
  await withRetry(async () => {
    await client.getCollections();
    const collections = await client.getCollections();
    if (!collections.collections.some(c => c.name === collectionName)) {
      await client.createCollection(collectionName, { vectors: { size: 768, distance: "Cosine" } }); // Vector size might need to be dynamic if embedding model changes
      logger.info(`Created collection: ${collectionName}`);
    }
  });
  return client;
}
