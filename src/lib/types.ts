import { z } from "zod";

// Schemas
export const SearchCodeSchema = z.object({ 
  query: z.string().min(1, "Query is required") 
});

export const GenerateSuggestionSchema = z.object({
  query: z.string().min(1, "Query is required").optional(),
  prompt: z.string().min(1, "Prompt is required").optional(),
}).transform((data) => ({
  query: data.query || data.prompt || "",
})).refine(data => data.query.length > 0, {
  message: "Either query or prompt must be a non-empty string",
  path: ["query"],
});

export const GetRepositoryContextSchema = z.object({ 
  query: z.string().min(1, "Query is required") 
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
