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
  // Diagnostic log for integration tests
  console.error(`[QDRANT_INIT_DEBUG] initializeQdrant called. CODECOMPASS_INTEGRATION_TEST_MOCK_QDRANT: ${process.env.CODECOMPASS_INTEGRATION_TEST_MOCK_QDRANT}`);
  logger.info(`[QDRANT_INIT_DEBUG] initializeQdrant called. CODECOMPASS_INTEGRATION_TEST_MOCK_QDRANT: ${process.env.CODECOMPASS_INTEGRATION_TEST_MOCK_QDRANT}`);

  if (process.env.CI === 'true' || process.env.SKIP_QDRANT_INIT === 'true' || process.env.CODECOMPASS_INTEGRATION_TEST_MOCK_QDRANT === 'true') {
    logger.info("CI, SKIP_QDRANT_INIT, or CODECOMPASS_INTEGRATION_TEST_MOCK_QDRANT is true, returning mock Qdrant client.");
    // Return a minimal mock client that satisfies the QdrantClient interface
    // for methods called during server startup or basic operations.
    return {
      getCollections: (() => Promise.resolve({ collections: [], time: 0.1 })) as QdrantClient['getCollections'],
      createCollection: (() => Promise.resolve(true)) as QdrantClient['createCollection'],
      getCollection: (() => Promise.resolve({
        status: 'ok',
        result: {
          status: 'green',
          optimizer_status: 'ok',
          vectors_count: 0,
          indexed_vectors_count: 0,
          points_count: 0,
          segments_count: 0,
          config: {
            params: {
              vectors: { size: configService.EMBEDDING_DIMENSION, distance: 'Cosine' },
              shard_number: 1,
              replication_factor: 1,
              write_consistency_factor: 1,
              on_disk_payload: true,
            },
            hnsw_config: { m: 16, ef_construct: 100 },
            optimizer_config: { deleted_threshold: 0.2, vacuum_min_vector_number: 1000, default_segment_number: 0, max_segment_size: undefined, memmap_threshold: undefined, indexing_threshold: 20000, flush_interval_sec: 5, max_optimization_threads: 1 },
            wal_config: { wal_capacity_mb: 32, wal_segments_ahead: 0 },
            quantization_config: undefined,
          },
          payload_schema: {},
        },
        time: 0.1
      })) as unknown as QdrantClient['getCollection'],
      // Add other methods if server startup or critical paths strictly depend on them.
      // For example, if upsert or search are called immediately and unconditionally:
      upsert: ((collectionName: string, params: { wait?: boolean, points: any[] }) => {
        const message = `[MOCK_QDRANT_UPSERT] Called for collection: ${collectionName}, points: ${params.points.length}`;
        logger.info(message);
        console.error(message); // Diagnostic: Force output to stderr
        return Promise.resolve({ status: 'ok', result: { operation_id: 0, status: 'completed' }});
      }) as unknown as QdrantClient['upsert'],
      search: (() => Promise.resolve([])) as unknown as QdrantClient['search'],
      scroll: (() => Promise.resolve({ points: [], next_page_offset: null })) as unknown as QdrantClient['scroll'],
      delete: (() => Promise.resolve({ status: 'ok', result: { operation_id: 0, status: 'completed' }})) as unknown as QdrantClient['delete'],
    } as unknown as QdrantClient;
  }

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
    const expectedVectorSize = configService.EMBEDDING_DIMENSION;
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
  // Diagnostic log to check client type during tests
  // This log helps verify if the mock Qdrant client is being used in tests.
  // Ensure this log is the VERY FIRST operational line in this function.
  const clientConstructorName = client?.constructor?.name || 'UnknownClient';
  const clientIsMock = process.env.CODECOMPASS_INTEGRATION_TEST_MOCK_QDRANT === 'true' && client?.['url'] === 'mocked-qdrant-url'; // Check for mock indicator
  const debugMsg = `[DEBUG_BATCH_UPSERT_CLIENT_TYPE] qdrant.ts::batchUpsertVectors called. Client: ${clientConstructorName}, IsMock: ${clientIsMock}, Collection: ${collectionName}, Points: ${points.length}`;
  console.error(debugMsg); // Use console.error for high visibility in test logs.
  logger.info(debugMsg); // Also log to regular logger.

  if (points.length === 0) {
    logger.debug("batchUpsertVectors: No points to upsert.");
    return;
  }

  logger.info(`Starting batch upsert of ${points.length} points to collection '${collectionName}' in batches of ${batchSize}.`);
  
  for (let i = 0; i < points.length; i += batchSize) {
    const batch = points.slice(i, i + batchSize);
    try {
      // TEMPORARY DEBUG LOG:
      logger.debug(`[DEBUG QDRANT IDs] Batch ${Math.floor(i / batchSize) + 1} IDs: ${JSON.stringify(batch.map(p => p.id))}`);
      // The console.error for DEBUG_BATCH_UPSERT_CLIENT_TYPE is now at the top of the function.
      
      await withRetry(async () => {
        // The js-client-rest library expects points to be an object { points: PointStruct[] }
        // or just PointStruct[] if using client.upsertPoints
        // The method client.upsert(collectionName, { wait: true, points: batch }) is correct
        await client.upsert(collectionName, { points: batch });
      });
      logger.debug(`Batch upserted ${batch.length} points (total processed: ${Math.min(i + batchSize, points.length)})`);
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      const detailedErrorMessage = `Original error message: ${err.message}`;
      const errorDetailsPayload: Record<string, unknown> = { 
        collectionName, 
        batchStartIndex: i, 
        batchSize 
      };

      // Attempt to extract more details if the error object has common fields from HTTP client errors
      if (typeof error === 'object' && error !== null) {
        if ('status' in error) errorDetailsPayload.qdrantErrorStatus = error.status;
        if ('data' in error) errorDetailsPayload.qdrantErrorData = error.data; // Common for some clients
        if ('response' in error && typeof (error as {response:unknown}).response === 'object' && (error as {response:object}).response !== null) {
             errorDetailsPayload.qdrantErrorResponse = (error as {response:object}).response; // If response is an object
        }
      }
      logger.error(`Failed to batch upsert points. ${detailedErrorMessage}`, errorDetailsPayload);
      throw new Error(`Failed to batch upsert points: ${detailedErrorMessage}`);
    }
  }
  logger.info(`Successfully batch upserted ${points.length} points to collection '${collectionName}'`);
}
