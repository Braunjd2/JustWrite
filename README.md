# SimpleWriter v2

SimpleWriter v2 is a local-first fiction drafting tool that keeps your manuscript outline, scene drafts, and Codex references fully in the browser. This repository contains the application source code alongside technical documentation.

## Getting Started

1. Open a terminal and move into the project folder. From the repository root that usually looks like:

   ```bash
   cd /workspace/Codex
   ```

   You can confirm you are in the right place if `ls` shows files such as `package.json`, `server.js`, and the `src/` directory.

2. Install dependencies (there are no external packages, but this step ensures the local `node_modules` folder exists for the npm scripts):

   ```bash
   npm install
   ```

3. Launch the development server:

   ```bash
   npm run dev
   ```

4. Open [http://localhost:5173](http://localhost:5173) in your browser. The terminal will print `SimpleWriter running on http://localhost:5173` once the server is ready.

All interactivity is implemented with modern vanilla JavaScript, custom state helpers, and handcrafted utility styles defined in `src/index.css`, so no additional packages are required for installation beyond Node.js.

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
