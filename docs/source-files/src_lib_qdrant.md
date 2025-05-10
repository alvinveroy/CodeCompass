# File: src/lib/qdrant.ts

## Purpose

This file is responsible for all interactions with the Qdrant vector database. It handles initializing the Qdrant client, ensuring the necessary collection exists, and providing utility functions for vector operations like batch upserting.

## Key Responsibilities/Exports

-   **`SimplePoint` Type**:
    -   Defines a simplified type for points to be inserted into Qdrant, including `id`, `vector`, and an optional `payload`.

-   **`initializeQdrant(): Promise<QdrantClient>`**:
    -   Creates and returns an instance of the `QdrantClient`.
    -   Connects to the Qdrant server specified by `configService.QDRANT_HOST`.
    -   Checks if the collection specified by `configService.COLLECTION_NAME` exists.
    -   If the collection does not exist, it creates it with a predefined vector size (currently 768 for `nomic-embed-text`) and distance metric (Cosine).
    -   Uses `withRetry` from `src/utils/retry-utils.ts` to handle transient connection issues during initialization.

-   **`batchUpsertVectors(client: QdrantClient, collectionName: string, points: SimplePoint[], batchSize = 100): Promise<void>`**:
    -   Provides an efficient way to upsert multiple vector points into a specified Qdrant collection.
    -   Splits the input `points` array into smaller batches based on the `batchSize`.
    -   Iteratively upserts each batch to Qdrant.
    -   Uses `withRetry` for each batch operation to enhance robustness.
    -   Logs progress and any errors encountered during the batch upsert process.

## Notes

-   This module relies on `configService` for Qdrant host URL and collection name.
-   The vector size for collection creation (currently hardcoded to 768) should ideally be dynamically determined or configurable based on the embedding model being used, as different models produce embeddings of different dimensions.
-   Error handling is included, with retries for Qdrant operations and logging for diagnostics.
-   The `batchUpsertVectors` function is crucial for performance when indexing large amounts of data (e.g., during initial repository indexing).
