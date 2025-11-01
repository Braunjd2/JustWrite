import {
  CHARACTER_BACKGROUND_FIELDS,
  CHARACTER_BACKGROUND_LABELS,
  CHARACTER_CORE_SECTION_KEYS
} from '../../../constants.js';
import { createId } from '../../../lib/id.js';
import { getOrderedSceneIds } from '../../scenes/utils/order.js';
import {
  createCharacterBackground,
  createCharacterCoreSections,
  createCodexDetail
} from '../utils/normalizers.js';
import { extractMentionsFromText } from '../../../lib/text/mentions.js';

const BACKGROUND_LABEL_TO_FIELD = Object.entries(CHARACTER_BACKGROUND_LABELS).reduce((map, [field, label]) => {
  map[label] = field;
  return map;
}, {});

export function normalizeCodexCategory(value) {
  const normalized = typeof value === 'string' ? value.toLowerCase().trim() : '';
  if (normalized === 'character' || normalized === 'place' || normalized === 'item' || normalized === 'lore') {
    return normalized;
  }
  return 'lore';
}

export function findCodexEntryIdByName(entries, name) {
  if (!name) {
    return null;
  }
  const target = name.trim().toLowerCase();
  for (const [id, entry] of Object.entries(entries || {})) {
    if (entry && entry.name && entry.name.trim().toLowerCase() === target) {
      return id;
    }
  }
  return null;
}

export function detailExists(entry, detailText, sceneId, beatId) {
  if (!entry || !Array.isArray(entry.details)) {
    return false;
  }
  const trimmed = detailText.trim().toLowerCase();
  return entry.details.some((detail) => {
    if (!detail || !detail.text) {
      return false;
    }
    if (detail.text.trim().toLowerCase() !== trimmed) {
      return false;
    }
    if (beatId) {
      if (detail.sourceBeatId && detail.sourceBeatId === beatId) {
        return true;
      }
      return false;
    }
    if (sceneId) {
      return detail.sourceSceneId === sceneId;
    }
    return !detail.sourceSceneId;
  });
}

export function getSceneAndBeatOrder(draftState, beatId) {
  if (!draftState || !beatId) {
    return { sceneIndex: Number.MAX_SAFE_INTEGER, beatIndex: Number.MAX_SAFE_INTEGER };
  }
  const orderedSceneIds = getOrderedSceneIds(draftState);
  for (let sceneIndex = 0; sceneIndex < orderedSceneIds.length; sceneIndex += 1) {
    const sceneId = orderedSceneIds[sceneIndex];
    const scene = draftState.scenes?.[sceneId];
    if (!scene || !Array.isArray(scene.beats)) {
      continue;
    }
    const beatsSorted = scene.beats.slice().sort((a, b) => (a.order || 0) - (b.order || 0));
    const beatIndex = beatsSorted.findIndex((beat) => beat.id === beatId);
    if (beatIndex !== -1) {
      return { sceneIndex, beatIndex };
    }
  }
  return { sceneIndex: Number.MAX_SAFE_INTEGER, beatIndex: Number.MAX_SAFE_INTEGER };
}

export function resolveBeatIdForScene(scene, hint) {
  if (!hint) {
    return null;
  }
  const beats = scene && Array.isArray(scene.beats)
    ? scene.beats.slice().sort((a, b) => (a.order || 0) - (b.order || 0))
    : [];
  const hasBeats = beats.length > 0;
  if (typeof hint.beatId === 'string' && hint.beatId.length > 0) {
    if (!hasBeats) {
      return hint.beatId;
    }
    const direct = beats.find((beat) => beat.id === hint.beatId);
    if (direct) {
      return direct.id;
    }
  }
  const numeric =
    Number.isFinite(hint.beatNumber)
      ? hint.beatNumber
      : Number.isFinite(hint.order)
        ? hint.order
        : Number.isFinite(hint.index)
          ? hint.index + 1
          : null;
  if (numeric && hasBeats) {
    const index = Math.max(0, Math.min(beats.length - 1, numeric - 1));
    const beat = beats[index];
    if (beat) {
      return beat.id;
    }
  }
  if (typeof hint.beatTitle === 'string' && hint.beatTitle.trim().length > 0 && hasBeats) {
    const normalized = hint.beatTitle.trim().toLowerCase();
    let match = beats.find((beat) => (beat.title || '').trim().toLowerCase() === normalized);
    if (match) {
      return match.id;
    }
    match = beats.find((beat) => (beat.title || '').trim().toLowerCase().includes(normalized));
    if (match) {
      return match.id;
    }
  }
  return typeof hint.beatId === 'string' ? hint.beatId : null;
}

