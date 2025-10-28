# SimpleWriter v2

SimpleWriter v2 is a local-first fiction drafting tool that keeps your manuscript outline, scene drafts, and Codex references fully in the browser. This repository contains the application source code alongside technical documentation.

## Getting Started

```bash
npm install
npm run dev
```

The development server runs at [http://localhost:5173](http://localhost:5173). All interactivity is implemented with modern vanilla JavaScript, custom state helpers, and handcrafted utility styles defined in `src/index.css`, so no additional packages are required for installation.

## Project Structure

```
index.html         # Application shell and layout containers
server.js          # Lightweight static file server used for development
src/
  app.js           # UI rendering, state management, and user interactions
  index.css        # Design system and layout styles
```

## Documentation

Design and architecture notes live in [`docs/blueprint.md`](docs/blueprint.md).
