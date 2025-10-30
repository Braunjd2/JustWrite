export function extractMentionsFromText(text) {
  if (typeof text !== 'string' || text.trim().length === 0) {
    return [];
  }
  const matches = text.match(/@[a-zA-Z0-9_-]+/g);
  if (!matches) {
    return [];
  }
  return Array.from(new Set(matches));
}
