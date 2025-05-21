import { QdrantClient } from "@qdrant/js-client-rest";
import { configService, logger } from "./config-service";
import { preprocessText } from "../utils/text-utils";
import { generateEmbedding } from "./ollama";
import { DetailedQdrantSearchResult } from "./types";

// --- Helper Functions (remain the same, ensure they are exported) ---
export function extractKeywords(text: string): string[] {
  const processed = preprocessText(text);
  const cleanedForKeywords = processed.toLowerCase().replace(/[.,;:!?(){}[\]"']/g, " ");
  const words = cleanedForKeywords.split(/\s+/);
  const commonWords = new Set(['the', 'and', 'that', 'this', 'with', 'from', 'have', 'for', 'is', 'was', 'are', 'were', 'be', 'been', 'being', 'it', 'its', 'a', 'an', 'to', 'of', 'in', 'on', 'at', 'by']);
  const keywords = words.filter(word => {
    const cleanedWord = word.replace(/[():<>]$/, '');
    return cleanedWord.length > 2 && !commonWords.has(cleanedWord) && !/^\d+$/.test(cleanedWord);
  }).map(word => word.replace(/[():<>]$/, ''));
  return [...new Set(keywords)].filter(kw => kw.length > 0);
}

export function broadenQuery(query: string): string {
  let broadened = query
    .replace(/\b(exact|specific|only|must)\b/gi, '')
    .replace(/\.(ts|js|tsx|jsx|py|java|cpp|rb|go|rs|php)\b/gi, '')
    .replace(/["'{}()[\]]/g, ' ')
    .trim();
  broadened = broadened.replace(/\s\s+/g, ' ');
  if (broadened.length < 10 && broadened.length > 0) {
    return `${broadened} implementation code`;
  }
  if (broadened.length === 0) {
    return "general code context";
  }
  return broadened;
}

export function focusQueryBasedOnResults(query: string, results: DetailedQdrantSearchResult[]): string {
  if (results.length === 0) return query;
  const contentSamples = results.slice(0, 3).map(r =>
    r.payload?.content?.substring(0, 200) || ''
  ).join(' ');
  const potentialKeywords = extractKeywords(contentSamples);
  const keywordsToAdd = potentialKeywords.slice(0, 2).join(' ');
  if (keywordsToAdd) {
    return `${query} ${keywordsToAdd}`.trim();
  }
  return query;
}

export function tweakQuery(query: string, results: DetailedQdrantSearchResult[]): string {
  if (!results || results.length === 0) return query;
  const topResult = results[0];
  const filepath = topResult?.payload?.filepath || '';
  const fileTypeMatch = filepath.match(/\.([a-zA-Z0-9]+)$/);
  const fileType = fileTypeMatch ? fileTypeMatch[1] : '';
  const pathParts = filepath.split(/[/\\]/);
  const directory = pathParts.length > 1 ? pathParts[0] : '';
  if (fileType && !query.toLowerCase().includes(fileType.toLowerCase())) {
    return `${query} ${fileType}`;
  }
  if (directory && !query.toLowerCase().includes(directory.toLowerCase())) {
    return `${query} in ${directory}`;
  }
  return query;
}

// --- Main Functions (Refactored for DI) ---

// Define types for the injectable functions
type RefineQueryFunc = (originalQuery: string, results: DetailedQdrantSearchResult[], currentRelevance: number) => string;
type BroadenQueryFunc = (query: string) => string;
type FocusQueryFunc = (query: string, results: DetailedQdrantSearchResult[]) => string;
type TweakQueryFunc = (query: string, results: DetailedQdrantSearchResult[]) => string;

interface RefineQueryHelpers {
  broaden: BroadenQueryFunc;
  focus: FocusQueryFunc;
  tweak: TweakQueryFunc;
}

// Actual refineQuery implementation
function actualRefineQuery(
  originalQuery: string,
  results: DetailedQdrantSearchResult[],
  currentRelevance: number,
  helpers: RefineQueryHelpers = { broaden: broadenQuery, focus: focusQueryBasedOnResults, tweak: tweakQuery }
): string {
  if (results.length === 0 || currentRelevance < 0.3) {
    logger.debug(`Relevance ${currentRelevance.toFixed(2)} is low or no results. Broadening query: "${originalQuery}"`);
    return helpers.broaden(originalQuery);
  }
  if (currentRelevance < 0.7) {
    logger.debug(`Relevance ${currentRelevance.toFixed(2)} is mediocre. Focusing query: "${originalQuery}"`);
    return helpers.focus(originalQuery, results);
  }
  logger.debug(`Relevance ${currentRelevance.toFixed(2)} is decent. Tweaking query: "${originalQuery}"`);
  return helpers.tweak(originalQuery, results);
}
// Export the actual implementation for direct use and for default parameter
export { actualRefineQuery as refineQuery };


export async function searchWithRefinement(
  client: QdrantClient,
  query: string,
  files: string[] = [],
  customLimit?: number,
  maxRefinements?: number,
  relevanceThreshold = 0.7,
  // Injectable refineQuery function for testing
  refineQueryFunc: RefineQueryFunc = actualRefineQuery
): Promise<{ results: DetailedQdrantSearchResult[], refinedQuery: string, relevanceScore: number }> {
  const effectiveMaxRefinements = maxRefinements === undefined ? configService.MAX_REFINEMENT_ITERATIONS : maxRefinements;
  let currentQuery = query;
  let bestResults: DetailedQdrantSearchResult[] = [];
  let bestRelevanceScore = 0;
  let refinementCount = 0;

  logger.info(`Starting iterative search with query: "${currentQuery}", maxRefinements: ${effectiveMaxRefinements}, threshold: ${relevanceThreshold}`);

  for (let i = 0; i <= effectiveMaxRefinements; i++) {
    const embedding = await generateEmbedding(currentQuery);
    const searchLimit = (customLimit && customLimit > 0) ? customLimit : configService.QDRANT_SEARCH_LIMIT_DEFAULT;
    const searchResults = await client.search(configService.COLLECTION_NAME, {
      vector: embedding,
      limit: searchLimit,
      filter: files.length ? { must: [{ key: "filepath", match: { any: files } }] } : undefined,
    }) as DetailedQdrantSearchResult[];

    const avgRelevance = searchResults.length > 0
      ? searchResults.reduce((sum, r) => sum + r.score, 0) / searchResults.length
      : 0;
    logger.info(`Refinement iteration ${i}: Query "${currentQuery}" yielded ${searchResults.length} results with avg relevance ${avgRelevance.toFixed(2)}`);

    if (avgRelevance > bestRelevanceScore) {
      bestResults = searchResults;
      bestRelevanceScore = avgRelevance;
    }

    if (avgRelevance >= relevanceThreshold || i === effectiveMaxRefinements) {
      logger.info(`Stopping refinement: relevance ${bestRelevanceScore.toFixed(2)} >= threshold ${relevanceThreshold} or max iterations ${i}/${effectiveMaxRefinements} reached.`);
      break;
    }

    const refinedQuerySuggestion = refineQueryFunc(currentQuery, searchResults, avgRelevance); // Use injected function
    if (refinedQuerySuggestion === currentQuery && searchResults.length > 0) {
        logger.info(`Query "${currentQuery}" did not change after refinement with current results. Stopping.`);
        break;
    }
    currentQuery = refinedQuerySuggestion;
    refinementCount++;
  }
  logger.info(`Completed search with ${refinementCount} refinements. Final query: "${currentQuery}", Final relevance: ${bestRelevanceScore.toFixed(2)}`);
  return {
    results: bestResults,
    refinedQuery: currentQuery,
    relevanceScore: bestRelevanceScore
  };
}
