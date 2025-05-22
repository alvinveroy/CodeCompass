import { QdrantClient } from "@qdrant/js-client-rest";
import { configService, logger } from "./config-service";
import axios from "axios"; // Import axios
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
  const client = new QdrantClient({ url: qdrantHost, timeout: configService.REQUEST_TIMEOUT }); // Added timeout

  await withRetry(async () => {
    // Expected vector configuration
    const expectedVectorSize = 768; // TODO: Make this configurable or dynamic based on EMBEDDING_MODEL
    const expectedVectorDistance = "Cosine";

    const collections = await client.getCollections();
    const existingCollection = collections.collections.find(c => c.name === collectionName);

    if (!existingCollection) {
      logger.info(`Creating collection: ${collectionName} with vector size ${expectedVectorSize} and distance ${expectedVectorDistance}`);
      await client.createCollection(collectionName, {
        vectors: { size: expectedVectorSize, distance: expectedVectorDistance }
      });
      logger.info(`Created collection: ${collectionName}`);
    } else {
      logger.info(`Collection '${collectionName}' already exists. Verifying configuration...`);
      const collectionInfo = await client.getCollection(collectionName);

      let actualSize: number | undefined;
      let actualDistance: string | undefined;

      // Check if vectors config is a single, unnamed vector config
      if (typeof collectionInfo.config.params.vectors === 'object' &&
          collectionInfo.config.params.vectors !== null &&
          'size' in collectionInfo.config.params.vectors &&
          'distance' in collectionInfo.config.params.vectors &&
          typeof (collectionInfo.config.params.vectors as { size: unknown }).size === 'number' &&
          typeof (collectionInfo.config.params.vectors as { distance: unknown }).distance === 'string') {
        actualSize = (collectionInfo.config.params.vectors as { size: number }).size;
        actualDistance = (collectionInfo.config.params.vectors as { distance: string }).distance;
      } else {
        // This handles cases where vectors might be an object of named vectors, or an unexpected format
        logger.error(`Collection '${collectionName}' exists but its vector configuration is unexpected. It might be using named vectors, which is not supported by the current simple upsert logic. Config: ${JSON.stringify(collectionInfo.config.params.vectors)}`);
        throw new Error(`Collection '${collectionName}' has an incompatible vector configuration (e.g., named vectors or unexpected structure).`);
      }

      if (actualSize !== expectedVectorSize || actualDistance !== expectedVectorDistance) {
        logger.error(`Collection '${collectionName}' exists but has a mismatched configuration. Expected: size=${expectedVectorSize}, distance=${expectedVectorDistance}. Actual: size=${actualSize}, distance=${actualDistance}. Please delete the collection in Qdrant and restart, or ensure your EMBEDDING_MODEL matches the existing collection's vector size.`);
        throw new Error(`Collection '${collectionName}' has a mismatched vector configuration.`);
      } else {
        logger.info(`Collection '${collectionName}' configuration is compatible (size: ${actualSize}, distance: ${actualDistance}).`);
      }
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
      let detailedErrorMessage = err.message;
      if (axios.isAxiosError(error) && error.response) {
        detailedErrorMessage = `Status: ${error.response.status} - ${error.response.statusText}. Data: ${JSON.stringify(error.response.data)}`;
      }
      logger.error(`Failed to batch upsert points: ${detailedErrorMessage}`, { collectionName, batchStartIndex: i, batchSize });
      // Depending on requirements, you might want to re-throw or handle partial failures
      throw new Error(`Failed to batch upsert points: ${detailedErrorMessage}`);
    }
  }
  logger.info(`Successfully batch upserted ${points.length} points to collection '${collectionName}'`);
}
