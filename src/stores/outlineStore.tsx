import { PropsWithChildren, createContext, useContext, useRef } from 'react';
import { createStore } from 'zustand/vanilla';
import { StoreApi, useStore } from 'zustand';
import type { Act, Chapter, OutlineState, Scene } from '../types/outline';
import { createId } from '../utils/id';

export interface OutlineActions {
  addAct(title?: string): void;
  addChapter(actId: string, title?: string): void;
  addScene(chapterId: string, title?: string): void;
  addBeat(sceneId: string, title?: string): void;
  selectScene(sceneId: string | null): void;
  updateSceneText(sceneId: string, text: string): void;
}

export type OutlineStore = OutlineState & OutlineActions;

const OutlineStoreContext = createContext<StoreApi<OutlineStore> | null>(null);

function initializeOutlineState(): OutlineState {
  const actId = createId('act');
  const chapterId = createId('chapter');
  const sceneId = createId('scene');
  const now = new Date().toISOString();

  const scene: Scene = {
    id: sceneId,
    order: 1,
    title: 'Opening Scene',
    chapterId,
    actId,
    beats: [],
    text: '',
    wordCount: 0,
    draftStatus: 'empty',
    lastUpdated: now
  };

  const chapter: Chapter = {
    id: chapterId,
    order: 1,
    title: 'Chapter 1',
    actId,
    sceneIds: [sceneId]
  };

  const act: Act = {
    id: actId,
    order: 1,
    title: 'Act 1',
    chapterIds: [chapterId]
  };

  return {
    acts: { [actId]: act },
    chapters: { [chapterId]: chapter },
    scenes: { [sceneId]: scene },
    selectedSceneId: sceneId
  };
}

export function createOutlineStore(initialState = initializeOutlineState()) {
  return createStore<OutlineStore>((set, get) => ({
    ...initialState,
    addAct(title = 'New Act') {
      set((state) => {
        const id = createId('act');
        const order = Object.keys(state.acts).length + 1;
        return {
          acts: {
            ...state.acts,
            [id]: { id, order, title, chapterIds: [] }
          }
        } as Partial<OutlineStore>;
      });
    },
    addChapter(actId, title = 'New Chapter') {
      set((state) => {
        const act = state.acts[actId];
        if (!act) {
          return {};
        }
        const id = createId('chapter');
        const order = act.chapterIds.length + 1;
        return {
          chapters: {
            ...state.chapters,
            [id]: { id, order, title, actId, sceneIds: [] }
          },
          acts: {
            ...state.acts,
            [actId]: {
              ...act,
              chapterIds: [...act.chapterIds, id]
            }
          }
        } as Partial<OutlineStore>;
      });
    },
    addScene(chapterId, title = 'New Scene') {
      set((state) => {
        const chapter = state.chapters[chapterId];
        if (!chapter) {
          return {};
        }
        const id = createId('scene');
        const order = chapter.sceneIds.length + 1;
        const actId = chapter.actId;
        const now = new Date().toISOString();
        const scene: Scene = {
          id,
          order,
          title,
          chapterId,
          actId,
          beats: [],
          text: '',
          wordCount: 0,
          draftStatus: 'empty',
          lastUpdated: now
        };
        return {
          scenes: {
            ...state.scenes,
            [id]: scene
          },
          chapters: {
            ...state.chapters,
            [chapterId]: {
              ...chapter,
              sceneIds: [...chapter.sceneIds, id]
            }
          },
          selectedSceneId: id
        } as Partial<OutlineStore>;
      });
    },
    addBeat(sceneId, title = 'New Beat') {
      set((state) => {
        const scene = state.scenes[sceneId];
        if (!scene) {
          return {};
        }
        const beatId = createId('beat');
        return {
          scenes: {
            ...state.scenes,
            [sceneId]: {
              ...scene,
              beats: [
                ...scene.beats,
                {
                  id: beatId,
                  order: scene.beats.length + 1,
                  title
                }
              ]
            }
          }
        } as Partial<OutlineStore>;
      });
    },
    selectScene(sceneId) {
      set({ selectedSceneId: sceneId });
    },
    updateSceneText(sceneId, text) {
      set((state) => {
        const scene = state.scenes[sceneId];
        if (!scene) {
          return {};
        }
        const wordCount = text.trim().split(/\s+/).filter(Boolean).length;
        return {
          scenes: {
            ...state.scenes,
            [sceneId]: {
              ...scene,
              text,
              wordCount,
              draftStatus: text.length === 0 ? 'empty' : 'drafted',
              lastUpdated: new Date().toISOString()
            }
          }
        } as Partial<OutlineStore>;
      });
    }
  }));
}

export function OutlineStoreProvider({ children }: PropsWithChildren) {
  const storeRef = useRef<StoreApi<OutlineStore>>();
  if (!storeRef.current) {
    storeRef.current = createOutlineStore();
  }

  return <OutlineStoreContext.Provider value={storeRef.current}>{children}</OutlineStoreContext.Provider>;
}

export function useOutlineStore<T>(selector: (store: OutlineStore) => T): T {
  const store = useContext(OutlineStoreContext);
  if (!store) {
    throw new Error('OutlineStoreProvider missing in component tree');
  }
  return useStore(store, selector);
}

export function useOutlineActions() {
  return useOutlineStore((state) => ({
    addAct: state.addAct,
    addChapter: state.addChapter,
    addScene: state.addScene,
    addBeat: state.addBeat,
    selectScene: state.selectScene,
    updateSceneText: state.updateSceneText
  }));
}
