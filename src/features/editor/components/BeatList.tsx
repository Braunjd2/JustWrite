import { useMemo } from 'react';
import { useOutlineActions, useOutlineStore } from '../../../stores/outlineStore';

interface BeatListProps {
  sceneId: string;
}

export function BeatList({ sceneId }: BeatListProps) {
  const scene = useOutlineStore((state) => state.scenes[sceneId]);
  const { addBeat } = useOutlineActions();

  const beats = useMemo(() => scene?.beats ?? [], [scene?.beats]);

  if (!scene) {
    return null;
  }

  return (
    <div className="flex h-full flex-col gap-3">
      <div className="flex items-center justify-between">
        <div>
          <h3 className="text-sm font-semibold text-accent">Beats</h3>
          <p className="text-[11px] uppercase tracking-wide text-slate-500">Structure your scene progression</p>
        </div>
        <button
          onClick={() => addBeat(sceneId, `Beat ${beats.length + 1}`)}
          className="rounded border border-outline px-2 py-1 text-xs font-medium text-slate-200 transition hover:bg-outline hover:text-background"
        >
          + Beat
        </button>
      </div>
      <ul className="space-y-2 overflow-y-auto">
        {beats.map((beat) => (
          <li key={beat.id} className="rounded border border-outline/40 bg-background/50 p-3">
            <p className="text-xs uppercase tracking-wide text-slate-400">Beat {beat.order}</p>
            <p className="text-sm text-slate-200">{beat.title}</p>
          </li>
        ))}
        {beats.length === 0 && (
          <li className="rounded border border-dashed border-outline/40 p-4 text-center text-xs text-slate-500">
            No beats yet. Add beats to guide your drafting.
          </li>
        )}
      </ul>
    </div>
  );
}
