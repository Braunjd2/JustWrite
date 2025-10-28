import { PropsWithChildren, createContext, useContext, useRef } from 'react';
import { createStore } from 'zustand/vanilla';
import { StoreApi, useStore } from 'zustand';

interface SceneUiState {
  isBeatPanelOpen: boolean;
  isAssistantOpen: boolean;
}

interface SceneUiActions {
  toggleBeatPanel(): void;
  toggleAssistant(): void;
  closeAssistant(): void;
}

export type SceneStore = SceneUiState & SceneUiActions;

const SceneStoreContext = createContext<StoreApi<SceneStore> | null>(null);

export function createSceneStore(initialState: SceneUiState = {
  isBeatPanelOpen: true,
  isAssistantOpen: false
}) {
  return createStore<SceneStore>((set) => ({
    ...initialState,
    toggleBeatPanel() {
      set((state) => ({ isBeatPanelOpen: !state.isBeatPanelOpen }));
    },
    toggleAssistant() {
      set((state) => ({ isAssistantOpen: !state.isAssistantOpen }));
    },
    closeAssistant() {
      set({ isAssistantOpen: false });
    }
  }));
}

export function SceneStoreProvider({ children }: PropsWithChildren) {
  const storeRef = useRef<StoreApi<SceneStore>>();
  if (!storeRef.current) {
    storeRef.current = createSceneStore();
  }

  return <SceneStoreContext.Provider value={storeRef.current}>{children}</SceneStoreContext.Provider>;
}

export function useSceneStore<T>(selector: (store: SceneStore) => T) {
  const store = useContext(SceneStoreContext);
  if (!store) {
    throw new Error('SceneStoreProvider missing in component tree');
  }
  return useStore(store, selector);
}
