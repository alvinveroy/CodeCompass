import { z } from "zod";

// Schemas
export const SearchCodeSchema = z.object({ 
  query: z.string().min(1, "Query is required"),
  sessionId: z.string().optional()
});

export const GenerateSuggestionSchema = z.object({
  query: z.string().min(1, "Query is required").optional(),
  prompt: z.string().min(1, "Prompt is required").optional(),
  sessionId: z.string().optional()
}).transform((data) => ({
  query: data.query || data.prompt || "",
  sessionId: data.sessionId
})).refine(data => data.query.length > 0, {
  message: "Either query or prompt must be a non-empty string",
  path: ["query"],
});

export const GetRepositoryContextSchema = z.object({ 
  query: z.string().min(1, "Query is required"),
  sessionId: z.string().optional()
}).or(
  z.string().min(1, "Query is required").transform(query => ({ query }))
);

// FeedbackSchema removed

// Agent schema
export const AgentQuerySchema = z.object({
  query: z.string().min(1, "Query is required"),
  sessionId: z.string().optional()
  // maxSteps removed
});

// Zod schema for AgentStep
export const AgentStepSchema = z.object({
  tool: z.string(),
  input: z.unknown(),
  output: z.unknown(),
  reasoning: z.string(),
});

// Zod schema for AgentState
export const AgentStateSchema = z.object({
  sessionId: z.string(),
  query: z.string(),
  planText: z.string().optional(),
  steps: z.array(AgentStepSchema),
  context: z.array(z.unknown()),
  finalResponse: z.string().optional(),
  isComplete: z.boolean(),
});

// Add these new interfaces BEFORE the existing QdrantPoint interface:
export interface BaseQdrantPayload {
  dataType: 'file_chunk' | 'commit_info' | 'diff_chunk';
  repositoryPath?: string; // Optional: if your Qdrant collection might span multiple repos
}

export interface FileChunkPayload extends BaseQdrantPayload {
  dataType: 'file_chunk';
  filepath: string;
  file_content_chunk: string; // Renamed from 'content' for clarity
  chunk_index: number;
  total_chunks: number;
  last_modified: string; // From original file stat
}

export interface CommitInfoPayload extends BaseQdrantPayload {
  dataType: 'commit_info';
  commit_oid: string;
  commit_message: string;
  commit_author_name: string;
  commit_author_email: string;
  commit_date: string; // ISO string format
  changed_files_summary: string[]; // e.g., ["M path/to/file.ts", "A path/to/new.ts"]
  parent_oids: string[];
}

export interface DiffChunkPayload extends BaseQdrantPayload {
  dataType: 'diff_chunk';
  commit_oid: string; // The commit this diff is associated with (could be parent or current)
  filepath: string; // The file path this diff pertains to
  diff_content_chunk: string;
  chunk_index: number;
  total_chunks: number;
  change_type: 'modify' | 'add' | 'delete' | 'typechange'; // Ensure 'typechange' is handled if needed
}

// Types
export interface OllamaEmbeddingResponse { 
  embedding: number[] 
}

export interface OllamaGenerateResponse { 
  response: string 
}

// Modify the existing QdrantPoint interface:
// Replace the existing QdrantPoint interface with this:
export interface QdrantPoint {
  id: string; // Ensure unique IDs, e.g., `file:${filepath}:chunk:${index}`, `commit:${oid}`, `diff:${commit_oid}:${filepath}:chunk:${index}`
  vector: number[];
  payload: FileChunkPayload | CommitInfoPayload | DiffChunkPayload;
}


// Modify the existing QdrantSearchResult interface (if it's meant to be simple, otherwise DetailedQdrantSearchResult is the target)
// Let's assume QdrantSearchResult is a simpler version and DetailedQdrantSearchResult is the one we primarily use for agent context.

// Modify the existing DetailedQdrantSearchResult interface:
// Replace the existing DetailedQdrantSearchResult interface with this:
export interface DetailedQdrantSearchResult {
  id: string | number;
  score: number;
  payload: FileChunkPayload | CommitInfoPayload | DiffChunkPayload; // This is the main change
  version?: number; // Keep this as Qdrant might return it
  vector?: number[] | Record<string, unknown> | number[][] | null; // Keep this
  shard_key?: string; // Keep this
  order_value?: number; // Keep this
  // The following properties are now part of the typed payloads and can be removed from this top level:
  // filepath: string; (remove, now in FileChunkPayload, DiffChunkPayload)
  // content: string; (remove, now in FileChunkPayload as file_content_chunk, or DiffChunkPayload as diff_content_chunk)
  // last_modified: string; (remove, now in FileChunkPayload)
  // is_chunked?: boolean; (remove, implicit via chunk_index/total_chunks in FileChunkPayload, DiffChunkPayload)
  // chunk_index?: number; (remove, now in FileChunkPayload, DiffChunkPayload)
  // total_chunks?: number; (remove, now in FileChunkPayload, DiffChunkPayload)
  // [key: string]: unknown; // This can be removed if all expected payload fields are covered by the union.
                           // Or, keep it if there's a chance of other dynamic fields not in our defined types.
                           // For stricter typing, let's remove it for now. If issues arise, it can be re-added.
}

// Ensure the QdrantSearchResult (if it exists and is different from DetailedQdrantSearchResult)
// is also updated or reviewed. If it's a simplified version, it might look like:
// export interface QdrantSearchResult {
//   id: string | number;
//   payload: Partial<FileChunkPayload & CommitInfoPayload & DiffChunkPayload>; // A less strict payload for simple searches
//   score: number;
// }
// However, for consistency, it's often better to use DetailedQdrantSearchResult everywhere
// and just pick the fields needed. If QdrantSearchResult is used, ensure its payload reflects the new structure,
// perhaps as a Partial of the union or a simpler common subset.
// For now, let's assume DetailedQdrantSearchResult is the primary one used.
// The existing QdrantSearchResult in your provided file is:
// export interface QdrantSearchResult {
//   id: string | number;
//   payload: {
//     content: string;
//     filepath: string;
//     last_modified: string
//   };
//   score: number
// }
// This should be updated to:
// Replace the existing QdrantSearchResult interface with this:
export interface QdrantSearchResult {
  id: string | number;
  payload: Partial<FileChunkPayload | CommitInfoPayload | DiffChunkPayload>; // Or be more specific if it only ever returns one type
  score: number;
}

// Agent types
export interface AgentStep {
  tool: string;
  input: unknown;
  output: unknown;
  reasoning: string;
}

export interface AgentState {
  sessionId: string;
  query: string;
  planText?: string; // Stores the raw plan generated by the LLM
  steps: AgentStep[]; // Stores executed steps or a structured plan
  context: unknown[];
  finalResponse?: string;
  isComplete: boolean;
}

export interface AgentInitialQueryResponse {
  sessionId: string;
  status: "COMPLETED" | "ERROR"; // Status simplified: plan and summary are generated in one go or it errors.
  message: string;
  generatedPlanText?: string; // The raw plan text from the LLM
  agentState: AgentState; // The complete, updated agent state including the planText and finalResponse
}

// AgentStepExecutionResponse interface removed

// DetailedQdrantSearchResult is now defined above the QdrantSearchResult interface.
// The old definition of DetailedQdrantSearchResult has been replaced.

export interface ParsedToolCall {
  tool: string;
  parameters: Record<string, unknown>;
}
