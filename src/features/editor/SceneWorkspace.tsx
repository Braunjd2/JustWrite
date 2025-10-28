import { useMemo } from 'react';
import { useOutlineActions, useOutlineStore } from '../../stores/outlineStore';
import { useSceneStore } from '../../stores/sceneStore';
import { BeatList } from './components/BeatList';
import { SceneToolbar } from './components/SceneToolbar';

export function SceneWorkspace() {
  const selectedSceneId = useOutlineStore((state) => state.selectedSceneId);
  const scene = useOutlineStore((state) => (selectedSceneId ? state.scenes[selectedSceneId] : null));
  const chapter = useOutlineStore((state) => (scene ? state.chapters[scene.chapterId] : null));
  const act = useOutlineStore((state) => (scene ? state.acts[scene.actId] : null));
  const { updateSceneText } = useOutlineActions();
  const { isBeatPanelOpen, isAssistantOpen } = useSceneStore((state) => ({
    isBeatPanelOpen: state.isBeatPanelOpen,
    isAssistantOpen: state.isAssistantOpen
  }));

  const sceneHierarchy = useMemo(() => {
    if (!scene || !chapter || !act) return null;
    return `${act.title} / ${chapter.title} / ${scene.title}`;
  }, [act, chapter, scene]);

  if (!scene) {
    return (
      <div className="flex h-full flex-col items-center justify-center text-center text-sm text-slate-400">
        <p>Select a scene from the outline to begin writing.</p>
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col">
      <SceneToolbar scene={scene} hierarchy={sceneHierarchy ?? ''} />
      <div className="flex flex-1 overflow-hidden">
        <div className="flex-1 overflow-y-auto border-r border-outline/40 p-4">
          <textarea
            value={scene.text}
            onChange={(event) => updateSceneText(scene.id, event.target.value)}
            placeholder="Draft your scene here..."
            className="h-full w-full resize-none rounded-lg border border-outline/40 bg-background/60 p-4 text-base text-slate-100 focus:border-accent focus:outline-none focus:ring-2 focus:ring-accent/50"
          />
        </div>
        {isBeatPanelOpen && (
          <aside className="w-72 shrink-0 overflow-y-auto border-r border-outline/30 p-4">
            <BeatList sceneId={scene.id} />
          </aside>
        )}
        {isAssistantOpen && (
          <aside className="w-72 shrink-0 overflow-y-auto p-4">
            <div className="flex h-full flex-col gap-3 rounded-lg border border-outline/40 bg-background/40 p-4 text-sm text-slate-200">
              <h3 className="text-base font-semibold text-accent">AI Assistant</h3>
              <p className="text-xs text-slate-400">
                AI features are optional and require explicit invocation. Integrations will appear here in future iterations.
              </p>
              <div className="rounded border border-dashed border-outline/40 p-3 text-xs text-slate-500">
                Configure your preferred model in Settings to enable suggestions.
              </div>
            </div>
          </aside>
        )}
      </div>
    </div>
  );
}
