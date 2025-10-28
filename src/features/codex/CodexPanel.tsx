import { useMemo } from 'react';
import { useCodexStore } from '../../stores/codexStore';
import type { CodexEntry } from '../../types/codex';

const CATEGORY_LABELS: Record<string, string> = {
  character: 'Characters',
  place: 'Places',
  item: 'Items',
  lore: 'Lore'
};

export function CodexPanel() {
  const entries = useCodexStore((state) => state.entries);
  const selectedEntryId = useCodexStore((state) => state.selectedEntryId);
  const selectEntry = useCodexStore((state) => state.selectEntry);
  const updateSummary = useCodexStore((state) => state.updateSummary);

  const grouped = useMemo(() => {
    return Object.values(entries).reduce<Record<string, CodexEntry[]>>((acc, entry) => {
      const bucket = acc[entry.category] ?? [];
      return {
        ...acc,
        [entry.category]: [...bucket, entry]
      };
    }, {} as Record<string, CodexEntry[]>);
  }, [entries]);

  const selectedEntry = selectedEntryId ? entries[selectedEntryId] : undefined;

  return (
    <div className="flex h-full flex-col">
      <header className="border-b border-outline px-4 py-3">
        <h2 className="text-lg font-semibold text-accent">Codex</h2>
        <p className="text-xs text-slate-400">Track characters, places, items, and lore from your manuscript.</p>
      </header>
      <div className="flex flex-1 overflow-hidden">
        <div className="w-64 shrink-0 overflow-y-auto border-r border-outline/30 p-3">
          {Object.entries(grouped).map(([category, categoryEntries]) => (
            <section key={category} className="mb-4">
              <h3 className="text-xs uppercase tracking-wide text-slate-500">{CATEGORY_LABELS[category] ?? category}</h3>
              <ul className="mt-2 space-y-1">
                {categoryEntries
                  .sort((a, b) => a.name.localeCompare(b.name))
                  .map((entry) => (
                    <li key={entry.id}>
                      <button
                        onClick={() => selectEntry(entry.id)}
                        className={`w-full rounded px-2 py-2 text-left text-sm transition ${
                          entry.id === selectedEntryId
                            ? 'bg-accent/20 text-accent ring-1 ring-accent/60'
                            : 'text-slate-200 hover:bg-background/70'
                        }`}
                      >
                        {entry.name}
                      </button>
                    </li>
                  ))}
              </ul>
            </section>
          ))}
          {Object.keys(grouped).length === 0 && (
            <p className="text-xs text-slate-500">No entries yet. AI scans and manual additions will appear here.</p>
          )}
        </div>
        <div className="flex-1 overflow-y-auto p-4">
          {selectedEntry ? (
            <div className="space-y-4">
              <div>
                <h3 className="text-xl font-semibold text-slate-100">{selectedEntry.name}</h3>
                <p className="text-xs uppercase tracking-wide text-slate-500">{CATEGORY_LABELS[selectedEntry.category]}</p>
              </div>
              <div>
                <label className="text-xs uppercase tracking-wide text-slate-500">Summary</label>
                <textarea
                  value={selectedEntry.summary}
                  onChange={(event) => updateSummary(selectedEntry.id, event.target.value)}
                  className="mt-1 h-32 w-full resize-none rounded border border-outline/40 bg-background/60 p-3 text-sm text-slate-100 focus:border-accent focus:outline-none focus:ring-2 focus:ring-accent/50"
                />
              </div>
              <div>
                <h4 className="text-sm font-semibold text-slate-200">Details</h4>
                <ul className="mt-2 space-y-2">
                  {selectedEntry.details.map((detail, index) => (
                    <li key={`${detail.text}-${index}`} className="rounded border border-outline/30 bg-background/50 p-3 text-xs text-slate-300">
                      <p>{detail.text}</p>
                      {detail.sourceSceneId && (
                        <p className="mt-1 text-[10px] uppercase tracking-wide text-slate-500">Scene: {detail.sourceSceneId}</p>
                      )}
                    </li>
                  ))}
                  {selectedEntry.details.length === 0 && (
                    <li className="rounded border border-dashed border-outline/40 p-3 text-xs text-slate-500">No details recorded yet.</li>
                  )}
                </ul>
              </div>
            </div>
          ) : (
            <div className="flex h-full items-center justify-center text-sm text-slate-500">
              Select a Codex entry to view details.
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
