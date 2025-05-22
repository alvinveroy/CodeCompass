import { QdrantClient } from "@qdrant/js-client-rest";
import { configService, logger } from "./config-service";
import { withRetry } from "../utils/retry-utils";

let qdrantClientInstance: QdrantClient | null = null;
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
  if (qdrantClientInstance) {
    try {
      // Perform a lightweight operation to check if the client is still healthy
      await qdrantClientInstance.getCollections(); // Example: list collections
      logger.info("Qdrant client already initialized and healthy.");
      return qdrantClientInstance;
    } catch (e) {
      logger.warn("Qdrant client was initialized but seems unhealthy. Re-initializing.", { error: e instanceof Error ? e.message : String(e) });
      // Fall through to re-initialize
    }
  }

  const qdrantHost = configService.QDRANT_HOST;
  const collectionName = configService.COLLECTION_NAME;
  logger.info(`Initializing Qdrant client for ${qdrantHost}`);
  const client = new QdrantClient({ url: qdrantHost });

  await withRetry(async () => {
    const collections = await client.getCollections();
    if (!collections.collections.some(c => c.name === collectionName)) {
      // Determine vector size from embedding model if possible, or make it configurable
      // For now, assuming 768 is a common default (e.g., nomic-embed-text)
      // This should ideally come from configService or be dynamically determined
      const vectorSize = 768; // TODO: Make this configurable or dynamic
      logger.info(`Creating collection: ${collectionName} with vector size ${vectorSize}`);
      await client.createCollection(collectionName, {
        vectors: { size: vectorSize, distance: "Cosine" }
      });
      logger.info(`Created collection: ${collectionName}`);
    } else {
      logger.info(`Collection '${collectionName}' already exists.`);
    }
  });

  qdrantClientInstance = client;
  logger.info("Qdrant client initialized successfully.");
  return qdrantClientInstance;
}

export function getQdrantClient(): QdrantClient {
  if (!qdrantClientInstance) {
    logger.error("Qdrant client has not been initialized. Call initializeQdrant() first.");
    throw new Error("Qdrant client is not initialized.");
  }
  return qdrantClientInstance;
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
