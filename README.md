# SimpleWriter v2

SimpleWriter v2 is a local-first fiction drafting tool that keeps your manuscript outline, scene drafts, and Codex references fully in the browser. This repository contains the application source code alongside technical documentation.

## Getting Started

```bash
npm install
npm run dev
```

The application is built with Vite, React, Zustand, Dexie, and Tailwind CSS. All state is stored locally in the browser.

## Testing

```bash
npm run test
```

Vitest powers the unit test suite. Tests currently cover foundational utilities like outline renumbering.

## Documentation

Design and architecture notes live in [`docs/blueprint.md`](docs/blueprint.md).
