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

## Phases

Each phase is useful on its own and unblocks the next. The spine is: **prove a
headless run → wrap it in a runner → put a shell around it → add history → add
remotes → package.** Decisions are pulled to the phase that first forces them.

### Phase 0 — Prove a headless run (a spike, no app) — ✅ DONE (2026-08-12)

> **Result:** confirmed. `claude -p "/whydiff HEAD~1..HEAD" --plugin-dir <repo>` ran
> a full analysis on the `synthetic` fixture headlessly, **exit 0, no interactive
> permission wall** — the plugin's `approve` hook auto-approves the pipeline's own
> ops in `-p` mode. It produced a valid `review-map.json` (10 files, 6 groups, 3
> diagrams; `validate.mjs --ref HEAD~1..HEAD` → *"structure valid, manifest matches
> the real diff"*) **and** the self-contained `review-map.served.html`. Wall-clock
> ~4 min on the small fixture. **Path (A) — shell the skill — is viable; it is the
> MVP path.** Notes for the runner: it must pass and record the range and reuse it
> for validation (the pipeline already records `ref` in `manifest.json`); and the
> MVP therefore depends on Claude Code + the plugin being installed (fine for A,
> lifted later by B).

The one unknown that everything rested on: **can a full whydiff run happen without an
interactive Claude Code agent?** The skill today is driven by the main agent.

- The headless docs say user-invoked skills work in `-p` mode (`claude -p "/whydiff
  HEAD~1..HEAD"` expands the skill), so **shelling the skill is the likely path** —
  confirm it end-to-end on a fixture and check `.whydiff/review-map.json` comes out
  valid (`validate.mjs`).
- **Decision it forces — how the model is driven (the crux):**
  - **(A) Shell the skill** — `claude -p "/whydiff …"` with the plugin installed;
    Claude Code does the orchestration. Fastest; but needs Claude Code + the plugin
    present (the app runs it, the user doesn't open it).
  - **(B) Orchestrate the passes ourselves** — the runner reads `agents/*.md`, calls
    `claude -p` (or the API) per pass, merges/assembles deterministically. True
    standalone (no Claude Code), more work; this is the portable core done properly.
  - Recommendation: **start with (A)** to get end-to-end fast; **evolve to (B)** for
    real independence and non-Claude providers.
- **Done when:** a fixture analyses from a plain terminal and the map validates.

### Phase 1 — Standalone runner (headless, no UI)

- **Goal:** `node scripts/run.mjs <repo> <base..head>` → writes `.whydiff/` (map +
  assembled HTML), streaming progress; wraps whichever path Phase 0 chose.
- **Depends on:** Phase 0.
- **Decisions:** progress/streaming shape; timeouts; failure handling; which passes a
  "quick" run does (core: classifier + diagrammer) vs a "full" one.
- **Done when:** the runner produces a valid map on the fixtures; independently useful
  for CI (closes the ROADMAP "standalone CLI" item).

### Phase 2 — Electron skeleton + projects — 🚧 in progress (2026-08-12)

- **Goal:** one window; "add project" (disk path or GitHub URL); a saved **project
  list**; re-select on next launch.
- **Depends on:** nothing (can run parallel to Phase 1).
- **Decisions settled:** Electron (electron-vite + React), monorepo `app/`. **Store:
  a plain JSON file, not SQLite** — the native `better-sqlite3` segfaulted under this
  Node/Electron ABI, and Electron's bundled Node has no built-in `sqlite`; a JSON file
  is enough for a project list and keeps the app native-dependency-free (the exact
  cross-OS packaging pain we want to avoid). SQLite returns in **Phase 4** behind the
  same `openStore()` interface. Still open: where a GitHub-URL clone is cached.
- **Built:** `app/` — window + IPC, the projects store (`openStore()`, tested under
  node), and the React project list (add local folder / add GitHub URL, remove,
  persisted). `npm run build` compiles; `npm test` passes.
- **Done when:** add two projects, relaunch, they're listed and re-selectable
  (verified headlessly via the store test + a compiling build; the GUI itself is run
  locally with `npm run dev`).

### Phase 3 — Select → git state → run → view — 🚧 built (2026-08-12)

- **Goal:** select a local project → check uncommitted → offer analysis (accept →
  runner → **`serve.mjs` spawned and loaded in the window**); decline → list
  commits, click one → run. This is the core loop.
- **Depends on:** Phases 1 + 2.
- **Decisions settled:** the app spawns the runner (`scripts/run.mjs`) and the server
  (`scripts/serve.mjs`) as child processes via `app/src/main/whydiff.mjs`, streaming
  the runner's progress lines to the window and loading the server's localhost URL in
  a new `BrowserWindow`. Working-tree analysis needed `run.mjs` to treat "no range" as
  the working tree — done (0.19.0). GitHub projects show a placeholder until Phase 5.
- **Built:** `app/src/main/git.mjs` (git state: uncommitted + commits + per-commit
  range) and `whydiff.mjs` (run + serve bridge), both tested under node; IPC in
  `main/index.js`; the `ProjectView` UI (uncommitted banner + "Analyze working
  changes", a commit list with per-commit "Analyze", live progress, opens the map in
  its own window). `npm test` (store/git/bridge) passes; the build compiles.
- **Done when:** the full loop is exercised in the running app — verified headlessly
  here (module tests + compiling build); the GUI + a real analysis are run locally
  with `npm run dev`.

### Phase 4 — Analyses index + history — 🚧 built (2026-08-12)

- **Goal:** save analyses; mark commits that already have one with an icon; a **latest
  analyses** list; re-open a saved analysis.
- **Depends on:** Phase 3.
- **Decisions settled:** each analysis's map (+ HTML) is copied to an **app-owned**
  store, `userData/analyses/<id>/`, and indexed in the store (JSON) by
  `{projectId, kind, ref, created_at}` — so a saved analysis re-opens even if the
  repo's own `.whydiff/` was cleaned or a clone is gone. `ref` is the commit hash /
  range / `""` (working tree) / `pr:N`. **SQLite stays deferred** — JSON handles this
  scale fine (a "does this commit have a map" lookup is an array scan), and it keeps
  the app native-dependency-free.
- **Built:** the store gained the analyses index (add/list newest-first/`analysisForRef`/
  remove, tested + persisted); `project:analyze` now saves + records; new IPC
  `analyses:forProject` / `analyses:latest` / `analysis:open` / `analysis:remove`. The
  UI marks commits that have a map (● + **View** / **Re-run**), lists a project's
  **Recent analyses**, and a **Latest analyses** list on the home screen. `npm test` +
  build green.
- **Done when:** relaunch shows prior analyses and which commits carry one — verified
  by the store test + build; exercised in the running app via `npm run dev`.

### Phase 5 — Remotes: PR/MR + GitHub-URL projects — 🚧 built (2026-08-12)

- **Goal:** GitHub-URL projects (clone + PR browse); click a PR → run.
- **Depends on:** Phase 3 (+ 4 for marking).
- **Decisions settled:** the GitHub API is called with the built-in **`fetch`** — no
  Octokit dependency (`github.mjs`). A GitHub project **clones on demand** into
  `userData/clones/<owner>__<repo>/`; once cloned it reuses the whole local path
  (commits, working tree, analyze). A PR is fetched (`pull/N/head`) and analysed over
  its `base...head` range, saved as `kind:'pr'`, `ref:'pr:N'`. **Auth:** unauthenticated
  for public repos (rate-limited); an optional `GITHUB_TOKEN` env lifts the limit and
  reaches private repos. Storing a token in the **OS keychain is still to do** — a UI
  refinement, not a blocker.
- **Built:** `github.mjs` (parseRepo, mapPRs, fetchPRs) and `git.mjs` clone +
  `fetchPrRange`; IPC `project:resolve` / `project:clone` (streams progress) /
  `github:prs` / `project:rangeForPr`; `ProjectView` now resolves a project's repo
  (local or clone), offers **Clone repo** for an un-cloned GitHub project, and lists
  **Pull requests** with mark / View / Re-run. Tests cover the pure helpers and a real
  clone (of a local repo); `npm test` + build green.
- **Done when:** add a repo by URL, clone it, list PRs, analyse one — pure/clone parts
  verified by tests; the live GitHub calls + a real PR run are exercised in the running
  app via `npm run dev`.

### Phase 6 — Packaging & cross-OS polish — 🚧 built (unsigned) (2026-08-13)

- **Goal:** installable builds for macOS / Linux / Windows.
- **Decision (user's):** **unsigned, all three OSes** — no cost; the artifacts open
  with a one-time "unidentified developer" / SmartScreen warning. Signing +
  notarisation + auto-update are deferred (macOS needs an Apple Developer account
  $99/yr, Windows a code-signing cert; auto-update is coupled to signing).
- **Built:** electron-builder config (`app/electron-builder.yml`) → dmg/zip (mac),
  AppImage/deb (linux), nsis (win). The plugin rides inside the app as
  `extraResources` (`whydiff-plugin/`: scripts, templates, agents, skills, schema,
  hooks, `.claude-plugin`, mermaid), and at runtime the app points
  `WHYDIFF_PLUGIN_DIR` there, runs the plugin's scripts with **Electron's own node**
  (`ELECTRON_RUN_AS_NODE`, so no separate node is needed), and **widens `PATH`** (via
  the login shell) so `claude`/`git` resolve when launched from Finder. `run.mjs` uses
  `process.execPath` for its sub-steps so it works under that Electron node too.
- **Verified here:** the mac `.app` builds and bundles the whole plugin; the bundled
  `assemble.mjs`, run through the app's Electron-as-node against the bundled mermaid,
  produces a full map. The **GUI launch + a real analysis** are the user's to confirm.
- **CI + releases:** `.github/workflows/desktop.yml` builds all three on their own
  runners (unsigned) — the reliable way to get Linux/Windows, which can't be
  cross-built from a Mac. A manual run uploads them as run artifacts (for testing);
  **pushing a tag `app-vX.Y.Z` also publishes a GitHub Release** with every OS's
  installer attached (a `release` job gathers the per-OS artifacts and uploads them
  via the default `GITHUB_TOKEN`, `contents: write`).
- **App icon:** the brand giraffe — `build/icon.svg` (source) rendered to a
  1024×1024 `build/icon.png`; electron-builder generates the mac `.icns` / win `.ico`
  / linux png from it (the mac `.app` ships `icon.icns`, not the default).
- **Left:** signing/notarisation + auto-update when distributing publicly; the Tauri
  revisit if size/memory matter.

### Phase 7 — Live mode (in-app ask / instruct / options) — 🚧 built (2026-08-13)

- **Goal (the original interactive vision):** the map isn't just viewed in the app —
  it's **live**. Opening an analysis serves it through `serve.mjs`, so the ask panel
  works: ask a question about a block, instruct a change, choose between options —
  answered by the model against the repo, right in the window.
- **Blocker fixed:** `serve` re-assembles the saved map on open and used to crash when
  an `embedFull` file wasn't readable at its path (a commit range that renamed/deleted
  it, or a moved repo) — which is why the first cut fell back to a static file.
  `assemble.mjs` now **degrades** a missing embed to a plain drill-down (warn, don't
  fail), so serve always starts (regression test: `tests/assemble-degrade.mjs`).
- **Built:** opening a saved analysis now serves it live (`serveMap`, a fresh loopback
  port per window, `--repo` = the project/clone) and loads that URL; if serve can't
  start it falls back to the static self-contained HTML (inert ask UI) rather than
  nothing. The token serve injects rides in the served page, so `/api` calls are
  authorised.
- **Left / next:** worktree "Do it" (serve `--work`) as an opt-in so a proposed change
  can be applied from the window; per-analysis journal location; run live confirmation
  in the GUI (`npm run dev`).

## Cross-cutting questions to settle

1. **How the model is driven** — (A) shell the skill vs (B) orchestrate passes vs API
   key/SDK. *Blocks Phase 0/1. The most important one.*
2. **Does whydiff run headlessly today**, and with what dependencies (Claude Code +
   plugin installed)? *Phase 0 spike.*
3. **GitHub auth** — token in the OS keychain. *Phase 5.*
4. **Canonical analyses store** — `.whydiff/` + SQLite index. *Phase 4.*
5. **Packaging/signing** — Apple developer account, Windows cert. *Phase 6, has lead
   time and cost — worth deciding early even though it lands late.*
6. **Electron vs Tauri** — MVP leans Electron; low-risk to defer the final call to
   Phase 2.

## Start here

**Phase 0 spike:** run `claude -p "/whydiff HEAD~1..HEAD"` in a prepared fixture and
check that a valid `review-map.json` lands in `.whydiff/`. It's cheap, answers the
biggest unknown (does a headless run work, and via which path), and everything else
depends on the answer. If it works, Phase 1 (wrap it as `scripts/run.mjs`) is a small,
CI-useful step that doesn't touch any app code.

## Scope note

This is a **separate product** from the plugin — a real app, sizable — but
architecturally clean and heavily reusing what exists (`serve.mjs`, the pipeline, the
viewer). We move toward it gradually; the first concrete stone is the **standalone
runner**.
