import { describe, expect, it } from 'vitest';
import {
  normalizeDetailItems,
  normalizeBackgroundUpdates,
  normalizeCoreUpdates,
  applyCodexUpdates,
  updateAllCodexRelations
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
    expect(entry.details.length).toBeGreaterThanOrEqual(1);
  });

  it('updates existing entries without duplication', () => {
    const draft = baseDraft();
    const entryId = 'codex-1';
    draft.codex.entries[entryId] = {
      id: entryId,
      name: 'Avery',
      category: 'character',
      summary: '',
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
    expect(draft.codex.entries[entryId].summary).toBe('Updated hero');
    expect(draft.codex.entries[entryId].details).toHaveLength(1);
  });

  it('builds relations when codex entries mention others', () => {
    const draft = baseDraft();
    draft.codex.entries = {
      A: { id: 'A', name: 'Alpha', category: 'lore', summary: '@Beta is here', details: [] },
      B: { id: 'B', name: 'Beta', category: 'lore', summary: '', details: [] }
    };
    updateAllCodexRelations(draft.codex.entries);
    expect(draft.codex.entries.A.relations).toHaveLength(1);
    expect(draft.codex.entries.B.relatedBy).toEqual([{ sourceId: 'A', sources: [{ kind: 'summary' }] }]);
  });
});
