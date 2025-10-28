import {
  loadStateFromDb,
  saveStateToDb,
  loadLegacyState,
  clearLegacyState,
  clearStateFromDb
} from './storage.js';
import { requestSceneScan, requestChatCompletion } from './ai.js';

const CATEGORY_LABELS = {
  character: 'Characters',
  place: 'Places',
  item: 'Items',
  lore: 'Lore'
};

const CHARACTER_BACKGROUND_FIELDS = ['age', 'gender', 'species', 'faction'];

const CHARACTER_BACKGROUND_LABELS = {
  age: 'Age',
  gender: 'Gender',
  species: 'Species',
  faction: 'Faction'
};

const CHARACTER_CORE_SECTION_KEYS = ['appearance', 'personality', 'dialogueVoice', 'powersAbilities', 'relationships'];

const CHARACTER_CORE_SECTION_LABELS = {
  appearance: 'Appearance',
  personality: 'Personality',
  dialogueVoice: 'Dialogue & Voice',
  powersAbilities: 'Powers & Abilities',
  relationships: 'Relationships'
};

const AI_PROVIDERS = [
  { id: 'openai:gpt-5', label: 'OpenAI · GPT-5' },
  { id: 'openai:gpt-4.1', label: 'OpenAI · GPT-4.1' },
  { id: 'openai:gpt-4o-legacy', label: 'OpenAI · GPT-4o Legacy' },
  { id: 'anthropic:sonnet-4.5', label: 'Anthropic · Claude Sonnet 4.5' },
  { id: 'anthropic:sonnet-4', label: 'Anthropic · Claude Sonnet 4' },
  { id: 'anthropic:opus-4.1', label: 'Anthropic · Claude Opus 4.1' },
  { id: 'google:gemini-2.5', label: 'Google · Gemini 2.5' },
  { id: 'xai:grok-latest', label: 'xAI · Grok (latest)' }
];

const PROVIDER_ROLES = ['assistant', 'codex'];
const DEFAULT_PROVIDER = AI_PROVIDERS[0].id;
const PERSIST_DEBOUNCE_MS = 400;
const BEAT_GENERATION_SYSTEM_PROMPT = [
  'You are a story structure assistant who creates concise scene beats that track character intent, conflict, and change.',
  'Always respond with strictly valid JSON shaped as {"beats":[{"title": string, "summary": string}]} with 4-6 beats.',
  'Beat summaries must be 1-2 sentences focused on what changes in the scene. Avoid meta commentary.'
].join('\n');

function createId(prefix) {
  return `${prefix}-${Math.random().toString(36).slice(2, 8)}-${Date.now().toString(36)}`;
}

function createCharacterBackground(source = {}) {
  const result = {};
  CHARACTER_BACKGROUND_FIELDS.forEach((field) => {
    const value = source && typeof source[field] === 'string' ? source[field] : '';
    result[field] = value;
  });
  return result;
}

function normalizeCharacterBackground(value) {
  return createCharacterBackground(value || {});
}