export function normalizeDetailItems(rawDetails, defaultSceneId) {
  if (!Array.isArray(rawDetails)) {
    return [];
  }
  return rawDetails
    .map((item) => {
      if (typeof item === 'string') {
        const text = item.trim();
        if (!text) {
          return null;
        }
        return {
          text,
          sceneId: defaultSceneId,
          beatId: null,
          beatTitle: null,
          beatNumber: null
        };
      }
      if (!item || typeof item.text !== 'string') {
        return null;
      }
      const text = item.text.trim();
      if (text.length === 0) {
        return null;
      }
      return {
        text,
        sceneId: typeof item.sceneId === 'string' && item.sceneId.length > 0 ? item.sceneId : defaultSceneId,
        beatId: typeof item.beatId === 'string' && item.beatId.length > 0 ? item.beatId : null,
        beatTitle: typeof item.beatTitle === 'string' ? item.beatTitle.trim() : null,
        beatNumber: Number.isFinite(item.beatNumber)
          ? item.beatNumber
          : Number.isFinite(item.order)
            ? item.order
            : Number.isFinite(item.index)
              ? item.index + 1
              : null
      };
    })
    .filter(Boolean);
}

export function normalizeBackgroundUpdates(rawBackground, defaultSceneId) {
  if (!rawBackground || typeof rawBackground !== 'object') {
    return [];
  }
  const updates = [];
  CHARACTER_BACKGROUND_FIELDS.forEach((field) => {
    const value = rawBackground[field];
    if (!value) {
      return;
    }
    if (typeof value === 'string') {
      const text = value.trim();
      if (text.length === 0) {
        return;
      }
      updates.push({
        field,
        value: text,
        sceneId: defaultSceneId,
        beatId: null,
        beatTitle: null,
        beatNumber: null
      });
      return;
    }
    if (typeof value === 'object') {
      const text = typeof value.value === 'string' ? value.value.trim() : '';
      if (text.length === 0) {
        return;
      }
      updates.push({
        field,
        value: text,
        sceneId: typeof value.sceneId === 'string' && value.sceneId.length > 0 ? value.sceneId : defaultSceneId,
        beatId: typeof value.beatId === 'string' && value.beatId.length > 0 ? value.beatId : null,
        beatTitle: typeof value.beatTitle === 'string' ? value.beatTitle.trim() : null,
        beatNumber: Number.isFinite(value.beatNumber)
          ? value.beatNumber
          : Number.isFinite(value.order)
            ? value.order
            : null
      });
    }
  });
  return updates;
}

export function normalizeCoreUpdates(rawCore, defaultSceneId) {
  if (!rawCore || typeof rawCore !== 'object') {
    return [];
  }
  const updates = [];
  CHARACTER_CORE_SECTION_KEYS.forEach((section) => {
    const items = Array.isArray(rawCore[section]) ? rawCore[section] : [];
    items.forEach((item) => {
      if (typeof item === 'string') {
        const text = item.trim();
        if (text.length === 0) {
          return;
        }
        updates.push({
          section,
          text,
          sceneId: defaultSceneId,
          beatId: null,
          beatTitle: null,
          beatNumber: null,
          confidence: 'medium'
        });
        return;
      }
      if (!item || typeof item.text !== 'string') {
        return;
      }
      const text = item.text.trim();
      if (text.length === 0) {
        return;
      }
      updates.push({
        section,
        text,
        sceneId: typeof item.sceneId === 'string' && item.sceneId.length > 0 ? item.sceneId : defaultSceneId,
        beatId: typeof item.beatId === 'string' && item.beatId.length > 0 ? item.beatId : null,
        beatTitle: typeof item.beatTitle === 'string' ? item.beatTitle.trim() : null,
        beatNumber: Number.isFinite(item.beatNumber)
          ? item.beatNumber
          : Number.isFinite(item.order)
            ? item.order
            : Number.isFinite(item.index)
              ? item.index + 1
              : null,
        confidence: typeof item.confidence === 'string' ? item.confidence.toLowerCase() : null
      });
    });
  });
  return updates;
}

