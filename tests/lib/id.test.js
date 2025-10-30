import { describe, expect, it } from 'vitest';
import { createId, nextActId, nextChapterId, nextSceneId, nextBeatId } from '../../src/lib/id.js';

describe('id helpers', () => {
  it('creates unique ids with prefix', () => {
    const id = createId('test');
    expect(id.startsWith('test-')).toBe(true);
    const other = createId('test');
    expect(other).not.toBe(id);
  });

  it('generates hierarchical ids', () => {
    expect(nextActId(1)).toBe('A1');
    expect(nextChapterId('A1', 2)).toBe('A1.C2');
    expect(nextSceneId('A1.C2', 3)).toBe('A1.C2.S3');
    expect(nextBeatId('A1.C2.S3', 4)).toBe('A1.C2.S3.B4');
  });
});

