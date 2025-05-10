import { QdrantClient } from "@qdrant/js-client-rest";
import { configService, logger } from "./config-service";
import { withRetry } from "../utils/retry-utils";
// preprocessText, generateEmbedding, trackQueryRefinement are used by query-refinement.ts
// DetailedQdrantSearchResult will be imported in files using searchWithRefinement

// Define a type for points, compatible with Qdrant's PointStruct for simplicity
export type SimplePoint = { 
  id: string | number; 
  vector: number[]; 
  payload?: Record<string, unknown>; 
};

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

// Add batch processing for vector operations
export async function batchUpsertVectors(
  client: QdrantClient,
  collectionName: string,
  points: SimplePoint[],
  batchSize = 100
): Promise<void> {
  logger.info(`Batch upserting ${points.length} points to collection '${collectionName}' with batch size ${batchSize}`);
  for (let i = 0; i < points.length; i += batchSize) {
    const batch = points.slice(i, i + batchSize);
    try {
      await withRetry(async () => {
        // The js-client-rest library expects points to be an object { points: PointStruct[] }
        // or just PointStruct[] if using client.upsertPoints
        // The method client.upsert(collectionName, { wait: true, points: batch }) is correct
        await client.upsert(collectionName, { points: batch });
      });
      logger.debug(`Batch upserted ${batch.length} points (total processed: ${Math.min(i + batchSize, points.length)})`);
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      logger.error(`Failed to batch upsert points: ${err.message}`, { collectionName, batchStartIndex: i, batchSize });
      // Depending on requirements, you might want to re-throw or handle partial failures
      throw err; 
    }
  }
  logger.info(`Successfully batch upserted ${points.length} points to collection '${collectionName}'`);
}
