const STORAGE_KEY = 'simplewriter-v2-state';
const CATEGORY_LABELS = {
  character: 'Characters',
  place: 'Places',
  item: 'Items',
  lore: 'Lore'
};

function createId(prefix) {
  return `${prefix}-${Math.random().toString(36).slice(2, 8)}-${Date.now().toString(36)}`;
}

function createInitialState() {
  const actId = createId('act');
  const chapterId = createId('chapter');
  const sceneId = createId('scene');
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
        beats: [],
        text: '',
        wordCount: 0,
        draftStatus: 'empty',
        lastUpdated: now
      }
    },
    codex: {
      entries: {
        [codexCharacterId]: {
          id: codexCharacterId,
          name: 'Avery Sol',
          category: 'character',
          summary: 'Protagonist and reluctant hero.',
          details: [
            { text: 'First appears in the opening scene.', sourceSceneId: null }
          ]
        },
        [codexPlaceId]: {
          id: codexPlaceId,
          name: 'Harbor District',
          category: 'place',
          summary: 'Rain-soaked sprawl where the story begins.',
          details: [
            { text: 'Establishes the noir atmosphere of the city.', sourceSceneId: sceneId }
          ]
        }
      },
      selectedId: codexCharacterId
    },
    selectedSceneId: sceneId,
    ui: {
      showBeats: true,
      showAssistant: false
    }
  };
}

function loadState() {
  if (typeof localStorage === 'undefined') {
    return createInitialState();
  }

  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) {
      return createInitialState();
    }
    const parsed = JSON.parse(raw);
    return normalizeState(parsed);
  } catch (error) {
    console.warn('Failed to load saved state, falling back to defaults.', error);
    return createInitialState();
  }
}