export function applyBackgroundUpdatesToEntry(entry, updates, draftState, fallbackSceneId, options = {}) {
  if (!entry || entry.category !== 'character' || !Array.isArray(updates) || updates.length === 0) {
    return false;
  }
  if (!entry.background) {
    entry.background = createCharacterBackground(entry.background);
  }
  if (!Array.isArray(entry.details)) {
    entry.details = [];
  }
  let mutated = false;
  updates.forEach((update) => {
    if (!update || !CHARACTER_BACKGROUND_FIELDS.includes(update.field)) {
      return;
    }
    const label = CHARACTER_BACKGROUND_LABELS[update.field] || update.field;
    const value = typeof update.value === 'string' ? update.value : '';
    if (value.length === 0) {
      return;
    }
    const hasChanged = entry.background[update.field] !== value;
    if (hasChanged) {
      entry.background[update.field] = value;
      mutated = true;
    }
    if (options.suppressDetail || !hasChanged) {
      return;
    }
    const sceneId = update.sceneId || fallbackSceneId || null;
    const scene = sceneId ? draftState.scenes?.[sceneId] || null : null;
    const beatId = resolveBeatIdForScene(scene, update);
    const text = `Background · ${label}: ${value}`;
    if (!detailExists(entry, text, sceneId, beatId)) {
      entry.details.push(createCodexDetail(text, sceneId, beatId));
      mutated = true;
    }
  });
  return mutated;
}

export function applyCoreUpdatesToEntry(entry, updates, draftState, fallbackSceneId) {
  if (!entry || entry.category !== 'character' || !Array.isArray(updates) || updates.length === 0) {
    return false;
  }
  if (!entry.core) {
    entry.core = createCharacterCoreSections(entry.core);
  }
  let mutated = false;
  updates.forEach((update) => {
    if (!update || !CHARACTER_CORE_SECTION_KEYS.includes(update.section) || typeof update.text !== 'string') {
      return;
    }
    const text = update.text.trim();
    if (text.length === 0 || text.length < 10) {
      return;
    }
    if (update.confidence === 'low') {
      return;
    }
    const section = update.section;
    const list = Array.isArray(entry.core[section]) ? entry.core[section] : [];
    entry.core[section] = list;
    const sceneId = update.sceneId || fallbackSceneId || null;
    const scene = sceneId ? draftState.scenes?.[sceneId] || null : null;
    const beatId = resolveBeatIdForScene(scene, update);

    const existingByBeat = beatId ? list.find((item) => item && item.sourceBeatId === beatId) : null;
    if (existingByBeat) {
      if (existingByBeat.text.trim() !== text) {
        existingByBeat.text = text;
        existingByBeat.sourceSceneId = sceneId || existingByBeat.sourceSceneId || null;
        existingByBeat.updatedAt = new Date().toISOString();
        mutated = true;
      }
      return;
    }
    const duplicateText = list.find(
      (item) => item && typeof item.text === 'string' && item.text.trim().toLowerCase() === text.toLowerCase()
    );
    if (duplicateText) {
      return;
    }
    list.push({
      id: createId('core'),
      text,
      sourceSceneId: sceneId || null,
      sourceBeatId: beatId || null,
      createdAt: new Date().toISOString()
    });
    mutated = true;
  });

  if (mutated) {
    CHARACTER_CORE_SECTION_KEYS.forEach((section) => {
      const list = entry.core[section];
      if (!Array.isArray(list) || list.length === 0) {
        return;
      }
      list.sort((a, b) => {
        const orderA = getSceneAndBeatOrder(draftState, a.sourceBeatId);
        const orderB = getSceneAndBeatOrder(draftState, b.sourceBeatId);
        if (orderA.sceneIndex !== orderB.sceneIndex) {
          return orderA.sceneIndex - orderB.sceneIndex;
        }
        if (orderA.beatIndex !== orderB.beatIndex) {
          return orderA.beatIndex - orderB.beatIndex;
        }
        const createdA = a.createdAt ? new Date(a.createdAt).getTime() : 0;
        const createdB = b.createdAt ? new Date(b.createdAt).getTime() : 0;
        return createdA - createdB;
      });
    });
  }

  return mutated;
}

