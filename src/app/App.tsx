import { OutlineBoard } from '../features/outline/OutlineBoard';
import { SceneWorkspace } from '../features/editor/SceneWorkspace';
import { CodexPanel } from '../features/codex/CodexPanel';
import { WorkspaceProvider } from '../stores/workspaceProvider';

export default function App() {
  return (
    <WorkspaceProvider>
      <div className="min-h-screen bg-background text-white">
        <header className="border-b border-outline bg-surface/80 p-4 backdrop-blur">
          <h1 className="text-2xl font-semibold text-accent">SimpleWriter v2</h1>
          <p className="text-sm text-slate-300">
            Local-first fiction drafting studio with outline, scene, and codex management.
          </p>
        </header>
        <main className="grid h-[calc(100vh-5.5rem)] grid-cols-[minmax(20rem,1fr)_minmax(28rem,2fr)_minmax(18rem,1fr)] gap-4 p-4">
          <section className="rounded-lg border border-outline bg-surface/80 shadow-lg">
            <OutlineBoard />
          </section>
          <section className="rounded-lg border border-outline bg-surface/80 shadow-lg">
            <SceneWorkspace />
          </section>
          <section className="rounded-lg border border-outline bg-surface/80 shadow-lg">
            <CodexPanel />
          </section>
        </main>
      </div>
    </WorkspaceProvider>
  );
}
