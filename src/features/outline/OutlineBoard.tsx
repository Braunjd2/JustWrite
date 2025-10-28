import { useOutlineActions, useOutlineStore } from '../../stores/outlineStore';

export function OutlineBoard() {
  const acts = useOutlineStore((state) => state.acts);
  const chapters = useOutlineStore((state) => state.chapters);
  const scenes = useOutlineStore((state) => state.scenes);
  const selectedSceneId = useOutlineStore((state) => state.selectedSceneId);
  const { addAct, addChapter, addScene, selectScene } = useOutlineActions();

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center justify-between border-b border-outline px-4 py-3">
        <div>
          <h2 className="text-lg font-semibold text-accent">Outline</h2>
          <p className="text-xs text-slate-400">Acts, chapters, and scenes organised hierarchically.</p>
        </div>
        <button
          onClick={() => addAct('New Act')}
          className="rounded border border-accent px-3 py-1 text-sm font-medium text-accent transition hover:bg-accent hover:text-background"
        >
          + Act
        </button>
      </div>
      <div className="flex-1 overflow-y-auto p-4">
        {Object.values(acts)
          .sort((a, b) => a.order - b.order)
          .map((act) => (
            <div key={act.id} className="mb-4 rounded-lg border border-outline/70 bg-surface/90">
              <header className="flex items-center justify-between border-b border-outline/40 px-3 py-2">
                <div>
                  <h3 className="text-base font-semibold">{`Act ${act.order}: ${act.title}`}</h3>
                  <p className="text-[11px] uppercase tracking-wide text-slate-400">{act.chapterIds.length} chapters</p>
                </div>
                <button
                  onClick={() => addChapter(act.id, `Chapter ${act.chapterIds.length + 1}`)}
                  className="rounded border border-outline px-2 py-1 text-xs font-medium text-slate-200 transition hover:bg-outline hover:text-background"
                >
                  + Chapter
                </button>
              </header>
              <div className="space-y-3 p-3">
                {act.chapterIds.map((chapterId) => {
                  const chapter = chapters[chapterId];
                  if (!chapter) return null;
                  return (
                    <div key={chapter.id} className="rounded-md border border-outline/30 bg-background/50 p-3">
                      <div className="mb-2 flex items-center justify-between">
                        <h4 className="font-medium">{`Chapter ${chapter.order}: ${chapter.title}`}</h4>
                        <button
                          onClick={() => addScene(chapter.id, `Scene ${chapter.sceneIds.length + 1}`)}
                          className="rounded border border-outline px-2 py-1 text-xs font-medium text-slate-200 transition hover:bg-outline hover:text-background"
                        >
                          + Scene
                        </button>
                      </div>
                      <ul className="space-y-1">
                        {chapter.sceneIds.map((sceneId) => {
                          const scene = scenes[sceneId];
                          if (!scene) return null;
                          const isSelected = scene.id === selectedSceneId;
                          return (
                            <li key={scene.id}>
                              <button
                                onClick={() => selectScene(scene.id)}
                                className={`w-full rounded px-3 py-2 text-left text-sm transition ${
                                  isSelected
                                    ? 'bg-accent/20 text-accent ring-1 ring-accent/60'
                                    : 'bg-background/60 text-slate-200 hover:bg-background/80'
                                }`}
                              >
                                <p className="font-medium">{scene.title}</p>
                                <p className="text-[11px] text-slate-400">{scene.wordCount} words · {scene.draftStatus}</p>
                              </button>
                            </li>
                          );
                        })}
                        {chapter.sceneIds.length === 0 && (
                          <li className="rounded border border-dashed border-outline/40 p-3 text-center text-xs text-slate-500">
                            No scenes yet. Add one to start writing.
                          </li>
                        )}
                      </ul>
                    </div>
                  );
                })}
                {act.chapterIds.length === 0 && (
                  <div className="rounded border border-dashed border-outline/40 p-4 text-center text-xs text-slate-500">
                    No chapters in this act.
                  </div>
                )}
              </div>
            </div>
          ))}
        {Object.values(acts).length === 0 && (
          <div className="rounded border border-dashed border-outline/40 p-6 text-center text-sm text-slate-500">
            Start by creating an act for your story.
          </div>
        )}
      </div>
    </div>
  );
}
