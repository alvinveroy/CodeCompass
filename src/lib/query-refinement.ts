import { QdrantClient } from "@qdrant/js-client-rest";
import { configService, logger } from "./config-service";
 // Assuming this is the correct path
import { preprocessText } from "../utils/text-utils";
import { generateEmbedding } from "./ollama"; // Assuming ollama.ts exports generateEmbedding
// import { trackQueryRefinement } from "./metrics"; // Metrics removed
import { DetailedQdrantSearchResult } from "./types";

// Search with iterative refinement
export async function searchWithRefinement(
  client: QdrantClient,
  query: string,
  files: string[] = [],
  maxRefinements = 2,
  relevanceThreshold = 0.7
): Promise<{ results: DetailedQdrantSearchResult[], refinedQuery: string, relevanceScore: number }> {
  let currentQuery = query;
  let bestResults: DetailedQdrantSearchResult[] = [];
  let bestRelevanceScore = 0;
  let refinementCount = 0;

  logger.info(`Starting iterative search with query: "${currentQuery}"`);

  for (let i = 0; i <= maxRefinements; i++) {
    // Generate embedding for the current query
    const embedding = await generateEmbedding(currentQuery);

    // Search Qdrant
    const searchResults = await client.search(configService.COLLECTION_NAME, {
      vector: embedding,
      limit: 5, // This limit could also be a config value
      filter: files.length ? { must: [{ key: "filepath", match: { any: files } }] } : undefined,
    });

    // Calculate average relevance score
    const avgRelevance = searchResults.length > 0
      ? searchResults.reduce((sum, r) => sum + r.score, 0) / searchResults.length
      : 0;

    logger.info(`Refinement ${i}: Query "${currentQuery}" yielded ${searchResults.length} results with avg relevance ${avgRelevance.toFixed(2)}`);

    // If this is the best result so far, save it
    if (avgRelevance > bestRelevanceScore) {
      bestResults = searchResults as DetailedQdrantSearchResult[];
      bestRelevanceScore = avgRelevance;
    }

    // If we've reached the relevance threshold or max refinements, stop
    if (avgRelevance >= relevanceThreshold || i === maxRefinements) {
      break;
    }

    // Refine the query based on results
    currentQuery = await refineQuery(currentQuery, searchResults as DetailedQdrantSearchResult[], avgRelevance);
    refinementCount++;
    // trackQueryRefinement(queryId); // Metrics removed
  }

  logger.info(`Completed search with ${refinementCount} refinements. Final relevance: ${bestRelevanceScore.toFixed(2)}`);

  return {
    results: bestResults,
    refinedQuery: currentQuery,
    relevanceScore: bestRelevanceScore
  };
}

// Refine query based on search results
function refineQuery(originalQuery: string, results: DetailedQdrantSearchResult[], currentRelevance: number): string {
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
function focusQueryBasedOnResults(query: string, results: DetailedQdrantSearchResult[]): string {
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
function tweakQuery(query: string, results: DetailedQdrantSearchResult[]): string {
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
