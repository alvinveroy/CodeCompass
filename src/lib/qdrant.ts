import { QdrantClient } from "@qdrant/js-client-rest";
import { logger, QDRANT_HOST, COLLECTION_NAME } from "./config";
import { withRetry } from "./utils";

// Initialize Qdrant
export async function initializeQdrant(): Promise<QdrantClient> {
  logger.info(`Checking Qdrant at ${QDRANT_HOST}`);
  const client = new QdrantClient({ url: QDRANT_HOST });
  await withRetry(async () => {
    await client.getCollections();
    const collections = await client.getCollections();
    if (!collections.collections.some(c => c.name === COLLECTION_NAME)) {
      await client.createCollection(COLLECTION_NAME, { vectors: { size: 768, distance: "Cosine" } });
      logger.info(`Created collection: ${COLLECTION_NAME}`);
    }
  });
  return client;
}