function resolveSceneIdForBeat(draftState, beatId) {
  if (!draftState || !draftState.scenes || !beatId) {
    return null;
  }
  for (const [sceneKey, scene] of Object.entries(draftState.scenes)) {
    if (!scene || !Array.isArray(scene.beats)) {
      continue;
    }
    const matches = scene.beats.some((beat) => beat && beat.id === beatId);
    if (matches) {
      return scene.id || sceneKey;
    }
  }
  return null;
}

function beatBelongsToScene(draftState, beatId, sceneId) {
  if (!beatId || !sceneId) {
    return false;
  }
  const ownerSceneId = resolveSceneIdForBeat(draftState, beatId);
  return ownerSceneId === sceneId;
}

function detailMatchesScene(detail, draftState, sceneId) {
  if (!detail || !sceneId) {
    return false;
  }
  if (detail.sourceSceneId === sceneId) {
    return true;
  }
  if (detail.sourceBeatId) {
    return beatBelongsToScene(draftState, detail.sourceBeatId, sceneId);
  }
  return false;
}

export function removeSceneContributions(draftState, sceneId) {
  if (!draftState || !sceneId || !draftState.codex || !draftState.codex.entries) {
    return;
  }

  let mutated = false;
  Object.values(draftState.codex.entries).forEach((entry) => {
    if (!entry) {
      return;
    }

    let removedDetails = [];
    if (Array.isArray(entry.details) && entry.details.length > 0) {
      const kept = [];
      entry.details.forEach((detail) => {
        if (detailMatchesScene(detail, draftState, sceneId)) {
          removedDetails.push(detail);
          return;
        }
        kept.push(detail);
      });
      if (kept.length !== entry.details.length) {
        entry.details = kept;
        mutated = true;
      }
    }

    if (entry.category === 'character' && entry.core && typeof entry.core === 'object') {
      CHARACTER_CORE_SECTION_KEYS.forEach((section) => {
        const list = Array.isArray(entry.core[section]) ? entry.core[section] : [];
        if (list.length === 0) {
          return;
        }
        const filtered = list.filter(
          (item) =>
            item &&
            item.sourceSceneId !== sceneId &&
            !beatBelongsToScene(draftState, item.sourceBeatId, sceneId)
        );
        if (filtered.length !== list.length) {
          entry.core[section] = filtered;
          mutated = true;
        }
      });

      if (removedDetails.length > 0 && entry.background && typeof entry.background === 'object') {
        removedDetails.forEach((detail) => {
          if (!detail || typeof detail.text !== 'string') {
            return;
          }
          const prefix = 'Background · ';
          if (!detail.text.startsWith(prefix)) {
            return;
          }
          const remainder = detail.text.slice(prefix.length);
          const separatorIndex = remainder.indexOf(':');
          if (separatorIndex === -1) {
            return;
          }
          const label = remainder.slice(0, separatorIndex).trim();
          const value = remainder.slice(separatorIndex + 1).trim();
          const field = BACKGROUND_LABEL_TO_FIELD[label];
          if (!field) {
            return;
          }
          if (typeof entry.background[field] === 'string' && entry.background[field].trim() === value) {
            entry.background[field] = '';
            mutated = true;
          }
        });
      }
    }
  });

  if (mutated) {
    refreshCodexDerivedData(draftState);
  }
}

