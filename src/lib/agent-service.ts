import { QdrantClient } from '@qdrant/js-client-rest';
import { LLMProvider, getLLMProvider } from './llm-provider';
import { configService, logger } from './config-service';
import {
  DetailedQdrantSearchResult,
  FileChunkPayload,
  CommitInfoPayload,
  DiffChunkPayload,
} from './types';
import { getQdrantClient } from './qdrant';
import { preprocessText } from '../utils/text-utils';

// Helper function to format Qdrant results for the LLM context
function formatQdrantResultForContext(result: DetailedQdrantSearchResult): string {
  const payload = result.payload;
  let contextChunk = `[Found Data (Score: ${result.score.toFixed(3)})]\n`;
  contextChunk += `ID: ${result.id}\n`;

  switch (payload.dataType) {
    case 'file_chunk': {
      contextChunk += `Type: File Chunk\n`;
      contextChunk += `File: ${payload.filepath}\n`;
      if (payload.repositoryPath) contextChunk += `Repository: ${payload.repositoryPath}\n`;
      contextChunk += `Chunk: ${payload.chunk_index + 1}/${payload.total_chunks}\n`;
      contextChunk += `Modified: ${payload.last_modified}\n`;
      contextChunk += `Content Snippet:\n---\n${payload.file_content_chunk}\n---\n`;
      break;
    }
    case 'commit_info': {
      contextChunk += `Type: Commit Information\n`;
      contextChunk += `Commit OID: ${payload.commit_oid}\n`;
      if (payload.repositoryPath) contextChunk += `Repository: ${payload.repositoryPath}\n`;
      contextChunk += `Author: ${payload.commit_author_name} <${payload.commit_author_email}>\n`;
      contextChunk += `Date: ${payload.commit_date}\n`;
      contextChunk += `Message: ${payload.commit_message}\n`;
      if (payload.parent_oids && payload.parent_oids.length > 0) {
        contextChunk += `Parent OIDs: ${payload.parent_oids.join(', ')}\n`;
      }
      contextChunk += `Changed Files Summary: ${payload.changed_files_summary.join('; ')}\n`;
      break;
    }
    case 'diff_chunk': {
      contextChunk += `Type: Diff Chunk\n`;
      contextChunk += `Commit OID: ${payload.commit_oid}\n`;
      if (payload.repositoryPath) contextChunk += `Repository: ${payload.repositoryPath}\n`;
      contextChunk += `File: ${payload.filepath}\n`;
      contextChunk += `Change Type: ${payload.change_type}\n`;
      contextChunk += `Chunk: ${payload.chunk_index + 1}/${payload.total_chunks}\n`;
      contextChunk += `Diff Snippet:\n---\n${payload.diff_content_chunk}\n---\n`;
      break;
    }
    default: {
      // This case should ideally not be reached if types are correct and exhaustive
      const exhaustiveCheck: never = payload; // Ensures all cases are handled
      logger.warn(`Unknown Qdrant payload type encountered in formatQdrantResultForContext: ${JSON.stringify(exhaustiveCheck)}`);
      contextChunk += `Type: Unknown\nContent: ${JSON.stringify(payload)}\n`;
      break;
    }
  }
  return contextChunk + "[End of Data Segment]\n\n";
}

