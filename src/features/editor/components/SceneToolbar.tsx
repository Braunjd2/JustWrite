import { useMemo } from 'react';
import type { Scene } from '../../../types/outline';
import { useSceneStore } from '../../../stores/sceneStore';

interface SceneToolbarProps {
  scene: Scene;
  hierarchy: string;
}

export function SceneToolbar({ scene, hierarchy }: SceneToolbarProps) {
  const { toggleBeatPanel, toggleAssistant, isBeatPanelOpen, isAssistantOpen } = useSceneStore((state) => ({
    toggleBeatPanel: state.toggleBeatPanel,
    toggleAssistant: state.toggleAssistant,
    isBeatPanelOpen: state.isBeatPanelOpen,
    isAssistantOpen: state.isAssistantOpen
  }));

  const metadata = useMemo(() => {
    const updatedAt = new Date(scene.lastUpdated).toLocaleString();
    return `${scene.wordCount} words · updated ${updatedAt}`;
  }, [scene.lastUpdated, scene.wordCount]);

  return (
    <header className="flex items-center justify-between border-b border-outline/40 bg-surface/70 px-4 py-3">
      <div>
        <p className="text-xs uppercase tracking-wide text-slate-500">{hierarchy}</p>
        <h2 className="text-xl font-semibold text-slate-100">{scene.title}</h2>
        <p className="text-xs text-slate-400">{metadata}</p>
      </div>
      <div className="flex items-center gap-2">
        <button
          onClick={toggleBeatPanel}
          className={`rounded border px-3 py-1 text-sm font-medium transition ${
            isBeatPanelOpen ? 'border-accent text-accent' : 'border-outline text-slate-200'
          }`}
        >
          {isBeatPanelOpen ? 'Hide Beats' : 'Show Beats'}
        </button>
        <button
          onClick={toggleAssistant}
          className={`rounded border px-3 py-1 text-sm font-medium transition ${
            isAssistantOpen ? 'border-accent text-accent' : 'border-outline text-slate-200'
          }`}
        >
          {isAssistantOpen ? 'Close Assistant' : 'AI Assistant'}
        </button>
      </div>
    </header>
  );
}
