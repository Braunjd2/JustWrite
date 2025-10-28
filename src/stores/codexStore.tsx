import { PropsWithChildren, createContext, useContext, useRef } from 'react';
import { createStore } from 'zustand/vanilla';
import { StoreApi, useStore } from 'zustand';
import type { CodexEntry, CodexState } from '../types/codex';
import { createId } from '../utils/id';

interface CodexActions {
  addEntry(partial?: Partial<CodexEntry>): void;
  selectEntry(id: string | null): void;
  updateSummary(id: string, summary: string): void;
}

export type CodexStore = CodexState & CodexActions;

const CodexStoreContext = createContext<StoreApi<CodexStore> | null>(null);

function createInitialEntry(): CodexEntry {
  const id = createId('codex');
  return {
    id,
    name: 'Protagonist',
    category: 'character',
    aliases: [],
    summary: 'The hero of the story.',
    details: [
      {
        text: 'Introduced in the opening scene.',
        createdAt: new Date().toISOString(),
        sourceSceneId: undefined
      }
    ],
    tags: ['lead']
  };
}

function initializeCodexState(): CodexState {
  const entry = createInitialEntry();
  return {
    entries: { [entry.id]: entry },
    selectedEntryId: entry.id
  };
}

export function createCodexStore(initialState = initializeCodexState()) {
  return createStore<CodexStore>((set) => ({
    ...initialState,
    addEntry(partial) {
      set((state) => {
        const id = createId('codex');
        const entry: CodexEntry = {
          id,
          name: partial?.name ?? 'New Entry',
          category: partial?.category ?? 'lore',
          aliases: partial?.aliases ?? [],
          summary: partial?.summary ?? '',
          details: partial?.details ?? [],
          tags: partial?.tags ?? []
        };
        return {
          entries: {
            ...state.entries,
            [id]: entry
          },
          selectedEntryId: id
        };
      });
    },
    selectEntry(id) {
      set({ selectedEntryId: id });
    },
    updateSummary(id, summary) {
      set((state) => {
        const entry = state.entries[id];
        if (!entry) {
          return {};
        }
        return {
          entries: {
            ...state.entries,
            [id]: {
              ...entry,
              summary
            }
          }
        };
      });
    }
  }));
}

export function CodexStoreProvider({ children }: PropsWithChildren) {
  const storeRef = useRef<StoreApi<CodexStore>>();
  if (!storeRef.current) {
    storeRef.current = createCodexStore();
  }

  return <CodexStoreContext.Provider value={storeRef.current}>{children}</CodexStoreContext.Provider>;
}

export function useCodexStore<T>(selector: (store: CodexStore) => T): T {
  const store = useContext(CodexStoreContext);
  if (!store) {
    throw new Error('CodexStoreProvider missing in component tree');
  }
  return useStore(store, selector);
}
