// Utility: Preprocess input text
export function preprocessText(text: string): string {
  // eslint-disable-next-line no-control-regex
  text = text.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, ""); // Remove control characters, preserving \t, \n, and \r
  text = text.replace(/\s+/g, (match) => {
    if (match.includes("\n")) return "\n";
    return " ";
  });
  return text.trim();
}

// Add the following function to the end of the file:
export function chunkText(
  text: string,
  chunkSize: number,
  overlap: number
): string[] {
  if (!text || text.length === 0) return [];
  if (chunkSize <= 0) {
    // Consider logging this error or handling it as per project policy
    // For now, returning an empty array or throwing an error are options.
    // Throwing an error might be safer to catch configuration issues early.
    throw new Error("Chunk size must be positive.");
  }
  if (overlap < 0 || overlap >= chunkSize) {
    // Similar to above, consider logging or throwing.
    throw new Error("Overlap must be non-negative and less than chunk size.");
  }

  const chunks: string[] = [];
  let i = 0;
  while (i < text.length) {
    const end = Math.min(i + chunkSize, text.length);
    chunks.push(text.substring(i, end));
    if (end === text.length) break; // Reached the end of the text
    
    // Move the starting point for the next chunk
    // Ensure we don't get stuck if chunkSize - overlap is 0 or negative (covered by overlap check)
    i += (chunkSize - overlap);
    
    // Safety break for potential infinite loops if logic is flawed, though current logic should be fine.
    // This is more of a defensive measure during development.
    if (chunks.length > text.length) { // Heuristic: can't have more chunks than characters
        // logger.error("Chunking seems to be in an infinite loop. Breaking."); // Requires logger access
        console.error("Chunking seems to be in an infinite loop. Breaking.");
        break;
    }
  }
  return chunks;
}
