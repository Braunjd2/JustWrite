import { describe, expect, it } from 'vitest';
import {
  normalizeDetailItems,
  normalizeBackgroundUpdates,
  normalizeCoreUpdates,
  applyCodexUpdates,
  updateAllCodexRelations,
  removeSceneContributions
} from '../../../src/features/codex/state/updates.js';
import {
  createCharacterBackground,
  createCharacterCoreSections
} from '../../../src/features/codex/utils/normalizers.js';

const baseDraft = () => ({
  acts: [],
  chapters: {},
  scenes: {
    S1: {
      id: 'S1',
      beats: [
        { id: 'S1.B1', order: 1, title: 'Beat 1', summary: '' }
      ]
    }
  },
  codex: {
    entries: {}
  }
});

describe('codex updates', () => {
  it('normalizes detail items from strings and objects', () => {
    const items = normalizeDetailItems([' Note ', { text: 'Other', sceneId: 'S1', beatId: 'S1.B1' }], 'S1');
    expect(items).toEqual([
      { text: 'Note', sceneId: 'S1', beatId: null, beatTitle: null, beatNumber: null },
      { text: 'Other', sceneId: 'S1', beatId: 'S1.B1', beatTitle: null, beatNumber: null }
    ]);
  });

  it('normalizes background updates', () => {
    const updates = normalizeBackgroundUpdates({ age: '30', gender: { value: 'F', sceneId: 'S1' } }, 'S1');
    expect(updates).toHaveLength(2);
    expect(updates[1].sceneId).toBe('S1');
  });

  it('normalizes core updates', () => {
    const updates = normalizeCoreUpdates({ appearance: [{ text: 'Tall', sceneId: 'S1' }] }, 'S1');
    expect(updates[0]).toMatchObject({ section: 'appearance', text: 'Tall', sceneId: 'S1' });
  });

  it('applies codex updates creating new entries', () => {
    const draft = baseDraft();
    const result = applyCodexUpdates(draft, 'S1', [
      {
        name: 'Avery',
        category: 'character',
        summary: 'Hero',
        details: [{ text: 'Arrives', sceneId: 'S1', beatId: 'S1.B1' }],
        background: { age: '29' },
        core: { appearance: [{ text: 'Tall', sceneId: 'S1' }] }
      }
    ]);
    expect(result.created).toBe(1);
    const entry = Object.values(draft.codex.entries).find((item) => item.name === 'Avery');
    expect(entry).toBeTruthy();
    expect(entry.details.map((detail) => detail.text)).toContain('Hero');
  });

  it('updates existing entries without duplication', () => {
    const draft = baseDraft();
    const entryId = 'codex-1';
    draft.codex.entries[entryId] = {
      id: entryId,
      name: 'Avery',
      category: 'character',
      details: [],
      background: createCharacterBackground(),
      core: createCharacterCoreSections()
    };
    const result = applyCodexUpdates(draft, 'S1', [
      {
        name: 'Avery',
        category: 'character',
        summary: 'Updated hero',
        details: [{ text: 'New detail', sceneId: 'S1', beatId: 'S1.B1' }]
      }
    ]);
    expect(result.updated).toBe(1);
    const updatedEntry = draft.codex.entries[entryId];
    expect(updatedEntry.details.map((detail) => detail.text)).toContain('Updated hero');
  });

  it('builds relations when codex entries mention others', () => {
    const draft = baseDraft();
    draft.codex.entries = {
      A: { id: 'A', name: 'Alpha', category: 'lore', details: [{ text: '@Beta is here' }] },
      B: { id: 'B', name: 'Beta', category: 'lore', details: [] }
    };
    updateAllCodexRelations(draft.codex.entries);
    expect(draft.codex.entries.A.relations).toHaveLength(1);
    expect(draft.codex.entries.B.relatedBy).toEqual([
      { sourceId: 'A', sources: [{ kind: 'detail', detailId: null, sceneId: null, beatId: null }] }
    ]);
  });

  it('removes scene contributions while preserving manual notes', () => {
    const draft = {
      acts: [],
      chapters: {},
      scenes: {
        'A1.C1.S1': {
          id: 'A1.C1.S1',
          beats: [{ id: 'A1.C1.S1.B1', order: 1, title: 'Beat 1', summary: '' }]
        }
      },
      codex: {
        entries: {
          hero: {
            id: 'hero',
            name: 'Hero',
            category: 'character',
            details: [
              { id: 'd1', text: 'AI detail', sourceSceneId: 'A1.C1.S1', sourceBeatId: null },
              { id: 'd2', text: 'Manual note', sourceSceneId: null, sourceBeatId: null }
            ],
            core: {
              appearance: [
                {
                  id: 'c1',
                  text: 'Looks tired',
                  sourceSceneId: 'A1.C1.S1',
                  sourceBeatId: 'A1.C1.S1.B1',
                  createdAt: new Date().toISOString()
                }
              ],
              personality: []
            }
          }
        }
      }
    };

    removeSceneContributions(draft, 'A1.C1.S1');

    const entry = draft.codex.entries.hero;
    expect(entry.details).toEqual([{ id: 'd2', text: 'Manual note', sourceSceneId: null, sourceBeatId: null }]);
    expect(entry.core.appearance).toEqual([]);
  });

  it('removes details attached via beat id when scene changed', () => {
    const draft = {
      acts: [],
      chapters: {},
      scenes: {
        'A1.C1.S1': {
          id: 'A1.C1.S1',
          beats: [{ id: 'A1.C1.S1.B1', order: 1, title: 'Beat 1', summary: '' }]
        }
      },
      codex: {
        entries: {
          item: {
            id: 'item',
            name: 'Artifact',
            category: 'item',
            details: [
              { id: 'd1', text: 'Beat only', sourceSceneId: null, sourceBeatId: 'A1.C1.S1.B1' }
            ]
          }
        }
      }
    };

    removeSceneContributions(draft, 'A1.C1.S1');

    expect(draft.codex.entries.item.details).toEqual([]);
  });

  it('clears background values that originated from the scene', () => {
    const draft = {
      acts: [],
      chapters: {},
      scenes: {
        'A1.C1.S1': {
          id: 'A1.C1.S1',
          beats: []
        }
      },
      codex: {
        entries: {
          hero: {
            id: 'hero',
            name: 'Hero',
            category: 'character',
            background: {
              age: '12',
              gender: ''
            },
            details: [
              {
                id: 'd1',
                text: 'Background · Age: 12',
                sourceSceneId: 'A1.C1.S1',
                sourceBeatId: null
              }
            ],
            core: {
              appearance: [],
              personality: []
            }
          }
        }
      }
    };

    removeSceneContributions(draft, 'A1.C1.S1');

    const entry = draft.codex.entries.hero;
    expect(entry.background.age).toBe('');
    expect(entry.details).toEqual([]);
    expect('summary' in entry).toBe(false);
  });
});
