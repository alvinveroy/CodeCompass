// Utility: Preprocess input text
export function preprocessText(text: string): string {
  // eslint-disable-next-line no-control-regex
  text = text.replace(/\x00/g, ""); // Only remove null characters
  text = text.replace(/\s+/g, (match) => {
    if (match.includes("\n")) return "\n";
    return " ";
  });
  return text.trim();
}