export function applyCodexUpdates(draft, sceneId, updates) {
  const result = { created: 0, updated: 0 };
  if (!Array.isArray(updates) || updates.length === 0) {
    return result;
  }

  if (!draft.codex.entries || typeof draft.codex.entries !== 'object') {
    draft.codex.entries = {};
  }

  const currentScene = sceneId ? draft.scenes?.[sceneId] || null : null;

  updates.forEach((update) => {
    if (!update || typeof update.name !== 'string') {
      return;
    }
    const name = update.name.trim();
    if (name.length === 0) {
      return;
    }

    const category = normalizeCodexCategory(update.category);
    const summaryText = typeof update.summary === 'string' ? update.summary.trim() : '';
    const detailItems = normalizeDetailItems(Array.isArray(update.details) ? update.details : [], sceneId);
    if (summaryText.length > 0) {
      detailItems.unshift({
        text: summaryText,
        sceneId,
        beatId: null,
        beatTitle: null,
        beatNumber: null
      });
    }
    const backgroundUpdates =
      category === 'character' ? normalizeBackgroundUpdates(update.background || {}, sceneId) : [];
    const coreUpdates = category === 'character' ? normalizeCoreUpdates(update.core || {}, sceneId) : [];

    const existingId = findCodexEntryIdByName(draft.codex.entries, name);
    if (existingId) {
      const entry = draft.codex.entries[existingId];
      let entryMutated = false;

      if (entry.category !== category && category) {
        entry.category = category;
        entryMutated = true;
        if (entry.category === 'character') {
          entry.background = createCharacterBackground(entry.background);
          entry.core = createCharacterCoreSections(entry.core);
        } else {
          delete entry.background;
          delete entry.core;
        }
      }

      if (!Array.isArray(entry.details)) {
        entry.details = [];
      }

      detailItems.forEach((detail) => {
        if (!detail || typeof detail.text !== 'string' || detail.text.length === 0) {
          return;
        }
        const targetSceneId = detail.sceneId || sceneId;
        const targetScene = targetSceneId ? draft.scenes?.[targetSceneId] || null : currentScene;
        const resolvedBeatId = resolveBeatIdForScene(targetScene, detail);
        if (!detailExists(entry, detail.text, targetSceneId, resolvedBeatId)) {
          entry.details.push(createCodexDetail(detail.text, targetSceneId, resolvedBeatId));
          entryMutated = true;
        }
      });

      if (category === 'character') {
        const backgroundChanged = applyBackgroundUpdatesToEntry(entry, backgroundUpdates, draft, sceneId);
        const coreChanged = applyCoreUpdatesToEntry(entry, coreUpdates, draft, sceneId);
        if (backgroundChanged || coreChanged) {
          entryMutated = true;
        }
      }

      if (entryMutated) {
        result.updated += 1;
      }
    } else {
      const id = createId('codex');
      const newEntry = {
        id,
        name,
        category,
        details: []
      };
      detailItems.forEach((detail) => {
        if (!detail || typeof detail.text !== 'string' || detail.text.length === 0) {
          return;
        }
        const targetSceneId = detail.sceneId || sceneId;
        const targetScene = targetSceneId ? draft.scenes?.[targetSceneId] || null : currentScene;
        const resolvedBeatId = resolveBeatIdForScene(targetScene, detail);
        newEntry.details.push(createCodexDetail(detail.text, targetSceneId, resolvedBeatId));
      });
      if (category === 'character') {
        newEntry.background = createCharacterBackground();
        newEntry.core = createCharacterCoreSections();
        applyBackgroundUpdatesToEntry(newEntry, backgroundUpdates, draft, sceneId);
        applyCoreUpdatesToEntry(newEntry, coreUpdates, draft, sceneId);
      }
      draft.codex.entries[id] = newEntry;
      result.created += 1;
    }
  });

  updateAllCodexRelations(draft.codex.entries);
  return result;
}

