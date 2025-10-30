import {
  loadStateFromDb,
  saveStateToDb,
  loadLegacyState,
  clearLegacyState,
  clearStateFromDb
} from './storage.js';
import { requestSceneScan, requestChatCompletion } from './ai.js';
import { createId, nextActId, nextBeatId, nextChapterId, nextSceneId } from './lib/id.js';
import { getNextOrder, sortByOrder } from './lib/array/order.js';
import { calculateWordCount } from './lib/text/count.js';

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

const DEFAULT_SIDEBAR_WIDTHS = { left: 320, right: 280 };
const SIDEBAR_LIMITS = {
  left: { min: 240, max: 560 },
  right: { min: 220, max: 480 },
  centerMin: 520
};
const LAYOUT_RESIZER_WIDTH = 12;
const LAYOUT_RESIZER_COUNT = 2;
const MAX_MEDIA_SIZE_BYTES = 2 * 1024 * 1024;

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

const SCENE_DRAFT_SYSTEM_PROMPT = [
  'You are a collaborative fiction writing assistant.',
  'When asked to write a scene, provide polished narrative prose that follows the supplied beats and context.',
  'Prioritise vivid sensory detail, character voice, and pacing that fits the outlined mood and stakes.',
  'Avoid hedging or disclaimers—deliver the requested scene confidently, unless the user explicitly asks for something prohibited.',
  'Return the scene text only unless the user asks for additional commentary.'
].join('\n');

function createInlineEditableText(initialValue, options = {}) {
  const { onCommit, className = '', placeholder = '', allowEmpty = false } = options;
  const span = document.createElement('span');
  span.className = `inline-editable${className ? ` ${className}` : ''}`;
  span.contentEditable = 'true';
  span.spellcheck = false;
  if (placeholder) {
    span.dataset.placeholder = placeholder;
  }
  span.textContent = initialValue || '';
  const commit = () => {
    if (typeof onCommit !== 'function') {
      return;
    }
    const raw = span.textContent || '';
    const nextValue = allowEmpty ? raw : raw.trim();
    onCommit(nextValue);
  };
  span.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      span.blur();
    }
  });
  span.addEventListener('blur', commit);
  span.addEventListener('paste', (event) => {
    event.preventDefault();
    const text = event.clipboardData ? event.clipboardData.getData('text/plain') : '';
    document.execCommand('insertText', false, text);
  });
  return span;
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

