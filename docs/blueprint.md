# SimpleWriter v2 – Technical Blueprint

> **Implementation note:** The current repository includes a lightweight vanilla JavaScript prototype that delivers the outline, scene workspace, and Codex experience without third-party packages so it can run fully offline in constrained environments. The architectural goals captured below remain the longer-term direction for a richer React + IndexedDB client once external dependencies become feasible.

## 1. Overview
SimpleWriter v2 is a local-first fiction drafting tool that organises manuscripts into Acts, Chapters, Scenes, and Beats while maintaining an automatically generated Codex of proper-noun entities. The application keeps all state in the browser using IndexedDB, runs entirely offline, and integrates pluggable AI services for optional assistance with beat generation, scene drafting, and Codex updates. Every AI feature must be explicitly invoked by the user and respects the manuscript text as the source of truth.

Key design goals:
- Fully local storage and operation with deterministic, auditable state transitions.
- Modular React-based UI with no monolithic components.
- Extensible AI abstraction layer that supports multiple providers but limits requests to the user-selected model.
- Robust scene reordering with automatic ID propagation across all dependent data.
- Codex enforcement of proper-noun-only entries with additive updates and user-controlled merges.

## 2. Technology Stack
- **Frontend Framework:** React 18 with TypeScript.
- **State Management:** Zustand stores for modular state slices (outline, scenes, codex, settings, ui). Zustand provides minimal boilerplate and explicit actions aligned with undo/redo requirements.
- **Routing:** Single page application without external router (view state handled via component state since app is workspace-like).
- **Styling:** Tailwind CSS for rapid layout of blob UI components; PostCSS configured locally. Lightweight CSS variables manage colour themes.
- **Data Layer:** Dexie.js as a thin wrapper around IndexedDB for schema management, transactions, and migrations.
- **AI Integration:** Local `lib/ai` module exposing provider-agnostic `AiClient` interface with concrete adapters for OpenAI, Anthropic, Google, and xAI. Fetch-based HTTP requests with streaming disabled (requests are short, chunked manually for scanning).
- **Cryptography:** Web Crypto API for encrypting API keys before persisting in IndexedDB.
- **Testing:** Vitest + React Testing Library for unit/component coverage of core logic, especially renumbering and Codex merging.
- **Build Tooling:** Vite for fast dev/build cycle.

## 3. Directory Structure
```
/                      # Vite project root
├─ public/             # Static assets
├─ src/
│  ├─ app/             # App shell and layout components
│  ├─ components/      # Reusable UI components (Buttons, Panels, Blob, Progress)
│  ├─ features/
│  │  ├─ outline/      # Outline board, drag logic, numbering utilities
│  │  ├─ editor/       # Scene editor, beat manager, drafting controls
│  │  ├─ codex/        # Codex viewer/editor, merge dialogs
│  │  ├─ ai/           # AI invocation panels, prompts, status handling
│  │  └─ chat/         # Local-first chat interface and command parsing
│  ├─ hooks/           # Shared hooks (useUndoRedo, useChunkedProcessing, etc.)
│  ├─ lib/
│  │  ├─ ai/           # Provider clients and orchestrators
│  │  ├─ codex/        # Proper noun extraction helpers, merge utilities
│  │  ├─ db/           # Dexie database, schema definitions, migrations
│  │  ├─ outline/      # Renumbering algorithms and hierarchy helpers
│  │  └─ security/     # Encryption helpers for settings storage
│  ├─ stores/          # Zustand slices grouped by feature
│  ├─ types/           # Shared TypeScript interfaces and enums
│  ├─ utils/           # General utility functions (hashing, string formatting)
│  └─ index.tsx        # App entrypoint
├─ tests/              # Unit and integration tests
└─ docs/               # Supplemental documentation (this blueprint, prompts)
```

## 4. Data Model

### 4.1 Core Types
- `Act`, `Chapter`, `Scene`, `Beat` include `id`, `title`, `order`, `parentId`, derived IDs (e.g., `A1.C2.S3`), and metadata (word counts for scenes). IDs follow the pattern `A{actIndex}.C{chapterIndex}.S{sceneIndex}.B{beatIndex}` and update automatically.
- `Scene` stores `text`, `beats: Beat[]`, `wordCount`, `lastUpdated`, `hash` (for diffing), and `draftStatus`.
- `CodexEntry` includes `id`, `name`, `category` (`character | place | item | lore`), `aliases`, `summary`, `details[]` (bullet array with `text`, `sourceSceneId`, `createdAt`), and `tags`.
- `SceneEntity` maps `sceneId` to `codexEntryId` and includes `role` (`mentioned | focus | POV`).
- `ActionLogEntry` stores undo/redo payloads with `type`, `payload`, and `timestamp`.
- `Settings` holds `activeModel`, `apiKeys[]` (encrypted), `preferences` (theme, chunk size override).

### 4.2 IndexedDB Schema (Dexie)
```ts
export const db = new Dexie('simplewriter');
db.version(1).stores({
  codex: '++id,name,category',
  scenes: 'id,hash,chapterId,actId',
  sceneEntities: '++id,sceneId,codexEntryId',
  actions: '++id,timestamp',
  settings: 'id'
});
```
- Use Dexie `transaction('rw', tables, async () => { ... })` for atomic updates when renumbering or merging.
- API keys encrypted with AES-GCM via Web Crypto before writing to `settings`.