function normalizeState(value) {
  const base = createInitialState();
  const acts = Array.isArray(value.acts) && value.acts.length ? value.acts : base.acts;
  const chapters = value.chapters && typeof value.chapters === 'object' ? value.chapters : base.chapters;
  const scenes = value.scenes && typeof value.scenes === 'object' ? value.scenes : base.scenes;
  const codexEntries = value.codex && value.codex.entries ? value.codex.entries : base.codex.entries;
  const codexSelected = value.codex && value.codex.selectedId ? value.codex.selectedId : base.codex.selectedId;
  const ui = { ...base.ui, ...(value.ui || {}) };
  let selectedSceneId = value.selectedSceneId;

  if (!selectedSceneId || !scenes[selectedSceneId]) {
    selectedSceneId = findFirstSceneId(acts, chapters);
  }

  let codexSelectedId = codexSelected && codexEntries[codexSelected] ? codexSelected : null;
  if (!codexSelectedId) {
    const firstEntry = Object.values(codexEntries)[0];
    codexSelectedId = firstEntry ? firstEntry.id : null;
  }

  return {
    acts: acts.map((act, index) => ({
      id: act.id || createId('act'),
      title: act.title || `Act ${index + 1}`,
      order: typeof act.order === 'number' ? act.order : index + 1,
      chapterIds: Array.isArray(act.chapterIds) ? act.chapterIds : []
    })),
    chapters: Object.fromEntries(
      Object.entries(chapters).map(([id, chapter]) => [
        id,
        {
          id,
          title: chapter.title || 'Chapter',
          order: typeof chapter.order === 'number' ? chapter.order : 1,
          actId: chapter.actId,
          sceneIds: Array.isArray(chapter.sceneIds) ? chapter.sceneIds : []
        }
      ])
    ),
    scenes: Object.fromEntries(
      Object.entries(scenes).map(([id, scene]) => [
        id,
        {
          id,
          title: scene.title || 'Scene',
          order: typeof scene.order === 'number' ? scene.order : 1,
          chapterId: scene.chapterId,
          actId: scene.actId,
          beats: Array.isArray(scene.beats) ? scene.beats : [],
          text: scene.text || '',
          wordCount: typeof scene.wordCount === 'number' ? scene.wordCount : 0,
          draftStatus: scene.draftStatus || 'empty',
          lastUpdated: scene.lastUpdated || new Date().toISOString()
        }
      ])
    ),
    codex: {
      entries: Object.fromEntries(
        Object.entries(codexEntries).map(([id, entry]) => [
          id,
          {
            id,
            name: entry.name || 'Entry',
            category: entry.category || 'lore',
            summary: entry.summary || '',
            details: Array.isArray(entry.details) ? entry.details : []
          }
        ])
      ),
      selectedId: codexSelectedId
    },
    selectedSceneId,
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

const state = loadState();

function saveState() {
  if (typeof localStorage === 'undefined') {
    return;
  }
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch (error) {
    console.warn('Unable to persist state', error);
  }
}

function updateState(mutator) {
  mutator(state);
  ensureSelections();
  saveState();
  renderAll();
}

function ensureSelections() {
  let changed = false;

  if (!state.selectedSceneId || !state.scenes[state.selectedSceneId]) {
    state.selectedSceneId = findFirstSceneId(state.acts, state.chapters);
    changed = true;
  }

  if (!state.codex.selectedId || !state.codex.entries[state.codex.selectedId]) {
    const firstEntry = Object.values(state.codex.entries)[0];
    state.codex.selectedId = firstEntry ? firstEntry.id : null;
    changed = true;
  }

  if (changed) {
    saveState();
  }
}

const actions = {
  addAct(title = 'New Act') {
    updateState((draft) => {
      const id = createId('act');
      draft.acts.push({ id, title, order: draft.acts.length + 1, chapterIds: [] });
    });
  },
  addChapter(actId, title = 'New Chapter') {
    updateState((draft) => {
      const act = draft.acts.find((item) => item.id === actId);
      if (!act) {
        return;
      }
      const id = createId('chapter');
      const order = act.chapterIds.length + 1;
      draft.chapters[id] = { id, title, order, actId, sceneIds: [] };
      act.chapterIds.push(id);
    });
  },
  addScene(chapterId, title = 'New Scene') {
    updateState((draft) => {
      const chapter = draft.chapters[chapterId];
      if (!chapter) {
        return;
      }
      const id = createId('scene');
      const order = chapter.sceneIds.length + 1;
      const now = new Date().toISOString();
      draft.scenes[id] = {
        id,
        title,
        order,
        chapterId,
        actId: chapter.actId,
        beats: [],
        text: '',
        wordCount: 0,
        draftStatus: 'empty',
        lastUpdated: now
      };
      chapter.sceneIds.push(id);
      draft.selectedSceneId = id;
    });
  },
  addBeat(sceneId, title = 'New Beat') {
    updateState((draft) => {
      const scene = draft.scenes[sceneId];
      if (!scene) {
        return;
      }
      const beatId = createId('beat');
      scene.beats.push({ id: beatId, title, order: scene.beats.length + 1 });
    });
  },
  selectScene(sceneId) {
    updateState((draft) => {
      draft.selectedSceneId = sceneId;
    });
  },
  updateSceneText(sceneId, text) {
    updateState((draft) => {
      const scene = draft.scenes[sceneId];
      if (!scene) {
        return;
      }
      scene.text = text;
      scene.wordCount = text.trim().length === 0 ? 0 : text.trim().split(/\s+/).filter(Boolean).length;
      scene.draftStatus = text.trim().length === 0 ? 'empty' : 'drafted';
      scene.lastUpdated = new Date().toISOString();
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
  selectCodexEntry(entryId) {
    updateState((draft) => {
      draft.codex.selectedId = entryId;
    });
  },
  updateCodexSummary(entryId, summary) {
    updateState((draft) => {
      const entry = draft.codex.entries[entryId];
      if (!entry) {
        return;
      }
      entry.summary = summary;
    });
  }
};

const outlineRoot = document.getElementById('outline-root');
const workspaceRoot = document.getElementById('workspace-root');
const codexRoot = document.getElementById('codex-root');

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

function renderOutline() {
  outlineRoot.innerHTML = '';

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
    const actHeader = createElement('div', 'outline-act-header');
    const actHeaderText = document.createElement('div');
    actHeaderText.appendChild(createElement('h3', 'outline-act-title', `Act ${act.order}: ${act.title}`));
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

    const chapterList = createElement('div', 'outline-chapter-list');
    if (act.chapterIds.length === 0) {
      chapterList.appendChild(createElement('div', 'outline-empty', 'No chapters in this act.'));
    } else {
      act.chapterIds.forEach((chapterId) => {
        const chapter = state.chapters[chapterId];
        if (!chapter) {
          return;
        }
        const chapterContainer = createElement('div', 'outline-chapter');
        const chapterHeader = createElement('div', 'outline-chapter-header');
        chapterHeader.appendChild(
          createElement('h4', 'outline-chapter-title', `Chapter ${chapter.order}: ${chapter.title}`)
        );
        const addSceneButton = createElement('button', 'button-outline', '+ Scene');
        addSceneButton.addEventListener('click', () => actions.addScene(chapter.id));
        chapterHeader.appendChild(addSceneButton);
        chapterContainer.appendChild(chapterHeader);

        const sceneList = createElement('ul', 'outline-scene-list');
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
            const button = createElement(
              'button',
              `scene-button${state.selectedSceneId === scene.id ? ' is-active' : ''}`
            );
            const buttonTitle = createElement('p', 'scene-button-title', scene.title);
            const buttonMeta = createElement(
              'p',
              'scene-button-meta',
              `${scene.wordCount} ${scene.wordCount === 1 ? 'word' : 'words'} · ${scene.draftStatus}`
            );
            button.appendChild(buttonTitle);
            button.appendChild(buttonMeta);
            button.addEventListener('click', () => actions.selectScene(scene.id));
            listItem.appendChild(button);
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

  outlineRoot.appendChild(scrollRegion);
}

function renderWorkspace() {
  workspaceRoot.innerHTML = '';

  const selectedScene = state.selectedSceneId ? state.scenes[state.selectedSceneId] : null;
  if (!selectedScene) {
    workspaceRoot.appendChild(
      createElement('div', 'workspace-empty', 'Select a scene from the outline to begin writing.')
    );
    return;
  }

  const container = createElement('div', 'workspace');
  container.appendChild(renderSceneToolbar(selectedScene));

  const body = createElement('div', 'workspace-body');

  const editor = createElement('div', 'workspace-editor');
  const textarea = document.createElement('textarea');
  textarea.className = 'workspace-textarea';
  textarea.value = selectedScene.text;
  textarea.placeholder = 'Draft your scene here...';
  textarea.addEventListener('input', (event) => {
    actions.updateSceneText(selectedScene.id, event.target.value);
  });
  editor.appendChild(textarea);
  body.appendChild(editor);

  if (state.ui.showBeats) {
    const beatAside = createElement('aside', 'workspace-side workspace-side--beats');
    beatAside.appendChild(renderBeatList(selectedScene));
    body.appendChild(beatAside);
  }

  if (state.ui.showAssistant) {
    const assistantAside = createElement('aside', 'workspace-side workspace-side--assistant');
    assistantAside.appendChild(renderAssistantPanel());
    body.appendChild(assistantAside);
  }

  container.appendChild(body);
  workspaceRoot.appendChild(container);
}

function renderSceneToolbar(scene) {
  const toolbar = createElement('header', 'scene-toolbar');
  const textWrapper = document.createElement('div');
  textWrapper.appendChild(createElement('p', 'scene-toolbar-path', buildSceneHierarchy(scene)));
  textWrapper.appendChild(createElement('h2', 'scene-toolbar-title', scene.title));
  const updatedAt = new Date(scene.lastUpdated).toLocaleString();
  textWrapper.appendChild(
    createElement('p', 'scene-toolbar-meta', `${scene.wordCount} words · updated ${updatedAt}`)
  );
  toolbar.appendChild(textWrapper);

  const actionsWrapper = createElement('div', 'toolbar-actions');
  const beatsButton = createElement(
    'button',
    `toolbar-button${state.ui.showBeats ? ' is-active' : ''}`,
    state.ui.showBeats ? 'Hide Beats' : 'Show Beats'
  );
  beatsButton.addEventListener('click', () => actions.toggleBeats());
  const assistantButton = createElement(
    'button',
    `toolbar-button${state.ui.showAssistant ? ' is-active' : ''}`,
    state.ui.showAssistant ? 'Close Assistant' : 'AI Assistant'
  );
  assistantButton.addEventListener('click', () => actions.toggleAssistant());
  actionsWrapper.appendChild(beatsButton);
  actionsWrapper.appendChild(assistantButton);
  toolbar.appendChild(actionsWrapper);

  return toolbar;
}

function buildSceneHierarchy(scene) {
  const chapter = state.chapters[scene.chapterId];
  const act = chapter ? state.acts.find((item) => item.id === chapter.actId) : null;
  const parts = [];
  if (act) {
    parts.push(act.title);
  }
  if (chapter) {
    parts.push(chapter.title);
  }
  parts.push(scene.title);
  return parts.join(' / ');
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
    list.appendChild(createElement('li', 'beat-empty', 'No beats yet. Add beats to guide your drafting.'));
  } else {
    scene.beats.forEach((beat) => {
      const item = createElement('li', 'beat-item');
      item.appendChild(createElement('p', 'beat-item-label', `Beat ${beat.order}`));
      item.appendChild(createElement('p', 'beat-item-title', beat.title));
      list.appendChild(item);
    });
  }
  container.appendChild(list);

  return container;
}

function renderAssistantPanel() {
  const panel = createElement('div', 'assistant-panel');
  panel.appendChild(createElement('h3', 'assistant-title', 'AI Assistant'));
  panel.appendChild(
    createElement(
      'p',
      'assistant-subtitle',
      'AI features are optional and will appear here in future iterations.'
    )
  );
  panel.appendChild(
    createElement(
      'div',
      'assistant-empty',
      'Configure your preferred workflow in Settings to enable suggestions.'
    )
  );
  return panel;
}

function renderCodex() {
  codexRoot.innerHTML = '';

  const container = createElement('div', 'codex-panel');
  const header = createElement('header', 'codex-header');
  header.appendChild(createElement('h2', 'codex-title', 'Codex'));
  header.appendChild(
    createElement('p', 'codex-subtitle', 'Track characters, places, items, and lore from your manuscript.')
  );
  container.appendChild(header);

  const body = createElement('div', 'codex-body');
  const sidebar = createElement('div', 'codex-sidebar');

  const grouped = groupCodexEntries();
  const categoryKeys = Object.keys(grouped);

  if (categoryKeys.length === 0) {
    sidebar.appendChild(createElement('p', 'codex-empty', 'No entries yet. Add details as you write.'));
  } else {
    categoryKeys
      .sort((a, b) => (CATEGORY_LABELS[a] || a).localeCompare(CATEGORY_LABELS[b] || b))
      .forEach((category) => {
        const section = createElement('section', 'codex-category');
        section.appendChild(
          createElement('h3', 'codex-category-title', CATEGORY_LABELS[category] || category)
        );
        const list = createElement('ul', 'codex-entry-list');
        grouped[category]
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

  const content = createElement('div', 'codex-content');
  const selectedEntry = state.codex.selectedId ? state.codex.entries[state.codex.selectedId] : null;
  if (!selectedEntry) {
    content.appendChild(createElement('div', 'codex-placeholder', 'Select a Codex entry to view details.'));
  } else {
    const detailsWrapper = createElement('div', 'codex-details');
    const heading = document.createElement('div');
    heading.appendChild(createElement('h3', 'codex-entry-name', selectedEntry.name));
    heading.appendChild(
      createElement('p', 'codex-entry-category', CATEGORY_LABELS[selectedEntry.category] || selectedEntry.category)
    );
    detailsWrapper.appendChild(heading);

    const summaryBlock = document.createElement('div');
    summaryBlock.appendChild(createElement('label', 'codex-summary-label', 'Summary'));
    const summaryArea = document.createElement('textarea');
    summaryArea.className = 'codex-textarea';
    summaryArea.value = selectedEntry.summary;
    summaryArea.addEventListener('input', (event) => {
      actions.updateCodexSummary(selectedEntry.id, event.target.value);
    });
    summaryBlock.appendChild(summaryArea);
    detailsWrapper.appendChild(summaryBlock);

    const detailBlock = document.createElement('div');
    detailBlock.appendChild(createElement('h4', 'codex-details-title', 'Details'));
    const detailList = createElement('ul', 'codex-detail-list');
    if (selectedEntry.details.length === 0) {
      detailList.appendChild(createElement('li', 'codex-detail-empty', 'No details recorded yet.'));
    } else {
      selectedEntry.details.forEach((detail, index) => {
        const detailItem = createElement('li', 'codex-detail-item');
        detailItem.appendChild(createElement('p', null, detail.text));
        if (detail.sourceSceneId) {
          detailItem.appendChild(
            createElement('p', 'codex-detail-scene', `Scene: ${detail.sourceSceneId}`)
          );
        }
        detailList.appendChild(detailItem);
      });
    }
    detailBlock.appendChild(detailList);
    detailsWrapper.appendChild(detailBlock);

    content.appendChild(detailsWrapper);
  }

  body.appendChild(content);
  container.appendChild(body);
  codexRoot.appendChild(container);
}

function groupCodexEntries() {
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
  renderOutline();
  renderWorkspace();
  renderCodex();
}

ensureSelections();
renderAll();
