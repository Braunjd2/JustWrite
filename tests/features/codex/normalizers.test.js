import { describe, expect, it } from 'vitest';
import {
  createCharacterBackground,
  normalizeCharacterBackground,
  createCharacterCoreSections,
  normalizeCharacterCoreSections,
  createCodexDetail,
  normalizeCodexDetails,
  createCodexMedia,
  normalizeCodexMedia
} from '../../../src/features/codex/utils/normalizers.js';

describe('codex normalizers', () => {
  it('creates character background with expected fields', () => {
    const background = createCharacterBackground({ age: '30', gender: 'F' });
    expect(background).toMatchObject({ age: '30', gender: 'F', species: '', faction: '' });
  });

  it('normalizes background safely when undefined', () => {
    expect(normalizeCharacterBackground()).toMatchObject({ age: '', gender: '', species: '', faction: '' });
  });

  it('creates core sections and trims entries', () => {
    const core = createCharacterCoreSections({
      appearance: [{ text: ' Tall ' }],
      personality: [{ text: ' Brave ', sourceSceneId: 'S1' }]
    });
    expect(core.appearance[0].text).toBe('Tall');
    expect(core.personality[0].sourceSceneId).toBe('S1');
  });

  it('normalizes codex detail strings into structured objects', () => {
    const details = normalizeCodexDetails([
      ' First note ',
      { text: 'Second', sourceSceneId: 'S1', sourceBeatId: 'B1' }
    ]);
    expect(details).toHaveLength(2);
    expect(details[0].text).toBe('First note');
    expect(details[1].sourceBeatId).toBe('B1');
  });

  it('creates codex detail with timestamps', () => {
    const detail = createCodexDetail('Note', 'S1', 'B1');
    expect(detail.text).toBe('Note');
    expect(detail.sourceSceneId).toBe('S1');
    expect(detail.sourceBeatId).toBe('B1');
    expect(detail.createdAt).toBeTruthy();
  });

  it('normalizes codex media entries', () => {
    const media = normalizeCodexMedia([
      { dataUrl: 'data:image/png;base64,abc', name: 'Pic', type: 'image/png', size: 123 }
    ]);
    expect(media).toHaveLength(1);
    expect(media[0].name).toBe('Pic');
  });

  it('throws on invalid media payload', () => {
    expect(() => createCodexMedia({})).toThrow();
  });
});