export async function processAgentQuery(query: string, sessionId?: string): Promise<string> {
  logger.info(`Processing agent query: "${query}" (Session: ${sessionId || 'N/A'})`);

  let llmProvider: LLMProvider;
  let qdrantClient: QdrantClient;

  try {
    llmProvider = await getLLMProvider();
    qdrantClient = getQdrantClient();
  } catch (initError) {
    const errorMessage = initError instanceof Error ? initError.message : String(initError);
    logger.error("Failed to initialize LLM provider or Qdrant client for agent query", { error: errorMessage });
    return `Error: Could not initialize required services. ${errorMessage}`;
  }

  const preprocessedQuery = preprocessText(query);
  let queryEmbedding: number[];
  try {
    queryEmbedding = await llmProvider.generateEmbedding(preprocessedQuery);
  } catch (embedError) {
    const errorMessage = embedError instanceof Error ? embedError.message : String(embedError);
    logger.error("Failed to generate embedding for agent query", { error: errorMessage });
    return `Error: Could not process query embedding. ${errorMessage}`;
  }

  const searchLimit = configService.QDRANT_SEARCH_LIMIT_DEFAULT;
  let searchResults: DetailedQdrantSearchResult[] = [];

  try {
    const qdrantResponse = await qdrantClient.search(configService.COLLECTION_NAME, {
      vector: queryEmbedding,
      limit: searchLimit,
      with_payload: true,
      // score_threshold: configService.QDRANT_SCORE_THRESHOLD, // Optional: Add to config if needed
    });

    searchResults = qdrantResponse.map(point => ({
        id: point.id,
        score: point.score,
        payload: point.payload as unknown as FileChunkPayload | CommitInfoPayload | DiffChunkPayload, // Trusting the payload structure from Qdrant
        version: point.version,
        // vector: point.vector, // Not typically needed for context generation
        // shard_key: (point as any).shard_key, // Qdrant types might not expose this directly
    })) as DetailedQdrantSearchResult[];

  } catch (qdrantError) {
    const errorMessage = qdrantError instanceof Error ? qdrantError.message : String(qdrantError);
    logger.error("Error searching Qdrant for agent query", { error: errorMessage });
    return `Error: Could not retrieve information from the knowledge base. ${errorMessage}`;
  }

  if (!searchResults || searchResults.length === 0) {
    logger.info("No relevant information found in Qdrant for the agent query.");
    return "I could not find any relevant information in the indexed repository data to answer your query.";
  }

  let contextText = "Based on the retrieved information from the repository:\n\n";
  const maxContextItems = configService.AGENT_MAX_CONTEXT_ITEMS;
  for (const result of searchResults.slice(0, maxContextItems)) {
    contextText += formatQdrantResultForContext(result);
  }
  
  // Basic context length check (character-based, not token-based)
  const MAX_CONTEXT_LENGTH_CHARS = 15000; // Example limit, make configurable if needed
  if (contextText.length > MAX_CONTEXT_LENGTH_CHARS) {
    logger.warn(`Generated context text for agent is very long (${contextText.length} chars), truncating.`);
    contextText = contextText.substring(0, MAX_CONTEXT_LENGTH_CHARS) + "\n\n[CONTEXT TRUNCATED DUE TO LENGTH]\n\n";
  }

  const systemPrompt = `You are an AI assistant. Your primary task is to answer the user's query based *solely* on the provided context below.
The context is retrieved from a vectorized code repository and includes file contents, commit history, and diffs.
If the information to answer the query is not present in the provided context, you *must* state that clearly (e.g., "Based on the provided context, I cannot answer this question" or "The context does not contain specific information about X").
Do not make assumptions, do not use any external knowledge, and do not invent information not present in the context.
When referencing information, try to cite the source if relevant (e.g., "According to commit X..." or "In file Y...").
Be concise and directly answer the user's query.`;

  const fullPrompt = `${systemPrompt}\n\n[CONTEXT]\n${contextText}\n\n[USER QUERY]\n${query}\n\n[ASSISTANT'S RESPONSE BASED *ONLY* ON THE PROVIDED CONTEXT]\n`;
  
  logger.debug(`Agent LLM Prompt (length: ${fullPrompt.length}):\n${fullPrompt.substring(0, 1000)}...`);

  try {
    // forceFresh = true ensures the LLM generates a response based on the current, unique context.
    const response = await llmProvider.generateText(fullPrompt, true); 
    logger.info(`Agent LLM Raw Response (first 200 chars): ${response.substring(0, 200)}...`);
    return response;
  } catch (llmError) {
    const errorMessage = llmError instanceof Error ? llmError.message : String(llmError);
    logger.error("Error generating text with LLM for agent query:", { error: errorMessage });
    return `Error: The language model failed to process the request after retrieving context. ${errorMessage}`;
  }
}
