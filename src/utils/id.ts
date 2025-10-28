let counter = 0;

export function createId(prefix: string): string {
  counter += 1;
  const now = new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14);
  return `${prefix}-${now}-${counter}`;
}