function createCodexMedia(media) {
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

function normalizeCodexMedia(list) {
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

const MAX_BEAT_OUTLINE_BEATS = 120;
const MAX_BEAT_SUMMARY_LENGTH = 220;

function truncateForPrompt(text, limit = MAX_BEAT_SUMMARY_LENGTH) {
  if (typeof text !== 'string') {
    return '';
  }
  const normalized = text.replace(/\s+/g, ' ').trim();
  if (normalized.length <= limit) {
    return normalized;
  }
  return `${normalized.slice(0, Math.max(0, limit - 3))}...`;
}

function getBeatSummaryLines(scene, indent = '      ') {
  if (!scene || !Array.isArray(scene.beats) || scene.beats.length === 0) {
    return [];
  }
  return scene.beats
    .slice()
    .sort((a, b) => (a.order || 0) - (b.order || 0))
    .map((beat, index) => {
      const fallback = typeof beat.title === 'string' && beat.title.trim().length > 0 ? beat.title.trim() : `Beat ${index + 1}`;
      const summaryRaw = typeof beat.summary === 'string' && beat.summary.trim().length > 0 ? beat.summary : fallback;
      const summary = truncateForPrompt(summaryRaw);
      return `${indent}${index + 1}. ${summary}`;
    });
}

function buildBeatOutlineSnapshot(appState, maxBeats = MAX_BEAT_OUTLINE_BEATS) {
  if (!appState) {
    return '';
  }

  const lines = [];
  let beatsIncluded = 0;
  let truncated = false;

  const acts = [...(appState.acts || [])].sort((a, b) => (a.order || 0) - (b.order || 0));
  for (let actIndex = 0; actIndex < acts.length; actIndex += 1) {
    const act = acts[actIndex];
    const chapters = (act?.chapterIds || [])
      .map((chapterId) => appState.chapters[chapterId])
      .filter(Boolean)
      .sort((a, b) => (a.order || 0) - (b.order || 0));

    const actLines = [];
    for (let chapterIndex = 0; chapterIndex < chapters.length; chapterIndex += 1) {
      const chapter = chapters[chapterIndex];
      const scenes = (chapter?.sceneIds || [])
        .map((sceneId) => appState.scenes[sceneId])
        .filter(Boolean)
        .sort((a, b) => (a.order || 0) - (b.order || 0));

      const chapterLines = [];
      for (let sceneIndex = 0; sceneIndex < scenes.length; sceneIndex += 1) {
        const scene = scenes[sceneIndex];
        const beatLines = getBeatSummaryLines(scene);
        if (beatLines.length === 0) {
          continue;
        }
        if (beatsIncluded >= maxBeats) {
          truncated = true;
          break;
        }
        const remaining = maxBeats - beatsIncluded;
        const limitedBeatLines = beatLines.slice(0, remaining);
        beatsIncluded += limitedBeatLines.length;
        const sceneLabel = scene?.order || sceneIndex + 1;
        const sceneTitle = scene?.title || 'Untitled Scene';

        chapterLines.push(`    Scene ${sceneLabel} (${scene?.id || 'S?'}): ${sceneTitle}`);
        chapterLines.push(...limitedBeatLines);
        if (limitedBeatLines.length < beatLines.length) {
          chapterLines.push('      ... (additional beats omitted)');
          truncated = true;
          break;
        }
      }

      if (chapterLines.length > 0) {
        const chapterLabel = chapter?.order || chapterIndex + 1;
        actLines.push(`  Chapter ${chapterLabel} (${chapter?.id || 'C?'}): ${chapter?.title || 'Untitled Chapter'}`);
        actLines.push(...chapterLines);
      }

      if (truncated) {
        break;
      }
    }

    if (actLines.length > 0) {
      const actLabel = act?.order || actIndex + 1;
      lines.push(`Act ${actLabel} (${act?.id || 'A?'}): ${act?.title || 'Untitled Act'}`);
      lines.push(...actLines);
    }

    if (truncated) {
      break;
    }
  }

  if (beatsIncluded === 0) {
    return '';
  }
  if (truncated) {
    lines.push('... Beat outline truncated for brevity.');
  }
  return lines.join('\n');
}

function buildManuscriptExcerpt(text, limit = 900) {
  if (typeof text !== 'string' || text.trim().length === 0) {
    return '';
  }
  const normalized = text.replace(/\s+/g, ' ').trim();
  if (normalized.length <= limit) {
    return normalized;
  }
  return `${normalized.slice(0, Math.max(0, limit - 3))}...`;
}

function extractMentionsFromText(text) {
  if (typeof text !== 'string' || text.trim().length === 0) {
    return [];
  }
  const matches = text.match(/@[a-zA-Z0-9_-]+/g);
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

  const initialState = {
    acts: [
      { id: actId, title: '', order: 1, chapterIds: [chapterId] }
    ],
    chapters: {
      [chapterId]: { id: chapterId, title: '', order: 1, actId, sceneIds: [sceneId], isPrologue: false }
    },
    scenes: {
      [sceneId]: {
        id: sceneId,
        title: '',
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
          media: [],
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
          details: [createCodexDetail('Establishes the noir atmosphere of the city.', sceneId)],
          media: []
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
      sidebarView: 'outline',
      layout: {
        sidebarWidths: { ...DEFAULT_SIDEBAR_WIDTHS }
      },
      sceneScanCollapsed: {},
      showBeats: false,
      showAssistant: true,
      showSettings: false,
      scanStatus: null,
      selectionContext: null,
      generatingBeats: false,
      generatingSceneDraft: false,
      codexSearch: '',
  codexSidebar: {
        collapsedCategories: [],
        selectedEntryId: null
      },
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
  updateAllCodexRelations(initialState.codex.entries);
  return initialState;
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

    let chapterSequence = 1;
    let prologueSeen = false;
    sortedChapters.forEach((chapter) => {
      const isPrologue = Boolean(
        chapter && (chapter.isPrologue || chapter.order === 0) && !prologueSeen
      );
      if (isPrologue) {
        prologueSeen = true;
      }
      const newChapterOrder = isPrologue ? 0 : chapterSequence++;
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
        const normalizedSceneTitle =
          scene && typeof scene.title === 'string' ? scene.title : '';

        scenesNormalized[newSceneId] = {
          id: newSceneId,
          title: normalizedSceneTitle,
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

      const normalizedChapterTitle =
        chapter && typeof chapter.title === 'string' ? chapter.title : '';

      chaptersNormalized[newChapterId] = {
        id: newChapterId,
        title: normalizedChapterTitle,
        order: newChapterOrder,
        actId: newActId,
        sceneIds: newSceneIds,
        isPrologue
      };

      newChapterIds.push(newChapterId);
    });

    const normalizedActTitle = act && typeof act.title === 'string' ? act.title : '';

    actsNormalized.push({
      id: newActId,
      title: normalizedActTitle,
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
        details,
        media: normalizeCodexMedia(entry.media)
      };

      if (category === 'character') {
        normalizedEntry.background = normalizeCharacterBackground(entry.background);
        normalizedEntry.core = normalizeCharacterCoreSections(entry.core);
      }

      return [id, normalizedEntry];
    })
  );

  updateAllCodexRelations(codexEntriesNormalized);

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
  const allowedViews = ['workspace', 'codex', 'manuscript'];
  const activeMainView = allowedViews.includes(uiValue.activeMainView)
    ? uiValue.activeMainView
    : base.ui.activeMainView;
  const sidebarView = uiValue.sidebarView === 'codex' ? 'codex' : base.ui.sidebarView;
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
  const layoutValue = uiValue.layout && typeof uiValue.layout === 'object' ? uiValue.layout : {};
  const sidebarWidthsNormalized = normalizeSidebarWidths(layoutValue.sidebarWidths || {});
  const codexSearchValue = typeof uiValue.codexSearch === 'string' ? uiValue.codexSearch : '';
  const codexSidebarValue =
    uiValue.codexSidebar && typeof uiValue.codexSidebar === 'object' ? uiValue.codexSidebar : {};
  const collapsedCategories = Array.isArray(codexSidebarValue.collapsedCategories)
    ? codexSidebarValue.collapsedCategories.filter((item) => typeof item === 'string')
    : [];
  const sidebarSelectedEntry =
    typeof codexSidebarValue.selectedEntryId === 'string' && codexEntriesNormalized[codexSidebarValue.selectedEntryId]
      ? codexSidebarValue.selectedEntryId
      : null;
  const rawSceneScanCollapsed = uiValue.sceneScanCollapsed && typeof uiValue.sceneScanCollapsed === 'object'
    ? uiValue.sceneScanCollapsed
    : {};
  const sceneScanCollapsedNormalized = {};
  Object.entries(rawSceneScanCollapsed).forEach(([key, value]) => {
    if (typeof key === 'string' && value) {
      sceneScanCollapsedNormalized[key] = true;
    }
  });
  const ui = {
    ...base.ui,
    activeMainView,
    sidebarView,
    layout: {
      sidebarWidths: sidebarWidthsNormalized
    },
    sceneScanCollapsed: sceneScanCollapsedNormalized,
    showBeats: Boolean(uiValue.showBeats),
    showAssistant: uiValue.showAssistant === false ? false : true,
    showSettings: Boolean(uiValue.showSettings),
    scanStatus: null,
    generatingBeats: false,
    generatingSceneDraft: false,
    codexSearch: codexSearchValue,
    codexSidebar: {
      collapsedCategories,
      selectedEntryId: sidebarSelectedEntry
    },
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
  } catch (_error) {
    console.warn('Falling back to shallow clone for undo snapshot', _error);
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
    } catch (_error) {
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
  } catch (_error) {
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
  } catch (_error) {
    console.error('Failed to initialise state from IndexedDB.', _error);
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
      .catch((_error) => {
        console.warn('Failed to persist state to IndexedDB', _error);
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

  if (!['workspace', 'codex', 'manuscript'].includes(state.ui.activeMainView)) {
    state.ui.activeMainView = 'workspace';
  }

  if (!state.ui.outline) {
    state.ui.outline = { collapsedActs: [], collapsedChapters: [], expandedScenes: [] };
  }
  if (!state.ui.layout || !state.ui.layout.sidebarWidths) {
    state.ui.layout = { sidebarWidths: { ...DEFAULT_SIDEBAR_WIDTHS } };
  } else {
    state.ui.layout.sidebarWidths = normalizeSidebarWidths(state.ui.layout.sidebarWidths);
  }
  if (!state.ui.sceneScanCollapsed || typeof state.ui.sceneScanCollapsed !== 'object') {
    state.ui.sceneScanCollapsed = {};
  }
  if (typeof state.ui.codexSearch !== 'string') {
    state.ui.codexSearch = '';
  }
  if (!state.ui.codexSidebar || !Array.isArray(state.ui.codexSidebar.collapsedCategories)) {
    state.ui.codexSidebar = { collapsedCategories: [] };
  } else {
    state.ui.codexSidebar.collapsedCategories = state.ui.codexSidebar.collapsedCategories
      .filter((item) => typeof item === 'string');
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
    const prologueIds = [];
    const regularChapterIds = [];
    act.chapterIds.forEach((chapterId) => {
      const chapter = draft.chapters[chapterId];
      if (!chapter) {
        return;
      }
      if (chapter.isPrologue) {
        prologueIds.push(chapterId);
      } else {
        regularChapterIds.push(chapterId);
      }
    });
    act.chapterIds = [...prologueIds, ...regularChapterIds];
    let chapterOrder = 1;
    act.chapterIds.forEach((chapterId) => {
      const chapter = draft.chapters[chapterId];
      if (!chapter) {
        return;
      }
      if (chapter.isPrologue) {
        chapter.order = 0;
      } else {
        chapter.order = chapterOrder;
        chapterOrder += 1;
      }
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
  addAct(title = '') {
    updateState((draft) => {
      const nextOrder = getNextOrder(draft.acts, (act) => act?.order || 0);
      const id = nextActId(nextOrder);
      draft.acts.push({ id, title, order: nextOrder, chapterIds: [] });
    });
  },
  addChapter(actId, title = '') {
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
      draft.chapters[id] = { id, title, order, actId: act.id, sceneIds: [], isPrologue: false };
      act.chapterIds.push(id);
      refreshOutlineOrdering(draft);
    });
  },
  addPrologue(actId, title = '') {
    updateState((draft) => {
      const act = draft.acts.find((item) => item.id === actId);
      if (!act) {
        return false;
      }
      if (!Array.isArray(act.chapterIds)) {
        act.chapterIds = [];
      }
      const hasPrologue = act.chapterIds.some((chapterId) => draft.chapters[chapterId]?.isPrologue);
      if (hasPrologue) {
        return false;
      }
      const id = nextChapterId(act.id, 0);
      draft.chapters[id] = { id, title, order: 0, actId: act.id, sceneIds: [], isPrologue: true };
      act.chapterIds.unshift(id);
      refreshOutlineOrdering(draft);
    });
  },
  addScene(chapterId, title = '') {
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
  updateBeat(sceneId, beatId, changes = {}) {
    if (!sceneId || !beatId || !changes || typeof changes !== 'object') {
      return;
    }
    updateState((draft) => {
      const scene = draft.scenes[sceneId];
      if (!scene || !Array.isArray(scene.beats)) {
        return false;
      }
      const beat = scene.beats.find((item) => item && item.id === beatId);
      if (!beat) {
        return false;
      }
      let mutated = false;
      if (Object.prototype.hasOwnProperty.call(changes, 'title')) {
        const nextTitle = typeof changes.title === 'string' ? changes.title : '';
        if (beat.title !== nextTitle) {
          beat.title = nextTitle;
          mutated = true;
        }
      }
      if (Object.prototype.hasOwnProperty.call(changes, 'summary')) {
        const nextSummary = typeof changes.summary === 'string' ? changes.summary : '';
        if (beat.summary !== nextSummary) {
          beat.summary = nextSummary;
          mutated = true;
        }
      }
      if (mutated) {
        beat.updatedAt = new Date().toISOString();
        scene.lastUpdated = new Date().toISOString();
        if (!scene.beats.some((item) => item.id === beatId && item.order === beat.order)) {
          scene.beats = normalizeBeats(sceneId, scene.beats);
        }
      }
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
    if (view !== 'workspace' && view !== 'codex' && view !== 'manuscript') {
      return;
    }
    updateState((draft) => {
      if (draft.ui.activeMainView === view) {
        return false;
      }
      draft.ui.activeMainView = view;
    });
  },
  setSidebarView(view) {
    updateState((draft) => {
      const next = view === 'codex' ? 'codex' : 'outline';
      if (draft.ui.sidebarView === next) {
        return false;
      }
      draft.ui.sidebarView = next;
    });
  },
  setCodexSearch(value) {
    const nextValue = typeof value === 'string' ? value : '';
    updateState((draft) => {
      if (draft.ui.codexSearch === nextValue) {
        return false;
      }
      draft.ui.codexSearch = nextValue;
      if (draft.ui.codexSidebar) {
        draft.ui.codexSidebar.selectedEntryId = null;
      }
    }, { skipHistory: true });
  },
  toggleCodexCategoryCollapse(categoryId, isOpen) {
    if (!categoryId) {
      return;
    }
    updateState((draft) => {
      if (!draft.ui.codexSidebar || !Array.isArray(draft.ui.codexSidebar.collapsedCategories)) {
        draft.ui.codexSidebar = { collapsedCategories: [] };
      }
      const collapsed = draft.ui.codexSidebar.collapsedCategories;
      const index = collapsed.indexOf(categoryId);
      const shouldCollapse = isOpen === undefined ? index === -1 : !isOpen;
      if (shouldCollapse) {
        if (index !== -1) {
          return false;
        }
        collapsed.push(categoryId);
      } else {
        if (index === -1) {
          return false;
        }
        collapsed.splice(index, 1);
      }
    }, { skipHistory: true });
  },
  openCodexSidebarEntry(entryId) {
    if (!entryId) {
      return;
    }
    updateState((draft) => {
      if (!draft.ui.codexSidebar) {
        draft.ui.codexSidebar = { collapsedCategories: [], selectedEntryId: null };
      }
      draft.ui.codexSidebar.selectedEntryId = entryId;
    }, { skipHistory: true });
  },
  closeCodexSidebarEntry() {
    updateState((draft) => {
      if (!draft.ui.codexSidebar) {
        return false;
      }
      if (!draft.ui.codexSidebar.selectedEntryId) {
        return false;
      }
      draft.ui.codexSidebar.selectedEntryId = null;
    }, { skipHistory: true });
  },
  setSidebarWidths(widths) {
    if (!widths) {
      return;
    }
    updateState((draft) => {
      if (!draft.ui.layout) {
        draft.ui.layout = { sidebarWidths: { ...DEFAULT_SIDEBAR_WIDTHS } };
      }
      const current = draft.ui.layout.sidebarWidths || { ...DEFAULT_SIDEBAR_WIDTHS };
      const next = normalizeSidebarWidths(widths);
      if (current.left === next.left && current.right === next.right) {
        return false;
      }
      draft.ui.layout.sidebarWidths = next;
    }, { skipHistory: true });
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
    let didChange = false;
    updateState((draft) => {
      if (!snippet) {
        if (!draft.ui.selectionContext) {
          return false;
        }
        draft.ui.selectionContext = null;
        didChange = true;
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
      didChange = true;
    }, { skipHistory: true, skipRender: true });
    if (didChange) {
      renderAssistant();
    }
  },
  clearSelectionContext() {
    let didChange = false;
    updateState((draft) => {
      if (!draft.ui.selectionContext) {
        return false;
      }
      draft.ui.selectionContext = null;
      didChange = true;
    }, { skipHistory: true, skipRender: true });
    if (didChange) {
      renderAssistant();
    }
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
  toggleSceneScanCollapse(sceneId) {
    if (!sceneId) {
      return;
    }
    updateState((draft) => {
      if (!draft.ui.sceneScanCollapsed || typeof draft.ui.sceneScanCollapsed !== 'object') {
        draft.ui.sceneScanCollapsed = {};
      }
      if (draft.ui.sceneScanCollapsed[sceneId]) {
        delete draft.ui.sceneScanCollapsed[sceneId];
      } else {
        draft.ui.sceneScanCollapsed[sceneId] = true;
      }
    }, { skipHistory: true });
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
    }, { skipHistory: true, skipRender: true });
    suppressChatBlurClear = false;
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
    } catch (_error) {
      console.error('Chat completion failed', _error);
      updateState((draft) => {
        draft.ui.chat.isSending = false;
        draft.ui.chat.error = _error && _error.message ? _error.message : 'Assistant request failed.';
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
    } catch (_error) {
      console.error('Beat generation failed', _error);
      updateState((draft) => {
        draft.ui.generatingBeats = false;
        if (draft.ui.chat) {
          draft.ui.chat.error =
            _error && _error.message ? `Beat generation failed: ${_error.message}` : 'Beat generation failed.';
        }
      }, { skipHistory: true });
    }
  },
  async generateSceneDraft(sceneId) {
    if (!state || state.ui.generatingSceneDraft) {
      return;
    }
    const scene = state.scenes[sceneId];
    if (!scene) {
      return;
    }
    if (!Array.isArray(scene.beats) || scene.beats.length === 0) {
      updateState((draft) => {
        if (draft.ui.chat) {
          draft.ui.chat.error = 'Add beats to this scene before generating a draft.';
        }
      }, { skipHistory: true });
      return;
    }

    const providerId = getProviderId('assistant');
    if (!providerId) {
      updateState((draft) => {
        if (draft.ui.chat) {
          draft.ui.chat.error = 'Select a writing provider in Settings before generating a draft.';
        }
      }, { skipHistory: true });
      return;
    }

    const apiKey = state.settings.apiKeys ? state.settings.apiKeys[providerId] : null;
    if (!apiKey || apiKey.trim().length === 0) {
      updateState((draft) => {
        if (draft.ui.chat) {
          draft.ui.chat.error = 'Add an API key for the writing provider in Settings before generating a draft.';
        }
      }, { skipHistory: true });
      return;
    }

    const neighbors = findSceneNeighbors(state, sceneId);
    const previousSummary = summarizeSceneForBeats(neighbors.previous, 'Previous scene');
    const nextSummary = summarizeSceneForBeats(neighbors.next, 'Next scene');
    const selectionContext =
      state.ui.selectionContext && state.ui.selectionContext.sceneId === sceneId ? state.ui.selectionContext.text : '';
    const chatInput = state.ui.chatInput ? state.ui.chatInput.trim() : '';
    let latestUserMessage = '';
    if (state.chat && Array.isArray(state.chat.messages)) {
      for (let index = state.chat.messages.length - 1; index >= 0; index -= 1) {
        const message = state.chat.messages[index];
        if (message && message.role === 'user' && typeof message.content === 'string' && message.content.trim().length > 0) {
          latestUserMessage = message.content.trim();
          break;
        }
      }
    }
    const userGuidance = chatInput || latestUserMessage || '';

    updateState((draft) => {
      draft.ui.generatingSceneDraft = true;
      if (draft.ui.chat) {
        draft.ui.chat.error = null;
      }
    }, { skipHistory: true });

    try {
      const prompt = buildSceneDraftPrompt(state, scene, {
        storyOutline: buildBeatOutlineSnapshot(state),
        codexSummary: buildCodexSummary(state, 12),
        previousSummary,
        nextSummary,
        selectionContext,
        userGuidance,
        sceneExcerpt: buildManuscriptExcerpt(scene.text || '', 400)
      });

      const reply = await requestChatCompletion({
        providerId,
        apiKey,
        messages: [{ role: 'user', content: prompt }],
        systemPrompt: SCENE_DRAFT_SYSTEM_PROMPT,
        temperature: 0.65
      });

      const draftText = typeof reply === 'string' ? reply.trim() : JSON.stringify(reply, null, 2);
      updateState((draft) => {
        const targetScene = draft.scenes[sceneId];
        if (!targetScene) {
          return false;
        }
        targetScene.text = draftText;
        targetScene.wordCount = calculateWordCount(draftText);
        targetScene.draftStatus = targetScene.wordCount === 0 ? 'empty' : 'drafted';
        targetScene.lastUpdated = new Date().toISOString();
        draft.ui.generatingSceneDraft = false;
        draft.ui.showBeats = false;
      });
    } catch (_error) {
      console.error('Scene draft generation failed', _error);
      updateState((draft) => {
        draft.ui.generatingSceneDraft = false;
        if (draft.ui.chat) {
          draft.ui.chat.error =
            _error && _error.message ? `Scene draft failed: ${_error.message}` : 'Scene draft failed.';
        }
      }, { skipHistory: true });
    }
  },
  shiftAct(actId, delta) {
    updateState((draft) => {
      const acts = draft.acts;
      const index = acts.findIndex((act) => act.id === actId);
      if (index === -1) {
        return false;
      }
      const targetIndex = index + delta;
      if (targetIndex < 0 || targetIndex >= acts.length) {
        return false;
      }
      const [act] = acts.splice(index, 1);
      acts.splice(targetIndex, 0, act);
      refreshOutlineOrdering(draft);
    });
  },
  shiftChapter(chapterId, delta) {
    updateState((draft) => {
      const chapter = draft.chapters[chapterId];
      if (!chapter) {
        return false;
      }
      if (chapter.isPrologue) {
        return false;
      }
      const act = draft.acts.find((item) => item.id === chapter.actId);
      if (!act || !Array.isArray(act.chapterIds)) {
        return false;
      }
      const index = act.chapterIds.indexOf(chapterId);
      if (index === -1) {
        return false;
      }
      const targetIndex = index + delta;
      if (targetIndex < 0 || targetIndex >= act.chapterIds.length) {
        return false;
      }
      const prologueChapter = act.chapterIds[0] ? draft.chapters[act.chapterIds[0]] : null;
      if (prologueChapter && prologueChapter.isPrologue && targetIndex === 0) {
        return false;
      }
      act.chapterIds.splice(index, 1);
      act.chapterIds.splice(targetIndex, 0, chapterId);
      refreshOutlineOrdering(draft);
    });
  },
  shiftScene(sceneId, delta) {
    updateState((draft) => {
      const scene = draft.scenes[sceneId];
      if (!scene) {
        return false;
      }
      const chapter = draft.chapters[scene.chapterId];
      if (!chapter || !Array.isArray(chapter.sceneIds)) {
        return false;
      }
      const index = chapter.sceneIds.indexOf(sceneId);
      if (index === -1) {
        return false;
      }
      const targetIndex = index + delta;
      if (targetIndex < 0 || targetIndex >= chapter.sceneIds.length) {
        return false;
      }
      chapter.sceneIds.splice(index, 1);
      chapter.sceneIds.splice(targetIndex, 0, sceneId);
      refreshOutlineOrdering(draft);
    });
  },
  shiftBeat(sceneId, beatId, delta) {
    updateState((draft) => {
      const scene = draft.scenes[sceneId];
      if (!scene || !Array.isArray(scene.beats)) {
        return false;
      }
      const index = scene.beats.findIndex((beat) => beat.id === beatId);
      if (index === -1) {
        return false;
      }
      const targetIndex = index + delta;
      if (targetIndex < 0 || targetIndex >= scene.beats.length) {
        return false;
      }
      const [beat] = scene.beats.splice(index, 1);
      scene.beats.splice(targetIndex, 0, beat);
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
      refreshCodexDerivedData(draft);
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
    } catch (_error) {
      console.warn('Failed to clear persisted database state', _error);
      throw _error;
    }
  },
  async clearAllData() {
    await persistChain.catch(() => {});
    cancelScheduledPersist();
    try {
      await clearStateFromDb();
    } catch (_error) {
      console.warn('Failed to clear persisted database state before reset', _error);
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
        details: [],
        media: []
      };
      if (normalizedCategory === 'character') {
        entry.background = createCharacterBackground();
        entry.core = createCharacterCoreSections();
      }
      draft.codex.entries[id] = entry;
      draft.codex.selectedId = id;
      refreshCodexDerivedData(draft);
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
      refreshCodexDerivedData(draft);
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
      if (entry.category === normalizedCategory) {
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
      refreshCodexDerivedData(draft);
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
      refreshCodexDerivedData(draft);
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
      refreshCodexDerivedData(draft);
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
      refreshCodexDerivedData(draft);
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
      refreshCodexDerivedData(draft);
    });
  },
  addCodexMedia(entryId, mediaPayload) {
    if (!entryId || !mediaPayload || typeof mediaPayload.dataUrl !== 'string') {
      return;
    }
    updateState((draft) => {
      const entry = draft.codex.entries[entryId];
      if (!entry) {
        return false;
      }
      if (!Array.isArray(entry.media)) {
        entry.media = [];
      }
      try {
        entry.media.push(createCodexMedia(mediaPayload));
      } catch (_error) {
        console.warn('Failed to add Codex media', _error);
        return false;
      }
      refreshCodexDerivedData(draft);
    }, { skipHistory: true });
  },
  removeCodexMedia(entryId, mediaId) {
    if (!entryId || !mediaId) {
      return;
    }
    updateState((draft) => {
      const entry = draft.codex.entries[entryId];
      if (!entry || !Array.isArray(entry.media)) {
        return false;
      }
      const index = entry.media.findIndex((item) => item.id === mediaId);
      if (index === -1) {
        return false;
      }
      entry.media.splice(index, 1);
      refreshCodexDerivedData(draft);
    }, { skipHistory: true });
  },
  exportManuscript() {
    if (!state) {
      window.alert('No manuscript data available.');
      return;
    }
    const text = buildFullManuscriptText(state);
    if (!text || text.trim().length === 0) {
      window.alert('No manuscript content to export yet.');
      return;
    }
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    downloadFile(`manuscript-${timestamp}.txt`, text, 'text/plain;charset=utf-8');
  },
  exportDatabase() {
    if (!state) {
      window.alert('No database data available.');
      return;
    }
    const snapshot = JSON.stringify(state, null, 2);
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    downloadFile(`codex-database-${timestamp}.json`, snapshot, 'application/json');
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
      refreshCodexDerivedData(draft);
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
      refreshCodexDerivedData(draft);
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
      refreshCodexDerivedData(draft);
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
      refreshCodexDerivedData(draft);
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
    } catch (_error) {
      console.error('Scene scan failed', _error);
      updateState((draft) => {
        let message = _error && _error.message ? _error.message : 'Scene scan failed. Check console for details.';
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
const layoutRoot = document.querySelector('.main-layout');
const outlinePanel = layoutRoot ? layoutRoot.querySelector('.panel-outline') : null;
const mainPanel = layoutRoot ? layoutRoot.querySelector('.panel-main') : null;
const assistantPanel = layoutRoot ? layoutRoot.querySelector('.panel-assistant') : null;

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

if (!layoutRoot || !outlinePanel || !mainPanel || !assistantPanel) {
  throw new Error('Main layout panels not found');
}

const leftResizer = document.createElement('div');
leftResizer.className = 'panel-resizer panel-resizer-left';
layoutRoot.insertBefore(leftResizer, mainPanel);

const rightResizer = document.createElement('div');
rightResizer.className = 'panel-resizer panel-resizer-right';
layoutRoot.insertBefore(rightResizer, assistantPanel);

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

function downloadFile(filename, data, mimeType = 'text/plain') {
  try {
    const blob = new Blob([data], { type: mimeType });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = filename;
    anchor.style.display = 'none';
    document.body.appendChild(anchor);
    anchor.click();
    document.body.removeChild(anchor);
    globalThis.setTimeout(() => URL.revokeObjectURL(url), 0);
  } catch (_error) {
    console.warn('Failed to download file', _error);
    window.alert('Unable to trigger download. Check browser permissions.');
  }
}

const CLIPBOARD_SHORTCUT_KEYS = new Set(['c', 'v', 'x']);
const TEXTUAL_INPUT_TYPES = new Set(['text', 'search', 'url', 'tel', 'password', 'email', 'number']);

function isTextualInput(element) {
  if (!element || element.tagName !== 'INPUT') {
    return false;
  }
  const type = (element.type || '').toLowerCase();
  if (type === '') {
    return true;
  }
  return TEXTUAL_INPUT_TYPES.has(type);
}

function isEditableTarget(element) {
  if (!element) {
    return false;
  }
  if (element.tagName === 'TEXTAREA') {
    return true;
  }
  if (isTextualInput(element)) {
    return true;
  }
  return Boolean(element.isContentEditable);
}

function hasEditableSelection(element) {
  if (!element || !isEditableTarget(element)) {
    return false;
  }
  if (element.tagName === 'TEXTAREA' || element.tagName === 'INPUT') {
    const start = element.selectionStart;
    const end = element.selectionEnd;
    return typeof start === 'number' && typeof end === 'number' && end > start;
  }
  if (element.isContentEditable) {
    const selection = typeof window !== 'undefined' && window.getSelection ? window.getSelection() : null;
    if (!selection || selection.isCollapsed) {
      return false;
    }
    const anchorNode = selection.anchorNode;
    return anchorNode instanceof Node && element.contains(anchorNode);
  }
  return false;
}

function canCutFrom(element) {
  if (!isEditableTarget(element)) {
    return false;
  }
  if (element.readOnly || element.disabled) {
    return false;
  }
  return hasEditableSelection(element);
}

function canPasteInto(element) {
  if (!isEditableTarget(element)) {
    return false;
  }
  if (element.readOnly || element.disabled) {
    return false;
  }
  return true;
}

function tryExecCommand(command) {
  if (typeof document === 'undefined' || typeof document.execCommand !== 'function') {
    return false;
  }
  try {
    return document.execCommand(command);
  } catch (_error) {
    return false;
  }
}

function focusEditable(target) {
  if (!target || typeof target.focus !== 'function') {
    return;
  }
  if (typeof document !== 'undefined' && document.activeElement === target) {
    return;
  }
  try {
    target.focus({ preventScroll: true });
  } catch (_error) {
    target.focus();
  }
}

function insertTextAtCursor(target, text) {
  if (!target || typeof text !== 'string') {
    return false;
  }
  focusEditable(target);
  if (target.tagName === 'TEXTAREA' || target.tagName === 'INPUT') {
    const start = target.selectionStart;
    const end = target.selectionEnd;
    if (typeof start !== 'number' || typeof end !== 'number') {
      return false;
    }
    if (typeof target.setRangeText === 'function') {
      target.setRangeText(text, start, end, 'end');
    } else {
      const value = typeof target.value === 'string' ? target.value : '';
      target.value = `${value.slice(0, start)}${text}${value.slice(end)}`;
      const nextCursor = start + text.length;
      target.selectionStart = nextCursor;
      target.selectionEnd = nextCursor;
    }
    target.dispatchEvent(new Event('input', { bubbles: true }));
    return true;
  }
  if (target.isContentEditable) {
    try {
      return document.execCommand('insertText', false, text);
    } catch (_error) {
      return false;
    }
  }
  return false;
}

function extractSelectedText(activeElement) {
  const selection = typeof window !== 'undefined' && window.getSelection ? window.getSelection() : null;
  if (selection && !selection.isCollapsed) {
    return selection.toString();
  }
  if (!activeElement || (activeElement.tagName !== 'TEXTAREA' && activeElement.tagName !== 'INPUT')) {
    return '';
  }
  const start = activeElement.selectionStart;
  const end = activeElement.selectionEnd;
  if (typeof start !== 'number' || typeof end !== 'number' || end <= start) {
    return '';
  }
  const value = typeof activeElement.value === 'string' ? activeElement.value : '';
  return value.slice(start, end);
}

function deleteEditableSelection(target) {
  if (!target || !hasEditableSelection(target)) {
    return;
  }
  if (target.tagName === 'TEXTAREA' || target.tagName === 'INPUT') {
    insertTextAtCursor(target, '');
    return;
  }
  if (target.isContentEditable) {
    tryExecCommand('delete');
  }
}

function applyClipboardPaste(target) {
  if (!target) {
    return false;
  }
  focusEditable(target);
  const execResult = tryExecCommand('paste');
  if (execResult) {
    return true;
  }
  if (typeof navigator !== 'undefined' && navigator.clipboard && typeof navigator.clipboard.readText === 'function') {
    return navigator.clipboard
      .readText()
      .then((text) => {
        if (typeof text !== 'string') {
          return false;
        }
        return insertTextAtCursor(target, text);
      })
      .catch(() => false);
  }
  return false;
}

let clipboardShortcutsRegistered = false;

function setupClipboardShortcuts() {
  if (clipboardShortcutsRegistered || typeof document === 'undefined') {
    return;
  }
  const handler = (event) => {
    if (event.defaultPrevented) {
      return;
    }
    if (!(event.metaKey || event.ctrlKey)) {
      return;
    }
    const key = typeof event.key === 'string' ? event.key.toLowerCase() : '';
    if (!CLIPBOARD_SHORTCUT_KEYS.has(key)) {
      return;
    }
    const activeElement = document.activeElement;
    const globalSelection = typeof window !== 'undefined' && window.getSelection ? window.getSelection() : null;
    if (key === 'c') {
      const hasSelection =
        (globalSelection && !globalSelection.isCollapsed) ||
        (activeElement && isEditableTarget(activeElement) && hasEditableSelection(activeElement));
      if (!hasSelection) {
        return;
      }
      const success = tryExecCommand('copy');
      if (success) {
        event.preventDefault();
        return;
      }
      if (typeof navigator !== 'undefined' && navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
        const text = extractSelectedText(activeElement);
        if (text) {
          navigator.clipboard.writeText(text).catch(() => {});
          event.preventDefault();
        }
      }
      return;
    }
    if (key === 'x') {
      if (!canCutFrom(activeElement)) {
        return;
      }
      const success = tryExecCommand('cut');
      if (success) {
        event.preventDefault();
        return;
      }
      if (typeof navigator !== 'undefined' && navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
        const text = extractSelectedText(activeElement);
        if (text) {
          navigator.clipboard
            .writeText(text)
            .then(() => {
              deleteEditableSelection(activeElement);
            })
            .catch(() => {});
          event.preventDefault();
        }
      }
      return;
    }
    if (key === 'v') {
      if (!canPasteInto(activeElement)) {
        return;
      }
      const result = applyClipboardPaste(activeElement);
      if (result && typeof result.then === 'function') {
        event.preventDefault();
        result.catch(() => {});
      } else if (result) {
        event.preventDefault();
      }
    }
  };
  document.addEventListener('keydown', handler);
  clipboardShortcutsRegistered = true;
}

function buildFullManuscriptText(appState) {
  if (!appState) {
    return '';
  }
  const lines = [];
  const acts = [...appState.acts].sort((a, b) => (a.order || 0) - (b.order || 0));
  acts.forEach((act) => {
    lines.push(`# Act ${act.order || ''}${act.title ? `: ${act.title}` : ''}`.trim());
    const chapters = (act.chapterIds || [])
      .map((chapterId) => appState.chapters[chapterId])
      .filter(Boolean)
      .sort((a, b) => (a.order || 0) - (b.order || 0));
    chapters.forEach((chapter) => {
      let chapterHeading;
      const chapterTitle = typeof chapter.title === 'string' ? chapter.title.trim() : '';
      if (chapter.isPrologue) {
        chapterHeading = `Prologue${chapterTitle ? `: ${chapterTitle}` : ''}`;
      } else {
        const orderLabel =
          typeof chapter.order === 'number' && Number.isFinite(chapter.order) && chapter.order > 0
            ? chapter.order
            : '';
        const base = orderLabel !== '' ? `Chapter ${orderLabel}` : 'Chapter';
        chapterHeading = `${base}${chapterTitle ? `: ${chapterTitle}` : ''}`;
      }
      lines.push(`\n## ${chapterHeading}`.trim());
      const scenes = (chapter.sceneIds || [])
        .map((sceneId) => appState.scenes[sceneId])
        .filter(Boolean)
        .sort((a, b) => (a.order || 0) - (b.order || 0));
      scenes.forEach((scene) => {
        lines.push(`\n### Scene ${scene.order || ''}${scene.title ? `: ${scene.title}` : ''}`.trim());
        lines.push(scene.text || '(Scene is empty)');
      });
    });
    lines.push('\n');
  });
  return lines.join('\n').trim();
}

function clampNumber(value, min, max, fallback) {
  if (!Number.isFinite(value)) {
    return Number.isFinite(fallback) ? fallback : min;
  }
  return Math.min(max, Math.max(min, value));
}

function clampSidebarWidth(side, value) {
  const limits = SIDEBAR_LIMITS[side];
  const fallback = DEFAULT_SIDEBAR_WIDTHS[side];
  if (!limits) {
    return Number.isFinite(value) ? value : fallback;
  }
  return clampNumber(value, limits.min, limits.max, fallback);
}

function normalizeSidebarWidths(input = {}) {
  return {
    left: clampSidebarWidth('left', input.left),
    right: clampSidebarWidth('right', input.right)
  };
}

function getSidebarWidthsSnapshot(sourceState = state) {
  if (!sourceState || !sourceState.ui || !sourceState.ui.layout) {
    return { ...DEFAULT_SIDEBAR_WIDTHS };
  }
  const widths = sourceState.ui.layout.sidebarWidths || {};
  return normalizeSidebarWidths(widths);
}

let layoutPreviewWidths = null;
let resizeSession = null;

function computeCenterWidth(totalWidth, leftWidth, rightWidth) {
  return totalWidth - leftWidth - rightWidth - LAYOUT_RESIZER_COUNT * LAYOUT_RESIZER_WIDTH;
}

function applyLayoutWidths(previewWidths = null) {
  if (!layoutRoot || !outlinePanel || !mainPanel || !assistantPanel) {
    return;
  }
  const activeWidths =
    previewWidths !== null
      ? normalizeSidebarWidths(previewWidths)
      : layoutPreviewWidths !== null
        ? normalizeSidebarWidths(layoutPreviewWidths)
        : getSidebarWidthsSnapshot();
  outlinePanel.style.flex = `0 0 ${activeWidths.left}px`;
  outlinePanel.style.width = `${activeWidths.left}px`;
  outlinePanel.style.minWidth = `${SIDEBAR_LIMITS.left.min}px`;

  assistantPanel.style.flex = `0 0 ${activeWidths.right}px`;
  assistantPanel.style.width = `${activeWidths.right}px`;
  assistantPanel.style.minWidth = `${SIDEBAR_LIMITS.right.min}px`;

  mainPanel.style.flex = '1 1 auto';
  mainPanel.style.minWidth = `${SIDEBAR_LIMITS.centerMin}px`;
}

function setupSidebarResizers() {
  if (!leftResizer || !rightResizer) {
    return;
  }

  const startResize = (side, event) => {
    if (event && event.button !== undefined && event.button !== 0) {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    const widths = getSidebarWidthsSnapshot();
    const layoutBox = layoutRoot.getBoundingClientRect();
    resizeSession = {
      side,
      startX: event.clientX,
      widthsAtStart: widths,
      layoutWidth: layoutBox.width
    };
    layoutPreviewWidths = { ...widths };
    layoutRoot.classList.add('is-resizing');
    document.body.classList.add('is-resizing');
    if (side === 'left') {
      leftResizer.classList.add('is-active');
    } else {
      rightResizer.classList.add('is-active');
    }
    window.addEventListener('pointermove', handleResizeMove);
    window.addEventListener('pointerup', handleResizeEnd);
    window.addEventListener('pointercancel', handleResizeEnd);
  };

  leftResizer.addEventListener('pointerdown', (event) => startResize('left', event));
  rightResizer.addEventListener('pointerdown', (event) => startResize('right', event));
}

function handleResizeMove(event) {
  if (!resizeSession) {
    return;
  }
  event.preventDefault();
  const delta = event.clientX - resizeSession.startX;
  const nextWidths = { ...resizeSession.widthsAtStart };
  const totalWidth = resizeSession.layoutWidth;
  if (resizeSession.side === 'left') {
    let candidate = clampSidebarWidth('left', resizeSession.widthsAtStart.left + delta);
    const maxLeft =
      totalWidth - resizeSession.widthsAtStart.right - SIDEBAR_LIMITS.centerMin - LAYOUT_RESIZER_COUNT * LAYOUT_RESIZER_WIDTH;
    if (maxLeft >= SIDEBAR_LIMITS.left.min) {
      candidate = Math.min(candidate, maxLeft);
    }
    nextWidths.left = clampSidebarWidth('left', candidate);
  } else {
    let candidate = clampSidebarWidth('right', resizeSession.widthsAtStart.right - delta);
    const maxRight =
      totalWidth - resizeSession.widthsAtStart.left - SIDEBAR_LIMITS.centerMin - LAYOUT_RESIZER_COUNT * LAYOUT_RESIZER_WIDTH;
    if (maxRight >= SIDEBAR_LIMITS.right.min) {
      candidate = Math.min(candidate, maxRight);
    }
    nextWidths.right = clampSidebarWidth('right', candidate);
  }

  let centerWidth = computeCenterWidth(totalWidth, nextWidths.left, nextWidths.right);
  if (centerWidth < SIDEBAR_LIMITS.centerMin) {
    if (resizeSession.side === 'left') {
      const maxLeft =
        totalWidth -
        nextWidths.right -
        SIDEBAR_LIMITS.centerMin -
        LAYOUT_RESIZER_COUNT * LAYOUT_RESIZER_WIDTH;
      nextWidths.left = clampSidebarWidth('left', maxLeft);
    } else {
      const maxRight =
        totalWidth -
        nextWidths.left -
        SIDEBAR_LIMITS.centerMin -
        LAYOUT_RESIZER_COUNT * LAYOUT_RESIZER_WIDTH;
      nextWidths.right = clampSidebarWidth('right', maxRight);
    }
    centerWidth = computeCenterWidth(totalWidth, nextWidths.left, nextWidths.right);
    if (centerWidth < SIDEBAR_LIMITS.centerMin) {
      nextWidths.left = resizeSession.widthsAtStart.left;
      nextWidths.right = resizeSession.widthsAtStart.right;
    }
  }

  layoutPreviewWidths = nextWidths;
  applyLayoutWidths(nextWidths);
}

function handleResizeEnd(event) {
  if (!resizeSession) {
    return;
  }
  if (event) {
    event.preventDefault();
    event.stopPropagation();
  }
  window.removeEventListener('pointermove', handleResizeMove);
  window.removeEventListener('pointerup', handleResizeEnd);
  window.removeEventListener('pointercancel', handleResizeEnd);
  layoutRoot.classList.remove('is-resizing');
  document.body.classList.remove('is-resizing');
  leftResizer.classList.remove('is-active');
  rightResizer.classList.remove('is-active');
  const finalWidths = layoutPreviewWidths ? normalizeSidebarWidths(layoutPreviewWidths) : resizeSession.widthsAtStart;
  resizeSession = null;
  layoutPreviewWidths = null;
  applyLayoutWidths(finalWidths);
  actions.setSidebarWidths(finalWidths);
}

function normalizeMentionKey(value) {
  if (!value || typeof value !== 'string') {
    return '';
  }
  return value.replace(/^@/, '').replace(/[^a-z0-9]+/gi, '').toLowerCase();
}

function buildCodexMentionMap(entries) {
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

function computeEntryDerivedData(entry, mentionMap) {
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

  mentionCount += collect(entry.summary || '', { kind: 'summary' });

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

function updateAllCodexRelations(entries) {
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

function refreshCodexDerivedData(draft) {
  if (!draft || !draft.codex || !draft.codex.entries) {
    return;
  }
  updateAllCodexRelations(draft.codex.entries);
}

function parseCodexSearchTokens(input) {
  if (typeof input !== 'string') {
    return [];
  }
  return input
    .split(/\s+/)
    .map((token) => token.trim())
    .filter((token) => token.length > 0)
    .map((token) => (token.startsWith('@') ? token : `@${token}`))
    .map((token) => normalizeMentionKey(token))
    .filter(Boolean);
}

function createReorderButton(direction, title, disabled, onClick) {
  const symbol = direction === 'up' ? '▲' : '▼';
  const button = createElement('button', 'outline-reorder-button', symbol);
  button.title = title;
  button.disabled = disabled;
  button.addEventListener('click', (event) => {
    event.stopPropagation();
    onClick();
  });
  button.addEventListener('mousedown', (event) => event.stopPropagation());
  return button;
}

function createReorderStack({ disableUp, disableDown, onUp, onDown }) {
  const stack = createElement('div', 'outline-reorder-stack');
  stack.appendChild(
    createReorderButton('up', 'Move up', disableUp, onUp)
  );
  stack.appendChild(
    createReorderButton('down', 'Move down', disableDown, onDown)
  );
  return stack;
}

function renderHeaderActions() {
  headerActionsRoot.innerHTML = '';

  if (!state) {
    headerActionsRoot.appendChild(createElement('span', 'app-header-loading', 'Preparing workspace…'));
    return;
  }

  const layout = createElement('div', 'header-actions-layout');

  const tabs = createElement('div', 'header-actions-tabs');
  const workspaceTab = createElement(
    'button',
    `header-tab${state.ui.activeMainView === 'workspace' ? ' is-active' : ''}`,
    'Workspace'
  );
  workspaceTab.addEventListener('click', () => actions.setActiveMainView('workspace'));
  tabs.appendChild(workspaceTab);

  const manuscriptTab = createElement(
    'button',
    `header-tab${state.ui.activeMainView === 'manuscript' ? ' is-active' : ''}`,
    'Manuscript'
  );
  manuscriptTab.addEventListener('click', () => actions.setActiveMainView('manuscript'));
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
  if (state.ui.activeMainView !== 'workspace' || !selectedScene || isScanning || !hasCodexKey) {
    scanButton.disabled = true;
  } else {
    scanButton.addEventListener('click', () => actions.startSceneScan(selectedScene.id));
  }
  if (!hasCodexKey) {
    scanButton.title = 'Add an API key for the Codex provider in Settings to enable scene scanning.';
  }
  actionGroup.appendChild(scanButton);

  const exportManuscriptButton = createElement('button', 'app-header-button', 'Export manuscript');
  exportManuscriptButton.addEventListener('click', () => actions.exportManuscript());
  actionGroup.appendChild(exportManuscriptButton);

  const exportDbButton = createElement('button', 'app-header-button', 'Export data');
  exportDbButton.addEventListener('click', () => actions.exportDatabase());
  actionGroup.appendChild(exportDbButton);

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
    } catch (_error) {
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

function renderSidebar() {
  outlineRoot.innerHTML = '';
  if (!outlineRoot.classList.contains('outline-board')) {
    outlineRoot.classList.add('outline-board');
  }

  if (!state) {
    outlineRoot.appendChild(createElement('div', 'panel-loading', 'Loading outline…'));
    return;
  }

  const sidebarView = state.ui.sidebarView === 'codex' ? 'codex' : 'outline';
  const outlineUi = state.ui.outline || { collapsedActs: [], collapsedChapters: [], expandedScenes: [] };
  const searchTokens = parseCodexSearchTokens(state.ui.codexSearch);

  const header = createElement('div', 'outline-header');
  const headerLeft = createElement('div', 'outline-header-left');
  const titleWrapper = document.createElement('div');
  const titleText = sidebarView === 'codex' ? 'Codex' : 'Outline';
  const subtitleText = sidebarView === 'codex'
    ? 'Browse Codex entries and quick-jump to reference cards.'
    : 'Acts, chapters, and scenes organised hierarchically.';
  titleWrapper.appendChild(createElement('h2', 'outline-title', titleText));
  titleWrapper.appendChild(createElement('p', 'outline-subtitle', subtitleText));
  headerLeft.appendChild(titleWrapper);

  const tabRow = createElement('div', 'sidebar-tabs');
  const outlineTab = createElement(
    'button',
    `sidebar-tab${sidebarView === 'outline' ? ' is-active' : ''}`,
    'Outline'
  );
  outlineTab.addEventListener('click', () => actions.setSidebarView('outline'));
  const codexTab = createElement(
    'button',
    `sidebar-tab${sidebarView === 'codex' ? ' is-active' : ''}`,
    'Codex'
  );
  codexTab.addEventListener('click', () => actions.setSidebarView('codex'));
  tabRow.appendChild(outlineTab);
  tabRow.appendChild(codexTab);
  headerLeft.appendChild(tabRow);

  header.appendChild(headerLeft);

  const headerActions = createElement('div', 'outline-header-actions');
  if (sidebarView === 'outline') {
    const addActButton = createElement('button', 'button-accent', '+ Act');
    addActButton.addEventListener('click', () => actions.addAct());
    headerActions.appendChild(addActButton);
  } else {
    const searchWrapper = createElement('div', 'codex-search codex-search--sidebar');
    const searchInput = document.createElement('input');
    searchInput.type = 'text';
    searchInput.className = 'codex-search-input';
    searchInput.placeholder = 'Search @mentions…';
    searchInput.value = state.ui.codexSearch || '';
    searchInput.addEventListener('input', (event) => actions.setCodexSearch(event.target.value));
    searchWrapper.appendChild(searchInput);
    if ((state.ui.codexSearch || '').length > 0) {
      const clearButton = createElement('button', 'codex-search-clear', '\u00D7');
      clearButton.type = 'button';
      clearButton.addEventListener('click', () => actions.setCodexSearch(''));
      searchWrapper.appendChild(clearButton);
    }
    headerActions.appendChild(searchWrapper);

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
  }
  if (headerActions.childElementCount > 0) {
    header.appendChild(headerActions);
  }

  outlineRoot.appendChild(header);

  if (sidebarView === 'outline') {
    outlineRoot.appendChild(buildOutlineSidebarContent(outlineUi));
  } else {
    const codexScroll = createElement('div', 'outline-scroll');
    codexScroll.appendChild(
      createCodexSidebarElement({
        tag: 'div',
        className: 'sidebar-codex',
        emptyClassName: 'codex-empty',
        entryButtonClass: 'codex-entry-button',
        searchTokens
      })
    );
    outlineRoot.appendChild(codexScroll);
  }
}

function buildOutlineSidebarContent(outlineUi) {
  const scrollRegion = createElement('div', 'outline-scroll');

  if (!state || state.acts.length === 0) {
    scrollRegion.appendChild(createElement('div', 'outline-empty', 'Start by creating an act for your story.'));
    return scrollRegion;
  }

  const sortedActs = [...state.acts].sort((a, b) => a.order - b.order);
  sortedActs.forEach((act, actIndex) => {
    const actContainer = createElement('div', 'outline-act');
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
    const actReorder = createReorderStack({
      disableUp: actIndex === 0,
      disableDown: actIndex === sortedActs.length - 1,
      onUp: () => actions.shiftAct(act.id, -1),
      onDown: () => actions.shiftAct(act.id, 1)
    });
    actTitleRow.appendChild(actReorder);
    const actTitle = document.createElement('h3');
    actTitle.className = 'outline-act-title';
    const actPrefix = document.createElement('span');
    actPrefix.className = 'outline-title-prefix';
    actPrefix.textContent = `Act ${act.order}: `;
    const actEditable = createInlineEditableText(act.title || '', {
      onCommit: (next) => actions.renameAct(act.id, next),
      className: 'outline-editable',
      allowEmpty: false
    });
    actTitle.appendChild(actPrefix);
    actTitle.appendChild(actEditable);
    actTitleRow.appendChild(actTitle);

    const actActions = createElement('div', 'outline-item-actions');
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
    actActions.appendChild(deleteActButton);

    actTitleRow.appendChild(actActions);
    actHeaderText.appendChild(actTitleRow);
    actHeaderText.appendChild(
      createElement(
        'p',
        'outline-act-summary',
        `${act.chapterIds.length} ${act.chapterIds.length === 1 ? 'chapter' : 'chapters'}`
      )
    );
    actHeader.appendChild(actHeaderText);

    const addControls = createElement('div', 'outline-add-buttons');
    if (actIndex === 0) {
      const prologueExists = act.chapterIds.some((chapterId) => state.chapters[chapterId]?.isPrologue);
      const prologueButton = createElement(
        'button',
        'button-outline outline-button-small',
        prologueExists ? 'Prologue added' : '+ Prologue'
      );
      if (prologueExists) {
        prologueButton.disabled = true;
        prologueButton.title = 'Prologue already exists for this act';
      } else {
        prologueButton.addEventListener('click', () => actions.addPrologue(act.id));
      }
      addControls.appendChild(prologueButton);
    }
    const addChapterClass = actIndex === 0 ? 'button-outline outline-button-small' : 'button-outline';
    const addChapterButton = createElement('button', addChapterClass, '+ Chapter');
    addChapterButton.addEventListener('click', () => actions.addChapter(act.id));
    addControls.appendChild(addChapterButton);
    actHeader.appendChild(addControls);

    actContainer.appendChild(actHeader);

    if (actCollapsed) {
      scrollRegion.appendChild(actContainer);
      return;
    }

    const chapterList = createElement('div', 'outline-chapter-list');
    if (act.chapterIds.length === 0) {
      chapterList.appendChild(createElement('div', 'outline-empty', 'No chapters in this act.'));
    } else {
      const prologueIndex = act.chapterIds.findIndex((chapterId) => state.chapters[chapterId]?.isPrologue);
      act.chapterIds.forEach((chapterId, chapterIndex) => {
        const chapter = state.chapters[chapterId];
        if (!chapter) {
          return;
        }
        const chapterContainer = createElement('div', 'outline-chapter');
        const chapterCollapsed = outlineUi.collapsedChapters.includes(chapter.id);
        if (chapterCollapsed) {
          chapterContainer.classList.add('is-collapsed');
        }
        const chapterHeader = createElement('div', 'outline-chapter-header');
        const chapterTitleRow = createElement('div', 'outline-chapter-title-row');
        const chapterToggle = createElement('button', 'outline-collapse-button', chapterCollapsed ? '▸' : '▾');
        chapterToggle.title = chapterCollapsed ? 'Expand chapter' : 'Collapse chapter';
        chapterToggle.addEventListener('click', (event) => {
          event.stopPropagation();
          actions.toggleChapterCollapse(chapter.id);
        });
        chapterTitleRow.appendChild(chapterToggle);

        const isPrologueChapter = Boolean(chapter.isPrologue);
        const chapterReorder = createReorderStack({
          disableUp: chapterIndex === 0 || isPrologueChapter || (prologueIndex === 0 && chapterIndex === 1),
          disableDown: chapterIndex === act.chapterIds.length - 1 || isPrologueChapter,
          onUp: () => actions.shiftChapter(chapter.id, -1),
          onDown: () => actions.shiftChapter(chapter.id, 1)
        });
        chapterTitleRow.appendChild(chapterReorder);

        const chapterTitle = document.createElement('span');
        chapterTitle.className = 'outline-chapter-chip';
        const chapterPrefix = document.createElement('span');
        chapterPrefix.className = 'outline-title-prefix';
        if (isPrologueChapter) {
          const hasTitle = typeof chapter.title === 'string' && chapter.title.trim().length > 0;
          chapterPrefix.textContent = hasTitle ? 'Prologue: ' : 'Prologue ';
        } else {
          chapterPrefix.textContent = `Ch. ${chapter.order}: `;
        }
        const chapterEditable = createInlineEditableText(chapter.title || '', {
          onCommit: (next) => actions.renameChapter(chapter.id, next),
          className: 'outline-editable',
          allowEmpty: false
        });
        chapterTitle.appendChild(chapterPrefix);
        chapterTitle.appendChild(chapterEditable);
        chapterTitleRow.appendChild(chapterTitle);

        const chapterActions = createElement('div', 'outline-item-actions');
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
        chapterActions.appendChild(deleteChapterButton);

        chapterTitleRow.appendChild(chapterActions);
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
        if (chapter.sceneIds.length === 0) {
          const emptyItem = createElement('li', 'outline-empty', 'No scenes yet. Add one to start writing.');
          sceneList.appendChild(emptyItem);
        } else {
          chapter.sceneIds.forEach((sceneId, sceneIndex) => {
            const scene = state.scenes[sceneId];
            if (!scene) {
              return;
            }
            const listItem = document.createElement('li');
            listItem.className = 'outline-scene-item';
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

            const sceneReorder = createReorderStack({
              disableUp: sceneIndex === 0,
              disableDown: sceneIndex === chapter.sceneIds.length - 1,
              onUp: () => actions.shiftScene(scene.id, -1),
              onDown: () => actions.shiftScene(scene.id, 1)
            });
            sceneRow.appendChild(sceneReorder);

            const sceneButton = createElement(
              'button',
              `scene-button${state.selectedSceneId === scene.id ? ' is-active' : ''}`
            );
            const buttonBody = createElement('div', 'scene-button-body');
            const sceneTitleLine = document.createElement('p');
            sceneTitleLine.className = 'scene-button-title';
            const scenePrefix = document.createElement('span');
            scenePrefix.className = 'outline-title-prefix';
            const orderLabel = typeof scene.order === 'number' && Number.isFinite(scene.order)
              ? scene.order
              : sceneIndex + 1;
            scenePrefix.textContent = `Scene ${orderLabel}: `;
            const sceneEditable = createInlineEditableText(scene.title || '', {
              onCommit: (next) => actions.renameScene(scene.id, next),
              className: 'outline-editable',
              allowEmpty: false
            });
            sceneEditable.addEventListener('mousedown', (event) => {
              event.stopPropagation();
              event.preventDefault();
              if (document.activeElement !== sceneEditable) {
                requestAnimationFrame(() => sceneEditable.focus());
              }
            });
            sceneEditable.addEventListener('click', (event) => {
              event.stopPropagation();
              event.preventDefault();
            });
            sceneEditable.addEventListener('focus', (event) => event.stopPropagation());
            sceneTitleLine.appendChild(scenePrefix);
            sceneTitleLine.appendChild(sceneEditable);
            buttonBody.appendChild(sceneTitleLine);
            buttonBody.appendChild(
              createElement(
                'p',
                'scene-button-meta',
                `${scene.wordCount} ${scene.wordCount === 1 ? 'word' : 'words'} · ${scene.draftStatus}`
              )
            );
            sceneButton.appendChild(buttonBody);
            sceneButton.addEventListener('click', () => actions.selectScene(scene.id));
            sceneRow.appendChild(sceneButton);

            const sceneActions = createElement('div', 'outline-item-actions scene-actions');
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
            sceneActions.appendChild(deleteSceneButton);

            sceneRow.appendChild(sceneActions);
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

  return scrollRegion;
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
  } else if (state.ui.activeMainView === 'manuscript') {
    renderManuscriptView();
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
  const locationValue = createElement(
    'span',
    'workspace-breadcrumb-value',
    formatSceneHeading(selectedScene)
  );
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
  const statUpdated = createElement('p', 'workspace-stat workspace-stat-updated', formatUpdatedAt(selectedScene.lastUpdated));
  stats.appendChild(statWords);
  stats.appendChild(statBeats);
  stats.appendChild(statStatus);
  stats.appendChild(statUpdated);
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
  const isQuickScanRunning = Boolean(state.ui.scanStatus && state.ui.scanStatus.state === 'running');
  const codexProviderId = getProviderId('codex');
  const hasCodexKey = hasApiKeyFor(codexProviderId);
  const assistantProviderId = getProviderId('assistant');
  const hasAssistantKey = hasApiKeyFor(assistantProviderId);
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

  const scanStatusState = state.ui.scanStatus && state.ui.scanStatus.sceneId === selectedScene.id ? state.ui.scanStatus : null;
  const forceExpandScanStatus = Boolean(scanStatusState && scanStatusState.state === 'running');
  const isScanCollapsed = !forceExpandScanStatus && Boolean(state.ui.sceneScanCollapsed && state.ui.sceneScanCollapsed[selectedScene.id]);
  const scanToggleLabel = isScanCollapsed ? 'Show status' : 'Hide status';
  const scanToggleButton = createQuickActionButton(scanToggleLabel, () => actions.toggleSceneScanCollapse(selectedScene.id));
  scanToggleButton.title = isScanCollapsed ? 'Show scene scan summary panel' : 'Hide scene scan summary panel';
  if (forceExpandScanStatus) {
    scanToggleButton.disabled = true;
    scanToggleButton.textContent = 'Scanning…';
    scanToggleButton.title = 'Scene status visible while scanning';
  }
  quickActions.appendChild(scanToggleButton);

  const sceneIsEmpty = !selectedScene.text || selectedScene.text.trim().length === 0;
  const sceneHasBeats = Array.isArray(selectedScene.beats) && selectedScene.beats.length > 0;
  if (sceneIsEmpty && sceneHasBeats) {
    const draftButton = createQuickActionButton(
      state.ui.generatingSceneDraft ? 'Drafting…' : 'Draft scene',
      () => actions.generateSceneDraft(selectedScene.id)
    );
    draftButton.disabled = state.ui.generatingSceneDraft || !hasAssistantKey;
    draftButton.title = hasAssistantKey
      ? 'Use the AI assistant to draft this scene based on its beats.'
      : 'Add an API key for the writing provider in Settings to generate scene drafts.';
    quickActions.appendChild(draftButton);
  }
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
    statUpdated.textContent = formatUpdatedAt(latestScene.lastUpdated);
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
      statUpdated.textContent = formatUpdatedAt(latestScene.lastUpdated);
    };
  } else {
    const editor = createElement('div', 'workspace-editor');
    const textPanel = createElement('div', 'editor-panel');
    const textarea = document.createElement('textarea');
    textarea.className = 'workspace-textarea';
    textarea.value = selectedScene.text;
    textarea.placeholder = 'Draft your scene here...';
    textarea.setAttribute('aria-label', 'Scene text');

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
      statUpdated.textContent = formatUpdatedAt(latestScene.lastUpdated);
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

  if (!isScanCollapsed || forceExpandScanStatus) {
    body.appendChild(renderSceneScanStatus(selectedScene));
  }

  shell.appendChild(body);
  root.appendChild(shell);

  if (editorTextarea) {
    restoreEditorFocusIfNeeded(editorTextarea, selectedScene.id);
    refreshSceneIndicators();
  }
}

function renderManuscriptView() {
  const root = mainRoot;
  if (!root) {
    return;
  }
  root.innerHTML = '';

  if (!state) {
    root.appendChild(createElement('div', 'panel-loading', 'Loading manuscript…'));
    return;
  }

  const orderedActs = [...state.acts].sort((a, b) => (a.order || 0) - (b.order || 0));
  const manuscript = createElement('div', 'manuscript-view');

  if (orderedActs.length === 0) {
    manuscript.appendChild(createElement('p', 'manuscript-empty', 'No scenes yet. Add scenes to build your manuscript.'));
    root.appendChild(manuscript);
    return;
  }

  orderedActs.forEach((act) => {
    const actSection = createElement('section', 'manuscript-act');
    actSection.appendChild(
      createElement('h2', 'manuscript-act-title', act.title && act.title.trim().length > 0 ? act.title : `Act ${act.order}`)
    );

    const chapters = (act.chapterIds || [])
      .map((chapterId) => state.chapters[chapterId])
      .filter(Boolean)
      .sort((a, b) => (a.order || 0) - (b.order || 0));

    chapters.forEach((chapter) => {
      const chapterBlock = createElement('section', 'manuscript-chapter');
      const chapterTitle = typeof chapter.title === 'string' ? chapter.title.trim() : '';
      const chapterHeading = chapter.isPrologue
        ? (chapterTitle.length > 0 ? `Prologue: ${chapterTitle}` : 'Prologue')
        : (chapterTitle.length > 0
            ? chapterTitle
            : `Chapter ${typeof chapter.order === 'number' && chapter.order > 0 ? chapter.order : ''}`.trim());
      chapterBlock.appendChild(
        createElement('h3', 'manuscript-chapter-title', chapterHeading)
      );

      const scenes = (chapter.sceneIds || [])
        .map((sceneId) => state.scenes[sceneId])
        .filter(Boolean)
        .sort((a, b) => (a.order || 0) - (b.order || 0));

      scenes.forEach((scene) => {
        const sceneBlock = createElement('article', 'manuscript-scene');
        const sceneHeading = createElement(
          'h4',
          'manuscript-scene-title',
          scene.title && scene.title.trim().length > 0 ? scene.title : `Scene ${scene.order}`
        );
        sceneBlock.appendChild(sceneHeading);

        const meta = createElement(
          'p',
          'manuscript-scene-meta',
          `${scene.wordCount || 0} ${scene.wordCount === 1 ? 'word' : 'words'} · ${scene.draftStatus || 'unknown'}`
        );
        sceneBlock.appendChild(meta);

        const textContent = scene.text && scene.text.trim().length > 0 ? scene.text : '(Scene is empty)';
        const textNode = document.createElement('pre');
        textNode.className = 'manuscript-scene-text';
        textNode.textContent = textContent;
        sceneBlock.appendChild(textNode);

        chapterBlock.appendChild(sceneBlock);
      });

      if (scenes.length === 0) {
        chapterBlock.appendChild(createElement('p', 'manuscript-empty', 'No scenes in this chapter yet.'));
      }

      actSection.appendChild(chapterBlock);
    });

    if (chapters.length === 0) {
      actSection.appendChild(createElement('p', 'manuscript-empty', 'No chapters in this act yet.'));
    }

    manuscript.appendChild(actSection);
  });

  root.appendChild(manuscript);
}

function createQuickActionButton(label, onClick) {
  const button = createElement('button', 'button-ghost', label);
  button.addEventListener('click', onClick);
  return button;
}

function formatScanSummary(scene, activeStatus) {
  if (activeStatus) {
    if (activeStatus.state === 'running') {
      return activeStatus.detail || activeStatus.message || 'Scanning in progress…';
    }
    if (activeStatus.state === 'error') {
      return 'Scan failed';
    }
    const completedAt = activeStatus.completedAt
      ? new Date(activeStatus.completedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
      : 'just now';
    return `Last scan ${completedAt}`;
  }
  if (scene.lastScan) {
    const completedAt = scene.lastScan.timestamp
      ? new Date(scene.lastScan.timestamp).toLocaleDateString()
      : 'recently';
    return `Last scan ${completedAt}`;
  }
  return 'No scans yet';
}

function renderSceneScanStatus(scene) {
  const activeStatus = state.ui.scanStatus && state.ui.scanStatus.sceneId === scene.id ? state.ui.scanStatus : null;
  const block = createElement('div', 'scan-status');
  const header = createElement('div', 'scan-status-header');
  const toggle = createElement('button', 'scan-status-toggle', '▾');
  toggle.title = 'Collapse status panel';
  if (activeStatus && activeStatus.state === 'running') {
    toggle.disabled = true;
    toggle.title = 'Scan in progress';
  }
  toggle.addEventListener('click', () => actions.toggleSceneScanCollapse(scene.id));
  header.appendChild(toggle);
  header.appendChild(createElement('span', 'scan-status-label', 'Scene scan status'));
  header.appendChild(createElement('span', 'scan-status-summary', formatScanSummary(scene, activeStatus)));
  block.appendChild(header);

  const content = createElement('div', 'scan-status-content');

  if (!activeStatus) {
    if (scene.lastScan) {
      const provider = AI_PROVIDERS.find((item) => item.id === scene.lastScan.providerId);
      const providerLabel = provider ? provider.label : scene.lastScan.providerId || 'Unknown provider';
      const completedAt = scene.lastScan.timestamp ? new Date(scene.lastScan.timestamp).toLocaleString() : 'Unknown time';
      content.appendChild(createElement('p', 'scan-status-detail', `Last scan completed ${completedAt}.`));
      content.appendChild(
        createElement(
          'p',
          'scan-status-detail',
          `Provider: ${providerLabel}. New entries: ${scene.lastScan.created || 0}. Updated entries: ${scene.lastScan.updated || 0}.`
        )
      );
      if (scene.lastScan.summary) {
        content.appendChild(createElement('p', 'scan-status-detail', `Scene notes: ${scene.lastScan.summary}`));
      }
      if (Array.isArray(scene.lastScan.entries) && scene.lastScan.entries.length > 0) {
        content.appendChild(
          createElement('p', 'scan-status-detail', `Affected codex entries: ${scene.lastScan.entries.join(', ')}`)
        );
      }
    } else {
      content.appendChild(createElement('p', 'scan-status-detail', 'No scan has run for this scene yet.'));
      content.appendChild(
        createElement('p', 'scan-status-detail', 'Use “Scan scene” to extract new Codex details from this draft.')
      );
    }
    block.appendChild(content);
    return block;
  }

  if (activeStatus.state === 'running') {
    content.appendChild(
      createElement('p', 'scan-status-detail', activeStatus.detail || activeStatus.message || 'Scanning in progress…')
    );
    if (activeStatus.step) {
      content.appendChild(createElement('p', 'scan-status-detail', `Step: ${activeStatus.step}`));
    } else {
      content.appendChild(createElement('p', 'scan-status-detail', 'Chunking scene and preparing Codex updates.'));
    }
    block.appendChild(content);
    return block;
  }

  if (activeStatus.state === 'error') {
    content.appendChild(createElement('p', 'scan-status-detail', 'Scan failed.'));
    content.appendChild(createElement('p', 'scan-status-detail', activeStatus.message || 'Unknown error.'));
    const retryButton = createElement('button', 'settings-secondary', 'Clear status');
    retryButton.addEventListener('click', () => actions.resetScanStatus());
    const actionsRow = createElement('div', 'settings-actions');
    actionsRow.appendChild(retryButton);
    content.appendChild(actionsRow);
    block.appendChild(content);
    return block;
  }

  const providerId = activeStatus.providerId || getProviderId('codex');
  const provider = AI_PROVIDERS.find((item) => item.id === providerId);
  const providerLabel = provider ? provider.label : providerId;
  const completedAt = activeStatus.completedAt ? new Date(activeStatus.completedAt).toLocaleString() : 'just now';
  content.appendChild(createElement('p', 'scan-status-detail', `Last scan completed ${completedAt}.`));
  content.appendChild(createElement('p', 'scan-status-detail', `Provider: ${providerLabel}.`));
  if (activeStatus.message) {
    content.appendChild(createElement('p', 'scan-status-detail', activeStatus.message));
  }

  const resetButton = createElement('button', 'settings-secondary', 'Reset status');
  resetButton.addEventListener('click', () => actions.resetScanStatus());
  const actionsRow = createElement('div', 'settings-actions');
  actionsRow.appendChild(resetButton);
  content.appendChild(actionsRow);

  block.appendChild(content);
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
      lines.push(`  Ch. ${chapterLabel} (${chapter?.id || 'C?'}): ${chapter?.title || 'Untitled Chapter'}`);

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

function buildSceneDraftPrompt(appState, scene, options = {}) {
  if (!appState || !scene) {
    return '';
  }

  const lines = [
    `Draft the full scene "${scene.title || 'Untitled Scene'}" in polished narrative prose.`,
    'Target roughly 600-900 words unless the user specifies otherwise. Maintain continuity with the established story voice.'
  ];

  const beatLines = getBeatSummaryLines(scene, '    ');
  if (beatLines.length > 0) {
    lines.push('Scene beats (follow these sequentially):', beatLines.join('\n'));
  }

  if (options.previousSummary) {
    lines.push(options.previousSummary);
  }
  if (options.nextSummary) {
    lines.push(options.nextSummary);
  }

  if (options.storyOutline) {
    lines.push('Story outline snapshot:', options.storyOutline);
  }

  if (options.codexSummary) {
    lines.push('Relevant Codex highlights:', options.codexSummary);
  }

  if (options.selectionContext) {
    lines.push('Author notes / highlighted excerpt:', options.selectionContext);
  }

  if (options.userGuidance) {
    lines.push('Author guidance:', options.userGuidance);
  }

  if (options.sceneExcerpt) {
    lines.push('Existing manuscript excerpt:', options.sceneExcerpt);
  }

  lines.push(
    'Write the scene in third-person unless the beats indicate otherwise, keeping character voice and mood consistent.',
    'Return only the completed scene text with line breaks where appropriate.'
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
  } catch (_error) {
    const match = content.match(/\{[\s\S]*\}/);
    if (match) {
      return JSON.parse(match[0]);
    }
    throw _error;
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

function createCodexEntryContent(entry, options = {}) {
  const {
    wrapperClass = 'codex-entry',
    showTitleRow = true,
    showHeaderActions = true
  } = options;

  if (!entry) {
    return createElement('div', wrapperClass, 'Entry not found.');
  }

  const entryWrapper = createElement('div', wrapperClass);

  if (showTitleRow) {
    const titleRow = createElement('div', 'codex-entry-title-row');
    titleRow.appendChild(createElement('h3', 'codex-entry-name', entry.name));
    if (showHeaderActions) {
      const titleActions = createElement('div', 'codex-entry-actions');
      const renameButton = createElement('button', 'button-icon', '✎');
      renameButton.title = 'Rename entry';
      renameButton.addEventListener('click', () => {
        const nextName = window.prompt('Rename entry', entry.name);
        if (nextName !== null) {
          actions.renameCodexEntry(entry.id, nextName);
        }
      });
      titleActions.appendChild(renameButton);

      const deleteButton = createElement('button', 'codex-delete-button', 'Delete');
      deleteButton.addEventListener('click', () => {
        if (window.confirm('Delete this Codex entry? This cannot be undone.')) {
          actions.deleteCodexEntry(entry.id);
        }
      });
      titleActions.appendChild(deleteButton);
      titleRow.appendChild(titleActions);
    }
    entryWrapper.appendChild(titleRow);
  }

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
  categorySelect.value = entry.category;
  categorySelect.addEventListener('change', (event) => {
    actions.updateCodexCategory(entry.id, event.target.value);
  });
  categoryRow.appendChild(categorySelect);
  entryWrapper.appendChild(categoryRow);

  const summarySection = createElement('section', 'codex-summary-section');
  summarySection.appendChild(createElement('label', 'codex-summary-label', 'Summary'));
  const summaryArea = document.createElement('textarea');
  summaryArea.className = 'codex-summary-textarea';
  summaryArea.placeholder = 'Write a short description that captures the essence of this entry.';
  summaryArea.value = entry.summary || '';
  summaryArea.addEventListener('blur', (event) => {
    actions.updateCodexSummary(entry.id, event.target.value);
  });
  summarySection.appendChild(summaryArea);
  entryWrapper.appendChild(summarySection);

  entryWrapper.appendChild(renderCodexMediaSection(entry));
  entryWrapper.appendChild(renderCodexRelations(entry));

  if (entry.category === 'character') {
    entryWrapper.appendChild(renderCharacterCoreSections(entry));
    entryWrapper.appendChild(renderCharacterDynamicSection(entry, state));
  } else {
    entryWrapper.appendChild(renderGenericCodexDetailsSection(entry, state));
  }

  return entryWrapper;
}

function createCodexSidebarDetail(entry) {
  const detail = createElement('div', 'codex-sidebar-detail');
  const header = createElement('div', 'codex-sidebar-detail-header');
  const backButton = createElement('button', 'codex-sidebar-back', '← Back');
  backButton.addEventListener('click', () => actions.closeCodexSidebarEntry());
  header.appendChild(backButton);
  header.appendChild(createElement('h3', 'codex-sidebar-title', entry.name));

  const headerActions = createElement('div', 'codex-sidebar-header-actions');
  const renameButton = createElement('button', 'button-icon', '✎');
  renameButton.title = 'Rename entry';
  renameButton.addEventListener('click', () => {
    const nextName = window.prompt('Rename entry', entry.name);
    if (nextName !== null) {
      actions.renameCodexEntry(entry.id, nextName);
    }
  });
  headerActions.appendChild(renameButton);

  const deleteButton = createElement('button', 'codex-delete-button', 'Delete');
  deleteButton.addEventListener('click', () => {
    if (window.confirm('Delete this Codex entry? This cannot be undone.')) {
      actions.deleteCodexEntry(entry.id);
      actions.closeCodexSidebarEntry();
    }
  });
  headerActions.appendChild(deleteButton);
  header.appendChild(headerActions);
  detail.appendChild(header);

  const content = createCodexEntryContent(entry, {
    wrapperClass: 'codex-entry codex-entry--sidebar',
    showTitleRow: false,
    showHeaderActions: false
  });
  detail.appendChild(content);
  return detail;
}

function buildChatSystemPrompt(appState) {
  const lines = [
    'You are the SimpleWriter assistant. Treat beat summaries as the authoritative outline for the story world.',
    'Your priority is to comply with the author’s requests: draft scenes, continue prose, revise text, or brainstorm on command.',
    'Use beats, outline data, and supplied excerpts to stay grounded, but when details are missing, make confident creative choices that fit the established tone.',
    'Never refuse direct writing or planning tasks unless the user asks for something explicitly disallowed.',
    'When the user asks for prose, respond with the requested text first, keeping any commentary brief and optional.'
  ];

  const beatOutline = buildBeatOutlineSnapshot(appState);
  if (beatOutline) {
    lines.push('Story beat outline (primary reference):', beatOutline);
  }

  const outline = buildOutlineSummary(appState);
  if (outline) {
    lines.push('Outline snapshot (secondary reference):', outline);
  }

  const selectedScene = appState.selectedSceneId ? appState.scenes[appState.selectedSceneId] : null;
  if (selectedScene) {
    const sceneHeading = `Current scene (${selectedScene.id || 'S?'} · ${selectedScene.title || 'Untitled Scene'} — ${selectedScene.wordCount || 0} words)`;
    lines.push(sceneHeading);

    const currentBeatLines = getBeatSummaryLines(selectedScene);
    if (currentBeatLines.length > 0) {
      lines.push('Current scene beats:', currentBeatLines.join('\n'));
    }

    const sceneExcerpt = buildManuscriptExcerpt(selectedScene.text || '');
    if (sceneExcerpt) {
      lines.push('Current scene manuscript excerpt:', sceneExcerpt);
    }

    const orderedSceneIds = getOrderedSceneIds(appState);
    const currentIndex = orderedSceneIds.indexOf(appState.selectedSceneId);
    if (currentIndex > 0) {
      const previousScene = appState.scenes[orderedSceneIds[currentIndex - 1]];
      if (previousScene) {
        lines.push(`Previous scene (${previousScene.id || 'S?'} · ${previousScene.title || 'Untitled Scene'})`);
        const previousBeats = getBeatSummaryLines(previousScene);
        if (previousBeats.length > 0) {
          lines.push('Previous scene beats:', previousBeats.join('\n'));
        }
        const previousExcerpt = buildManuscriptExcerpt(previousScene.text || '', 600);
        if (previousExcerpt) {
          lines.push('Previous scene manuscript excerpt:', previousExcerpt);
        }
      }
    }
    if (currentIndex >= 0 && currentIndex < orderedSceneIds.length - 1) {
      const nextScene = appState.scenes[orderedSceneIds[currentIndex + 1]];
      if (nextScene) {
        lines.push(`Next scene (${nextScene.id || 'S?'} · ${nextScene.title || 'Untitled Scene'})`);
        const nextBeats = getBeatSummaryLines(nextScene);
        if (nextBeats.length > 0) {
          lines.push('Next scene beats:', nextBeats.join('\n'));
        }
        const nextExcerpt = buildManuscriptExcerpt(nextScene.text || '', 600);
        if (nextExcerpt) {
          lines.push('Next scene manuscript excerpt:', nextExcerpt);
        }
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

function formatDetailTag(detail) {
  if (!detail) {
    return null;
  }
  if (detail.sourceBeatId) {
    return `[${detail.sourceBeatId}]`;
  }
  if (detail.sourceSceneId) {
    return `[${detail.sourceSceneId}]`;
  }
  return null;
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

  updateAllCodexRelations(draft.codex.entries);

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
  if (scene.beats.length === 0) {
    list.appendChild(
      createElement(
        'li',
        'beat-empty',
        'No beats yet. Use “Generate beats” in the assistant or add beats manually to guide your drafting.'
      )
    );
  } else {
    scene.beats.forEach((beat, beatIndex) => {
      const item = createElement('li', 'beat-item');
      const beatHeader = createElement('div', 'beat-item-header');
      beatHeader.appendChild(createElement('p', 'beat-item-label', `Beat ${beat.order}`));

      const beatControls = createElement('div', 'beat-item-controls');
      beatControls.appendChild(
        createReorderButton('up', 'Move beat up', beatIndex === 0, () =>
          actions.shiftBeat(scene.id, beat.id, -1)
        )
      );
      beatControls.appendChild(
        createReorderButton('down', 'Move beat down', beatIndex === scene.beats.length - 1, () =>
          actions.shiftBeat(scene.id, beat.id, 1)
        )
      );

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
      beatControls.appendChild(deleteBeatButton);

      beatHeader.appendChild(beatControls);
      item.appendChild(beatHeader);

      const titleInput = document.createElement('input');
      titleInput.className = 'beat-title-input';
      titleInput.type = 'text';
      titleInput.value = beat.title || '';
      titleInput.placeholder = 'Beat title';
      const commitTitle = () => actions.updateBeat(scene.id, beat.id, { title: titleInput.value });
      titleInput.addEventListener('blur', commitTitle);
      titleInput.addEventListener('keydown', (event) => {
        if (event.key === 'Enter') {
          event.preventDefault();
          commitTitle();
        }
      });
      item.appendChild(titleInput);

      const summaryArea = document.createElement('textarea');
      summaryArea.className = 'beat-summary-input';
      summaryArea.placeholder = 'Beat summary…';
      summaryArea.value = beat.summary || '';
      summaryArea.rows = 3;
      const commitSummary = () => actions.updateBeat(scene.id, beat.id, { summary: summaryArea.value });
      summaryArea.addEventListener('blur', commitSummary);
      item.appendChild(summaryArea);

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
  panel.appendChild(thread);
  requestAnimationFrame(() => {
    thread.scrollTop = thread.scrollHeight;
  });

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

  let sendButton = null;

  const input = document.createElement('textarea');
  input.className = 'assistant-input';
  input.placeholder = 'Ask for revisions, summaries, or Codex updates…';
  input.value = state.ui.chatInput;
  input.rows = 3;
  input.addEventListener('input', (event) => {
    const nextValue = event.target.value;
    if (sendButton) {
      sendButton.disabled = chatState.isSending || nextValue.trim().length === 0;
    }
    markChatInputFocus(input.selectionStart, input.selectionEnd);
    actions.setChatInput(nextValue);
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
  sendButton = createElement('button', 'assistant-send', chatState.isSending ? 'Sending…' : 'Send');
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

function extractOrderFromId(id, pattern) {
  if (typeof id !== 'string') {
    return null;
  }
  const match = id.match(pattern);
  if (!match || !match[1]) {
    return null;
  }
  const parsed = Number.parseInt(match[1], 10);
  return Number.isNaN(parsed) ? null : parsed;
}

function formatActDisplayTitle(act) {
  if (!act) {
    return '';
  }
  const order =
    typeof act.order === 'number' && Number.isFinite(act.order)
      ? act.order
      : extractOrderFromId(act.id, /^A(\d+)$/);
  const orderLabel = order ?? '?';
  const title = typeof act.title === 'string' ? act.title.trim() : '';
  return title.length > 0 ? `Act ${orderLabel}: ${title}` : `Act ${orderLabel}`;
}

function formatChapterDisplayTitle(chapter) {
  if (!chapter) {
    return '';
  }
  const title = typeof chapter.title === 'string' ? chapter.title.trim() : '';
  if (chapter.isPrologue) {
    return title.length > 0 ? `Prologue: ${title}` : 'Prologue';
  }
  const order =
    typeof chapter.order === 'number' && Number.isFinite(chapter.order)
      ? chapter.order
      : extractOrderFromId(chapter.id, /\.C(\d+)$/);
  const orderLabel = order ?? '?';
  return title.length > 0 ? `Ch. ${orderLabel}: ${title}` : `Ch. ${orderLabel}`;
}

function formatSceneHeading(scene, fallbackIndex = null) {
  if (!scene) {
    return 'Scene';
  }
  const order =
    typeof scene.order === 'number' && Number.isFinite(scene.order)
      ? scene.order
      : Number.isInteger(fallbackIndex)
        ? fallbackIndex + 1
        : extractOrderFromId(scene.id, /\.S(\d+)$/);
  const orderLabel = order ?? '?';
  const title = typeof scene.title === 'string' ? scene.title.trim() : '';
  if (title.length > 0) {
    return `Scene ${orderLabel}: ${title}`;
  }
  return `Scene ${orderLabel}: `;
}

function createSceneLocation(scene) {
  const chapter = state.chapters[scene.chapterId];
  const act = chapter ? state.acts.find((item) => item.id === chapter.actId) : null;
  const parts = [];
  if (act) {
    const actLabel = formatActDisplayTitle(act);
    if (actLabel) {
      parts.push(actLabel);
    }
  }
  if (chapter) {
    const chapterLabel = formatChapterDisplayTitle(chapter);
    if (chapterLabel) {
      parts.push(chapterLabel);
    }
  }
  return parts.join(' › ');
}

function formatUpdatedAt(value) {
  if (!value) {
    return 'Updated: not yet saved';
  }
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    return 'Updated: not yet saved';
  }
  const now = new Date();
  const sameDay = parsed.toDateString() === now.toDateString();
  const timeLabel = parsed.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  return sameDay ? `Updated ${timeLabel}` : `Updated ${parsed.toLocaleDateString()} ${timeLabel}`;
}

function createCodexSidebarElement(options = {}) {
  const {
    tag = 'aside',
    className = 'codex-main-sidebar',
    emptyClassName = 'codex-empty',
    entryButtonClass = 'codex-entry-button',
    searchTokens = [],
    allowSidebarDetail = true
  } = options;

  const container = document.createElement(tag);
  if (className) {
    container.className = className;
  }

  if (!state || !state.codex || !state.codex.entries) {
    container.appendChild(createElement('p', emptyClassName, 'No entries yet. Add details as you write.'));
    return container;
  }

  const grouped = groupCodexEntries(searchTokens);
  const sidebarState =
    state.ui && state.ui.codexSidebar ? state.ui.codexSidebar : { collapsedCategories: [], selectedEntryId: null };
  const selectedSidebarEntryId = allowSidebarDetail ? sidebarState.selectedEntryId : null;
  if (allowSidebarDetail && selectedSidebarEntryId) {
    const entry = state.codex.entries[selectedSidebarEntryId];
    if (entry && codexEntryMatchesTokens(entry, searchTokens)) {
      container.appendChild(createCodexSidebarDetail(entry));
      return container;
    }
  }
  const categoryKeys = Object.keys(grouped).filter((key) => grouped[key] && grouped[key].length > 0);
  if (categoryKeys.length === 0) {
    container.appendChild(createElement('p', emptyClassName, 'No Codex entries match the current filters.'));
    return container;
  }

  const collapsedCategories =
    Array.isArray(sidebarState.collapsedCategories)
      ? sidebarState.collapsedCategories
      : [];

  categoryKeys
    .sort((a, b) => (CATEGORY_LABELS[a] || a).localeCompare(CATEGORY_LABELS[b] || b))
    .forEach((category) => {
      const entries = grouped[category];
      if (!entries || entries.length === 0) {
        return;
      }
      const section = document.createElement('details');
      section.className = 'codex-category';
      let isInitializing = true;
      if (!collapsedCategories.includes(category)) {
        section.open = true;
      }
      section.addEventListener('toggle', () => {
        if (isInitializing) {
          return;
        }
        const shouldCollapse = !section.open;
        const collapsed = state.ui.codexSidebar && Array.isArray(state.ui.codexSidebar.collapsedCategories)
          ? state.ui.codexSidebar.collapsedCategories
          : [];
        const isCollapsed = collapsed.includes(category);
        if (shouldCollapse === isCollapsed) {
          return;
        }
        actions.toggleCodexCategoryCollapse(category, section.open);
      });

      const summary = document.createElement('summary');
      summary.className = 'codex-category-summary';
      summary.textContent = `${CATEGORY_LABELS[category] || category} (${entries.length})`;
      section.appendChild(summary);

      const list = createElement('ul', 'codex-entry-list');
      entries.forEach((entry) => {
        const item = document.createElement('li');
        const mentionCount = entry.stats && typeof entry.stats.mentionCount === 'number' ? entry.stats.mentionCount : 0;
        const label = mentionCount > 0 ? `${entry.name} · ${mentionCount}` : entry.name;
        const isActive =
          state.codex.selectedId === entry.id ||
          (allowSidebarDetail && selectedSidebarEntryId === entry.id);
        const button = createElement(
          'button',
          `${entryButtonClass}${isActive ? ' is-active' : ''}`,
          label
        );
        button.addEventListener('click', () => {
          actions.selectCodexEntry(entry.id);
          if (allowSidebarDetail) {
            actions.openCodexSidebarEntry(entry.id);
          } else {
            actions.closeCodexSidebarEntry();
          }
        });
        item.appendChild(button);
        list.appendChild(item);
      });
      section.appendChild(list);
      isInitializing = false;
      container.appendChild(section);
    });

  return container;
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

  const searchTokens = parseCodexSearchTokens(state.ui.codexSearch);
  const groupedEntries = groupCodexEntries(searchTokens);
  const hasResults = Object.values(groupedEntries).some((list) => list.length > 0);

  const container = createElement('div', 'codex-full');
  const header = createElement('header', 'codex-main-header');
  const headerText = document.createElement('div');
  headerText.appendChild(createElement('h2', 'codex-title', 'Codex'));
  headerText.appendChild(
    createElement('p', 'codex-subtitle', 'Track characters, places, items, and lore from your manuscript.')
  );
  header.appendChild(headerText);

  const headerActions = createElement('div', 'codex-main-header-actions');
  const searchWrapper = createElement('div', 'codex-search');
  const searchInput = document.createElement('input');
  searchInput.type = 'text';
  searchInput.className = 'codex-search-input';
  searchInput.placeholder = 'Search @mentions…';
  searchInput.value = state.ui.codexSearch || '';
  searchInput.addEventListener('input', (event) => actions.setCodexSearch(event.target.value));
  searchWrapper.appendChild(searchInput);
  if ((state.ui.codexSearch || '').length > 0) {
    const clearButton = createElement('button', 'codex-search-clear', '\u00D7');
    clearButton.type = 'button';
    clearButton.addEventListener('click', () => actions.setCodexSearch(''));
    searchWrapper.appendChild(clearButton);
  }
  headerActions.appendChild(searchWrapper);

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

  const sidebar = createCodexSidebarElement({ searchTokens, allowSidebarDetail: false });
  body.appendChild(sidebar);

  const content = createElement('div', 'codex-main-content');
  let selectedEntry = state.codex.selectedId ? state.codex.entries[state.codex.selectedId] : null;
  if (selectedEntry && !codexEntryMatchesTokens(selectedEntry, searchTokens)) {
    selectedEntry = null;
  }
  if (!hasResults) {
    content.appendChild(
      createElement(
        'div',
        'codex-placeholder',
        searchTokens.length > 0
          ? 'No Codex entries match the current @mention search.'
          : 'No Codex entries found yet. Add details as you write.'
      )
    );
  } else if (!selectedEntry) {
    content.appendChild(createElement('div', 'codex-placeholder', 'Select a Codex entry to view details.'));
  } else {
    const entryWrapper = createCodexEntryContent(selectedEntry);
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

function renderCodexRelations(entry) {
  const section = createElement('section', 'codex-relations');
  section.appendChild(createElement('h4', 'codex-section-title', 'Relationships'));

  const outgoing = Array.isArray(entry?.relations) ? entry.relations : [];
  const incoming = Array.isArray(entry?.relatedBy) ? entry.relatedBy : [];

  if (outgoing.length === 0 && incoming.length === 0) {
    section.appendChild(createElement('p', 'codex-relations-empty', 'No relationships captured yet.'));
    return section;
  }

  if (outgoing.length > 0) {
    const group = createElement('div', 'codex-relation-group');
    group.appendChild(createElement('h5', 'codex-relation-heading', 'Connected to'));
    const list = createElement('div', 'codex-relation-list');
    outgoing.forEach((relation) => {
      if (!relation || !relation.targetId) {
        return;
      }
      const target = state.codex.entries[relation.targetId];
      if (!target) {
        return;
      }
      const item = createElement('div', 'codex-relation-item');
      const button = createElement('button', 'codex-relation-tag', target.name);
      button.addEventListener('click', () => actions.selectCodexEntry(target.id));
      item.appendChild(button);
      if (Array.isArray(relation.sources) && relation.sources.length > 0) {
        item.appendChild(
          createElement(
            'span',
            'codex-relation-meta',
            `${relation.sources.length} note${relation.sources.length === 1 ? '' : 's'}`
          )
        );
      }
      list.appendChild(item);
    });
    group.appendChild(list);
    section.appendChild(group);
  }

  if (incoming.length > 0) {
    const group = createElement('div', 'codex-relation-group');
    group.appendChild(createElement('h5', 'codex-relation-heading', 'Mentioned by'));
    const list = createElement('div', 'codex-relation-list');
    incoming.forEach((relation) => {
      if (!relation || !relation.sourceId) {
        return;
      }
      const sourceEntry = state.codex.entries[relation.sourceId];
      if (!sourceEntry) {
        return;
      }
      const item = createElement('div', 'codex-relation-item');
      const button = createElement('button', 'codex-relation-tag', sourceEntry.name);
      button.addEventListener('click', () => actions.selectCodexEntry(sourceEntry.id));
      item.appendChild(button);
      if (Array.isArray(relation.sources) && relation.sources.length > 0) {
        item.appendChild(
          createElement(
            'span',
            'codex-relation-meta',
            `${relation.sources.length} note${relation.sources.length === 1 ? '' : 's'}`
          )
        );
      }
      list.appendChild(item);
    });
    group.appendChild(list);
    section.appendChild(group);
  }

  return section;
}

function renderCodexMediaSection(entry) {
  const section = createElement('section', 'codex-media-section');
  section.appendChild(createElement('h4', 'codex-section-title', 'Images'));

  const mediaList = Array.isArray(entry?.media) ? entry.media : [];
  const controls = createElement('div', 'codex-media-controls');
  const uploadButton = createElement('button', 'button-outline', 'Upload image');
  uploadButton.type = 'button';
  const fileInput = document.createElement('input');
  fileInput.type = 'file';
  fileInput.accept = 'image/*';
  fileInput.className = 'codex-media-input';
  fileInput.addEventListener('change', (event) => {
    const files = event.target.files;
    if (!files || files.length === 0) {
      return;
    }
    const file = files[0];
    if (file.size > MAX_MEDIA_SIZE_BYTES) {
      window.alert('Image is too large (maximum size is 2 MB).');
      fileInput.value = '';
      return;
    }
    const reader = new FileReader();
    reader.addEventListener('load', () => {
      const dataUrl = typeof reader.result === 'string' ? reader.result : '';
      if (!dataUrl) {
        fileInput.value = '';
        return;
      }
      actions.addCodexMedia(entry.id, {
        name: file.name,
        type: file.type,
        size: file.size,
        dataUrl
      });
      fileInput.value = '';
    });
    reader.addEventListener('error', () => {
      console.warn('Failed to read image file for Codex entry');
      fileInput.value = '';
    });
    reader.readAsDataURL(file);
  });
  uploadButton.addEventListener('click', () => fileInput.click());
  controls.appendChild(uploadButton);
  controls.appendChild(fileInput);
  section.appendChild(controls);

  if (mediaList.length === 0) {
    section.appendChild(createElement('p', 'codex-media-empty', 'No images uploaded yet.'));
    return section;
  }

  const grid = createElement('div', 'codex-media-grid');
  mediaList.forEach((media) => {
    if (!media || typeof media.dataUrl !== 'string') {
      return;
    }
    const item = document.createElement('figure');
    item.className = 'codex-media-item';
    const image = document.createElement('img');
    image.src = media.dataUrl;
    image.alt = media.name || 'Codex image';
    item.appendChild(image);
    const caption = createElement('figcaption', 'codex-media-caption', media.name || 'Image');
    item.appendChild(caption);
    const removeButton = createElement('button', 'codex-media-remove', '\u00D7');
    removeButton.title = 'Remove image';
    removeButton.addEventListener('click', () => actions.removeCodexMedia(entry.id, media.id));
    item.appendChild(removeButton);
    grid.appendChild(item);
  });
  section.appendChild(grid);

  return section;
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
  CHARACTER_CORE_SECTION_KEYS.forEach((sectionKey) => {
    const subsection = createElement('div', 'codex-core-section');
    const header = createElement('div', 'codex-core-header');
    header.appendChild(createElement('h5', 'codex-subsection-title', CHARACTER_CORE_SECTION_LABELS[sectionKey]));
    const addButton = createElement('button', 'button-outline', '+');
    addButton.title = 'Add bullet';
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

        const tagLabel = formatDetailTag(item);
        if (tagLabel) {
          itemBody.appendChild(createElement('span', 'codex-detail-tag', tagLabel));
        }

        const removeButton = createElement('button', 'codex-core-remove', '-');
        removeButton.title = 'Remove bullet';
        removeButton.addEventListener('click', () => actions.removeCodexCoreDetail(entry.id, sectionKey, item.id));
        itemBody.appendChild(removeButton);
        itemRow.appendChild(itemBody);

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
      const sceneLabel = group.scene ? group.scene.title || group.scene.id : null;
      summary.textContent = `[${group.key}] (${group.details.length})`;
      if (sceneLabel && sceneLabel !== group.key) {
        summary.title = sceneLabel;
      }
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
      const resolvedDetail =
        detail.sourceSceneId || group.key === 'general'
          ? detail
          : { ...detail, sourceSceneId: group.key };
      const tagLabel = formatDetailTag(resolvedDetail);
      if (tagLabel) {
        controls.appendChild(createElement('span', 'codex-detail-tag', tagLabel));
      }
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

      const removeButton = createElement('button', 'codex-dynamic-remove', '-');
      removeButton.title = 'Remove note';
      removeButton.addEventListener('click', () => actions.removeCodexDetail(entry.id, detail.id));
      controls.appendChild(removeButton);

      itemRow.appendChild(controls);

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
      const tagLabel = formatDetailTag(detail);
      if (tagLabel) {
        controls.appendChild(createElement('span', 'codex-detail-tag', tagLabel));
      }
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

      const removeButton = createElement('button', 'codex-dynamic-remove', '-');
      removeButton.title = 'Remove note';
      removeButton.addEventListener('click', () => actions.removeCodexDetail(entry.id, detail.id));
      controls.appendChild(removeButton);

      item.appendChild(controls);

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

function codexEntryMatchesTokens(entry, tokens) {
  if (!entry || !Array.isArray(tokens) || tokens.length === 0) {
    return true;
  }
  const mentionKeys =
    entry.stats && Array.isArray(entry.stats.mentionKeys) ? entry.stats.mentionKeys : [];
  return tokens.every((token) => mentionKeys.includes(token));
}

function groupCodexEntries(filterTokens = []) {
  if (!state || !state.codex || !state.codex.entries) {
    return {};
  }
  const tokens = Array.isArray(filterTokens) ? filterTokens.filter(Boolean) : [];
  const grouped = {};
  Object.values(state.codex.entries).forEach((entry) => {
    if (!entry) {
      return;
    }
    if (!codexEntryMatchesTokens(entry, tokens)) {
      return;
    }
    const key = entry.category || 'lore';
    if (!grouped[key]) {
      grouped[key] = [];
    }
    grouped[key].push(entry);
  });
  Object.values(grouped).forEach((list) => {
    list.sort((a, b) => {
      const countA = a.stats && typeof a.stats.mentionCount === 'number' ? a.stats.mentionCount : 0;
      const countB = b.stats && typeof b.stats.mentionCount === 'number' ? b.stats.mentionCount : 0;
      if (countA !== countB) {
        return countB - countA;
      }
      return a.name.localeCompare(b.name);
    });
  });
  return grouped;
}

function renderAll() {
  applyLayoutWidths();
  renderHeaderActions();
  renderSidebar();
  renderMainView();
  renderAssistant();
  renderSettings();
}

setupClipboardShortcuts();
setupSidebarResizers();
applyLayoutWidths();
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
