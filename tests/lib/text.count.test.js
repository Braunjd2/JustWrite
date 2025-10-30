import { describe, expect, it } from 'vitest';
import { calculateWordCount } from '../../src/lib/text/count.js';

describe('text/count', () => {
  it('handles empty and non-string input', () => {
    expect(calculateWordCount()).toBe(0);
    expect(calculateWordCount(123)).toBe(0);
    expect(calculateWordCount('   ')).toBe(0);
  });

  it('counts words separated by whitespace', () => {
    expect(calculateWordCount('hello world')).toBe(2);
    expect(calculateWordCount('hello\nworld\tagain')).toBe(3);
  });
});