function createCharacterCoreSections(source = {}) {
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

function normalizeCharacterCoreSections(value) {
  return createCharacterCoreSections(value || {});
}

function createCodexDetail(text = '', sourceSceneId = null, sourceBeatId = null) {
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

function normalizeCodexDetails(list) {
  if (!Array.isArray(list)) {
    return [];
  }
  return list
    .map((detail) => {
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

function nextActId(order) {
  return `A${order}`;
}

function nextChapterId(actId, order) {
  return `${actId}.C${order}`;
}

function nextSceneId(chapterId, order) {
  return `${chapterId}.S${order}`;
}

function nextBeatId(sceneId, order) {
  return `${sceneId}.B${order}`;
}

function getNextOrder(items, getOrder) {
  if (!Array.isArray(items) || items.length === 0) {
    return 1;
  }
  return items.reduce((max, item) => {
    if (!item) {
      return max;
    }
    const value = getOrder(item);
    const numeric = typeof value === 'number' && !Number.isNaN(value) ? value : 0;
    return numeric > max ? numeric : max;
  }, 0) + 1;
}

function sortByOrder(list) {
  return [...list]
    .map((item, index) => ({ item, index }))
    .sort((a, b) => {
      const orderA = typeof a.item?.order === 'number' && !Number.isNaN(a.item.order) ? a.item.order : a.index + 1;
      const orderB = typeof b.item?.order === 'number' && !Number.isNaN(b.item.order) ? b.item.order : b.index + 1;
      if (orderA !== orderB) {
        return orderA - orderB;
      }
      return a.index - b.index;
    })
    .map((wrapper) => wrapper.item);
}

function normalizeBeats(sceneId, beats) {
  if (!Array.isArray(beats) || beats.length === 0) {
    return [];
  }

  return sortByOrder(beats)
    .map((beat, index) => {
      const order = index + 1;
      return {
        id: nextBeatId(sceneId, order),
        title: beat && beat.title ? beat.title : `Beat ${order}`,
        summary: beat && typeof beat.summary === 'string' ? beat.summary : '',
        order
      };
    });
}

function calculateWordCount(text) {
  if (typeof text !== 'string') {
    return 0;
  }
  const trimmed = text.trim();
  if (trimmed.length === 0) {
    return 0;
  }
  return trimmed.split(/\s+/).filter(Boolean).length;
}

function normalizeLastScan(lastScan) {
  if (!lastScan || typeof lastScan !== 'object') {
    return null;
  }
  return {
    providerId: typeof lastScan.providerId === 'string' ? lastScan.providerId : null,
    timestamp: typeof lastScan.timestamp === 'string' ? lastScan.timestamp : lastScan.completedAt || new Date().toISOString(),
    created: typeof lastScan.created === 'number' ? lastScan.created : 0,
    updated: typeof lastScan.updated === 'number' ? lastScan.updated : 0,
    entries: Array.isArray(lastScan.entries) ? lastScan.entries.map((entry) => String(entry)) : [],
    summary: typeof lastScan.summary === 'string' ? lastScan.summary : ''
  };
}

function normalizeChatHistory(chat) {
  if (!chat || typeof chat !== 'object') {
    return { messages: [] };
  }

  const messages = Array.isArray(chat.messages) ? chat.messages : [];
  return {
    messages: messages
      .map((message) => {
        if (!message || typeof message.content !== 'string') {
          return null;
        }
        return {
          id: message.id || createId('chat'),
          role: message.role === 'assistant' ? 'assistant' : 'user',
          content: message.content,
          createdAt: message.createdAt || new Date().toISOString()
        };
      })
      .filter(Boolean)
  };
}

function getOrderedSceneIds(appState) {
  if (!appState) {
    return [];
  }
  const orderedIds = [];
  const acts = [...(appState.acts || [])].sort((a, b) => (a.order || 0) - (b.order || 0));
  acts.forEach((act) => {
    const chapters = (act?.chapterIds || [])
      .map((chapterId) => appState.chapters[chapterId])
      .filter(Boolean)
      .sort((a, b) => (a.order || 0) - (b.order || 0));
    chapters.forEach((chapter) => {
      const scenes = (chapter?.sceneIds || [])
        .map((sceneId) => appState.scenes[sceneId])
        .filter(Boolean)
        .sort((a, b) => (a.order || 0) - (b.order || 0));
      scenes.forEach((scene) => orderedIds.push(scene.id));
    });
  });
  return orderedIds;
}

function findSceneNeighbors(appState, sceneId) {
  if (!appState || !sceneId) {
    return { previous: null, next: null };
  }
  const orderedIds = getOrderedSceneIds(appState);
  const index = orderedIds.indexOf(sceneId);
  if (index === -1) {
    return { previous: null, next: null };
  }
  const previousId = index > 0 ? orderedIds[index - 1] : null;
  const nextId = index < orderedIds.length - 1 ? orderedIds[index + 1] : null;
  return {
    previous: previousId ? appState.scenes[previousId] || null : null,
    next: nextId ? appState.scenes[nextId] || null : null
  };
}

function summarizeSceneForBeats(scene, label) {
  if (!scene) {
    return null;
  }
  const lines = [];
  const sceneTitle = scene.title || 'Untitled scene';
  const beatCount = Array.isArray(scene.beats) ? scene.beats.length : 0;
  const status = scene.draftStatus || 'unknown';
  lines.push(`${label}: ${sceneTitle} (${beatCount} beats · ${scene.wordCount || 0} words · ${status})`);

  if (Array.isArray(scene.beats) && scene.beats.length > 0) {
    const beatLines = scene.beats
      .slice()
      .sort((a, b) => (a.order || 0) - (b.order || 0))
      .map((beat, index) => {
        const title = beat && beat.title ? beat.title : `Beat ${index + 1}`;
        const summary = beat && beat.summary ? beat.summary : '';
        return `${index + 1}. ${title}${summary ? ` — ${summary}` : ''}`;
      });
    lines.push('Existing beats:');
    lines.push(beatLines.join(' | '));
  } else if (scene.text) {
    const preview = scene.text.replace(/\s+/g, ' ').trim();
    const excerpt = preview.length > 220 ? `${preview.slice(0, 217)}…` : preview;
    if (excerpt) {
      lines.push('Scene excerpt:');
      lines.push(excerpt);
    }
  }

  return lines.join('\n');
}

function extractMentionsFromText(text) {
  if (typeof text !== 'string' || text.trim().length === 0) {
    return [];
  }
  const matches = text.match(/@[a-zA-Z0-9_\-]+/g);
  if (!matches) {
    return [];
  }
  return Array.from(new Set(matches));
}

function getProviderId(role = 'assistant') {
  if (!state || !state.settings || !state.settings.providers) {
    return DEFAULT_PROVIDER;
  }
  const candidate = state.settings.providers[role];
  const valid = AI_PROVIDERS.some((provider) => provider.id === candidate);
  return valid ? candidate : DEFAULT_PROVIDER;
}

function hasApiKeyFor(providerId) {
  if (!state || !state.settings || !state.settings.apiKeys) {
    return false;
  }
  const key = state.settings.apiKeys[providerId];
  return typeof key === 'string' && key.trim().length > 0;
}

function createSceneContext(scene) {
  if (!scene) {
    return null;
  }
  const beats = Array.isArray(scene.beats)
    ? scene.beats
        .slice()
        .sort((a, b) => (a.order || 0) - (b.order || 0))
        .map((beat, index) => ({
          id: beat?.id || nextBeatId(scene.id, index + 1),
          title: beat?.title || `Beat ${index + 1}`,
          summary: beat?.summary || ''
        }))
    : [];
  return {
    id: scene.id,
    title: scene.title || 'Untitled Scene',
    beats,
    text: scene.text || ''
  };
}

function createInitialState() {
  const actId = 'A1';
  const chapterId = 'A1.C1';
  const sceneId = 'A1.C1.S1';
  const beatId = 'A1.C1.S1.B1';
  const codexCharacterId = createId('codex');
  const codexPlaceId = createId('codex');
  const now = new Date().toISOString();

  return {
    acts: [
      { id: actId, title: 'Act 1', order: 1, chapterIds: [chapterId] }
    ],
    chapters: {
      [chapterId]: { id: chapterId, title: 'Chapter 1', order: 1, actId, sceneIds: [sceneId] }
    },
    scenes: {
      [sceneId]: {
        id: sceneId,
        title: 'Opening Scene',
        order: 1,
        chapterId,
        actId,
        beats: [
          {
            id: beatId,
            title: 'Beat 1',
            summary: 'Establish the protagonist and setting.',
            order: 1
          }
        ],
        text: '',
        wordCount: 0,
        draftStatus: 'empty',
        lastUpdated: now,
        lastScan: null
      }
    },
    codex: {
      entries: {
        [codexCharacterId]: {
          id: codexCharacterId,
          name: 'Avery Sol',
          category: 'character',
          summary: 'Protagonist and reluctant hero.',
          details: [],
          background: createCharacterBackground(),
          core: createCharacterCoreSections({
            appearance: [{ text: 'First appears in the opening scene.' }]
          })
        },
        [codexPlaceId]: {
          id: codexPlaceId,
          name: 'Harbor District',
          category: 'place',
          summary: 'Rain-soaked sprawl where the story begins.',
          details: [createCodexDetail('Establishes the noir atmosphere of the city.', sceneId)]
        }
      },
      selectedId: codexCharacterId
    },
    selectedSceneId: sceneId,
    chat: {
      messages: []
    },
    settings: {
      providers: {
        assistant: DEFAULT_PROVIDER,
        codex: DEFAULT_PROVIDER
      },
      apiKeys: {}
    },
    ui: {
      activeMainView: 'workspace',
      showBeats: false,
      showAssistant: true,
      showSettings: false,
      scanStatus: null,
      selectionContext: null,
      generatingBeats: false,
      chat: {
        isSending: false,
        error: null
      },
      chatInput: '',
      outline: {
        collapsedActs: [],
        collapsedChapters: [],
        expandedScenes: []
      }
    }
  };
}

function normalizeState(value) {
  const base = createInitialState();

  const actsInput = Array.isArray(value.acts) && value.acts.length ? [...value.acts] : [...base.acts];
  const chaptersInput = value.chapters && typeof value.chapters === 'object' ? value.chapters : base.chapters;
  const scenesInput = value.scenes && typeof value.scenes === 'object' ? value.scenes : base.scenes;
  const codexEntriesInput = value.codex && value.codex.entries ? value.codex.entries : base.codex.entries;
  const codexSelectedInput = value.codex && value.codex.selectedId ? value.codex.selectedId : base.codex.selectedId;

  const actIdRegistry = new Set(actsInput.map((act) => act && act.id).filter(Boolean));
  Object.values(chaptersInput).forEach((chapter) => {
    if (!chapter || typeof chapter.actId !== 'string') {
      return;
    }
    if (!actIdRegistry.has(chapter.actId)) {
      actsInput.push({
        id: chapter.actId,
        title: chapter.title ? `Act for ${chapter.title}` : 'Act',
        order: actsInput.length + 1,
        chapterIds: []
      });
      actIdRegistry.add(chapter.actId);
    }
  });

  const sortedActs = sortByOrder(actsInput);

  const chaptersByAct = new Map();
  Object.values(chaptersInput).forEach((chapter) => {
    if (!chapter || typeof chapter.actId !== 'string') {
      return;
    }
    if (!chaptersByAct.has(chapter.actId)) {
      chaptersByAct.set(chapter.actId, []);
    }
    chaptersByAct.get(chapter.actId).push(chapter);
  });

  const scenesByChapter = new Map();
  Object.values(scenesInput).forEach((scene) => {
    if (!scene || typeof scene.chapterId !== 'string') {
      return;
    }
    if (!scenesByChapter.has(scene.chapterId)) {
      scenesByChapter.set(scene.chapterId, []);
    }
    scenesByChapter.get(scene.chapterId).push(scene);
  });

  const actIdMap = new Map();
  const chapterIdMap = new Map();
  const sceneIdMap = new Map();

  const actsNormalized = [];
  const chaptersNormalized = {};
  const scenesNormalized = {};

  sortedActs.forEach((act, actIndex) => {
    const newActOrder = actIndex + 1;
    const newActId = nextActId(newActOrder);
    if (act && typeof act.id === 'string') {
      actIdMap.set(act.id, newActId);
    }
    const rawChapters = chaptersByAct.get(act?.id) || [];
    const sortedChapters = sortByOrder(rawChapters);
    const newChapterIds = [];

    sortedChapters.forEach((chapter, chapterIndex) => {
      const newChapterOrder = chapterIndex + 1;
      const newChapterId = nextChapterId(newActId, newChapterOrder);
      if (chapter && typeof chapter.id === 'string') {
        chapterIdMap.set(chapter.id, newChapterId);
      }
      const rawScenes = scenesByChapter.get(chapter?.id) || [];
      const sortedScenes = sortByOrder(rawScenes);
      const newSceneIds = [];

      sortedScenes.forEach((scene, sceneIndex) => {
        const newSceneOrder = sceneIndex + 1;
      const newSceneId = nextSceneId(newChapterId, newSceneOrder);
        if (scene && typeof scene.id === 'string') {
          sceneIdMap.set(scene.id, newSceneId);
        }

        const beats = normalizeBeats(newSceneId, scene?.beats || []);

        scenesNormalized[newSceneId] = {
          id: newSceneId,
          title: scene?.title || `Scene ${newSceneOrder}`,
          order: newSceneOrder,
          chapterId: newChapterId,
          actId: newActId,
          beats,
          text: scene?.text || '',
          wordCount: typeof scene?.wordCount === 'number' ? scene.wordCount : 0,
          draftStatus: scene?.draftStatus || 'empty',
          lastUpdated: scene?.lastUpdated || new Date().toISOString(),
          lastScan: normalizeLastScan(scene?.lastScan)
        };

        newSceneIds.push(newSceneId);
      });

      chaptersNormalized[newChapterId] = {
        id: newChapterId,
        title: chapter?.title || `Chapter ${newChapterOrder}`,
        order: newChapterOrder,
        actId: newActId,
        sceneIds: newSceneIds
      };

      newChapterIds.push(newChapterId);
    });

    actsNormalized.push({
      id: newActId,
      title: act?.title || `Act ${newActOrder}`,
      order: newActOrder,
      chapterIds: newChapterIds
    });
  });

  if (actsNormalized.length === 0) {
    return base;
  }

  const rawSettings = value.settings && typeof value.settings === 'object' ? value.settings : {};
  const rawProviders =
    rawSettings.providers && typeof rawSettings.providers === 'object' ? rawSettings.providers : {};
  const legacyProvider =
    typeof rawSettings.selectedProvider === 'string' && rawSettings.selectedProvider.length > 0
      ? rawSettings.selectedProvider
      : null;
  const isValidProvider = (providerId) =>
    typeof providerId === 'string' && AI_PROVIDERS.some((provider) => provider.id === providerId);
  const normalizedProviders = {
    assistant: isValidProvider(rawProviders.assistant)
      ? rawProviders.assistant
      : isValidProvider(legacyProvider)
        ? legacyProvider
        : base.settings.providers.assistant,
    codex: isValidProvider(rawProviders.codex)
      ? rawProviders.codex
      : isValidProvider(legacyProvider)
        ? legacyProvider
        : base.settings.providers.codex
  };
  const normalizedSettings = {
    providers: normalizedProviders,
    apiKeys: rawSettings.apiKeys && typeof rawSettings.apiKeys === 'object' ? { ...rawSettings.apiKeys } : {}
  };

  const chatNormalized = normalizeChatHistory(value.chat);

  const codexEntriesNormalized = Object.fromEntries(
    Object.entries(codexEntriesInput).map(([id, entry]) => {
      const category = normalizeCodexCategory(entry.category);
      const details = normalizeCodexDetails(entry.details).map((detail) => {
        const mappedSceneId = detail.sourceSceneId ? sceneIdMap.get(detail.sourceSceneId) || null : null;
        return {
          ...detail,
          sourceSceneId: mappedSceneId
        };
      });

      const normalizedEntry = {
        id,
        name: entry.name || 'Entry',
        category,
        summary: entry.summary || '',
        details
      };

      if (category === 'character') {
        normalizedEntry.background = normalizeCharacterBackground(entry.background);
        normalizedEntry.core = normalizeCharacterCoreSections(entry.core);
      }

      return [id, normalizedEntry];
    })
  );

  const codexSelectedId =
    codexSelectedInput && codexEntriesNormalized[codexSelectedInput]
      ? codexSelectedInput
      : Object.keys(codexEntriesNormalized)[0] || null;

  let selectedSceneId = value.selectedSceneId ? sceneIdMap.get(value.selectedSceneId) : null;
  if (!selectedSceneId || !scenesNormalized[selectedSceneId]) {
    selectedSceneId = findFirstSceneId(actsNormalized, chaptersNormalized);
  }

  const uiValue = value.ui && typeof value.ui === 'object' ? value.ui : {};
  const outlineValue = uiValue.outline && typeof uiValue.outline === 'object' ? uiValue.outline : {};
  const toOutlineArray = (input) =>
    Array.isArray(input)
      ? input
          .map((item) => (typeof item === 'string' ? item : null))
          .filter(Boolean)
      : [];
  const outlineRaw = {
    collapsedActs: toOutlineArray(outlineValue.collapsedActs),
    collapsedChapters: toOutlineArray(outlineValue.collapsedChapters),
    expandedScenes: toOutlineArray(outlineValue.expandedScenes)
  };

  const selectionContextNormalized = uiValue.selectionContext && typeof uiValue.selectionContext === 'object'
    ? {
        ...uiValue.selectionContext,
        sceneId: uiValue.selectionContext.sceneId
          ? sceneIdMap.get(uiValue.selectionContext.sceneId) || null
          : null
      }
    : null;
  const activeMainView =
    uiValue.activeMainView === 'codex' || uiValue.activeMainView === 'workspace'
      ? uiValue.activeMainView
      : base.ui.activeMainView;
  const validActIds = new Set(actsNormalized.map((act) => act.id));
  const validChapterIds = new Set(Object.keys(chaptersNormalized));
  const validSceneIds = new Set(Object.keys(scenesNormalized));
  const remapOutlineIds = (list, map, validSet) => {
    if (!Array.isArray(list) || list.length === 0) {
      return [];
    }
    const seen = new Set();
    const result = [];
    list.forEach((id) => {
      if (typeof id !== 'string') {
        return;
      }
      const mapped = (map && map.get(id)) || id;
      if (!mapped || typeof mapped !== 'string') {
        return;
      }
      if (validSet && !validSet.has(mapped)) {
        return;
      }
      if (!seen.has(mapped)) {
        seen.add(mapped);
        result.push(mapped);
      }
    });
    return result;
  };

  const outlineUi = {
    collapsedActs: remapOutlineIds(outlineRaw.collapsedActs, actIdMap, validActIds),
    collapsedChapters: remapOutlineIds(outlineRaw.collapsedChapters, chapterIdMap, validChapterIds),
    expandedScenes: remapOutlineIds(outlineRaw.expandedScenes, sceneIdMap, validSceneIds)
  };
  const ui = {
    ...base.ui,
    activeMainView,
    showBeats: Boolean(uiValue.showBeats),
    showAssistant: uiValue.showAssistant === false ? false : true,
    showSettings: Boolean(uiValue.showSettings),
    scanStatus: null,
    generatingBeats: false,
    selectionContext: selectionContextNormalized,
    chat: {
      ...base.ui.chat,
      ...(uiValue.chat && typeof uiValue.chat === 'object' ? uiValue.chat : {})
    },
    chatInput: typeof uiValue.chatInput === 'string' ? uiValue.chatInput : '',
    outline: outlineUi
  };

  return {
    acts: actsNormalized,
    chapters: chaptersNormalized,
    scenes: scenesNormalized,
    codex: {
      entries: codexEntriesNormalized,
      selectedId: codexSelectedId
    },
    selectedSceneId,
    chat: chatNormalized,
    settings: normalizedSettings,
    ui
  };
}

function findFirstSceneId(acts, chapters) {
  for (const act of acts) {
    for (const chapterId of act.chapterIds || []) {
      const chapter = chapters[chapterId];
      if (chapter && chapter.sceneIds && chapter.sceneIds.length > 0) {
        return chapter.sceneIds[0];
      }
    }
  }
  return null;
}

let state = null;
let persistTimer = null;
let persistChain = Promise.resolve();
const HISTORY_LIMIT = 20;
let undoStack = [];
let isRestoringState = false;
let editorFocusState = null;
let chatInputFocusState = {
  isFocused: false,
  selectionStart: 0,
  selectionEnd: 0
};
let suppressChatBlurClear = false;

function cloneAppState(value) {
  if (!value) {
    return null;
  }
  if (typeof structuredClone === 'function') {
    return structuredClone(value);
  }
  try {
    return JSON.parse(JSON.stringify(value));
  } catch (error) {
    console.warn('Falling back to shallow clone for undo snapshot', error);
    return { ...value };
  }
}

function pushUndoSnapshot(snapshot) {
  if (!snapshot) {
    return;
  }
  undoStack.push(snapshot);
  if (undoStack.length > HISTORY_LIMIT) {
    undoStack.shift();
  }
}

function resetHistory() {
  undoStack = [];
}

function markEditorFocus(sceneId, selectionStart, selectionEnd, scrollTop, options = {}) {
  if (!sceneId) {
    return;
  }
  const start = Number.isInteger(selectionStart) ? selectionStart : Number(selectionEnd) || 0;
  const end = Number.isInteger(selectionEnd) ? selectionEnd : start;
  editorFocusState = {
    sceneId,
    selectionStart: Math.max(0, start),
    selectionEnd: Math.max(0, end),
    scrollTop: Number.isFinite(scrollTop) ? scrollTop : 0,
    shouldFocus: options.shouldFocus === false ? false : true,
    shouldRestore: true,
    timestamp: Date.now()
  };
}

function restoreEditorFocusIfNeeded(textarea, sceneId) {
  if (!textarea || !editorFocusState || editorFocusState.sceneId !== sceneId || !editorFocusState.shouldRestore) {
    return;
  }
  const snapshot = { ...editorFocusState };
  editorFocusState.shouldRestore = false;
  const schedule =
    typeof window !== 'undefined' && typeof window.requestAnimationFrame === 'function'
      ? window.requestAnimationFrame.bind(window)
      : (callback) => globalThis.setTimeout(callback, 0);
  schedule(() => {
    if (snapshot.shouldFocus) {
      textarea.focus();
    }
    try {
      textarea.setSelectionRange(snapshot.selectionStart, snapshot.selectionEnd);
    } catch (error) {
      textarea.selectionStart = snapshot.selectionStart;
      textarea.selectionEnd = snapshot.selectionEnd;
    }
    textarea.scrollTop = snapshot.scrollTop;
  });
}

function markChatInputFocus(selectionStart, selectionEnd) {
  chatInputFocusState.isFocused = true;
  if (Number.isInteger(selectionStart)) {
    chatInputFocusState.selectionStart = selectionStart;
  }
  if (Number.isInteger(selectionEnd)) {
    chatInputFocusState.selectionEnd = selectionEnd;
  }
}

function clearChatInputFocus() {
  chatInputFocusState.isFocused = false;
  chatInputFocusState.selectionStart = 0;
  chatInputFocusState.selectionEnd = 0;
}

function restoreChatInputFocus(input) {
  if (!input || !chatInputFocusState.isFocused) {
    return;
  }
  const length = typeof input.value === 'string' ? input.value.length : 0;
  const startRaw = Number.isInteger(chatInputFocusState.selectionStart)
    ? chatInputFocusState.selectionStart
    : length;
  const endRaw = Number.isInteger(chatInputFocusState.selectionEnd)
    ? chatInputFocusState.selectionEnd
    : startRaw;
  const start = Math.max(0, Math.min(length, startRaw));
  const end = Math.max(start, Math.min(length, endRaw));
  input.focus();
  try {
    input.setSelectionRange(start, end);
  } catch (error) {
    input.selectionStart = start;
    input.selectionEnd = end;
  }
}

function resetFocusStates() {
  editorFocusState = null;
  chatInputFocusState = {
    isFocused: false,
    selectionStart: 0,
    selectionEnd: 0
  };
}

async function bootstrapState() {
  try {
    const stored = await loadStateFromDb();
    if (stored) {
      state = normalizeState(stored);
    } else {
      const legacy = loadLegacyState();
      if (legacy) {
        state = normalizeState(legacy);
        await saveStateToDb(state);
        clearLegacyState();
      } else {
        state = createInitialState();
        await saveStateToDb(state);
      }
    }
  } catch (error) {
    console.error('Failed to initialise state from IndexedDB.', error);
    state = createInitialState();
  }

  resetHistory();
  ensureSelections();
  renderAll();
}

function cancelScheduledPersist() {
  if (persistTimer) {
    globalThis.clearTimeout(persistTimer);
    persistTimer = null;
  }
}

function schedulePersist() {
  if (!state) {
    return;
  }
  cancelScheduledPersist();
  persistTimer = globalThis.setTimeout(() => {
    persistTimer = null;
    persistChain = persistChain
      .then(() => saveStateToDb(state))
      .catch((error) => {
        console.warn('Failed to persist state to IndexedDB', error);
      });
  }, PERSIST_DEBOUNCE_MS);
}

function updateState(mutator, options = {}) {
  if (!state) {
    return;
  }
  const shouldRecordHistory = !isRestoringState && !options.skipHistory;
  const snapshot = shouldRecordHistory ? cloneAppState(state) : null;
  const result = mutator(state);
  if (result === false) {
    return;
  }
  if (shouldRecordHistory && snapshot) {
    pushUndoSnapshot(snapshot);
  }
  ensureSelections();
  if (!options.skipRender) {
    renderAll();
  }
  schedulePersist();
}

function ensureSelections() {
  if (!state) {
    return;
  }

  if (!state.selectedSceneId || !state.scenes[state.selectedSceneId]) {
    state.selectedSceneId = findFirstSceneId(state.acts, state.chapters);
  }

  if (!state.codex.selectedId || !state.codex.entries[state.codex.selectedId]) {
    const firstEntry = Object.values(state.codex.entries)[0];
    state.codex.selectedId = firstEntry ? firstEntry.id : null;
  }

  if (state.ui.activeMainView !== 'workspace' && state.ui.activeMainView !== 'codex') {
    state.ui.activeMainView = 'workspace';
  }

  if (!state.ui.outline) {
    state.ui.outline = { collapsedActs: [], collapsedChapters: [], expandedScenes: [] };
  }
}

function refreshOutlineOrdering(draft) {
  if (!draft) {
    return;
  }
  draft.acts.forEach((act, actIndex) => {
    if (!act) {
      return;
    }
    act.order = actIndex + 1;
    if (!Array.isArray(act.chapterIds)) {
      act.chapterIds = [];
    }
    act.chapterIds.forEach((chapterId, chapterIndex) => {
      const chapter = draft.chapters[chapterId];
      if (!chapter) {
        return;
      }
      chapter.order = chapterIndex + 1;
      if (!Array.isArray(chapter.sceneIds)) {
        chapter.sceneIds = [];
      }
      chapter.sceneIds.forEach((sceneId, sceneIndex) => {
        const scene = draft.scenes[sceneId];
        if (!scene) {
          return;
        }
        scene.order = sceneIndex + 1;
      });
    });
  });
}

function pruneOutlineList(list, idToRemove) {
  if (!Array.isArray(list)) {
    return [];
  }
  return list.filter((id) => id !== idToRemove);
}

function removeSceneFromState(draft, sceneId) {
  if (!draft || !sceneId || !draft.scenes || !draft.scenes[sceneId]) {
    return;
  }
  const scene = draft.scenes[sceneId];
  const chapter = draft.chapters ? draft.chapters[scene.chapterId] : null;
  if (chapter && Array.isArray(chapter.sceneIds)) {
    const index = chapter.sceneIds.indexOf(sceneId);
    if (index !== -1) {
      chapter.sceneIds.splice(index, 1);
    }
  }
  delete draft.scenes[sceneId];

  if (draft.selectedSceneId === sceneId) {
    draft.selectedSceneId = null;
  }

  if (draft.ui) {
    if (draft.ui.selectionContext && draft.ui.selectionContext.sceneId === sceneId) {
      draft.ui.selectionContext = null;
    }
    if (draft.ui.outline) {
      draft.ui.outline.expandedScenes = pruneOutlineList(draft.ui.outline.expandedScenes, sceneId);
    }
  }

  if (editorFocusState && editorFocusState.sceneId === sceneId) {
    editorFocusState = null;
  }
}

function removeChapterFromState(draft, chapterId) {
  if (!draft || !chapterId || !draft.chapters || !draft.chapters[chapterId]) {
    return;
  }
  const chapter = draft.chapters[chapterId];
  const sceneIds = Array.isArray(chapter.sceneIds) ? [...chapter.sceneIds] : [];
  sceneIds.forEach((sceneId) => removeSceneFromState(draft, sceneId));

  const act = draft.acts ? draft.acts.find((item) => item.id === chapter.actId) : null;
  if (act && Array.isArray(act.chapterIds)) {
    const index = act.chapterIds.indexOf(chapterId);
    if (index !== -1) {
      act.chapterIds.splice(index, 1);
    }
  }

  delete draft.chapters[chapterId];

  if (draft.ui && draft.ui.outline) {
    draft.ui.outline.collapsedChapters = pruneOutlineList(draft.ui.outline.collapsedChapters, chapterId);
  }
}

const actions = {
  addAct(title = 'New Act') {
    updateState((draft) => {
      const nextOrder = getNextOrder(draft.acts, (act) => act?.order || 0);
      const id = nextActId(nextOrder);
      draft.acts.push({ id, title, order: nextOrder, chapterIds: [] });
    });
  },
  addChapter(actId, title = 'New Chapter') {
    updateState((draft) => {
      const act = draft.acts.find((item) => item.id === actId);
      if (!act) {
        return false;
      }
      if (!Array.isArray(act.chapterIds)) {
        act.chapterIds = [];
      }
      const chaptersForAct = act.chapterIds
        .map((chapterId) => draft.chapters[chapterId])
        .filter(Boolean);
      const order = getNextOrder(chaptersForAct, (chapter) => chapter?.order || 0);
      const id = nextChapterId(act.id, order);
      draft.chapters[id] = { id, title, order, actId: act.id, sceneIds: [] };
      act.chapterIds.push(id);
    });
  },
  addScene(chapterId, title = 'New Scene') {
    updateState((draft) => {
      const chapter = draft.chapters[chapterId];
      if (!chapter) {
        return false;
      }
      if (!Array.isArray(chapter.sceneIds)) {
        chapter.sceneIds = [];
      }
      const scenesForChapter = chapter.sceneIds
        .map((sceneId) => draft.scenes[sceneId])
        .filter(Boolean);
      const order = getNextOrder(scenesForChapter, (scene) => scene?.order || 0);
      const id = nextSceneId(chapter.id, order);
      const now = new Date().toISOString();
      draft.scenes[id] = {
        id,
        title,
        order,
        chapterId: chapter.id,
        actId: chapter.actId,
        beats: [],
        text: '',
        wordCount: 0,
        draftStatus: 'empty',
        lastUpdated: now,
        lastScan: null
      };
      chapter.sceneIds.push(id);
      draft.selectedSceneId = id;
    });
  },
  addBeat(sceneId, title = 'New Beat') {
    updateState((draft) => {
      const scene = draft.scenes[sceneId];
      if (!scene) {
        return false;
      }
      if (!Array.isArray(scene.beats)) {
        scene.beats = [];
      }
      const order = getNextOrder(scene.beats, (beat) => beat?.order || 0);
      const beatId = nextBeatId(scene.id, order);
      scene.beats.push({ id: beatId, title, summary: '', order });
      scene.beats = normalizeBeats(scene.id, scene.beats);
    });
  },
  undo() {
    if (undoStack.length === 0) {
      return;
    }
    const snapshot = undoStack.pop();
    if (!snapshot) {
      return;
    }
    isRestoringState = true;
    state = snapshot;
    isRestoringState = false;
    resetFocusStates();
    ensureSelections();
    renderAll();
    schedulePersist();
  },
  deleteAct(actId) {
    updateState((draft) => {
      const index = draft.acts.findIndex((item) => item.id === actId);
      if (index === -1) {
        return false;
      }
      const [act] = draft.acts.splice(index, 1);
      const chapterIds = act && Array.isArray(act.chapterIds) ? [...act.chapterIds] : [];
      chapterIds.forEach((chapterId) => removeChapterFromState(draft, chapterId));
      if (draft.ui && draft.ui.outline) {
        draft.ui.outline.collapsedActs = pruneOutlineList(draft.ui.outline.collapsedActs, actId);
      }
      refreshOutlineOrdering(draft);
    });
  },
  deleteChapter(chapterId) {
    updateState((draft) => {
      if (!draft.chapters[chapterId]) {
        return false;
      }
      removeChapterFromState(draft, chapterId);
      refreshOutlineOrdering(draft);
    });
  },
  deleteScene(sceneId) {
    updateState((draft) => {
      if (!draft.scenes[sceneId]) {
        return false;
      }
      removeSceneFromState(draft, sceneId);
      refreshOutlineOrdering(draft);
    });
  },
  deleteBeat(sceneId, beatId) {
    updateState((draft) => {
      const scene = draft.scenes[sceneId];
      if (!scene || !Array.isArray(scene.beats)) {
        return false;
      }
      const index = scene.beats.findIndex((beat) => beat.id === beatId);
      if (index === -1) {
        return false;
      }
      scene.beats.splice(index, 1);
      scene.beats = normalizeBeats(sceneId, scene.beats);
    });
  },
  selectScene(sceneId) {
    updateState((draft) => {
      if (draft.selectedSceneId === sceneId) {
        return false;
      }
      draft.selectedSceneId = sceneId;
      draft.ui.selectionContext = null;
    });
  },
  updateSceneText(sceneId, text) {
    updateState((draft) => {
      const scene = draft.scenes[sceneId];
      if (!scene) {
        return false;
      }
      if (scene.text === text) {
        return false;
      }
      scene.text = text;
      scene.wordCount = calculateWordCount(text);
      scene.draftStatus = scene.wordCount === 0 ? 'empty' : 'drafted';
      scene.lastUpdated = new Date().toISOString();
    }, { skipRender: true, skipHistory: true });
  },
  setActiveMainView(view) {
    if (view !== 'workspace' && view !== 'codex') {
      return;
    }
    updateState((draft) => {
      if (draft.ui.activeMainView === view) {
        return false;
      }
      draft.ui.activeMainView = view;
    });
  },
  toggleBeats() {
    updateState((draft) => {
      draft.ui.showBeats = !draft.ui.showBeats;
    });
  },
  toggleAssistant() {
    updateState((draft) => {
      draft.ui.showAssistant = !draft.ui.showAssistant;
    });
  },
  setSelectionContext(sceneId, start, end, text) {
    const snippet = typeof text === 'string' ? text.trim() : '';
    updateState((draft) => {
      if (!snippet) {
        if (!draft.ui.selectionContext) {
          return false;
        }
        draft.ui.selectionContext = null;
        return;
      }
      const prev = draft.ui.selectionContext;
      if (
        prev &&
        prev.sceneId === sceneId &&
        prev.start === start &&
        prev.end === end &&
        prev.rawText === text
      ) {
        return false;
      }
      draft.ui.selectionContext = {
        sceneId,
        start,
        end,
        text: snippet,
        rawText: text
      };
    });
  },
  clearSelectionContext() {
    updateState((draft) => {
      if (!draft.ui.selectionContext) {
        return false;
      }
      draft.ui.selectionContext = null;
    });
  },
  toggleActCollapse(actId) {
    if (!actId) {
      return;
    }
    updateState((draft) => {
      if (!draft.ui.outline) {
        draft.ui.outline = { collapsedActs: [], collapsedChapters: [], expandedScenes: [] };
      }
      const list = draft.ui.outline.collapsedActs;
      const index = list.indexOf(actId);
      if (index === -1) {
        list.push(actId);
      } else {
        list.splice(index, 1);
      }
    });
  },
  toggleChapterCollapse(chapterId) {
    if (!chapterId) {
      return;
    }
    updateState((draft) => {
      if (!draft.ui.outline) {
        draft.ui.outline = { collapsedActs: [], collapsedChapters: [], expandedScenes: [] };
      }
      const list = draft.ui.outline.collapsedChapters;
      const index = list.indexOf(chapterId);
      if (index === -1) {
        list.push(chapterId);
      } else {
        list.splice(index, 1);
      }
    });
  },
  toggleSceneBeats(sceneId) {
    if (!sceneId) {
      return;
    }
    updateState((draft) => {
      if (!draft.ui.outline) {
        draft.ui.outline = { collapsedActs: [], collapsedChapters: [], expandedScenes: [] };
      }
      const list = draft.ui.outline.expandedScenes;
      const index = list.indexOf(sceneId);
      if (index === -1) {
        list.push(sceneId);
      } else {
        list.splice(index, 1);
      }
    });
  },
  setChatInput(value) {
    if (state && state.ui.chatInput === value) {
      return;
    }
    suppressChatBlurClear = true;
    updateState((draft) => {
      draft.ui.chatInput = value;
      if (draft.ui.chat) {
        draft.ui.chat.error = null;
      }
    }, { skipHistory: true });
    globalThis.setTimeout(() => {
      suppressChatBlurClear = false;
    }, 0);
  },
  clearChatHistory() {
    updateState((draft) => {
      if (!draft.chat || !Array.isArray(draft.chat.messages)) {
        return false;
      }
      if (draft.chat.messages.length === 0 && !draft.ui.chatInput && !(draft.ui.chat && draft.ui.chat.error)) {
        return false;
      }
      draft.chat.messages = [];
      draft.ui.chatInput = '';
      if (draft.ui.chat) {
        draft.ui.chat.error = null;
        draft.ui.chat.isSending = false;
      }
    });
  },
  async sendChatMessage() {
    if (!state || state.ui.chat.isSending) {
      return;
    }
    const input = state.ui.chatInput ? state.ui.chatInput.trim() : '';
    if (input.length === 0) {
      return;
    }

    const providerId = getProviderId('assistant');
    if (!providerId) {
      updateState((draft) => {
        draft.ui.chat.error = 'Select an AI provider in Settings before chatting.';
      });
      return;
    }

    const apiKey = state.settings.apiKeys ? state.settings.apiKeys[providerId] : null;
    if (!apiKey || apiKey.trim().length === 0) {
      updateState((draft) => {
        draft.ui.chat.error = 'Add an API key for the selected provider in Settings before chatting.';
      });
      return;
    }

    const userMessage = {
      id: createId('chat'),
      role: 'user',
      content: input,
      createdAt: new Date().toISOString()
    };

    updateState((draft) => {
      draft.chat.messages.push(userMessage);
      draft.ui.chatInput = '';
      draft.ui.chat.isSending = true;
      draft.ui.chat.error = null;
    });

    try {
      const systemPrompt = buildChatSystemPrompt(state);
      const history = state.chat.messages.slice(-12).map((message) => ({
        role: message.role,
        content: message.content
      }));
      const reply = await requestChatCompletion({
        providerId,
        apiKey,
        messages: history,
        systemPrompt
      });
      const assistantMessage = {
        id: createId('chat'),
        role: 'assistant',
        content: typeof reply === 'string' ? reply : JSON.stringify(reply, null, 2),
        createdAt: new Date().toISOString()
      };
      updateState((draft) => {
        draft.chat.messages.push(assistantMessage);
        draft.ui.chat.isSending = false;
      });
    } catch (error) {
      console.error('Chat completion failed', error);
      updateState((draft) => {
        draft.ui.chat.isSending = false;
        draft.ui.chat.error = error && error.message ? error.message : 'Assistant request failed.';
      });
    }
  },
  async generateSceneBeats(sceneId) {
    if (!state || state.ui.generatingBeats) {
      return;
    }
    const scene = state.scenes[sceneId];
    if (!scene) {
      return;
    }
    const providerId = getProviderId('assistant');
    if (!providerId) {
      updateState((draft) => {
        if (draft.ui.chat) {
          draft.ui.chat.error = 'Select a writing provider in Settings before generating beats.';
        }
      }, { skipHistory: true });
      return;
    }
    const apiKey = state.settings.apiKeys ? state.settings.apiKeys[providerId] : null;
    if (!apiKey || apiKey.trim().length === 0) {
      updateState((draft) => {
        if (draft.ui.chat) {
          draft.ui.chat.error = 'Add an API key for the writing provider in Settings before generating beats.';
        }
      }, { skipHistory: true });
      return;
    }

    const outline = buildOutlineSummary(state);
    const neighbors = findSceneNeighbors(state, sceneId);
    const selectionContext =
      state.ui.selectionContext && state.ui.selectionContext.sceneId === sceneId ? state.ui.selectionContext : null;
    const chatInput = state.ui.chatInput ? state.ui.chatInput.trim() : '';
    const mentions = extractMentionsFromText(chatInput);

    updateState((draft) => {
      draft.ui.generatingBeats = true;
      if (draft.ui.chat) {
        draft.ui.chat.error = null;
      }
    }, { skipHistory: true });

    try {
      const prompt = buildBeatGenerationPrompt(state, scene, {
        outline,
        previousSummary: summarizeSceneForBeats(neighbors.previous, 'Previous scene'),
        nextSummary: summarizeSceneForBeats(neighbors.next, 'Next scene'),
        selectionContext,
        userGuidance: chatInput,
        mentions
      });

      const reply = await requestChatCompletion({
        providerId,
        apiKey,
        messages: [{ role: 'user', content: prompt }],
        systemPrompt: BEAT_GENERATION_SYSTEM_PROMPT
      });

      const generatedBeats = parseBeatGenerationResponse(sceneId, reply);

      updateState((draft) => {
        const targetScene = draft.scenes[sceneId];
        if (!targetScene) {
          return false;
        }
        targetScene.beats = generatedBeats;
        if (targetScene.wordCount === 0) {
          targetScene.draftStatus = 'outlined';
        }
        targetScene.lastUpdated = new Date().toISOString();
        draft.ui.generatingBeats = false;
        draft.ui.showBeats = true;
      });
    } catch (error) {
      console.error('Beat generation failed', error);
      updateState((draft) => {
        draft.ui.generatingBeats = false;
        if (draft.ui.chat) {
          draft.ui.chat.error =
            error && error.message ? `Beat generation failed: ${error.message}` : 'Beat generation failed.';
        }
      }, { skipHistory: true });
    }
  },
  reorderAct(actId, targetActId) {
    updateState((draft) => {
      const acts = draft.acts;
      const sourceIndex = acts.findIndex((act) => act.id === actId);
      if (sourceIndex === -1) {
        return false;
      }
      const [act] = acts.splice(sourceIndex, 1);
      if (!targetActId) {
        acts.push(act);
      } else {
        let targetIndex = acts.findIndex((item) => item.id === targetActId);
        if (targetIndex === -1) {
          targetIndex = acts.length;
        }
        acts.splice(targetIndex, 0, act);
      }
      refreshOutlineOrdering(draft);
    });
  },
  moveChapter(chapterId, targetActId, targetIndex) {
    updateState((draft) => {
      const chapter = draft.chapters[chapterId];
      const targetAct = draft.acts.find((act) => act.id === targetActId);
      if (!chapter || !targetAct) {
        return false;
      }

      const sameAct = chapter.actId === targetAct.id;
      let sourceIndex = -1;
      if (sameAct) {
        sourceIndex = targetAct.chapterIds.indexOf(chapterId);
      }

      const sourceAct = draft.acts.find((act) => act.id === chapter.actId);
      if (sourceAct) {
        const removalIndex = sourceAct.chapterIds.indexOf(chapterId);
        if (removalIndex !== -1) {
          sourceAct.chapterIds.splice(removalIndex, 1);
        }
      }

      let insertionIndex = targetIndex;
      if (sameAct && sourceIndex !== -1 && sourceIndex < targetIndex) {
        insertionIndex = targetIndex - 1;
      }
      insertionIndex = Math.max(0, Math.min(insertionIndex, targetAct.chapterIds.length));

      targetAct.chapterIds.splice(insertionIndex, 0, chapterId);
      chapter.actId = targetAct.id;
      refreshOutlineOrdering(draft);
    });
  },
  moveScene(sceneId, targetChapterId, targetIndex) {
    updateState((draft) => {
      const scene = draft.scenes[sceneId];
      const targetChapter = draft.chapters[targetChapterId];
      if (!scene || !targetChapter) {
        return false;
      }

      const sameChapter = scene.chapterId === targetChapter.id;
      let sourceIndex = -1;
      if (sameChapter) {
        sourceIndex = targetChapter.sceneIds.indexOf(sceneId);
      }

      const sourceChapter = draft.chapters[scene.chapterId];
      if (sourceChapter) {
        const removalIndex = sourceChapter.sceneIds.indexOf(sceneId);
        if (removalIndex !== -1) {
          sourceChapter.sceneIds.splice(removalIndex, 1);
        }
      }

      let insertionIndex = targetIndex;
      if (sameChapter && sourceIndex !== -1 && sourceIndex < targetIndex) {
        insertionIndex = targetIndex - 1;
      }
      insertionIndex = Math.max(0, Math.min(insertionIndex, targetChapter.sceneIds.length));

      targetChapter.sceneIds.splice(insertionIndex, 0, sceneId);
      scene.chapterId = targetChapter.id;
      scene.actId = targetChapter.actId;
      refreshOutlineOrdering(draft);
    });
  },
  moveBeat(sceneId, beatId, targetIndex) {
    updateState((draft) => {
      const scene = draft.scenes[sceneId];
      if (!scene || !Array.isArray(scene.beats)) {
        return false;
      }
      const currentIndex = scene.beats.findIndex((beat) => beat.id === beatId);
      if (currentIndex === -1) {
        return false;
      }
      const [beat] = scene.beats.splice(currentIndex, 1);
      let insertionIndex = targetIndex;
      if (currentIndex < targetIndex) {
        insertionIndex = targetIndex - 1;
      }
      insertionIndex = Math.max(0, Math.min(insertionIndex, scene.beats.length));
      scene.beats.splice(insertionIndex, 0, beat);
      scene.beats = normalizeBeats(sceneId, scene.beats);
    });
  },
  renameAct(actId, title) {
    updateState((draft) => {
      const act = draft.acts.find((item) => item.id === actId);
      if (!act) {
        return false;
      }
      const trimmed = title.trim();
      if (trimmed.length > 0) {
        act.title = trimmed;
      }
    });
  },
  renameChapter(chapterId, title) {
    updateState((draft) => {
      const chapter = draft.chapters[chapterId];
      if (!chapter) {
        return false;
      }
      const trimmed = title.trim();
      if (trimmed.length > 0) {
        chapter.title = trimmed;
      }
    });
  },
  renameScene(sceneId, title) {
    updateState((draft) => {
      const scene = draft.scenes[sceneId];
      if (!scene) {
        return false;
      }
      const trimmed = title.trim();
      if (trimmed.length > 0) {
        scene.title = trimmed;
      }
    });
  },
  selectCodexEntry(entryId) {
    updateState((draft) => {
      if (draft.codex.selectedId === entryId) {
        return false;
      }
      draft.codex.selectedId = entryId;
    });
  },
  updateCodexSummary(entryId, summary) {
    updateState((draft) => {
      const entry = draft.codex.entries[entryId];
      if (!entry) {
        return false;
      }
      if (entry.summary === summary) {
        return false;
      }
      entry.summary = summary;
    });
  },
  toggleSettings() {
    updateState((draft) => {
      draft.ui.showSettings = !draft.ui.showSettings;
    });
  },
  selectProvider(role, providerId) {
    if (!PROVIDER_ROLES.includes(role)) {
      return;
    }
    if (!AI_PROVIDERS.some((provider) => provider.id === providerId)) {
      return;
    }
    updateState((draft) => {
      if (!draft.settings.providers || typeof draft.settings.providers !== 'object') {
        draft.settings.providers = {
          assistant: DEFAULT_PROVIDER,
          codex: DEFAULT_PROVIDER
        };
      }
      PROVIDER_ROLES.forEach((entryRole) => {
        const current = draft.settings.providers[entryRole];
        if (!AI_PROVIDERS.some((provider) => provider.id === current)) {
          draft.settings.providers[entryRole] = DEFAULT_PROVIDER;
        }
      });
      if (draft.settings.providers[role] === providerId) {
        return false;
      }
      draft.settings.providers[role] = providerId;
    }, { skipHistory: true });
  },
  updateApiKey(providerId, key) {
    if (!AI_PROVIDERS.some((provider) => provider.id === providerId)) {
      return;
    }
    updateState((draft) => {
      if (!draft.settings.apiKeys) {
        draft.settings.apiKeys = {};
      }
      if (typeof key === 'string' && key.length > 0) {
        if (draft.settings.apiKeys[providerId] === key) {
          return false;
        }
        draft.settings.apiKeys[providerId] = key;
      } else {
        if (!draft.settings.apiKeys[providerId]) {
          return false;
        }
        delete draft.settings.apiKeys[providerId];
      }
    }, { skipHistory: true });
  },
  clearApiKey(providerId) {
    if (!AI_PROVIDERS.some((provider) => provider.id === providerId)) {
      return;
    }
    updateState((draft) => {
      if (!draft.settings.apiKeys || !draft.settings.apiKeys[providerId]) {
        return false;
      }
      delete draft.settings.apiKeys[providerId];
    }, { skipHistory: true });
  },
  async clearDatabase() {
    await persistChain.catch(() => {});
    cancelScheduledPersist();
    try {
      await clearStateFromDb();
      clearLegacyState();
    } catch (error) {
      console.warn('Failed to clear persisted database state', error);
      throw error;
    }
  },
  async clearAllData() {
    await persistChain.catch(() => {});
    cancelScheduledPersist();
    try {
      await clearStateFromDb();
    } catch (error) {
      console.warn('Failed to clear persisted database state before reset', error);
    }
    clearLegacyState();
    state = createInitialState();
    resetFocusStates();
    resetHistory();
    ensureSelections();
    renderAll();
    schedulePersist();
  },
  addCodexEntry(name, category = 'lore') {
    const normalizedName = typeof name === 'string' ? name.trim() : '';
    if (normalizedName.length === 0) {
      return;
    }
    const normalizedCategory = normalizeCodexCategory(category);
    updateState((draft) => {
      const id = createId('codex');
      const entry = {
        id,
        name: normalizedName,
        category: normalizedCategory,
        summary: '',
        details: []
      };
      if (normalizedCategory === 'character') {
        entry.background = createCharacterBackground();
        entry.core = createCharacterCoreSections();
      }
      draft.codex.entries[id] = entry;
      draft.codex.selectedId = id;
    });
  },
  renameCodexEntry(entryId, name) {
    if (!entryId) {
      return;
    }
    const normalizedName = typeof name === 'string' ? name.trim() : '';
    if (normalizedName.length === 0) {
      return;
    }
    updateState((draft) => {
      const entry = draft.codex.entries[entryId];
      if (!entry) {
        return false;
      }
      entry.name = normalizedName;
    });
  },
  updateCodexCategory(entryId, category) {
    if (!entryId) {
      return;
    }
    const normalizedCategory = normalizeCodexCategory(category);
    updateState((draft) => {
      const entry = draft.codex.entries[entryId];
      if (!entry) {
        return false;
      }
      entry.category = normalizedCategory;
      if (normalizedCategory === 'character') {
        entry.background = createCharacterBackground(entry.background);
        entry.core = createCharacterCoreSections(entry.core);
      } else {
        delete entry.background;
        delete entry.core;
      }
    });
  },
  deleteCodexEntry(entryId) {
    if (!entryId) {
      return;
    }
    updateState((draft) => {
      if (!draft.codex.entries[entryId]) {
        return false;
      }
      delete draft.codex.entries[entryId];
      if (draft.codex.selectedId === entryId) {
        const ids = Object.keys(draft.codex.entries);
        draft.codex.selectedId = ids.length > 0 ? ids[0] : null;
      }
    });
  },
  addCodexDetail(entryId, sceneId = null) {
    if (!entryId) {
      return;
    }
    updateState((draft) => {
      const entry = draft.codex.entries[entryId];
      if (!entry) {
        return false;
      }
      if (!Array.isArray(entry.details)) {
        entry.details = [];
      }
      entry.details.push(createCodexDetail('', sceneId));
    });
  },
  updateCodexDetail(entryId, detailId, updates) {
    if (!entryId || !detailId) {
      return;
    }
    updateState((draft) => {
      const entry = draft.codex.entries[entryId];
      if (!entry || !Array.isArray(entry.details)) {
        return false;
      }
      const detail = entry.details.find((item) => item.id === detailId);
      if (!detail) {
        return false;
      }
      let mutated = false;
      if (Object.prototype.hasOwnProperty.call(updates, 'text')) {
        const textValue = typeof updates.text === 'string' ? updates.text : '';
        if (detail.text !== textValue) {
          detail.text = textValue;
          mutated = true;
        }
      }
      if (Object.prototype.hasOwnProperty.call(updates, 'sourceSceneId')) {
        const sceneId = updates.sourceSceneId;
        const normalized = typeof sceneId === 'string' && sceneId.length > 0 ? sceneId : null;
        if (detail.sourceSceneId !== normalized) {
          detail.sourceSceneId = normalized;
          if (normalized === null) {
            detail.sourceBeatId = null;
          }
          mutated = true;
        }
      }
      if (Object.prototype.hasOwnProperty.call(updates, 'sourceBeatId')) {
        const beatIdRaw = updates.sourceBeatId;
        const normalizedBeat = typeof beatIdRaw === 'string' && beatIdRaw.length > 0 ? beatIdRaw : null;
        if (detail.sourceBeatId !== normalizedBeat) {
          detail.sourceBeatId = normalizedBeat;
          mutated = true;
          if (normalizedBeat && !detail.sourceSceneId) {
            const sceneIdForBeat = findSceneIdForBeat(draft, normalizedBeat);
            if (sceneIdForBeat) {
              detail.sourceSceneId = sceneIdForBeat;
            }
          }
        }
      }
      if (!mutated) {
        return false;
      }
      detail.updatedAt = new Date().toISOString();
    });
  },
  removeCodexDetail(entryId, detailId) {
    if (!entryId || !detailId) {
      return;
    }
    updateState((draft) => {
      const entry = draft.codex.entries[entryId];
      if (!entry || !Array.isArray(entry.details)) {
        return false;
      }
      const index = entry.details.findIndex((item) => item.id === detailId);
      if (index === -1) {
        return false;
      }
      entry.details.splice(index, 1);
    });
  },
  updateCodexBackgroundField(entryId, field, value) {
    if (!entryId || !CHARACTER_BACKGROUND_FIELDS.includes(field)) {
      return;
    }
    updateState((draft) => {
      const entry = draft.codex.entries[entryId];
      if (!entry || entry.category !== 'character') {
        return false;
      }
      if (!entry.background) {
        entry.background = createCharacterBackground();
      }
      const nextValue = typeof value === 'string' ? value : '';
      if (entry.background[field] === nextValue) {
        return false;
      }
      entry.background[field] = nextValue;
    });
  },
  addCodexCoreDetail(entryId, section) {
    if (!entryId || !CHARACTER_CORE_SECTION_KEYS.includes(section)) {
      return;
    }
    updateState((draft) => {
      const entry = draft.codex.entries[entryId];
      if (!entry || entry.category !== 'character') {
        return false;
      }
      if (!entry.core) {
        entry.core = createCharacterCoreSections();
      }
      entry.core[section].push({
        id: createId('core'),
        text: '',
        sourceSceneId:
          entry.core[section].length > 0
            ? entry.core[section][0].sourceSceneId || null
            : state && state.selectedSceneId
              ? state.selectedSceneId
              : null,
        sourceBeatId: null,
        createdAt: new Date().toISOString()
      });
    });
  },
  updateCodexCoreDetail(entryId, section, itemId, text) {
    if (!entryId || !CHARACTER_CORE_SECTION_KEYS.includes(section) || !itemId) {
      return;
    }
    updateState((draft) => {
      const entry = draft.codex.entries[entryId];
      if (!entry || entry.category !== 'character') {
        return false;
      }
      if (!entry.core) {
        entry.core = createCharacterCoreSections();
      }
      const list = entry.core[section];
      if (!Array.isArray(list)) {
        entry.core[section] = [];
        return false;
      }
      const item = list.find((detail) => detail.id === itemId);
      if (!item) {
        return false;
      }
      const nextText = typeof text === 'string' ? text : '';
      if (item.text === nextText) {
        return false;
      }
      item.text = nextText;
      item.updatedAt = new Date().toISOString();
    });
  },
  removeCodexCoreDetail(entryId, section, itemId) {
    if (!entryId || !CHARACTER_CORE_SECTION_KEYS.includes(section) || !itemId) {
      return;
    }
    updateState((draft) => {
      const entry = draft.codex.entries[entryId];
      if (!entry || entry.category !== 'character') {
        return false;
      }
      if (!entry.core) {
        entry.core = createCharacterCoreSections();
      }
      const list = entry.core[section];
      if (!Array.isArray(list)) {
        entry.core[section] = [];
        return false;
      }
      const index = list.findIndex((detail) => detail.id === itemId);
      if (index === -1) {
        return false;
      }
      list.splice(index, 1);
    });
  },
  applyAssistantSuggestion(messageId) {
    if (!messageId || !state) {
      return;
    }
    const selection = state.ui.selectionContext;
    if (!selection || !selection.sceneId || !Number.isInteger(selection.start) || !Number.isInteger(selection.end)) {
      return;
    }
    if (selection.end <= selection.start) {
      return;
    }
    const scene = state.scenes[selection.sceneId];
    if (!scene) {
      return;
    }
    const messages = state.chat && Array.isArray(state.chat.messages) ? state.chat.messages : [];
    const message = messages.find((item) => item && item.id === messageId && item.role === 'assistant');
    if (!message || typeof message.content !== 'string') {
      return;
    }
    const replacement = message.content;
    if (replacement.trim().length === 0) {
      return;
    }
    const lastScroll =
      editorFocusState && editorFocusState.sceneId === selection.sceneId ? editorFocusState.scrollTop : 0;
    updateState((draft) => {
      const draftSelection = draft.ui.selectionContext;
      if (!draftSelection || draftSelection.sceneId !== selection.sceneId) {
        return false;
      }
      const draftScene = draft.scenes[draftSelection.sceneId];
      if (!draftScene) {
        return false;
      }
      const before = draftScene.text.slice(0, draftSelection.start);
      const after = draftScene.text.slice(draftSelection.end);
      draftScene.text = `${before}${replacement}${after}`;
      draftScene.wordCount = calculateWordCount(draftScene.text);
      draftScene.draftStatus = draftScene.wordCount === 0 ? 'empty' : 'drafted';
      draftScene.lastUpdated = new Date().toISOString();
      const newStart = before.length;
      const newEnd = newStart + replacement.length;
      const snippet = replacement.trim();
      draft.ui.selectionContext = {
        sceneId: draftScene.id,
        start: newStart,
        end: newEnd,
        text: snippet.length > 120 ? `${snippet.slice(0, 117)}…` : snippet,
        rawText: replacement
      };
      markEditorFocus(draftScene.id, newStart, newEnd, lastScroll);
    });
  },
  async startSceneScan(sceneId) {
    if (!state) {
      return;
    }
    const scene = sceneId ? state.scenes[sceneId] : null;
    if (!scene) {
      return;
    }

    const existingStatus = state.ui.scanStatus;
    if (existingStatus && existingStatus.state === 'running') {
      return;
    }

    const providerId = getProviderId('codex');
    const apiKey = state.settings.apiKeys ? state.settings.apiKeys[providerId] : null;
    const startedAt = new Date().toISOString();

    updateState((draft) => {
      draft.ui.scanStatus = {
        sceneId,
        state: 'running',
        step: 'preparing',
        message: 'Preparing scene for analysis…',
        startedAt
      };
    });

    if (!providerId) {
      updateState((draft) => {
        draft.ui.scanStatus = {
          sceneId,
          state: 'error',
          message: 'Select a Codex provider in Settings before scanning.',
          startedAt,
          completedAt: new Date().toISOString()
        };
      });
      return;
    }

    if (!apiKey || apiKey.trim().length === 0) {
      updateState((draft) => {
        draft.ui.scanStatus = {
          sceneId,
          state: 'error',
          message: 'Add an API key for the Codex provider in Settings before scanning.',
          startedAt,
          completedAt: new Date().toISOString()
        };
      });
      return;
    }

    const scenePayload = typeof structuredClone === 'function' ? structuredClone(scene) : JSON.parse(JSON.stringify(scene));
    const beats = Array.isArray(scenePayload.beats) ? [...scenePayload.beats] : [];
    const codexEntries = Object.values(state.codex.entries || {});
    const outline = buildOutlineSummary(state);
    const orderedSceneIds = getOrderedSceneIds(state);
    const currentIndex = orderedSceneIds.indexOf(sceneId);
    const previousSceneId = currentIndex > 0 ? orderedSceneIds[currentIndex - 1] : null;
    const nextSceneId = currentIndex >= 0 && currentIndex < orderedSceneIds.length - 1 ? orderedSceneIds[currentIndex + 1] : null;
    const previousScene = previousSceneId ? createSceneContext(state.scenes[previousSceneId]) : null;
    const nextScene = nextSceneId ? createSceneContext(state.scenes[nextSceneId]) : null;
    const selectionContext =
      state.ui.selectionContext && state.ui.selectionContext.sceneId === sceneId ? state.ui.selectionContext : null;

    const progress = (step, detail) => {
      updateState((draft) => {
        const status = draft.ui.scanStatus;
        if (!status || status.sceneId !== sceneId) {
          return false;
        }
        status.state = 'running';
        status.step = step;
        status.detail = detail;
        status.message = detail || status.message;
      });
    };

    try {
      progress('chunking', 'Chunking scene text for analysis…');
      const payload = await requestSceneScan({
        providerId,
        apiKey,
        scene: scenePayload,
        beats,
        outline,
        codexEntries,
        previousScene,
        nextScene,
        selectionContext,
        onProgress: progress
      });

      const updates = Array.isArray(payload.codexUpdates) ? payload.codexUpdates : [];
      const sceneSummary = payload.sceneNotes && payload.sceneNotes.summary ? payload.sceneNotes.summary : '';
      const aiBeats = Array.isArray(payload.beats) ? payload.beats : [];

      let stats = { created: 0, updated: 0 };
      updateState((draft) => {
        const draftScene = draft.scenes[sceneId];
        if (!draftScene) {
          return false;
        }
        stats = applyCodexUpdates(draft, sceneId, updates);
        draftScene.beats = normalizeBeats(
          sceneId,
          aiBeats.map((beat, index) => ({
            id: nextBeatId(sceneId, index + 1),
            title: beat && typeof beat.title === 'string' && beat.title.trim().length > 0 ? beat.title.trim() : `Beat ${index + 1}`,
            summary: beat && typeof beat.summary === 'string' ? beat.summary.trim() : '',
            order: index + 1
          }))
        );
        draftScene.lastScan = {
          providerId,
          timestamp: new Date().toISOString(),
          created: stats.created,
          updated: stats.updated,
          entries: updates.map((item) => item && item.name).filter(Boolean),
          summary: sceneSummary
        };
        draft.ui.scanStatus = {
          sceneId,
          state: 'success',
          message: `Scene scan complete. Beats refreshed and Codex updated (${stats.created} new, ${stats.updated} refined).`,
          startedAt,
          completedAt: new Date().toISOString(),
          providerId
        };
      });
    } catch (error) {
      console.error('Scene scan failed', error);
      updateState((draft) => {
        let message = error && error.message ? error.message : 'Scene scan failed. Check console for details.';
        if (message.includes('Failed to fetch') || message.includes('NetworkError') || message.includes('fetch')) {
          message = 'Unable to reach the AI provider. Check your network connection and API key permissions.';
        }
        draft.ui.scanStatus = {
          sceneId,
          state: 'error',
          message,
          startedAt,
          completedAt: new Date().toISOString()
        };
      });
    }
  },
  resetScanStatus() {
    updateState((draft) => {
      draft.ui.scanStatus = null;
    });
  }
};

const outlineRoot = document.getElementById('outline-root');
const mainRoot = document.getElementById('main-root');
const assistantRoot = document.getElementById('assistant-root');
const headerActionsRoot = document.getElementById('app-header-actions');
const settingsRoot = document.getElementById('settings-root');

if (!headerActionsRoot) {
  throw new Error('Header actions root not found');
}

if (!mainRoot) {
  throw new Error('Main root not found');
}

if (!assistantRoot) {
  throw new Error('Assistant root not found');
}

if (!settingsRoot) {
  throw new Error('Settings root not found');
}

let dragPayload = null;

function handleDragStart(event) {
  const target = event.currentTarget;
  const type = target?.dataset?.dragType;
  if (!type) {
    return;
  }
  dragPayload = {
    type,
    actId: target.dataset.actId || null,
    chapterId: target.dataset.chapterId || null,
    sceneId: target.dataset.sceneId || null,
    beatId: target.dataset.beatId || null
  };
  if (event.dataTransfer) {
    event.dataTransfer.effectAllowed = 'move';
    event.dataTransfer.setData('text/plain', type);
  }
}

function handleDragEnd() {
  dragPayload = null;
}

function canDrop(payload, dropType, target) {
  if (!payload || !dropType) {
    return false;
  }
  if (payload.type === 'act') {
    return dropType === 'act' || dropType === 'act-end';
  }
  if (payload.type === 'chapter') {
    if (dropType === 'chapter' || dropType === 'chapter-end') {
      const targetActId = target?.dataset?.actId;
      return targetActId && targetActId === payload.actId;
    }
    return false;
  }
  if (payload.type === 'scene') {
    if (dropType === 'scene' || dropType === 'scene-end') {
      const targetChapterId = target?.dataset?.chapterId;
      return targetChapterId && targetChapterId === payload.chapterId;
    }
    return false;
  }
  if (payload.type === 'beat') {
    if (dropType === 'beat' || dropType === 'beat-end') {
      const targetSceneId = target?.dataset?.sceneId;
      return targetSceneId && targetSceneId === payload.sceneId;
    }
    return false;
  }
  return false;
}

function handleDragOver(event) {
  if (!dragPayload) {
    return;
  }
  const dropType = event.currentTarget.dataset.dropType;
  if (canDrop(dragPayload, dropType, event.currentTarget)) {
    event.preventDefault();
    if (event.dataTransfer) {
      event.dataTransfer.dropEffect = 'move';
    }
    event.currentTarget.classList.add('is-drop-target');
  }
}

function handleDrop(event) {
  if (!dragPayload) {
    return;
  }
  const target = event.currentTarget;
  const dropType = target.dataset.dropType;
  if (!canDrop(dragPayload, dropType, target)) {
    return;
  }

  event.preventDefault();
  event.stopPropagation();
  target.classList.remove('is-drop-target');

  if (dragPayload.type === 'act') {
    if (dropType === 'act') {
      const targetActId = target.dataset.actId;
      if (dragPayload.actId && targetActId && dragPayload.actId !== targetActId) {
        actions.reorderAct(dragPayload.actId, targetActId);
      }
    } else if (dropType === 'act-end') {
      if (dragPayload.actId) {
        actions.reorderAct(dragPayload.actId, null);
      }
    }
  } else if (dragPayload.type === 'chapter') {
    const targetActId = target.dataset.actId;
    if (!targetActId) {
      return;
    }
    if (dropType === 'chapter') {
      const targetChapterId = target.dataset.chapterId;
      if (dragPayload.chapterId && targetChapterId && dragPayload.chapterId !== targetChapterId) {
        const act = state.acts.find((actItem) => actItem.id === targetActId);
        if (!act) {
          return;
        }
        const targetIndex = act.chapterIds.indexOf(targetChapterId);
        if (targetIndex !== -1) {
          actions.moveChapter(dragPayload.chapterId, targetActId, targetIndex);
        }
      }
    } else if (dropType === 'chapter-end') {
      const act = state.acts.find((actItem) => actItem.id === targetActId);
      const targetIndex = act ? act.chapterIds.length : 0;
      actions.moveChapter(dragPayload.chapterId, targetActId, targetIndex);
    }
  } else if (dragPayload.type === 'scene') {
    const targetChapterId = target.dataset.chapterId;
    if (!targetChapterId) {
      return;
    }
    const chapter = state.chapters[targetChapterId];
    if (!chapter) {
      return;
    }
    if (dropType === 'scene') {
      const targetSceneId = target.dataset.sceneId;
      if (dragPayload.sceneId && targetSceneId && dragPayload.sceneId !== targetSceneId) {
        const targetIndex = chapter.sceneIds.indexOf(targetSceneId);
        if (targetIndex !== -1) {
          actions.moveScene(dragPayload.sceneId, targetChapterId, targetIndex);
        }
      }
    } else if (dropType === 'scene-end') {
      actions.moveScene(dragPayload.sceneId, targetChapterId, chapter.sceneIds.length);
    }
  } else if (dragPayload.type === 'beat') {
    const targetSceneId = target.dataset.sceneId;
    if (!targetSceneId) {
      return;
    }
    const scene = state.scenes[targetSceneId];
    if (!scene) {
      return;
    }
    if (dropType === 'beat') {
      const targetBeatId = target.dataset.beatId;
      if (dragPayload.beatId && targetBeatId && dragPayload.beatId !== targetBeatId) {
        const targetIndex = scene.beats.findIndex((beat) => beat.id === targetBeatId);
        if (targetIndex !== -1) {
          actions.moveBeat(dragPayload.sceneId, dragPayload.beatId, targetIndex);
        }
      }
    } else if (dropType === 'beat-end') {
      const targetIndex = scene.beats.length;
      actions.moveBeat(dragPayload.sceneId, dragPayload.beatId, targetIndex);
    }
  }

  dragPayload = null;
}

function handleDragLeave(event) {
  event.currentTarget.classList.remove('is-drop-target');
}

function createElement(tag, className, textContent) {
  const element = document.createElement(tag);
  if (className) {
    element.className = className;
  }
  if (typeof textContent === 'string') {
    element.textContent = textContent;
  }
  return element;
}

function renderHeaderActions() {
  headerActionsRoot.innerHTML = '';

  if (!state) {
    headerActionsRoot.appendChild(createElement('span', 'app-header-loading', 'Preparing workspace…'));
    return;
  }

  const layout = createElement('div', 'header-actions-layout');

  const tabs = createElement('div', 'header-actions-tabs');
  const manuscriptTab = createElement(
    'button',
    `header-tab${state.ui.activeMainView === 'workspace' ? ' is-active' : ''}`,
    'Manuscript'
  );
  manuscriptTab.addEventListener('click', () => actions.setActiveMainView('workspace'));
  tabs.appendChild(manuscriptTab);

  const codexTab = createElement('button', `header-tab${state.ui.activeMainView === 'codex' ? ' is-active' : ''}`, 'Codex');
  codexTab.addEventListener('click', () => actions.setActiveMainView('codex'));
  tabs.appendChild(codexTab);

  layout.appendChild(tabs);

  const actionGroup = createElement('div', 'header-actions-group');

  const selectedScene = state.selectedSceneId ? state.scenes[state.selectedSceneId] : null;
  const isScanning = Boolean(state.ui.scanStatus && state.ui.scanStatus.state === 'running');
  const codexProviderId = getProviderId('codex');
  const hasCodexKey = hasApiKeyFor(codexProviderId);

  const scanButton = createElement('button', 'app-header-button', isScanning ? 'Scanning…' : 'Scan scene');
  if (!selectedScene || isScanning || !hasCodexKey) {
    scanButton.disabled = true;
  } else {
    scanButton.addEventListener('click', () => actions.startSceneScan(selectedScene.id));
  }
  if (!hasCodexKey) {
    scanButton.title = 'Add an API key for the Codex provider in Settings to enable scene scanning.';
  }
  actionGroup.appendChild(scanButton);

  const settingsLabel = state.ui.showSettings ? 'Close settings' : 'Settings';
  const settingsButton = createElement(
    'button',
    `app-header-button${state.ui.showSettings ? ' is-active' : ''}`,
    settingsLabel
  );
  settingsButton.addEventListener('click', () => actions.toggleSettings());
  actionGroup.appendChild(settingsButton);

  layout.appendChild(actionGroup);

  headerActionsRoot.appendChild(layout);
}

function renderSettings() {
  settingsRoot.innerHTML = '';

  if (!state) {
    settingsRoot.className = '';
    settingsRoot.onclick = null;
    return;
  }

  if (!state.ui.showSettings) {
    settingsRoot.className = '';
    settingsRoot.onclick = null;
    return;
  }

  settingsRoot.className = 'settings-overlay';
  settingsRoot.onclick = (event) => {
    if (event.target === settingsRoot) {
      actions.toggleSettings();
    }
  };

  const modal = createElement('div', 'settings-modal');

  const header = createElement('div', 'settings-header');
  const headerText = document.createElement('div');
  headerText.appendChild(createElement('h2', 'settings-title', 'AI Assistant Settings'));
  headerText.appendChild(
    createElement(
      'p',
      'settings-description',
      'Choose separate providers for writing/chat and Codex tasks, and manage their API keys locally.'
    )
  );
  header.appendChild(headerText);
  const closeButton = createElement('button', 'settings-close', 'Close');
  closeButton.addEventListener('click', () => actions.toggleSettings());
  header.appendChild(closeButton);
  modal.appendChild(header);

  const roleCopy = {
    assistant: {
      label: 'Writing & chat model',
      helper: 'Used for manuscript drafting, chat, and beat generation.'
    },
    codex: {
      label: 'Codex & scan model',
      helper: 'Used for outline maintenance, Codex updates, and scene scans.'
    }
  };

  PROVIDER_ROLES.forEach((role) => {
    const section = createElement('div', 'settings-section');
    const meta = roleCopy[role] || { label: `Provider (${role})`, helper: '' };
    section.appendChild(createElement('label', 'settings-label', meta.label));

    const providerSelect = document.createElement('select');
    providerSelect.className = 'settings-select';
    AI_PROVIDERS.forEach((provider) => {
      const option = document.createElement('option');
      option.value = provider.id;
      option.textContent = provider.label;
      providerSelect.appendChild(option);
    });
    const selectedId = getProviderId(role);
    providerSelect.value = selectedId;
    providerSelect.addEventListener('change', (event) => {
      actions.selectProvider(role, event.target.value);
    });
    section.appendChild(providerSelect);

    if (meta.helper) {
      section.appendChild(createElement('p', 'settings-helper', meta.helper));
    }

    const apiKeyInput = document.createElement('input');
    apiKeyInput.type = 'password';
    apiKeyInput.className = 'settings-input';
    apiKeyInput.placeholder = `API key for the ${meta.label.toLowerCase()}`;
    const apiKeys = state.settings.apiKeys || {};
    apiKeyInput.value = apiKeys[selectedId] || '';
    apiKeyInput.addEventListener('input', (event) => {
      actions.updateApiKey(getProviderId(role), event.target.value.trim());
    });
    section.appendChild(apiKeyInput);
    section.appendChild(
      createElement('p', 'settings-helper', 'Keys are stored locally for this browser session only.')
    );

    const sectionActions = createElement('div', 'settings-actions');
    const clearButton = createElement('button', 'settings-secondary', 'Clear key');
    clearButton.addEventListener('click', () => {
      actions.clearApiKey(getProviderId(role));
    });
    if (!hasApiKeyFor(selectedId)) {
      clearButton.disabled = true;
    }
    sectionActions.appendChild(clearButton);
    section.appendChild(sectionActions);

    modal.appendChild(section);
  });

  const clearDbSection = createElement('div', 'settings-section settings-section-danger');
  clearDbSection.appendChild(createElement('p', 'settings-section-title', 'Clear database'));
  clearDbSection.appendChild(
    createElement(
      'p',
      'settings-helper',
      'Remove the saved IndexedDB copy while keeping the current session open.'
    )
  );
  const clearDbButton = createElement('button', 'settings-danger', 'Clear database');
  clearDbButton.addEventListener('click', async () => {
    const confirmed = window.confirm(
      'This removes the saved database copy from your browser. Your current session stays active until reload. Continue?'
    );
    if (!confirmed) {
      return;
    }
    clearDbButton.disabled = true;
    try {
      await actions.clearDatabase();
      window.alert('Saved database cleared. Reload the app to start from a fresh state.');
    } catch (error) {
      window.alert('Unable to clear the database. Check the console for details.');
    } finally {
      clearDbButton.disabled = false;
    }
  });
  clearDbSection.appendChild(clearDbButton);
  modal.appendChild(clearDbSection);

  const clearAllSection = createElement('div', 'settings-section settings-section-danger');
  clearAllSection.appendChild(createElement('p', 'settings-section-title', 'Clear everything'));
  clearAllSection.appendChild(
    createElement(
      'p',
      'settings-helper',
      'Reset the database and remove your manuscript, beats, outline, and Codex data.'
    )
  );
  const clearAllButton = createElement('button', 'settings-danger', 'Clear database & manuscript');
  clearAllButton.addEventListener('click', async () => {
    const confirmed = window.confirm(
      'This clears all saved data, including manuscript text, outline, beats, and Codex entries. This cannot be undone. Continue?'
    );
    if (!confirmed) {
      return;
    }
    clearAllButton.disabled = true;
    try {
      await actions.clearAllData();
      window.alert('All SimpleWriter data cleared. A fresh workspace has been created.');
    } finally {
      clearAllButton.disabled = false;
    }
  });
  clearAllSection.appendChild(clearAllButton);
  modal.appendChild(clearAllSection);

  settingsRoot.appendChild(modal);
}

function renderOutline() {
  outlineRoot.innerHTML = '';
  if (!outlineRoot.classList.contains('outline-board')) {
    outlineRoot.classList.add('outline-board');
  }

  if (!state) {
    outlineRoot.appendChild(createElement('div', 'panel-loading', 'Loading outline…'));
    return;
  }

  const outlineUi = state.ui.outline || { collapsedActs: [], collapsedChapters: [], expandedScenes: [] };

  const header = createElement('div', 'outline-header');
  const titleWrapper = document.createElement('div');
  const title = createElement('h2', 'outline-title', 'Outline');
  const subtitle = createElement('p', 'outline-subtitle', 'Acts, chapters, and scenes organised hierarchically.');
  titleWrapper.appendChild(title);
  titleWrapper.appendChild(subtitle);
  const addActButton = createElement('button', 'button-accent', '+ Act');
  addActButton.addEventListener('click', () => actions.addAct());
  header.appendChild(titleWrapper);
  header.appendChild(addActButton);
  outlineRoot.appendChild(header);

  const scrollRegion = createElement('div', 'outline-scroll');

  if (state.acts.length === 0) {
    scrollRegion.appendChild(createElement('div', 'outline-empty', 'Start by creating an act for your story.'));
    outlineRoot.appendChild(scrollRegion);
    return;
  }

  const sortedActs = [...state.acts].sort((a, b) => a.order - b.order);
  sortedActs.forEach((act) => {
    const actContainer = createElement('div', 'outline-act');
    actContainer.draggable = true;
    actContainer.dataset.dragType = 'act';
    actContainer.dataset.actId = act.id;
    actContainer.dataset.dropType = 'act';
    actContainer.addEventListener('dragstart', handleDragStart);
    actContainer.addEventListener('dragend', handleDragEnd);
    actContainer.addEventListener('dragenter', handleDragOver);
    actContainer.addEventListener('dragover', handleDragOver);
    actContainer.addEventListener('drop', handleDrop);
    actContainer.addEventListener('dragleave', handleDragLeave);
    const actCollapsed = outlineUi.collapsedActs.includes(act.id);
    if (actCollapsed) {
      actContainer.classList.add('is-collapsed');
    }
    const actHeader = createElement('div', 'outline-act-header');
    const actHeaderText = document.createElement('div');
    const actTitleRow = createElement('div', 'outline-act-title-row');
    const actToggle = createElement('button', 'outline-collapse-button', actCollapsed ? '▸' : '▾');
    actToggle.title = actCollapsed ? 'Expand act' : 'Collapse act';
    actToggle.addEventListener('click', (event) => {
      event.stopPropagation();
      actions.toggleActCollapse(act.id);
    });
    actTitleRow.appendChild(actToggle);
    actTitleRow.appendChild(createElement('h3', 'outline-act-title', `Act ${act.order}: ${act.title}`));
    const renameActButton = createElement('button', 'button-icon', '✎');
    renameActButton.title = 'Rename act';
    renameActButton.addEventListener('click', () => {
      const nextTitle = window.prompt('Rename act', act.title);
      if (nextTitle !== null) {
        actions.renameAct(act.id, nextTitle);
      }
    });
    actTitleRow.appendChild(renameActButton);
    const deleteActButton = createElement('button', 'button-icon button-icon-danger', '🗑');
    deleteActButton.title = 'Delete act';
    deleteActButton.addEventListener('click', (event) => {
      event.stopPropagation();
      const label = act.title ? `Delete act "${act.title}" and all chapters/scenes?` : 'Delete this act and all chapters/scenes?';
      if (window.confirm(label)) {
        actions.deleteAct(act.id);
      }
    });
    deleteActButton.addEventListener('mousedown', (event) => event.stopPropagation());
    actTitleRow.appendChild(deleteActButton);
    actHeaderText.appendChild(actTitleRow);
    actHeaderText.appendChild(
      createElement(
        'p',
        'outline-act-summary',
        `${act.chapterIds.length} ${act.chapterIds.length === 1 ? 'chapter' : 'chapters'}`
      )
    );
    const addChapterButton = createElement('button', 'button-outline', '+ Chapter');
    addChapterButton.addEventListener('click', () => actions.addChapter(act.id));
    actHeader.appendChild(actHeaderText);
    actHeader.appendChild(addChapterButton);
    actContainer.appendChild(actHeader);

    if (actCollapsed) {
      scrollRegion.appendChild(actContainer);
      return;
    }

    const chapterList = createElement('div', 'outline-chapter-list');
    chapterList.dataset.dropType = 'chapter-end';
    chapterList.dataset.actId = act.id;
    chapterList.addEventListener('dragenter', handleDragOver);
    chapterList.addEventListener('dragover', handleDragOver);
    chapterList.addEventListener('drop', handleDrop);
    chapterList.addEventListener('dragleave', handleDragLeave);
    if (act.chapterIds.length === 0) {
      chapterList.appendChild(createElement('div', 'outline-empty', 'No chapters in this act.'));
    } else {
      act.chapterIds.forEach((chapterId) => {
        const chapter = state.chapters[chapterId];
        if (!chapter) {
          return;
        }
        const chapterContainer = createElement('div', 'outline-chapter');
        chapterContainer.draggable = true;
        chapterContainer.dataset.dragType = 'chapter';
        chapterContainer.dataset.chapterId = chapter.id;
        chapterContainer.dataset.actId = act.id;
        chapterContainer.dataset.dropType = 'chapter';
        chapterContainer.addEventListener('dragstart', handleDragStart);
        chapterContainer.addEventListener('dragend', handleDragEnd);
        chapterContainer.addEventListener('dragenter', handleDragOver);
        chapterContainer.addEventListener('dragover', handleDragOver);
        chapterContainer.addEventListener('drop', handleDrop);
        chapterContainer.addEventListener('dragleave', handleDragLeave);
        const chapterHeader = createElement('div', 'outline-chapter-header');
        const chapterTitleRow = createElement('div', 'outline-chapter-title-row');
        const chapterCollapsed = outlineUi.collapsedChapters.includes(chapter.id);
        if (chapterCollapsed) {
          chapterContainer.classList.add('is-collapsed');
        }
        const chapterToggle = createElement('button', 'outline-collapse-button', chapterCollapsed ? '▸' : '▾');
        chapterToggle.title = chapterCollapsed ? 'Expand chapter' : 'Collapse chapter';
        chapterToggle.addEventListener('click', (event) => {
          event.stopPropagation();
          actions.toggleChapterCollapse(chapter.id);
        });
        chapterTitleRow.appendChild(chapterToggle);
        chapterTitleRow.appendChild(
          createElement('h4', 'outline-chapter-title', `Chapter ${chapter.order}: ${chapter.title}`)
        );
        const renameChapterButton = createElement('button', 'button-icon', '✎');
        renameChapterButton.title = 'Rename chapter';
        renameChapterButton.addEventListener('click', () => {
          const nextTitle = window.prompt('Rename chapter', chapter.title);
          if (nextTitle !== null) {
            actions.renameChapter(chapter.id, nextTitle);
          }
        });
        chapterTitleRow.appendChild(renameChapterButton);
        const deleteChapterButton = createElement('button', 'button-icon button-icon-danger', '🗑');
        deleteChapterButton.title = 'Delete chapter';
        deleteChapterButton.addEventListener('click', (event) => {
          event.stopPropagation();
          const label = chapter.title
            ? `Delete chapter "${chapter.title}" and all scenes?`
            : 'Delete this chapter and all scenes?';
          if (window.confirm(label)) {
            actions.deleteChapter(chapter.id);
          }
        });
        deleteChapterButton.addEventListener('mousedown', (event) => event.stopPropagation());
        chapterTitleRow.appendChild(deleteChapterButton);
        chapterHeader.appendChild(chapterTitleRow);
        const addSceneButton = createElement('button', 'button-outline', '+ Scene');
        addSceneButton.addEventListener('click', () => actions.addScene(chapter.id));
        chapterHeader.appendChild(addSceneButton);
        chapterContainer.appendChild(chapterHeader);

        if (chapterCollapsed) {
          chapterList.appendChild(chapterContainer);
          return;
        }

        const sceneList = createElement('ul', 'outline-scene-list');
        sceneList.dataset.dropType = 'scene-end';
        sceneList.dataset.chapterId = chapter.id;
        sceneList.addEventListener('dragenter', handleDragOver);
        sceneList.addEventListener('dragover', handleDragOver);
        sceneList.addEventListener('drop', handleDrop);
        sceneList.addEventListener('dragleave', handleDragLeave);
        if (chapter.sceneIds.length === 0) {
          const emptyItem = createElement('li', 'outline-empty', 'No scenes yet. Add one to start writing.');
          sceneList.appendChild(emptyItem);
        } else {
          chapter.sceneIds.forEach((sceneId) => {
            const scene = state.scenes[sceneId];
            if (!scene) {
              return;
            }
            const listItem = document.createElement('li');
            listItem.className = 'outline-scene-item';
            listItem.draggable = true;
            listItem.dataset.dragType = 'scene';
            listItem.dataset.sceneId = scene.id;
            listItem.dataset.chapterId = chapter.id;
            listItem.dataset.dropType = 'scene';
            listItem.addEventListener('dragstart', handleDragStart);
            listItem.addEventListener('dragend', handleDragEnd);
            listItem.addEventListener('dragenter', handleDragOver);
            listItem.addEventListener('dragover', handleDragOver);
            listItem.addEventListener('drop', handleDrop);
            listItem.addEventListener('dragleave', handleDragLeave);
            const sceneExpanded = outlineUi.expandedScenes.includes(scene.id);
            if (sceneExpanded) {
              listItem.classList.add('is-expanded');
            }
            const sceneRow = createElement('div', 'outline-scene-row');
            const sceneToggle = createElement(
              'button',
              'outline-collapse-button outline-scene-toggle',
              sceneExpanded ? '▾' : '▸'
            );
            sceneToggle.title = sceneExpanded ? 'Hide beats' : 'Show beats';
            sceneToggle.addEventListener('click', (event) => {
              event.stopPropagation();
              actions.toggleSceneBeats(scene.id);
            });
            sceneToggle.addEventListener('mousedown', (event) => event.stopPropagation());
            sceneRow.appendChild(sceneToggle);
            const button = createElement(
              'button',
              `scene-button${state.selectedSceneId === scene.id ? ' is-active' : ''}`
            );
            const buttonBody = createElement('div', 'scene-button-body');
            const buttonTitle = createElement('p', 'scene-button-title', scene.title);
            const buttonMeta = createElement(
              'p',
              'scene-button-meta',
              `${scene.wordCount} ${scene.wordCount === 1 ? 'word' : 'words'} · ${scene.draftStatus}`
            );
            buttonBody.appendChild(buttonTitle);
            buttonBody.appendChild(buttonMeta);
            button.appendChild(buttonBody);
            const renameScene = createElement('button', 'button-icon scene-rename', '✎');
            renameScene.title = 'Rename scene';
            renameScene.addEventListener('click', (event) => {
              event.stopPropagation();
              const nextTitle = window.prompt('Rename scene', scene.title);
              if (nextTitle !== null) {
                actions.renameScene(scene.id, nextTitle);
              }
            });
            button.appendChild(renameScene);
            button.addEventListener('click', () => actions.selectScene(scene.id));
            sceneRow.appendChild(button);
            const deleteSceneButton = createElement('button', 'button-icon button-icon-danger scene-delete', '🗑');
            deleteSceneButton.title = 'Delete scene';
            deleteSceneButton.addEventListener('click', (event) => {
              event.stopPropagation();
              const label = scene.title ? `Delete scene "${scene.title}" and all beats?` : 'Delete this scene and all beats?';
              if (window.confirm(label)) {
                actions.deleteScene(scene.id);
              }
            });
            deleteSceneButton.addEventListener('mousedown', (event) => event.stopPropagation());
            sceneRow.appendChild(deleteSceneButton);
            listItem.appendChild(sceneRow);
            if (sceneExpanded && Array.isArray(scene.beats) && scene.beats.length > 0) {
              const beatPreview = createElement('ul', 'scene-beat-preview');
              scene.beats
                .slice()
                .sort((a, b) => (a.order || 0) - (b.order || 0))
                .forEach((beat, beatIndex) => {
                  const beatPreviewItem = createElement(
                    'li',
                    'scene-beat-preview-item',
                    `${beat.order || beatIndex + 1}. ${beat.title || 'Untitled Beat'}`
                  );
                  beatPreview.appendChild(beatPreviewItem);
                });
              listItem.appendChild(beatPreview);
            } else if (sceneExpanded) {
              listItem.appendChild(createElement('p', 'scene-beat-empty', 'No beats yet.'));
            }
            sceneList.appendChild(listItem);
          });
        }

        chapterContainer.appendChild(sceneList);
        chapterList.appendChild(chapterContainer);
      });
    }

    actContainer.appendChild(chapterList);
    scrollRegion.appendChild(actContainer);
  });

  const actDropTail = createElement('div', 'outline-drop-zone outline-drop-zone-act');
  actDropTail.dataset.dropType = 'act-end';
  actDropTail.addEventListener('dragenter', handleDragOver);
  actDropTail.addEventListener('dragover', handleDragOver);
  actDropTail.addEventListener('drop', handleDrop);
  actDropTail.addEventListener('dragleave', handleDragLeave);
  scrollRegion.appendChild(actDropTail);

  outlineRoot.appendChild(scrollRegion);
}

function renderMainView() {
  if (!state) {
    if (mainRoot) {
      mainRoot.innerHTML = '';
      mainRoot.appendChild(createElement('div', 'panel-loading', 'Loading workspace…'));
    }
    return;
  }

  if (state.ui.activeMainView === 'codex') {
    renderCodexView();
  } else {
    renderWorkspace();
  }
}

function renderWorkspace() {
  const root = mainRoot;
  if (!root) {
    return;
  }
  root.innerHTML = '';

  if (!state) {
    root.appendChild(createElement('div', 'panel-loading', 'Loading workspace…'));
    return;
  }

  const selectedScene = state.selectedSceneId ? state.scenes[state.selectedSceneId] : null;
  if (!selectedScene) {
    root.appendChild(createElement('div', 'workspace-empty', 'Select a scene from the outline to begin writing.'));
    return;
  }

  const shell = createElement('div', 'workspace-shell');

  const header = createElement('header', 'workspace-header');
  const headerLeft = createElement('div', 'workspace-header-left');
  const breadcrumb = createElement('div', 'workspace-breadcrumb');
  const locationLabel = createElement('span', 'workspace-breadcrumb-label', 'Scene');
  const locationValue = createElement('span', 'workspace-breadcrumb-value', selectedScene.title);
  breadcrumb.appendChild(locationLabel);
  breadcrumb.appendChild(locationValue);
  const hierarchy = createSceneLocation(selectedScene);
  if (hierarchy) {
    breadcrumb.appendChild(createElement('span', 'workspace-breadcrumb-meta', hierarchy));
  }
  headerLeft.appendChild(breadcrumb);

  const beatCount = Array.isArray(selectedScene.beats) ? selectedScene.beats.length : 0;
  const stats = createElement('div', 'workspace-stats');
  const statWords = createElement('p', 'workspace-stat workspace-stat-words', `${selectedScene.wordCount} words`);
  const statBeats = createElement(
    'p',
    'workspace-stat workspace-stat-beats',
    `${beatCount} ${beatCount === 1 ? 'beat' : 'beats'}`
  );
  const statStatus = createElement('p', 'workspace-stat workspace-stat-status', selectedScene.draftStatus);
  stats.appendChild(statWords);
  stats.appendChild(statBeats);
  stats.appendChild(statStatus);
  headerLeft.appendChild(stats);

  const headerRight = createElement('div', 'workspace-header-right');
  const headerControls = createElement('div', 'workspace-header-controls');
  const beatsButton = createElement(
    'button',
    `button-toggle${state.ui.showBeats ? ' is-active' : ''}`,
    state.ui.showBeats ? 'Show manuscript' : 'Show beats'
  );
  beatsButton.addEventListener('click', () => actions.toggleBeats());
  headerControls.appendChild(beatsButton);

  const assistantButton = createElement(
    'button',
    `button-toggle${state.ui.showAssistant ? ' is-active' : ''}`,
    state.ui.showAssistant ? 'Hide assistant' : 'Show assistant'
  );
  assistantButton.addEventListener('click', () => actions.toggleAssistant());
  headerControls.appendChild(assistantButton);

  const undoButton = createElement('button', 'button-toggle', 'Undo');
  undoButton.addEventListener('click', () => actions.undo());
  if (undoStack.length === 0) {
    undoButton.disabled = true;
    undoButton.title = 'Nothing to undo yet.';
  } else {
    undoButton.title = 'Undo the last change.';
  }
  headerControls.appendChild(undoButton);
  headerRight.appendChild(headerControls);

  const quickActions = createElement('div', 'workspace-quick-actions');
  quickActions.appendChild(createQuickActionButton('Manual beats', () => actions.toggleBeats()));
  const isQuickScanRunning = Boolean(state.ui.scanStatus && state.ui.scanStatus.state === 'running');
  const codexProviderId = getProviderId('codex');
  const hasCodexKey = hasApiKeyFor(codexProviderId);
  const scanQuickButton = createQuickActionButton(isQuickScanRunning ? 'Scanning…' : 'Scan scene', () =>
    actions.startSceneScan(selectedScene.id)
  );
  if (isQuickScanRunning || !hasCodexKey) {
    scanQuickButton.disabled = true;
  }
  if (!hasCodexKey) {
    scanQuickButton.title = 'Add an API key for the Codex provider in Settings to enable scene scanning.';
  }
  quickActions.appendChild(scanQuickButton);
  headerRight.appendChild(quickActions);

  header.appendChild(headerLeft);
  header.appendChild(headerRight);
  shell.appendChild(header);

  const body = createElement('div', 'workspace-body');
  let editorTextarea = null;
  let refreshSceneIndicators = () => {
    const latestScene = state.scenes[selectedScene.id];
    if (!latestScene) {
      return;
    }
    const latestBeatCount = Array.isArray(latestScene.beats) ? latestScene.beats.length : 0;
    statWords.textContent = `${latestScene.wordCount} words`;
    statBeats.textContent = `${latestBeatCount} ${latestBeatCount === 1 ? 'beat' : 'beats'}`;
    statStatus.textContent = latestScene.draftStatus;
  };

  if (state.ui.showBeats) {
    const beatsView = createElement('div', 'workspace-beats-view');
    beatsView.appendChild(renderBeatList(selectedScene));
    body.appendChild(beatsView);
    refreshSceneIndicators = () => {
      const latestScene = state.scenes[selectedScene.id];
      if (!latestScene) {
        return;
      }
      const latestBeatCount = Array.isArray(latestScene.beats) ? latestScene.beats.length : 0;
      statWords.textContent = `${latestScene.wordCount} words`;
      statBeats.textContent = `${latestBeatCount} ${latestBeatCount === 1 ? 'beat' : 'beats'}`;
      statStatus.textContent = latestScene.draftStatus;
    };
  } else {
    const editor = createElement('div', 'workspace-editor');
    const editorHeader = createElement('div', 'editor-header');
    editorHeader.appendChild(createElement('h2', 'editor-title', selectedScene.title));
    const editorMeta = createElement('p', 'editor-meta', createSceneSummary(selectedScene));
    const editorUpdated = createElement('p', 'editor-updated', formatUpdatedAt(selectedScene.lastUpdated));
    editorHeader.appendChild(editorMeta);
    editorHeader.appendChild(editorUpdated);
    editor.appendChild(editorHeader);

    const textPanel = createElement('div', 'editor-panel');
    textPanel.appendChild(createElement('label', 'editor-label', 'Scene text'));
    const textarea = document.createElement('textarea');
    textarea.className = 'workspace-textarea';
    textarea.value = selectedScene.text;
    textarea.placeholder = 'Draft your scene here...';

    const syncFocus = () => {
      markEditorFocus(
        selectedScene.id,
        textarea.selectionStart,
        textarea.selectionEnd,
        textarea.scrollTop
      );
    };

    refreshSceneIndicators = () => {
      const latestScene = state.scenes[selectedScene.id];
      if (!latestScene) {
        return;
      }
      const latestBeatCount = Array.isArray(latestScene.beats) ? latestScene.beats.length : 0;
      statWords.textContent = `${latestScene.wordCount} words`;
      statBeats.textContent = `${latestBeatCount} ${latestBeatCount === 1 ? 'beat' : 'beats'}`;
      statStatus.textContent = latestScene.draftStatus;
      editorMeta.textContent = createSceneSummary(latestScene);
      editorUpdated.textContent = formatUpdatedAt(latestScene.lastUpdated);
    };

    textarea.addEventListener('input', (event) => {
      syncFocus();
      actions.updateSceneText(selectedScene.id, event.target.value);
      refreshSceneIndicators();
    });

    const updateSelection = () => {
      syncFocus();
      const start = textarea.selectionStart;
      const end = textarea.selectionEnd;
      if (Number.isInteger(start) && Number.isInteger(end) && end > start) {
        const snippet = textarea.value.slice(start, end);
        actions.setSelectionContext(selectedScene.id, start, end, snippet);
      } else {
        actions.clearSelectionContext();
      }
    };

    ['mouseup', 'keyup', 'select'].forEach((eventName) => {
      textarea.addEventListener(eventName, updateSelection);
    });

    textarea.addEventListener('scroll', syncFocus);
    textarea.addEventListener('focus', syncFocus);
    textarea.addEventListener('blur', () => {
      markEditorFocus(selectedScene.id, textarea.selectionStart, textarea.selectionEnd, textarea.scrollTop, {
        shouldFocus: false
      });
    });

    textPanel.appendChild(textarea);
    editor.appendChild(textPanel);

    body.appendChild(editor);
    editorTextarea = textarea;
  }

  body.appendChild(renderSceneScanStatus(selectedScene));

  shell.appendChild(body);
  root.appendChild(shell);

  if (editorTextarea) {
    restoreEditorFocusIfNeeded(editorTextarea, selectedScene.id);
    refreshSceneIndicators();
  }
}

function createQuickActionButton(label, onClick) {
  const button = createElement('button', 'button-ghost', label);
  button.addEventListener('click', onClick);
  return button;
}

function renderSceneScanStatus(scene) {
  const block = createElement('div', 'scan-status');
  block.appendChild(createElement('p', 'scan-status-title', 'Scene scan status'));

  const status = state.ui.scanStatus;
  if (!status || status.sceneId !== scene.id) {
    if (scene.lastScan) {
      const provider = AI_PROVIDERS.find((item) => item.id === scene.lastScan.providerId);
      const providerLabel = provider ? provider.label : scene.lastScan.providerId || 'Unknown provider';
      const completedAt = scene.lastScan.timestamp ? new Date(scene.lastScan.timestamp).toLocaleString() : 'Unknown time';
      block.appendChild(createElement('p', 'scan-status-detail', `Last scan completed ${completedAt}.`));
      block.appendChild(
        createElement(
          'p',
          'scan-status-detail',
          `Provider: ${providerLabel}. New entries: ${scene.lastScan.created || 0}. Updated entries: ${scene.lastScan.updated || 0}.`
        )
      );
      if (scene.lastScan.summary) {
        block.appendChild(createElement('p', 'scan-status-detail', `Scene notes: ${scene.lastScan.summary}`));
      }
      if (Array.isArray(scene.lastScan.entries) && scene.lastScan.entries.length > 0) {
        block.appendChild(
          createElement('p', 'scan-status-detail', `Affected codex entries: ${scene.lastScan.entries.join(', ')}`)
        );
      }
    } else {
      block.appendChild(createElement('p', 'scan-status-detail', 'No scan has run for this scene yet.'));
      block.appendChild(
        createElement('p', 'scan-status-detail', 'Use “Scan scene” to extract new Codex details from this draft.')
      );
    }
    return block;
  }

  if (status.state === 'running') {
    block.appendChild(
      createElement('p', 'scan-status-detail', status.detail || status.message || 'Scanning in progress…')
    );
    if (status.step) {
      block.appendChild(createElement('p', 'scan-status-detail', `Step: ${status.step}`));
    } else {
      block.appendChild(createElement('p', 'scan-status-detail', 'Chunking scene and preparing Codex updates.'));
    }
    return block;
  }

  if (status.state === 'error') {
    block.appendChild(createElement('p', 'scan-status-detail', 'Scan failed.'));
    block.appendChild(createElement('p', 'scan-status-detail', status.message || 'Unknown error.'));
    const retryButton = createElement('button', 'settings-secondary', 'Clear status');
    retryButton.addEventListener('click', () => actions.resetScanStatus());
    const actionsRow = createElement('div', 'settings-actions');
    actionsRow.appendChild(retryButton);
    block.appendChild(actionsRow);
    return block;
  }

  const providerId = status.providerId || getProviderId('codex');
  const provider = AI_PROVIDERS.find((item) => item.id === providerId);
  const providerLabel = provider ? provider.label : providerId;
  const completedAt = status.completedAt ? new Date(status.completedAt).toLocaleString() : 'just now';
  block.appendChild(createElement('p', 'scan-status-detail', `Last scan completed ${completedAt}.`));
  block.appendChild(createElement('p', 'scan-status-detail', `Provider: ${providerLabel}.`));
  if (status.message) {
    block.appendChild(createElement('p', 'scan-status-detail', status.message));
  }

  const resetButton = createElement('button', 'settings-secondary', 'Reset status');
  resetButton.addEventListener('click', () => actions.resetScanStatus());
  const actionsRow = createElement('div', 'settings-actions');
  actionsRow.appendChild(resetButton);
  block.appendChild(actionsRow);

  return block;
}

function buildOutlineSummary(appState) {
  if (!appState) {
    return '';
  }

  const lines = [];
  const acts = [...(appState.acts || [])].sort((a, b) => (a.order || 0) - (b.order || 0));
  acts.forEach((act, actIndex) => {
    const actLabel = act?.order || actIndex + 1;
    lines.push(`Act ${actLabel} (${act?.id || 'A?'}): ${act?.title || 'Untitled Act'}`);

    const chapters = (act?.chapterIds || [])
      .map((chapterId) => appState.chapters[chapterId])
      .filter(Boolean)
      .sort((a, b) => (a.order || 0) - (b.order || 0));

    chapters.forEach((chapter, chapterIndex) => {
      const chapterLabel = chapter?.order || chapterIndex + 1;
      lines.push(`  Chapter ${chapterLabel} (${chapter?.id || 'C?'}): ${chapter?.title || 'Untitled Chapter'}`);

      const scenes = (chapter?.sceneIds || [])
        .map((sceneId) => appState.scenes[sceneId])
        .filter(Boolean)
        .sort((a, b) => (a.order || 0) - (b.order || 0));

      scenes.forEach((scene, sceneIndex) => {
        const sceneLabel = scene?.order || sceneIndex + 1;
        const wordCount = scene?.wordCount || 0;
        const status = scene?.draftStatus || 'unknown';
        lines.push(
          `    Scene ${sceneLabel} (${scene?.id || 'S?'}): ${scene?.title || 'Untitled Scene'} (${wordCount} words · ${status})`
        );

        if (Array.isArray(scene?.beats) && scene.beats.length > 0) {
          const beats = [...scene.beats].sort((a, b) => (a.order || 0) - (b.order || 0));
          beats.forEach((beat, beatIndex) => {
            const beatLabel = beat?.order || beatIndex + 1;
            const summary = beat?.summary ? ` — ${beat.summary}` : '';
            lines.push(`      Beat ${beatLabel} (${beat?.id || 'B?'}): ${beat?.title || 'Untitled Beat'}${summary}`);
          });
        }
      });
    });
  });

  return lines.join('\n');
}

function buildBeatGenerationPrompt(appState, scene, options = {}) {
  if (!scene) {
    return '';
  }
  const lines = [
    `Generate 4-6 chronological beats for the scene "${scene.title || 'Untitled Scene'}".`,
    'Each beat should describe the change or turning point in 1-2 sentences.'
  ];

  if (options.outline) {
    lines.push('Outline snapshot:');
    lines.push(options.outline);
  }

  if (options.previousSummary) {
    lines.push(options.previousSummary);
  }
  if (options.nextSummary) {
    lines.push(options.nextSummary);
  }

  const trimmedSceneText =
    scene.text && scene.text.trim().length > 0
      ? scene.text.replace(/\s+/g, ' ').trim().slice(0, 600)
      : '';
  if (trimmedSceneText) {
    lines.push('Scene manuscript excerpt:');
    lines.push(`${trimmedSceneText}${scene.text.length > 600 ? '…' : ''}`);
  }

  if (options.selectionContext && options.selectionContext.text) {
    lines.push('Highlighted selection from the author:');
    lines.push(options.selectionContext.text);
  }

  if (options.userGuidance && options.userGuidance.trim().length > 0) {
    lines.push('Writer guidance:');
    lines.push(options.userGuidance.trim());
  }

  if (options.mentions && options.mentions.length > 0) {
    lines.push(`Focus on these mentions: ${options.mentions.join(', ')}`);
  }

  lines.push(
    'Return strictly valid JSON following {"beats":[{"title": string, "summary": string}]}.',
    'Do not include additional commentary or Markdown code fences.'
  );

  return lines.join('\n\n');
}

function extractJsonPayload(raw) {
  if (raw === null || raw === undefined) {
    throw new Error('Empty response from model');
  }
  if (typeof raw === 'object') {
    return raw;
  }
  if (typeof raw !== 'string') {
    return { beats: [] };
  }
  let content = raw.trim();
  if (content.startsWith('```')) {
    content = content.replace(/^```json/i, '').replace(/^```/, '').replace(/```$/, '').trim();
  }
  try {
    return JSON.parse(content);
  } catch (error) {
    const match = content.match(/\{[\s\S]*\}/);
    if (match) {
      return JSON.parse(match[0]);
    }
    throw error;
  }
}

function parseBeatGenerationResponse(sceneId, response) {
  const payload = extractJsonPayload(response);
  const beatsRaw = Array.isArray(payload?.beats) ? payload.beats : Array.isArray(payload) ? payload : [];
  if (!Array.isArray(beatsRaw) || beatsRaw.length === 0) {
    throw new Error('Beat generator returned no beats.');
  }
  const prepared = beatsRaw.map((beat, index) => ({
    id: beat?.id || nextBeatId(sceneId, index + 1),
    title:
      typeof beat?.title === 'string' && beat.title.trim().length > 0 ? beat.title.trim() : `Beat ${index + 1}`,
    summary: typeof beat?.summary === 'string' ? beat.summary.trim() : ''
  }));
  return normalizeBeats(sceneId, prepared);
}

function buildCodexSummary(appState, limit = 12) {
  if (!appState || !appState.codex || !appState.codex.entries) {
    return '';
  }
  const entries = Object.values(appState.codex.entries);
  if (entries.length === 0) {
    return '';
  }
  const sorted = entries
    .filter((entry) => entry && entry.name)
    .sort((a, b) => a.name.localeCompare(b.name))
    .slice(0, limit);
  return sorted
    .map((entry) => `- ${entry.name} (${entry.category || 'lore'}): ${entry.summary || 'No summary available.'}`)
    .join('\n');
}

function buildChatSystemPrompt(appState) {
  const lines = [
    'You are the SimpleWriter assistant. Use the provided outline, beats, and manuscript excerpts to stay grounded in the story world.',
    'Never invent new facts. Quote or paraphrase from the supplied context when referencing story details.',
    'When rewriting text, respond with the rewritten passage only unless commentary is explicitly requested.'
  ];

  const outline = buildOutlineSummary(appState);
  if (outline) {
    lines.push('Outline snapshot:', outline);
  }

  const selectedScene = appState.selectedSceneId ? appState.scenes[appState.selectedSceneId] : null;
  if (selectedScene) {
    lines.push(
      `Current scene (${selectedScene.id || 'S?'} · ${selectedScene.title || 'Untitled Scene'} — ${selectedScene.wordCount || 0} words):`,
      selectedScene.text || '(Scene is currently empty.)'
    );

    if (Array.isArray(selectedScene.beats) && selectedScene.beats.length > 0) {
      const beatLines = selectedScene.beats
        .slice()
        .sort((a, b) => (a.order || 0) - (b.order || 0))
        .map((beat, index) => `  • Beat ${beat.order || index + 1}: ${beat.title || 'Untitled Beat'}${beat.summary ? ` — ${beat.summary}` : ''}`)
        .join('\n');
      lines.push('Current scene beats:', beatLines);
    }

    const orderedSceneIds = getOrderedSceneIds(appState);
    const currentIndex = orderedSceneIds.indexOf(appState.selectedSceneId);
    if (currentIndex > 0) {
      const previousScene = appState.scenes[orderedSceneIds[currentIndex - 1]];
      if (previousScene) {
        lines.push(
          `Previous scene (${previousScene.id || 'S?'} · ${previousScene.title || 'Untitled Scene'}):`,
          previousScene.text || '(Scene is currently empty.)'
        );
      }
    }
    if (currentIndex >= 0 && currentIndex < orderedSceneIds.length - 1) {
      const nextScene = appState.scenes[orderedSceneIds[currentIndex + 1]];
      if (nextScene) {
        lines.push(
          `Next scene (${nextScene.id || 'S?'} · ${nextScene.title || 'Untitled Scene'}):`,
          nextScene.text || '(Scene is currently empty.)'
        );
      }
    }
  }

  if (appState.ui?.selectionContext && appState.ui.selectionContext.text) {
    lines.push('Highlighted selection from manuscript:', appState.ui.selectionContext.text);
  }

  const codexSummary = buildCodexSummary(appState);
  if (codexSummary) {
    lines.push('Codex highlights:', codexSummary);
  }

  return lines.join('\n\n');
}

function normalizeCodexCategory(value) {
  const normalized = typeof value === 'string' ? value.toLowerCase().trim() : '';
  if (normalized === 'character' || normalized === 'place' || normalized === 'item' || normalized === 'lore') {
    return normalized;
  }
  return 'lore';
}

function findCodexEntryIdByName(entries, name) {
  if (!name) {
    return null;
  }
  const target = name.trim().toLowerCase();
  for (const [id, entry] of Object.entries(entries)) {
    if (entry && entry.name && entry.name.trim().toLowerCase() === target) {
      return id;
    }
  }
  return null;
}

function detailExists(entry, detailText, sceneId, beatId) {
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

function groupCodexDetailsByScene(appState, details) {
  if (!appState || !Array.isArray(details) || details.length === 0) {
    return [];
  }
  const sceneOrderMap = new Map();
  const beatOrderMaps = new Map();
  getOrderedSceneIds(appState).forEach((sceneId, index) => {
    sceneOrderMap.set(sceneId, index);
    const scene = appState.scenes[sceneId];
    if (scene && Array.isArray(scene.beats)) {
      const beatMap = new Map();
      scene.beats
        .slice()
        .sort((a, b) => (a.order || 0) - (b.order || 0))
        .forEach((beat, beatIndex) => {
          beatMap.set(beat.id, beatIndex);
        });
      beatOrderMaps.set(sceneId, beatMap);
    }
  });

  const groups = new Map();
  details.forEach((detail) => {
    if (!detail || typeof detail.text !== 'string') {
      return;
    }
    const key = detail.sourceSceneId || 'general';
    if (!groups.has(key)) {
      groups.set(key, []);
    }
    const beatMap = detail.sourceSceneId ? beatOrderMaps.get(detail.sourceSceneId) : null;
    const beatOrder =
      beatMap && detail.sourceBeatId && beatMap.has(detail.sourceBeatId)
        ? beatMap.get(detail.sourceBeatId)
        : Number.MAX_SAFE_INTEGER;
    groups.get(key).push({ ...detail, beatOrder });
  });

  return Array.from(groups.entries())
    .map(([key, list]) => {
      const scene = key !== 'general' ? appState.scenes[key] : null;
      const order = key !== 'general' && sceneOrderMap.has(key) ? sceneOrderMap.get(key) : Number.MAX_SAFE_INTEGER;
      const sortedDetails = list
        .slice()
        .sort((a, b) => {
          if (a.beatOrder !== b.beatOrder) {
            return a.beatOrder - b.beatOrder;
          }
          const createdA = a.createdAt ? new Date(a.createdAt).getTime() : 0;
          const createdB = b.createdAt ? new Date(b.createdAt).getTime() : 0;
          if (createdA !== createdB) {
            return createdA - createdB;
          }
          return a.text.localeCompare(b.text);
        });
      return {
        key,
        scene,
        order,
        details: sortedDetails
      };
    })
    .sort((a, b) => {
      if (a.order !== b.order) {
        return a.order - b.order;
      }
      if (a.key === b.key) {
        return 0;
      }
      return a.key < b.key ? -1 : 1;
    });
}

function buildBeatLookup(appState) {
  const lookup = new Map();
  if (!appState || !appState.scenes) {
    return lookup;
  }
  Object.values(appState.scenes).forEach((scene) => {
    if (!scene || !scene.id || !Array.isArray(scene.beats)) {
      return;
    }
    scene.beats.forEach((beat, beatIndex) => {
      if (!beat || !beat.id) {
        return;
      }
      lookup.set(beat.id, {
        sceneId: scene.id,
        sceneTitle: scene.title || scene.id,
        order: typeof beat.order === 'number' ? beat.order : beatIndex + 1,
        title: beat.title || ''
      });
    });
  });
  return lookup;
}

function formatDetailMeta(appState, beatLookup, detail) {
  if (!detail) {
    return null;
  }
  if (detail.sourceBeatId) {
    const info = beatLookup.get(detail.sourceBeatId);
    if (info) {
      const parts = [];
      if (info.order !== null && info.order !== undefined) {
        parts.push(`Beat ${info.order}`);
      }
      if (info.title) {
        parts.push(info.title);
      }
      const label = parts.length > 0 ? parts.join(' · ') : detail.sourceBeatId;
      const sceneLabel = info.sceneTitle ? ` (${info.sceneTitle})` : '';
      return `Linked to ${label}${sceneLabel}`;
    }
    return `Linked to beat ${detail.sourceBeatId}`;
  }
  if (detail.sourceSceneId) {
    const scene = appState && appState.scenes ? appState.scenes[detail.sourceSceneId] : null;
    const sceneLabel = scene ? scene.title || detail.sourceSceneId : detail.sourceSceneId;
    return sceneLabel ? `Linked to ${sceneLabel}` : null;
  }
  return 'General note';
}

function getSceneAndBeatOrder(draftState, beatId) {
  if (!draftState || !beatId) {
    return { sceneIndex: Number.MAX_SAFE_INTEGER, beatIndex: Number.MAX_SAFE_INTEGER };
  }
  const orderedSceneIds = getOrderedSceneIds(draftState);
  for (let sceneIndex = 0; sceneIndex < orderedSceneIds.length; sceneIndex += 1) {
    const sceneId = orderedSceneIds[sceneIndex];
    const scene = draftState.scenes[sceneId];
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

function findSceneIdForBeat(draftState, beatId) {
  if (!draftState || !beatId) {
    return null;
  }
  for (const [sceneId, scene] of Object.entries(draftState.scenes || {})) {
    if (!scene || !Array.isArray(scene.beats)) {
      continue;
    }
    if (scene.beats.some((beat) => beat.id === beatId)) {
      return scene.id || sceneId;
    }
  }
  return null;
}

function resolveBeatIdForScene(scene, hint) {
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
    Number.isFinite(hint.beatNumber) ? hint.beatNumber
      : Number.isFinite(hint.order) ? hint.order
      : Number.isFinite(hint.index) ? hint.index + 1
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

function normalizeDetailItems(rawDetails, defaultSceneId) {
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
      if (!text) {
        return null;
      }
      return {
        text,
        sceneId: typeof item.sceneId === 'string' && item.sceneId.length > 0 ? item.sceneId : defaultSceneId,
        beatId: typeof item.beatId === 'string' && item.beatId.length > 0 ? item.beatId : null,
        beatTitle: typeof item.beatTitle === 'string' ? item.beatTitle.trim() : null,
        beatNumber: Number.isFinite(item.beatNumber) ? item.beatNumber : Number.isFinite(item.order) ? item.order : null
      };
    })
    .filter(Boolean);
}

function normalizeBackgroundUpdates(rawBackground, defaultSceneId) {
  if (!rawBackground || typeof rawBackground !== 'object') {
    return [];
  }
  const updates = [];
  CHARACTER_BACKGROUND_FIELDS.forEach((field) => {
    if (!Object.prototype.hasOwnProperty.call(rawBackground, field)) {
      return;
    }
    const value = rawBackground[field];
    if (value === null || value === undefined) {
      return;
    }
    if (typeof value === 'string') {
      const trimmed = value.trim();
      if (trimmed.length > 0) {
        updates.push({
          field,
          value: trimmed,
          sceneId: defaultSceneId,
          beatId: null,
          beatTitle: null,
          beatNumber: null
        });
      }
      return;
    }
    if (typeof value === 'number') {
      const text = String(value).trim();
      if (text.length > 0) {
        updates.push({
          field,
          value: text,
          sceneId: defaultSceneId,
          beatId: null,
          beatTitle: null,
          beatNumber: null
        });
      }
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
        beatNumber: Number.isFinite(value.beatNumber) ? value.beatNumber : Number.isFinite(value.order) ? value.order : null
      });
    }
  });
  return updates;
}

function normalizeCoreUpdates(rawCore, defaultSceneId) {
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

function applyBackgroundUpdatesToEntry(entry, updates, draftState, fallbackSceneId, options = {}) {
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
    const scene = sceneId ? draftState.scenes[sceneId] || null : null;
    const beatId = resolveBeatIdForScene(scene, update);
    const text = `Background · ${label}: ${value}`;
    if (!detailExists(entry, text, sceneId, beatId)) {
      entry.details.push(createCodexDetail(text, sceneId, beatId));
      mutated = true;
    }
  });
  return mutated;
}

function applyCoreUpdatesToEntry(entry, updates, draftState, fallbackSceneId) {
  if (!entry || entry.category !== 'character' || !Array.isArray(updates) || updates.length === 0) {
    return false;
  }
  if (!entry.core) {
    entry.core = createCharacterCoreSections(entry.core);
  }
  let mutated = false;
  updates.forEach((update) => {
    if (
      !update ||
      !CHARACTER_CORE_SECTION_KEYS.includes(update.section) ||
      typeof update.text !== 'string'
    ) {
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
    const scene = sceneId ? draftState.scenes[sceneId] || null : null;
    const beatId = resolveBeatIdForScene(scene, update);

    const existingByBeat = beatId
      ? list.find((item) => item && item.sourceBeatId === beatId)
      : null;
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

function applyCodexUpdates(draft, sceneId, updates) {
  const result = { created: 0, updated: 0 };
  if (!Array.isArray(updates) || updates.length === 0) {
    return result;
  }

  if (!draft.codex.entries || typeof draft.codex.entries !== 'object') {
    draft.codex.entries = {};
  }

  const currentScene = sceneId ? draft.scenes[sceneId] || null : null;

  updates.forEach((update) => {
    if (!update || typeof update.name !== 'string') {
      return;
    }
    const name = update.name.trim();
    if (name.length === 0) {
      return;
    }

    const category = normalizeCodexCategory(update.category);
    const summary = typeof update.summary === 'string' ? update.summary.trim() : '';
    const detailItems = normalizeDetailItems(Array.isArray(update.details) ? update.details : [], sceneId);
    const backgroundUpdates =
      category === 'character' ? normalizeBackgroundUpdates(update.background || {}, sceneId) : [];
    const coreUpdates = category === 'character' ? normalizeCoreUpdates(update.core || {}, sceneId) : [];

    const existingId = findCodexEntryIdByName(draft.codex.entries, name);
    if (existingId) {
      const entry = draft.codex.entries[existingId];
      let entryMutated = false;

      if (summary.length > 0 && entry.summary !== summary) {
        entry.summary = summary;
        entryMutated = true;
      }

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
        const targetScene = targetSceneId ? draft.scenes[targetSceneId] || null : currentScene;
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
        summary: summary || '',
        details: []
      };
      detailItems.forEach((detail) => {
        if (!detail || typeof detail.text !== 'string' || detail.text.length === 0) {
          return;
        }
        const targetSceneId = detail.sceneId || sceneId;
        const targetScene = targetSceneId ? draft.scenes[targetSceneId] || null : currentScene;
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

  return result;
}

function renderBeatList(scene) {
  const container = createElement('div', 'beat-list');
  const header = createElement('div', 'beat-header');
  const textWrapper = document.createElement('div');
  textWrapper.appendChild(createElement('h3', 'beat-title', 'Beats'));
  textWrapper.appendChild(
    createElement('p', 'beat-subtitle', 'Structure your scene progression')
  );
  header.appendChild(textWrapper);
  const addBeatButton = createElement('button', 'button-outline', '+ Beat');
  addBeatButton.addEventListener('click', () => actions.addBeat(scene.id, `Beat ${scene.beats.length + 1}`));
  header.appendChild(addBeatButton);
  container.appendChild(header);

  const list = createElement('ul', 'beat-items');
  list.dataset.dropType = 'beat-end';
  list.dataset.sceneId = scene.id;
  list.addEventListener('dragenter', handleDragOver);
  list.addEventListener('dragover', handleDragOver);
  list.addEventListener('drop', handleDrop);
  list.addEventListener('dragleave', handleDragLeave);
  if (scene.beats.length === 0) {
    list.appendChild(
      createElement(
        'li',
        'beat-empty',
        'No beats yet. Use “Generate beats” in the assistant or add beats manually to guide your drafting.'
      )
    );
  } else {
    scene.beats.forEach((beat) => {
      const item = createElement('li', 'beat-item');
      item.draggable = true;
      item.dataset.dragType = 'beat';
      item.dataset.sceneId = scene.id;
      item.dataset.beatId = beat.id;
      item.dataset.dropType = 'beat';
      item.addEventListener('dragstart', handleDragStart);
      item.addEventListener('dragend', handleDragEnd);
      item.addEventListener('dragenter', handleDragOver);
      item.addEventListener('dragover', handleDragOver);
      item.addEventListener('drop', handleDrop);
      item.addEventListener('dragleave', handleDragLeave);
      const beatHeader = createElement('div', 'beat-item-header');
      beatHeader.appendChild(createElement('p', 'beat-item-label', `Beat ${beat.order}`));
      const deleteBeatButton = createElement('button', 'button-icon button-icon-danger beat-delete', '🗑');
      deleteBeatButton.title = 'Delete beat';
      deleteBeatButton.addEventListener('click', (event) => {
        event.stopPropagation();
        const label = beat.title ? `Delete beat "${beat.title}"?` : 'Delete this beat?';
        if (window.confirm(label)) {
          actions.deleteBeat(scene.id, beat.id);
        }
      });
      deleteBeatButton.addEventListener('mousedown', (event) => event.stopPropagation());
      beatHeader.appendChild(deleteBeatButton);
      item.appendChild(beatHeader);
      item.appendChild(createElement('p', 'beat-item-title', beat.title));
      if (beat.summary) {
        item.appendChild(createElement('p', 'beat-item-summary', beat.summary));
      }
      list.appendChild(item);
    });
  }
  container.appendChild(list);

  return container;
}

function renderAssistantPanel() {
  const panel = createElement('div', 'assistant-panel');

  const providerId = getProviderId('assistant');
  const provider = AI_PROVIDERS.find((item) => item.id === providerId);
  const providerLabel = provider ? provider.label : 'Provider not selected';
  const hasAssistantApiKey = hasApiKeyFor(providerId);

  const header = createElement('div', 'assistant-header');
  const headerRow = createElement('div', 'assistant-header-row');
  const titleGroup = createElement('div', 'assistant-title-group');
  titleGroup.appendChild(createElement('h3', 'assistant-title', 'AI Assistant'));
  titleGroup.appendChild(createElement('span', 'assistant-provider', providerLabel));
  headerRow.appendChild(titleGroup);

  const headerActions = createElement('div', 'assistant-header-actions');
  const hasAnyChatHistory = state.chat && Array.isArray(state.chat.messages) && state.chat.messages.length > 0;
  const clearChatButton = createElement('button', 'assistant-clear', 'Clear chat');
  clearChatButton.type = 'button';
  if (!hasAnyChatHistory && !(state.ui.chatInput && state.ui.chatInput.trim().length > 0)) {
    clearChatButton.disabled = true;
  } else {
    clearChatButton.addEventListener('click', () => actions.clearChatHistory());
  }
  headerActions.appendChild(clearChatButton);
  headerRow.appendChild(headerActions);
  header.appendChild(headerRow);
  header.appendChild(
    createElement(
      'p',
      'assistant-caption',
      'Context includes outline, neighbouring scenes, highlighted manuscript text, and recent chat mentions.'
    )
  );
  panel.appendChild(header);

  const selectionContextState = state.ui.selectionContext;
  const selectionContext =
    selectionContextState && selectionContextState.text ? selectionContextState : null;
  const thread = createElement('div', 'assistant-thread');
  const messages = state.chat && Array.isArray(state.chat.messages) ? state.chat.messages : [];
  if (messages.length === 0) {
    thread.appendChild(createElement('p', 'assistant-hint', 'No messages yet. Ask for help to start the conversation.'));
  }

  const canApplyMessages =
    selectionContextState && selectionContextState.sceneId && selectionContextState.sceneId === state.selectedSceneId;

  messages.forEach((message) => {
    const bubble = createElement('div', `assistant-message assistant-message-${message.role}`);
    bubble.appendChild(createElement('p', 'assistant-message-text', message.content));
    const meta = createElement(
      'p',
      'assistant-message-meta',
      new Date(message.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    );
    bubble.appendChild(meta);
    if (
      message.role === 'assistant' &&
      canApplyMessages &&
      typeof message.content === 'string' &&
      message.content.trim().length > 0
    ) {
      const actionsRow = createElement('div', 'assistant-message-actions');
      const applyButton = createElement('button', 'assistant-apply', 'Apply to manuscript');
      applyButton.addEventListener('click', () => actions.applyAssistantSuggestion(message.id));
      actionsRow.appendChild(applyButton);
      bubble.appendChild(actionsRow);
    }
    thread.appendChild(bubble);
  });
  thread.scrollTop = thread.scrollHeight;
  panel.appendChild(thread);

  const chatState = state.ui.chat || { isSending: false, error: null };
  const selectedScene = state.selectedSceneId ? state.scenes[state.selectedSceneId] : null;
  const isShowBeats = Boolean(state.ui.showBeats);
  const sceneHasBeats = selectedScene && Array.isArray(selectedScene.beats) && selectedScene.beats.length > 0;
  const canGenerateBeats = Boolean(selectedScene && isShowBeats && !sceneHasBeats);

  if (chatState.error) {
    panel.appendChild(createElement('p', 'assistant-error', chatState.error));
  }

  let contextBlock = null;
  if (selectionContext) {
    contextBlock = createElement('div', 'assistant-context');
    const snippet =
      selectionContext.text.length > 200 ? `${selectionContext.text.slice(0, 197)}…` : selectionContext.text;
    contextBlock.appendChild(createElement('p', 'assistant-context-label', 'Selected text'));
    contextBlock.appendChild(createElement('p', 'assistant-context-text', snippet));
    const contextActions = createElement('div', 'assistant-context-actions');
    const clearButton = createElement('button', 'assistant-context-clear', 'Clear selection');
    clearButton.addEventListener('click', () => actions.clearSelectionContext());
    contextActions.appendChild(clearButton);
    contextBlock.appendChild(contextActions);
  }

  const form = document.createElement('form');
  form.className = 'assistant-form';
  form.addEventListener('submit', (event) => {
    event.preventDefault();
    actions.sendChatMessage();
  });

  const input = document.createElement('textarea');
  input.className = 'assistant-input';
  input.placeholder = 'Ask for revisions, summaries, or Codex updates…';
  input.value = state.ui.chatInput;
  input.rows = 3;
  input.addEventListener('input', (event) => {
    markChatInputFocus(input.selectionStart, input.selectionEnd);
    actions.setChatInput(event.target.value);
  });
  input.addEventListener('focus', () => {
    markChatInputFocus(input.selectionStart, input.selectionEnd);
  });
  input.addEventListener('blur', () => {
    if (suppressChatBlurClear) {
      return;
    }
    clearChatInputFocus();
  });
  ['keyup', 'select'].forEach((eventName) => {
    input.addEventListener(eventName, () => {
      markChatInputFocus(input.selectionStart, input.selectionEnd);
    });
  });
  if (chatState.isSending) {
    input.setAttribute('readonly', 'readonly');
  } else {
    input.removeAttribute('readonly');
  }
  form.appendChild(input);

  const controls = createElement('div', 'assistant-controls');
  const sendButton = createElement('button', 'assistant-send', chatState.isSending ? 'Sending…' : 'Send');
  sendButton.type = 'submit';
  sendButton.disabled = chatState.isSending || (state.ui.chatInput || '').trim().length === 0;
  controls.appendChild(sendButton);

  if (canGenerateBeats) {
    const generateButton = createElement(
      'button',
      'assistant-generate',
      state.ui.generatingBeats ? 'Generating…' : 'Generate beats'
    );
    generateButton.type = 'button';
    generateButton.disabled = state.ui.generatingBeats || chatState.isSending || !hasAssistantApiKey;
    generateButton.title = hasAssistantApiKey
      ? 'Create beats for this scene using the outline, surrounding scenes, and any mentions in your prompt.'
      : 'Add an API key for the writing provider in Settings to enable beat generation.';
    generateButton.addEventListener('click', () => actions.generateSceneBeats(selectedScene.id));
    controls.appendChild(generateButton);
  }

  if (state.ui.generatingBeats) {
    controls.appendChild(createElement('span', 'assistant-status', 'Generating beats…'));
  }

  form.appendChild(controls);
  if (contextBlock) {
    panel.appendChild(contextBlock);
  }
  panel.appendChild(form);
  if (!chatState.isSending) {
    restoreChatInputFocus(input);
  } else {
    clearChatInputFocus();
  }

  return panel;
}

function renderAssistant() {
  if (!assistantRoot) {
    return;
  }
  assistantRoot.innerHTML = '';

  if (!state) {
    assistantRoot.appendChild(createElement('div', 'panel-loading', 'Loading assistant…'));
    return;
  }

  if (!state.ui.showAssistant) {
    assistantRoot.appendChild(
      createElement('div', 'assistant-hidden', 'Assistant hidden. Use “Show assistant” to reopen.')
    );
    return;
  }

  assistantRoot.appendChild(renderAssistantPanel());
}

function createSceneLocation(scene) {
  const chapter = state.chapters[scene.chapterId];
  const act = chapter ? state.acts.find((item) => item.id === chapter.actId) : null;
  const parts = [];
  if (act) {
    parts.push(act.title);
  }
  if (chapter) {
    parts.push(chapter.title);
  }
  return parts.join(' › ');
}

function createSceneSummary(scene) {
  const beats = scene.beats.length;
  const words = scene.wordCount;
  const beatsLabel = `${beats} ${beats === 1 ? 'beat' : 'beats'}`;
  const wordsLabel = `${words} ${words === 1 ? 'word' : 'words'}`;
  return `${beatsLabel} · ${wordsLabel} · ${scene.draftStatus}`;
}

function formatUpdatedAt(value) {
  if (!value) {
    return 'Last updated: not yet saved';
  }
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    return 'Last updated: not yet saved';
  }
  return `Last updated ${parsed.toLocaleString()}`;
}

function renderCodexView() {
  const root = mainRoot;
  if (!root) {
    return;
  }
  root.innerHTML = '';

  if (!state) {
    root.appendChild(createElement('div', 'panel-loading', 'Loading codex…'));
    return;
  }

  const container = createElement('div', 'codex-full');
  const header = createElement('header', 'codex-main-header');
  const headerText = document.createElement('div');
  headerText.appendChild(createElement('h2', 'codex-title', 'Codex'));
  headerText.appendChild(
    createElement('p', 'codex-subtitle', 'Track characters, places, items, and lore from your manuscript.')
  );
  header.appendChild(headerText);

  const headerActions = createElement('div', 'codex-main-header-actions');
  const addEntryButton = createElement('button', 'button-outline', '+ Entry');
  addEntryButton.addEventListener('click', () => {
    const name = window.prompt('New Codex entry name');
    if (!name) {
      return;
    }
    const categoryInput = window.prompt('Entry category (character, place, item, lore)', 'character');
    actions.addCodexEntry(name, categoryInput || 'character');
  });
  headerActions.appendChild(addEntryButton);
  header.appendChild(headerActions);
  container.appendChild(header);

  const body = createElement('div', 'codex-main-body');

  const sidebar = createElement('aside', 'codex-main-sidebar');
  const grouped = groupCodexEntries();
  const categoryKeys = Object.keys(grouped);
  if (categoryKeys.length === 0) {
    sidebar.appendChild(createElement('p', 'codex-empty', 'No entries yet. Add details as you write.'));
  } else {
    categoryKeys
      .sort((a, b) => (CATEGORY_LABELS[a] || a).localeCompare(CATEGORY_LABELS[b] || b))
      .forEach((category) => {
        const section = createElement('section', 'codex-category');
        section.appendChild(createElement('h3', 'codex-category-title', CATEGORY_LABELS[category] || category));
        const list = createElement('ul', 'codex-entry-list');
        grouped[category]
          .slice()
          .sort((a, b) => a.name.localeCompare(b.name))
          .forEach((entry) => {
            const item = document.createElement('li');
            const button = createElement(
              'button',
              `codex-entry-button${state.codex.selectedId === entry.id ? ' is-active' : ''}`,
              entry.name
            );
            button.addEventListener('click', () => actions.selectCodexEntry(entry.id));
            item.appendChild(button);
            list.appendChild(item);
          });
        section.appendChild(list);
        sidebar.appendChild(section);
      });
  }
  body.appendChild(sidebar);

  const content = createElement('div', 'codex-main-content');
  const selectedEntry = state.codex.selectedId ? state.codex.entries[state.codex.selectedId] : null;
  if (!selectedEntry) {
    content.appendChild(createElement('div', 'codex-placeholder', 'Select a Codex entry to view details.'));
  } else {
    const entryWrapper = createElement('div', 'codex-entry');

    const titleRow = createElement('div', 'codex-entry-title-row');
    titleRow.appendChild(createElement('h3', 'codex-entry-name', selectedEntry.name));
    const titleActions = createElement('div', 'codex-entry-actions');
    const renameButton = createElement('button', 'button-icon', '✎');
    renameButton.title = 'Rename entry';
    renameButton.addEventListener('click', () => {
      const nextName = window.prompt('Rename entry', selectedEntry.name);
      if (nextName !== null) {
        actions.renameCodexEntry(selectedEntry.id, nextName);
      }
    });
    titleActions.appendChild(renameButton);

    const deleteButton = createElement('button', 'codex-delete-button', 'Delete');
    deleteButton.addEventListener('click', () => {
      if (window.confirm('Delete this Codex entry? This cannot be undone.')) {
        actions.deleteCodexEntry(selectedEntry.id);
      }
    });
    titleActions.appendChild(deleteButton);
    titleRow.appendChild(titleActions);
    entryWrapper.appendChild(titleRow);

    const categoryRow = createElement('div', 'codex-entry-category-row');
    categoryRow.appendChild(createElement('label', 'codex-entry-label', 'Category'));
    const categorySelect = document.createElement('select');
    categorySelect.className = 'codex-entry-select';
    Object.keys(CATEGORY_LABELS).forEach((key) => {
      const option = document.createElement('option');
      option.value = key;
      option.textContent = CATEGORY_LABELS[key] || key;
      categorySelect.appendChild(option);
    });
    categorySelect.value = selectedEntry.category;
    categorySelect.addEventListener('change', (event) => {
      actions.updateCodexCategory(selectedEntry.id, event.target.value);
    });
    categoryRow.appendChild(categorySelect);
    entryWrapper.appendChild(categoryRow);

    const summarySection = createElement('section', 'codex-summary-section');
    summarySection.appendChild(createElement('label', 'codex-summary-label', 'Summary'));
    const summaryArea = document.createElement('textarea');
    summaryArea.className = 'codex-summary-textarea';
    summaryArea.placeholder = 'Write a short description that captures the essence of this entry.';
    summaryArea.value = selectedEntry.summary || '';
    summaryArea.addEventListener('blur', (event) => {
      actions.updateCodexSummary(selectedEntry.id, event.target.value);
    });
    summarySection.appendChild(summaryArea);
    entryWrapper.appendChild(summarySection);

    if (selectedEntry.category === 'character') {
      entryWrapper.appendChild(renderCharacterCoreSections(selectedEntry));
      entryWrapper.appendChild(renderCharacterDynamicSection(selectedEntry, state));
    } else {
      entryWrapper.appendChild(renderGenericCodexDetailsSection(selectedEntry, state));
    }

    content.appendChild(entryWrapper);
  }

  body.appendChild(content);
  container.appendChild(body);
  root.appendChild(container);
}

function populateSceneOptions(selectElement, orderedSceneIds, appState, includeGeneral = true) {
  if (!selectElement) {
    return;
  }
  selectElement.innerHTML = '';
  if (includeGeneral) {
    const generalOption = document.createElement('option');
    generalOption.value = '';
    generalOption.textContent = 'General';
    selectElement.appendChild(generalOption);
  }
  orderedSceneIds.forEach((sceneId) => {
    const scene = appState.scenes[sceneId];
    const option = document.createElement('option');
    option.value = sceneId;
    option.textContent = `${sceneId} · ${(scene && scene.title) || 'Untitled Scene'}`;
    selectElement.appendChild(option);
  });
}

function renderCharacterCoreSections(entry) {
  const coreSection = createElement('section', 'codex-character-section');
  coreSection.appendChild(createElement('h4', 'codex-section-title', 'Core Info'));

  const backgroundBlock = createElement('div', 'codex-background-block');
  backgroundBlock.appendChild(createElement('h5', 'codex-subsection-title', 'Background Info'));
  const grid = createElement('div', 'codex-background-grid');
  const background = entry.background && typeof entry.background === 'object' ? entry.background : createCharacterBackground();
  CHARACTER_BACKGROUND_FIELDS.forEach((field) => {
    const fieldWrapper = createElement('div', 'codex-background-field');
    fieldWrapper.appendChild(
      createElement('label', 'codex-background-label', `${CHARACTER_BACKGROUND_LABELS[field]}:`)
    );
    const input = document.createElement('input');
    input.className = 'codex-background-input';
    input.placeholder = CHARACTER_BACKGROUND_LABELS[field];
    input.value = background[field] || '';
    input.addEventListener('change', (event) => {
      actions.updateCodexBackgroundField(entry.id, field, event.target.value);
    });
    fieldWrapper.appendChild(input);
    grid.appendChild(fieldWrapper);
  });
  backgroundBlock.appendChild(grid);
  coreSection.appendChild(backgroundBlock);

  const core = entry.core && typeof entry.core === 'object' ? entry.core : createCharacterCoreSections();
  const beatLookup = buildBeatLookup(state);
  CHARACTER_CORE_SECTION_KEYS.forEach((sectionKey) => {
    const subsection = createElement('div', 'codex-core-section');
    const header = createElement('div', 'codex-core-header');
    header.appendChild(createElement('h5', 'codex-subsection-title', CHARACTER_CORE_SECTION_LABELS[sectionKey]));
    const addButton = createElement('button', 'button-outline', '+ Bullet');
    addButton.addEventListener('click', () => actions.addCodexCoreDetail(entry.id, sectionKey));
    header.appendChild(addButton);
    subsection.appendChild(header);

    const list = Array.isArray(core[sectionKey]) ? core[sectionKey] : [];
    if (list.length === 0) {
      subsection.appendChild(createElement('p', 'codex-core-empty', 'No notes captured yet.'));
    } else {
      const listContainer = createElement('div', 'codex-core-list');
      list.forEach((item) => {
        const itemRow = createElement('div', 'codex-core-item');
        const itemBody = createElement('div', 'codex-core-item-body');
        const textarea = document.createElement('textarea');
        textarea.className = 'codex-core-textarea';
        textarea.placeholder = 'Add detail…';
        textarea.value = item.text || '';
        textarea.addEventListener('blur', (event) => {
          actions.updateCodexCoreDetail(entry.id, sectionKey, item.id, event.target.value);
        });
        itemBody.appendChild(textarea);

        const removeButton = createElement('button', 'codex-core-remove', 'Remove');
        removeButton.addEventListener('click', () => actions.removeCodexCoreDetail(entry.id, sectionKey, item.id));
        itemBody.appendChild(removeButton);
        itemRow.appendChild(itemBody);

        const metaLabel = (item.sourceBeatId || item.sourceSceneId)
          ? formatDetailMeta(state, beatLookup, item)
          : null;
        if (metaLabel) {
          itemRow.appendChild(createElement('p', 'codex-core-meta', metaLabel));
        }

        listContainer.appendChild(itemRow);
      });
      subsection.appendChild(listContainer);
    }
    coreSection.appendChild(subsection);
  });

  return coreSection;
}

function renderCharacterDynamicSection(entry, appState) {
  const dynamicSection = createElement('section', 'codex-character-section');
  dynamicSection.appendChild(createElement('h4', 'codex-section-title', 'Dynamic Info'));

  const addRow = createElement('div', 'codex-dynamic-add-row');
  const addLabel = createElement('label', 'codex-entry-label', 'Add note for scene');
  addRow.appendChild(addLabel);
  const sceneSelect = document.createElement('select');
  sceneSelect.className = 'codex-dynamic-select';
  const orderedSceneIds = getOrderedSceneIds(appState);
  populateSceneOptions(sceneSelect, orderedSceneIds, appState, true);
  addRow.appendChild(sceneSelect);
  const addButton = createElement('button', 'button-outline', 'Add note');
  addButton.addEventListener('click', () => {
    const sceneId = sceneSelect.value || null;
    actions.addCodexDetail(entry.id, sceneId);
    sceneSelect.value = '';
  });
  addRow.appendChild(addButton);
  dynamicSection.appendChild(addRow);

  const groups = groupCodexDetailsByScene(appState, entry.details || []);
  if (groups.length === 0) {
    dynamicSection.appendChild(createElement('p', 'codex-dynamic-empty', 'No scene-linked notes yet.'));
    return dynamicSection;
  }

  const beatLookup = buildBeatLookup(appState);

  groups.forEach((group) => {
    const detailGroup = document.createElement('details');
    detailGroup.className = 'codex-dynamic-group';
    if (group.key === 'general' || group.details.some((detail) => !detail.text || detail.text.trim().length === 0)) {
      detailGroup.open = true;
    }
    const summary = document.createElement('summary');
    summary.className = 'codex-dynamic-summary';
    if (group.key === 'general') {
      summary.textContent = `General notes (${group.details.length})`;
    } else {
      const sceneLabel = group.scene ? group.scene.title || group.scene.id : group.key;
      summary.textContent = `${sceneLabel} (${group.details.length})`;
    }
    detailGroup.appendChild(summary);

    const itemsContainer = createElement('div', 'codex-dynamic-items');
    group.details.forEach((detail) => {
      const itemRow = createElement('div', 'codex-dynamic-item');
      const textarea = document.createElement('textarea');
      textarea.className = 'codex-dynamic-textarea';
      textarea.placeholder = 'Scene-specific detail…';
      textarea.value = detail.text || '';
      textarea.addEventListener('blur', (event) => {
        actions.updateCodexDetail(entry.id, detail.id, { text: event.target.value });
      });
      itemRow.appendChild(textarea);

      const controls = createElement('div', 'codex-dynamic-controls');
      const select = document.createElement('select');
      select.className = 'codex-dynamic-select';
      populateSceneOptions(select, orderedSceneIds, appState, true);
      select.value = detail.sourceSceneId || '';
      select.addEventListener('change', (event) => {
        const newSceneId = event.target.value || null;
        actions.updateCodexDetail(entry.id, detail.id, { sourceSceneId: newSceneId });
      });
      controls.appendChild(select);

      const sceneIdForDetail = detail.sourceSceneId || (group.key !== 'general' ? group.key : null);
      const sceneForBeat = sceneIdForDetail ? appState.scenes[sceneIdForDetail] || null : null;
      if (sceneForBeat && Array.isArray(sceneForBeat.beats) && sceneForBeat.beats.length > 0) {
        const beatSelect = document.createElement('select');
        beatSelect.className = 'codex-dynamic-select codex-dynamic-select-beat';
        const noneOption = document.createElement('option');
        noneOption.value = '';
        noneOption.textContent = 'Link beat';
        beatSelect.appendChild(noneOption);
        sceneForBeat.beats
          .slice()
          .sort((a, b) => (a.order || 0) - (b.order || 0))
          .forEach((beat) => {
            const option = document.createElement('option');
            option.value = beat.id;
            const parts = [];
            if (typeof beat.order === 'number') {
              parts.push(`Beat ${beat.order}`);
            }
            if (beat.title && beat.title.trim().length > 0) {
              parts.push(beat.title.trim());
            }
            option.textContent = parts.length > 0 ? parts.join(' · ') : beat.id;
            beatSelect.appendChild(option);
          });
        beatSelect.value = detail.sourceBeatId || '';
        beatSelect.addEventListener('change', (event) => {
          const beatValue = event.target.value || null;
          actions.updateCodexDetail(entry.id, detail.id, { sourceBeatId: beatValue });
        });
        controls.appendChild(beatSelect);
      }

      const removeButton = createElement('button', 'codex-dynamic-remove', 'Remove');
      removeButton.addEventListener('click', () => actions.removeCodexDetail(entry.id, detail.id));
      controls.appendChild(removeButton);

      itemRow.appendChild(controls);

      const detailForMeta =
        detail.sourceSceneId || group.key === 'general'
          ? detail
          : { ...detail, sourceSceneId: group.key };
      const metaLabel = formatDetailMeta(appState, beatLookup, detailForMeta);
      if (metaLabel) {
        itemRow.appendChild(createElement('p', 'codex-dynamic-meta', metaLabel));
      }

      itemsContainer.appendChild(itemRow);
    });

    const footer = createElement('div', 'codex-dynamic-footer');
    const addNoteButton = createElement('button', 'button-outline', '+ Note');
    addNoteButton.addEventListener('click', () =>
      actions.addCodexDetail(entry.id, group.key === 'general' ? null : group.key)
    );
    footer.appendChild(addNoteButton);
    itemsContainer.appendChild(footer);

    detailGroup.appendChild(itemsContainer);
    dynamicSection.appendChild(detailGroup);
  });

  return dynamicSection;
}

function renderGenericCodexDetailsSection(entry, appState) {
  const section = createElement('section', 'codex-generic-section');
  section.appendChild(createElement('h4', 'codex-section-title', 'Details'));

  const orderedSceneIds = getOrderedSceneIds(appState);
  const list = entry.details && Array.isArray(entry.details) ? entry.details : [];
  const beatLookup = buildBeatLookup(appState);

  if (list.length === 0) {
    section.appendChild(createElement('p', 'codex-generic-empty', 'No notes recorded yet.'));
  } else {
    const listContainer = createElement('div', 'codex-generic-list');
    list.forEach((detail) => {
      const item = createElement('div', 'codex-generic-item');
      const textarea = document.createElement('textarea');
      textarea.className = 'codex-generic-textarea';
      textarea.placeholder = 'Detail text…';
      textarea.value = detail.text || '';
      textarea.addEventListener('blur', (event) => {
        actions.updateCodexDetail(entry.id, detail.id, { text: event.target.value });
      });
      item.appendChild(textarea);

      const controls = createElement('div', 'codex-generic-controls');
      const select = document.createElement('select');
      select.className = 'codex-dynamic-select';
      populateSceneOptions(select, orderedSceneIds, appState, true);
      select.value = detail.sourceSceneId || '';
      select.addEventListener('change', (event) => {
        const newSceneId = event.target.value || null;
        actions.updateCodexDetail(entry.id, detail.id, { sourceSceneId: newSceneId });
      });
      controls.appendChild(select);

      const sceneForBeat = detail.sourceSceneId ? appState.scenes[detail.sourceSceneId] || null : null;
      if (sceneForBeat && Array.isArray(sceneForBeat.beats) && sceneForBeat.beats.length > 0) {
        const beatSelect = document.createElement('select');
        beatSelect.className = 'codex-dynamic-select codex-dynamic-select-beat';
        const noneOption = document.createElement('option');
        noneOption.value = '';
        noneOption.textContent = 'Link beat';
        beatSelect.appendChild(noneOption);
        sceneForBeat.beats
          .slice()
          .sort((a, b) => (a.order || 0) - (b.order || 0))
          .forEach((beat) => {
            const option = document.createElement('option');
            option.value = beat.id;
            const parts = [];
            if (typeof beat.order === 'number') {
              parts.push(`Beat ${beat.order}`);
            }
            if (beat.title && beat.title.trim().length > 0) {
              parts.push(beat.title.trim());
            }
            option.textContent = parts.length > 0 ? parts.join(' · ') : beat.id;
            beatSelect.appendChild(option);
          });
        beatSelect.value = detail.sourceBeatId || '';
        beatSelect.addEventListener('change', (event) => {
          const beatValue = event.target.value || null;
          actions.updateCodexDetail(entry.id, detail.id, { sourceBeatId: beatValue });
        });
        controls.appendChild(beatSelect);
      }

      const removeButton = createElement('button', 'codex-dynamic-remove', 'Remove');
      removeButton.addEventListener('click', () => actions.removeCodexDetail(entry.id, detail.id));
      controls.appendChild(removeButton);

      item.appendChild(controls);

      const metaLabel = formatDetailMeta(appState, beatLookup, detail);
      if (metaLabel) {
        item.appendChild(createElement('p', 'codex-dynamic-meta', metaLabel));
      }

      listContainer.appendChild(item);
    });
    section.appendChild(listContainer);
  }

  const addRow = createElement('div', 'codex-dynamic-add-row');
  addRow.appendChild(createElement('label', 'codex-entry-label', 'Add note for scene'));
  const sceneSelect = document.createElement('select');
  sceneSelect.className = 'codex-dynamic-select';
  populateSceneOptions(sceneSelect, orderedSceneIds, appState, true);
  addRow.appendChild(sceneSelect);
  const addButton = createElement('button', 'button-outline', 'Add note');
  addButton.addEventListener('click', () => {
    const sceneId = sceneSelect.value || null;
    actions.addCodexDetail(entry.id, sceneId);
    sceneSelect.value = '';
  });
  addRow.appendChild(addButton);
  section.appendChild(addRow);

  return section;
}

function groupCodexEntries() {
  if (!state) {
    return {};
  }
  const grouped = {};
  Object.values(state.codex.entries).forEach((entry) => {
    const key = entry.category || 'lore';
    if (!grouped[key]) {
      grouped[key] = [];
    }
    grouped[key].push(entry);
  });
  return grouped;
}

function renderAll() {
  renderHeaderActions();
  renderOutline();
  renderMainView();
  renderAssistant();
  renderSettings();
}

renderAll();
bootstrapState();

if (typeof window !== 'undefined') {
  window.addEventListener('beforeunload', () => {
    if (!state) {
      return;
    }
    if (persistTimer) {
      globalThis.clearTimeout(persistTimer);
      persistTimer = null;
    }
    persistChain = persistChain
      .then(() => saveStateToDb(state))
      .catch((error) => {
        console.warn('Failed to persist state during unload', error);
      });
  });
}
