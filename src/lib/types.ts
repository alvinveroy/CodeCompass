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

export const FeedbackSchema = z.object({
  sessionId: z.string().optional(),
  feedbackId: z.string().optional(),
  score: z.number().min(1).max(10),
  comments: z.string(),
  originalQuery: z.string(),
  suggestion: z.string()
});

// Agent schema
export const AgentQuerySchema = z.object({
  query: z.string().min(1, "Query is required"),
  sessionId: z.string().optional(),
  maxSteps: z.number().optional().default(5)
});

// Types
export interface OllamaEmbeddingResponse { 
  embedding: number[] 
}

export interface OllamaGenerateResponse { 
  response: string 
}

export interface QdrantPoint { 
  id: string; 
  vector: number[]; 
  payload: { 
    filepath: string; 
    content: string; 
    last_modified: string 
  } 
}

export interface QdrantSearchResult { 
  id: string | number; 
  payload: { 
    content: string; 
    filepath: string; 
    last_modified: string 
  }; 
  score: number 
}

// Agent types
export interface AgentStep {
  tool: string;
  input: any;
  output: any;
  reasoning: string;
}

export interface AgentState {
  sessionId: string;
  query: string;
  steps: AgentStep[];
  context: any[];
  finalResponse?: string;
  isComplete: boolean;
}
