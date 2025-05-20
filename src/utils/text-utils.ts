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
