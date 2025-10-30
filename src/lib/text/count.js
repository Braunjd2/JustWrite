export function calculateWordCount(text) {
  if (typeof text !== 'string') {
    return 0;
  }
  const trimmed = text.trim();
  if (trimmed.length === 0) {
    return 0;
  }
  return trimmed.split(/\s+/).filter(Boolean).length;
}

