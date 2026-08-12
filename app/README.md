# whydiff desktop (app/)

A desktop host for whydiff — pick a project, browse its changes, run a review map,
all in one window on macOS/Linux/Windows. Electron (electron-vite + React). See
[`../docs/desktop-app.md`](../docs/desktop-app.md) for the full plan and phases.

**Status: Phase 2** — the shell and the project list. Add a local folder or a GitHub
URL; the choice is remembered and shown on the next launch. Selecting a project to
run a review is Phase 3.

## Develop

```bash
cd app
npm install
npm run dev      # launch the app with hot reload
npm test         # the projects store (runs under plain node)
npm run build    # compile main/preload/renderer to out/
```

To actually launch a build, Electron's native ABI may differ from your Node's; if a
native module is ever added back, run `electron-rebuild`. The current store has **no
native dependency** (see below), so `npm run dev` works out of the box.

## Layout

```
src/main/index.js     Electron main: window, IPC handlers (projects add/list/remove)
src/main/store.mjs    the projects store (a factory over a file path — testable in node)
src/preload/index.js  the only bridge to the page: window.api.{listProjects, addLocal, …}
src/renderer/         the React UI (App.jsx: the project list + add controls)
test/store.test.mjs   the store contract
```

## Storage note

The projects store is a **plain JSON file** in the app's user-data dir — no native
dependency, so it builds and runs identically on every OS with no compile step. (The
initial plan named better-sqlite3, but its native module segfaulted under this
Node/Electron ABI, and Electron's bundled Node has no built-in `sqlite`.) A real
SQLite index earns its place in **Phase 4** — querying saved analyses across projects
— behind the same `openStore()` interface, once an Electron-compatible option is
picked.