### 4.3 Hash-Based Diffing
- Store SHA-256 hash of scene text. On “Scan Scene,” compute new hash, compare to stored value, and only reprocess if changed.
- For partial updates, compute diff between existing `hashSegments` (per chunk) to skip unchanged chunks.

## 5. Outline & Renumbering Workflow
1. Drag-drop interactions managed by `@dnd-kit/core` for keyboard-accessible sorting.
2. When an item is dropped, `renumberHierarchy` calculates new positional indices for the affected branch:
   - Re-index siblings (acts, chapters within act, scenes within chapter, beats within scene).
   - Generate new derived IDs recursively using parent indices.
3. `applyHierarchyUpdate` writes new IDs/indices to Dexie within a transaction:
   - Update `sceneEntities.sceneId` references.
   - Update `codex.details[].sourceSceneId` when scenes move.
   - Update `actions` entries referencing scene IDs to maintain undo fidelity.
4. State store updated after DB transaction resolves to maintain single source of truth.
5. Word counts recalculated per scene, aggregated to chapters and acts using memoised selectors.

## 6. Scene Editing & Beat Management
- Scene editor uses a split layout: left outline board, centre rich text editor (TipTap), right beats panel.
- Blank scenes show two primary buttons: “Manual Beats” and “AI Generate Beats.”
- Beat creation is inline (press Enter to add). Each beat displayed as a draggable blob with `Beat #:` prefix enforced by a helper formatter.
- “AI Draft Scene” button lives atop the editor once beats exist. Drafting prompts include beats, scene metadata, and optional @mentions context from the Codex.
- Drafted text inserted into editor with diff preview; user can accept or discard.

## 7. AI Architecture
### 7.1 Client Abstraction
```ts
type AiModel =
  | { provider: 'openai'; model: 'gpt-5' | 'gpt-4.1' }
  | { provider: 'anthropic'; model: 'claude-sonnet-4.5' | 'claude-sonnet-4' | 'opus-4.1' }
  | { provider: 'google'; model: 'gemini-2.5-pro' | 'gemini-2.5-flash' }
  | { provider: 'xai'; model: 'grok-latest' };

interface AiClient {
  generateBeats(input: BeatPrompt): Promise<Beat[]>;
  draftScene(input: DraftPrompt): Promise<string>;
  scanScene(input: ScanPrompt): Promise<ScanResult>;
  chat(input: ChatPrompt): Promise<ChatResult>;
}
```
- Provider adapters implement `AiClient` using provider-specific endpoints and API key headers.
- `AiService` selects active client based on `settings.activeModel`. Only one client instance active.
- Prompt templates stored in `src/features/ai/prompts/` and composed with user data.

### 7.2 Chunked Scene Scanning
- Scenes chunked at ~2,500 words using `splitIntoChunks` helper.
- UI shows progress: “Processing chunk 2/3…” via state machine (`idle → running(chunkIndex) → success/error`).
- Each chunk request returns candidate Codex entries.
- `mergeScanResults` deduplicates entries against local Codex using normalization rules, producing `autoMerged` and `needsReview` arrays.

## 8. Codex Management
- Codex viewer lists entries grouped by category. Clicking opens detail panel with editable fields.
- `CodexMergeDialog` presents side-by-side comparison when duplicates detected.
- Normalisation rules: lower-case + trim + remove parenthetical/epithet segments; compare primary tokens.
- Auto-merge path unions bullet lists, deduplicates by text + sourceSceneId.
- Lore entries flagged when AI output identifies conceptual entity with uppercase multi-word title and context emphasises systemic concept.
- Entries can be linked to scenes via `sceneEntities` when `@mentions` resolved.

## 9. Undo/Redo System
- `ActionManager` captures reversible actions (create beat, reorder scene, update text).
- Each action stores inverse payload. Only the latest 10 actions kept.
- Undo/Redo operations run Dexie transactions mirroring forward/backward state changes before updating stores.

## 10. Chat & @Mentions
- Chat input supports `@` autocomplete drawing from acts/chapters/scenes/beats/codex entries.
- Local commands parsed before AI submission:
  - `/timeline <character>` returns ordered list of scenes from local data.
  - `/outline` prints structured outline.
  - `/intersections <entityA> <entityB>` lists shared scenes.
- AI queries include selected context blocks stored temporarily, never persisted.

## 11. Export, Backup, and Safety Tools
- Export buttons trigger Dexie reads and compose Markdown or JSON files via `Blob` download.
- Backup compresses entire IndexedDB dump using `idb-export` utilities zipped with `JSZip`.
- Clear Database resets tables but leaves schema; Nuclear Delete drops database after double confirmation modal.

## 12. Testing Strategy
- Unit tests: renumbering logic, hash diffing, Codex normalization, AI response parsing.
- Component tests: Outline drag-drop snapshot, Codex merge dialog interactions, Scene editor command buttons.
- Integration smoke: Simulated flow of creating act → chapter → scene → beats → AI draft stub using mocked `AiClient`.

## 13. Accessibility & UX Notes
- Keyboard navigable drag handles with `@dnd-kit/accessibility`.
- High contrast theme with adjustable font size (setting stored in preferences).
- Status announcements via ARIA live regions for scan progress and AI results.

## 14. Future Enhancements (Post-MVP)
- Multi-project switcher with separate IndexedDB namespaces.
- Advanced search/filtering across scenes and Codex.
- Versioned snapshots for “milestone” saves beyond undo stack.
- Plugin architecture for custom exports or analysis scripts.

This blueprint captures the minimum viable implementation aligned with the SimpleWriter v2 specification while preserving extensibility and maintainability.
