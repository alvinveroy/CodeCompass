import { QdrantClient } from "@qdrant/js-client-rest";
import { logger, QDRANT_HOST, COLLECTION_NAME } from "./config";
import { withRetry, preprocessText } from "./utils";
import { generateEmbedding } from "./ollama";
import { trackQueryRefinement } from "./metrics";

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

// Define search result type
interface SearchResult {
  id: string | number;
  score: number;
  payload: {
    filepath: string;
    content: string;
    last_modified: string;
    [key: string]: unknown;
  };
  version?: number;
  vector?: number[] | Record<string, unknown> | number[][] | null;
  shard_key?: string;
  order_value?: number;
}

// Search with iterative refinement
export async function searchWithRefinement(
  client: QdrantClient, 
  query: string, 
  files: string[] = [], 
  maxRefinements = 2,
  relevanceThreshold = 0.7
): Promise<{ results: SearchResult[], refinedQuery: string, relevanceScore: number }> {
  const queryId = `query_${Date.now()}`;
  let currentQuery = query;
  let bestResults: SearchResult[] = [];
  let bestRelevanceScore = 0;
  let refinementCount = 0;
  
  logger.info(`Starting iterative search with query: "${currentQuery}"`);
  
  for (let i = 0; i <= maxRefinements; i++) {
    // Generate embedding for the current query
    const embedding = await generateEmbedding(currentQuery);
    
    // Search Qdrant
    const searchResults = await client.search(COLLECTION_NAME, {
      vector: embedding,
      limit: 5,
      filter: files.length ? { must: [{ key: "filepath", match: { any: files } }] } : undefined,
    });
    
    // Calculate average relevance score
    const avgRelevance = searchResults.length > 0 
      ? searchResults.reduce((sum, r) => sum + r.score, 0) / searchResults.length 
      : 0;
    
    logger.info(`Refinement ${i}: Query "${currentQuery}" yielded ${searchResults.length} results with avg relevance ${avgRelevance.toFixed(2)}`);
    
    // If this is the best result so far, save it
    if (avgRelevance > bestRelevanceScore) {
      bestResults = searchResults as SearchResult[];
      bestRelevanceScore = avgRelevance;
    }
    
    // If we've reached the relevance threshold or max refinements, stop
    if (avgRelevance >= relevanceThreshold || i === maxRefinements) {
      break;
    }
    
    // Refine the query based on results
    currentQuery = await refineQuery(currentQuery, searchResults as SearchResult[], avgRelevance);
    refinementCount++;
    trackQueryRefinement(queryId);
  }
  
  logger.info(`Completed search with ${refinementCount} refinements. Final relevance: ${bestRelevanceScore.toFixed(2)}`);
  
  return {
    results: bestResults,
    refinedQuery: currentQuery,
    relevanceScore: bestRelevanceScore
  };
}

// Refine query based on search results
async function refineQuery(originalQuery: string, results: SearchResult[], currentRelevance: number): Promise<string> {
  // If no results or very poor results, broaden the query
  if (results.length === 0 || currentRelevance < 0.3) {
    return broadenQuery(originalQuery);
  }
  
  // If mediocre results, focus the query based on the results
  if (currentRelevance < 0.7) {
    return focusQueryBasedOnResults(originalQuery, results);
  }
  
  // If decent results but not great, make minor adjustments
  return tweakQuery(originalQuery, results);
}

// Broaden a query that's too specific
function broadenQuery(query: string): string {
  // Remove specific terms, file extensions, or technical jargon
  const broadened = query
    .replace(/\b(exact|specific|only|must)\b/gi, '')
    .replace(/\.(ts|js|tsx|jsx|py|java|cpp|rb|go|rs|php)\b/gi, '')
    .replace(/["'{}()[\]]/g, ' ')
    .trim();
  
  // If query became too short, add some generic terms
  if (broadened.length < 10) {
    return `${broadened} implementation code`;
  }
  
  return broadened;
}

// Focus a query based on search results
function focusQueryBasedOnResults(query: string, results: SearchResult[]): string {
  // Extract key terms from the results
  const contentSamples = results.slice(0, 3).map(r => 
    r.payload?.content?.substring(0, 200) || ''
  ).join(' ');
  
  // Extract potential keywords from content
  const potentialKeywords = extractKeywords(contentSamples);
  
  // Add the most relevant keywords to the query
  const keywordsToAdd = potentialKeywords.slice(0, 2).join(' ');
  
  return `${query} ${keywordsToAdd}`.trim();
}

// Make minor tweaks to a query
function tweakQuery(query: string, results: SearchResult[]): string {
  // Get the most relevant result
  const topResult = results[0];
  const filepath = topResult.payload?.filepath || '';
  
  // Extract file type or directory
  const fileType = filepath.split('.').pop() || '';
  const directory = filepath.split('/')[0] || '';
  
  // Add file type or directory context if not already in query
  if (fileType && !query.includes(fileType)) {
    return `${query} ${fileType}`;
  }
  
  if (directory && !query.includes(directory)) {
    return `${query} in ${directory}`;
  }
  
  return query;
}

// Extract potential keywords from text
function extractKeywords(text: string): string[] {
  // Simple keyword extraction - split by spaces and filter
  const words = preprocessText(text).split(/\s+/);
  
  // Filter out common words, keep technical terms
  const keywords = words.filter(word => 
    word.length > 3 && 
    !['the', 'and', 'that', 'this', 'with', 'from', 'have'].includes(word.toLowerCase())
  );
  
  // Return unique keywords
  return [...new Set(keywords)];
}
