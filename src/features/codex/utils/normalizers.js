import { CHARACTER_BACKGROUND_FIELDS, CHARACTER_CORE_SECTION_KEYS } from '../../../constants.js';
import { createId } from '../../../lib/id.js';

export function createCharacterBackground(source = {}) {
  const result = {};
  CHARACTER_BACKGROUND_FIELDS.forEach((field) => {
    const value = source && typeof source[field] === 'string' ? source[field] : '';
    result[field] = value;
  });
  return result;
}

export function normalizeCharacterBackground(value) {
  return createCharacterBackground(value || {});
}

export function createCharacterCoreSections(source = {}) {
  const sections = {};
  CHARACTER_CORE_SECTION_KEYS.forEach((key) => {
    const items = Array.isArray(source[key]) ? source[key] : [];
    sections[key] = items
      .map((item) => {
        if (!item || typeof item.text !== 'string') {
          return null;
        }
        const text = item.text.trim();
        return {
          id: item.id || createId('core'),
          text,
          sourceSceneId: typeof item.sourceSceneId === 'string' ? item.sourceSceneId : null,
          sourceBeatId: typeof item.sourceBeatId === 'string' ? item.sourceBeatId : null,
          createdAt: item.createdAt || new Date().toISOString()
        };
      })
      .filter(Boolean);
  });
  return sections;
}

export function normalizeCharacterCoreSections(value) {
  return createCharacterCoreSections(value || {});
}

export function createCodexDetail(text = '', sourceSceneId = null, sourceBeatId = null) {
  const normalizedText = typeof text === 'string' ? text.trim() : '';
  const timestamp = new Date().toISOString();
  return {
    id: createId('detail'),
    text: normalizedText,
    sourceSceneId: typeof sourceSceneId === 'string' ? sourceSceneId : null,
    sourceBeatId: typeof sourceBeatId === 'string' ? sourceBeatId : null,
    createdAt: timestamp,
    updatedAt: timestamp
  };
}

export function normalizeCodexDetails(list) {
  if (!Array.isArray(list)) {
    return [];
  }
  return list
    .map((detail) => {
      if (typeof detail === 'string') {
        const text = detail.trim();
        if (!text) {
          return null;
        }
        const timestamp = new Date().toISOString();
        return {
          id: createId('detail'),
          text,
          sourceSceneId: null,
          sourceBeatId: null,
          createdAt: timestamp,
          updatedAt: timestamp
        };
      }
      if (!detail || typeof detail.text !== 'string') {
        return null;
      }
      const text = detail.text.trim();
      if (text.length === 0) {
        return null;
      }
      return {
        id: detail.id || createId('detail'),
        text,
        sourceSceneId: typeof detail.sourceSceneId === 'string' ? detail.sourceSceneId : null,
        sourceBeatId: typeof detail.sourceBeatId === 'string' ? detail.sourceBeatId : null,
        createdAt: detail.createdAt || new Date().toISOString(),
        updatedAt: detail.updatedAt || detail.createdAt || new Date().toISOString()
      };
    })
    .filter(Boolean);
}

export function createCodexMedia(media) {
  if (!media || typeof media.dataUrl !== 'string' || media.dataUrl.trim().length === 0) {
    throw new Error('Invalid Codex media payload');
  }
  return {
    id: media.id || createId('media'),
    name: typeof media.name === 'string' && media.name.trim().length > 0 ? media.name.trim() : 'Image',
    type: typeof media.type === 'string' && media.type.trim().length > 0 ? media.type : 'image',
    size: typeof media.size === 'number' ? media.size : 0,
    dataUrl: media.dataUrl,
    createdAt: media.createdAt || new Date().toISOString()
  };
}

export function normalizeCodexMedia(list) {
  if (!Array.isArray(list)) {
    return [];
  }
  return list
    .map((item) => {
      if (!item || typeof item.dataUrl !== 'string' || item.dataUrl.trim().length === 0) {
        return null;
      }
      return {
        id: item.id || createId('media'),
        name: typeof item.name === 'string' && item.name.trim().length > 0 ? item.name.trim() : 'Image',
        type: typeof item.type === 'string' && item.type.trim().length > 0 ? item.type : 'image',
        size: typeof item.size === 'number' ? item.size : 0,
        dataUrl: item.dataUrl,
        createdAt: item.createdAt || new Date().toISOString()
      };
    })
    .filter(Boolean);
}
