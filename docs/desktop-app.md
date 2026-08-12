# Plan: a desktop app for whydiff (a host over the core)

Status: **proposed / direction** (2026-08-12). Not committed to a release — a plan to
move toward gradually. Captures the vision, the stack decision, the real hard parts,
and an MVP sequence so the direction stays coherent as we take it one step at a time.

## Vision

A native/desktop app (one window, works the same on macOS, Linux, Windows) that makes
whydiff usable without a terminal or Claude Code open:

- **Open the app → pick a project**, either one already on disk or by a GitHub URL.
- The project is **saved**; next launch it's in a **project list** for quick re-select.
- **After a project is selected:**
  - **Local project:** check for uncommitted changes. If there are some, offer a
    whydiff analysis straight away — accept → run it, show the result **in the app**.
    Decline → show the repo's recent history: commits and merge/pull requests. Clicking
    a commit or a PR **runs whydiff** on that change.
  - **Analyses are saved.** Next time, commits/PRs that already have an analysis are
    marked with an icon, and there's a **latest whydiff analyses** list to jump back in.

## Why this fits (not a detour)

The app is another **host** over whydiff's portable core (`agents/*` prompts +
`review-map.json` + the HTML viewer/assembler) — exactly the "one core, many hosts"
direction in `ROADMAP.md`. It's also the most natural path to **non-Claude-Code
users**, and the offering closest to plannotator (see `docs/competitive-analysis.md`
and the positioning note in `ROADMAP.md`).

Crucially, most of the "show the analysis" surface **already exists**: `scripts/serve.mjs`
renders the map with ask / instruct / options / Tasks / worktree-work. So the app can
**spawn `serve.mjs` for a chosen analysis and load its URL in a window** — the render
layer is largely done. The app adds what's missing: a project manager, an analyses
index, and a git-history browser.

## Stack decision

| Layer | Choice (MVP) | Why |
|---|---|---|
| Shell | **Electron** | whydiff is Node/JS end-to-end (`scripts/*.mjs` pipeline + viewer + mermaid). Electron runs the pipeline **in the main process as-is** and renders the map in a BrowserWindow — the same Chromium we already target, so **identical rendering on all three OSes** and no rewrite. |
| App UI | React / Svelte / Solid | Thin: project list, history, git browser. The map itself is the embedded `serve.mjs`. |
| Storage | **SQLite** (`better-sqlite3`) | Projects, analyses (keyed by repo + commit/range), "this commit has an analysis" flags, "latest analyses". Fast queries. Stored under `app.getPath('userData')`. |
| Git | `git` CLI / `simple-git` | status (uncommitted), log (commits/branches), clone for a GitHub URL. |
| PR/MR | Octokit (GitHub) / GitLab API | Merge requests are a remote-API concept, not local git. A GitHub URL → shallow clone into a cache + API for the PR list. |

**Alternative — Tauri (Rust + system webview):** ~10 MB vs Electron's ~120 MB, lower
memory. But the backend is Rust while our pipeline is Node → we'd ship Node as a
**sidecar binary** (Tauri supports this) and render in the *system* webview (WebKit on
macOS/Linux, WebView2 on Windows), where small rendering differences can appear.
Verdict: **Electron for the MVP** (max reuse, consistent rendering); **Tauri later** if
bundle size / memory become priorities.

**On "no lag":** not a concern on either stack. The heavy work is the **LLM analysis
(remote, network-bound)**, not the UI; local work (git, assemble) is fast; the UI is
light. Electron's bundled Chromium gives the same rendering everywhere.

## The real hard parts (not the shell)

1. **How the analysis actually runs — the crux.** The plugin orchestrates the agents
   inside Claude Code. A standalone app needs a **whydiff runner**: the orchestration
   (manifest → shards → run the agent passes → merge → assemble) extracted from the
   skill into a script the app calls. This is the `ROADMAP.md` "standalone assembler /
   CLI" item, extended to the full run. Calling the model:
   - **MVP:** shell out to the user's installed `claude` CLI (already authenticated by
     their subscription) — zero new auth infrastructure, maximum reuse.
   - **Later / broader:** a bring-your-own Anthropic API key, or the Agent SDK; and for
     non-Claude users, a multi-provider path (the same "many hosts" logic).
2. **Fetching PR/MR.** A local repo yields commits/branches; PRs need the GitHub/GitLab
   API (a token). A GitHub URL → shallow clone into a cache + API for the PR list.
3. **Where analyses live.** whydiff already writes `<repo>/.whydiff/` (map + journal).
   The app also needs an index across projects (SQLite under `userData`). Decide what's
   canonical: the per-repo `.whydiff/` (portable, travels with the repo) as the store,
   with the SQLite DB as an index/cache over it.

## MVP sequence (one step at a time)

1. **Standalone runner** — `node scripts/run.mjs <repo> <range>` → `review-map.json`,
   calling `claude -p`. A precondition for the app, and independently valuable (CI, the
   ROADMAP CLI item). Build this first: the app has nothing to launch without it.
2. **Electron skeleton** — window, project list (SQLite), "add project" (disk path or
   GitHub URL).
3. **Select project → git status** — uncommitted present → offer analysis; else list
   commits/branches (+ PRs via API); click → runner → `serve.mjs` in the window.
4. **Analyses index** — save analyses, mark commits/PRs that have one, "latest whydiff
   analyses" list.

## Open decisions (to settle as we go)

- LLM path for v1: shell to `claude` CLI (assumed) vs API key vs Agent SDK.
- Electron vs Tauri final call (MVP leans Electron; revisit on size/memory).
- Canonical store for analyses: per-repo `.whydiff/` + SQLite index (assumed) vs
  app-owned store only.
- Multi-provider (non-Claude) — deferred until the single-host app proves out.

## Scope note

This is a **separate product** from the plugin — a real app, sizable — but
architecturally clean and heavily reusing what exists (`serve.mjs`, the pipeline, the
viewer). We move toward it gradually; the first concrete stone is the **standalone
runner**.