export function normalizeMentionKey(value) {
  if (!value || typeof value !== 'string') {
    return '';
  }
  return value.replace(/^@/, '').replace(/[^a-z0-9]+/gi, '').toLowerCase();
}

export function buildCodexMentionMap(entries) {
  const map = new Map();
  if (!entries) {
    return map;
  }
  Object.values(entries).forEach((entry) => {
    if (!entry || !entry.id || !entry.name) {
      return;
    }
    const key = normalizeMentionKey(entry.name);
    if (key && !map.has(key)) {
      map.set(key, entry.id);
    }
  });
  return map;
}

export function computeEntryDerivedData(entry, mentionMap) {
  if (!entry) {
    return;
  }
  const mentionKeys = new Set();
  const relationsMap = new Map();
  const nameKey = normalizeMentionKey(entry.name);
  if (nameKey) {
    mentionKeys.add(nameKey);
  }

  const collect = (text, context) => {
    if (typeof text !== 'string' || text.trim().length === 0) {
      return 0;
    }
    const mentions = extractMentionsFromText(text);
    mentions.forEach((mention) => {
      const key = normalizeMentionKey(mention);
      if (!key) {
        return;
      }
      mentionKeys.add(key);
      const targetId = mentionMap.get(key);
      if (!targetId || targetId === entry.id) {
        return;
      }
      let relation = relationsMap.get(targetId);
      if (!relation) {
        relation = { targetId, sources: [] };
        relationsMap.set(targetId, relation);
      }
      relation.sources.push(context);
    });
    return Math.max(1, mentions.length);
  };

  let mentionCount = 0;

  if (Array.isArray(entry.details)) {
    entry.details.forEach((detail) => {
      mentionCount += collect(detail?.text || '', {
        kind: 'detail',
        detailId: detail?.id || null,
        sceneId: detail?.sourceSceneId || null,
        beatId: detail?.sourceBeatId || null
      });
    });
  }

  if (entry.category === 'character') {
    if (entry.background && typeof entry.background === 'object') {
      Object.entries(entry.background).forEach(([field, value]) => {
        mentionCount += collect(value || '', { kind: 'background', field });
      });
    }
    if (entry.core && typeof entry.core === 'object') {
      Object.entries(entry.core).forEach(([sectionKey, items]) => {
        if (!Array.isArray(items)) {
          return;
        }
        items.forEach((item) => {
          mentionCount += collect(item?.text || '', {
            kind: 'core',
            section: sectionKey,
            itemId: item?.id || null
          });
        });
      });
    }
  }

  entry.relations = Array.from(relationsMap.values());
  const stats = entry.stats && typeof entry.stats === 'object' ? entry.stats : {};
  stats.mentionCount = mentionCount;
  stats.mentionKeys = Array.from(mentionKeys);
  entry.stats = stats;
}

export function updateAllCodexRelations(entries) {
  if (!entries) {
    return;
  }
  const mentionMap = buildCodexMentionMap(entries);
  Object.values(entries).forEach((entry) => computeEntryDerivedData(entry, mentionMap));
  const inbound = new Map();
  Object.values(entries).forEach((entry) => {
    if (!entry || !Array.isArray(entry.relations)) {
      return;
    }
    entry.relations.forEach((relation) => {
      const targetId = relation && relation.targetId;
      if (!targetId || !entries[targetId]) {
        return;
      }
      if (!inbound.has(targetId)) {
        inbound.set(targetId, []);
      }
      inbound.get(targetId).push({ sourceId: entry.id, sources: relation.sources || [] });
    });
  });
  Object.entries(entries).forEach(([entryId, entry]) => {
    const list = inbound.get(entryId);
    if (list && list.length > 0) {
      entry.relatedBy = list;
    } else if (entry && entry.relatedBy) {
      delete entry.relatedBy;
    }
  });
}

export function refreshCodexDerivedData(draft) {
  if (!draft || !draft.codex || !draft.codex.entries) {
    return;
  }
  updateAllCodexRelations(draft.codex.entries);
}
