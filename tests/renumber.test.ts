import { describe, expect, it } from 'vitest';
import { renumberHierarchy } from '../src/lib/outline/renumber';

const baseHierarchy = {
  acts: [
    { id: 'a2', order: 2, title: 'Act 2', chapterIds: [] },
    { id: 'a1', order: 1, title: 'Act 1', chapterIds: [] }
  ],
  chapters: [
    { id: 'c1', order: 2, title: 'Chapter 2', actId: 'a2', sceneIds: [] },
    { id: 'c2', order: 1, title: 'Chapter 1', actId: 'a2', sceneIds: [] }
  ],
  scenes: [
    {
      id: 's1',
      order: 2,
      title: 'Scene 2',
      chapterId: 'c1',
      actId: 'a2',
      beats: [],
      text: '',
      wordCount: 0,
      draftStatus: 'empty',
      lastUpdated: new Date().toISOString()
    },
    {
      id: 's2',
      order: 1,
      title: 'Scene 1',
      chapterId: 'c1',
      actId: 'a2',
      beats: [],
      text: '',
      wordCount: 0,
      draftStatus: 'empty',
      lastUpdated: new Date().toISOString()
    }
  ]
};

describe('renumberHierarchy', () => {
  it('renumbers acts, chapters, and scenes consistently', () => {
    const result = renumberHierarchy(baseHierarchy);
    expect(result.acts[0].order).toBe(1);
    expect(result.acts[1].order).toBe(2);
    expect(result.scenes[0].order).toBe(1);
    expect(result.chapters[0].order).toBe(1);
  });
});
