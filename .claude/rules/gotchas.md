# Gotchas

Surprises that cost real time on this repo. Add one whenever something bites you —
future agents (and you) read this before touching the area.

## Viewer (`templates/viewer.html`)

- **`hidden` loses to a CSS `display`.** An element styled `display: flex` stays visible
  with the `hidden` attribute set. Give it a `[hidden] { display: none; }` rule (see
  `.verdict[hidden]`). The verdict row shipped visible-when-empty until a test caught it.
- **Measure only what is on screen.** A clamped note in a hidden pane measures 0, so a
  "does it clip?" check at render time never fires. Re-run it when the tab is shown
  (`revealNoteToggles` in `setTab('files')`).
- **Sticky things stick at `--stick`, below the title bar.** The title bar is pinned to
  the top, so anything `position: sticky` in the reading column must use `top:
  var(--stick)`, not a few px, or it slides under the bar. A sticky panel as tall as the
  window also rides up with the end of its column on a short page: cap its height to
  leave room for what sits below the column (see `.askpanel, .inspector`).
- **Two sticky lines: `--bar-top` and `--stick`.** A section's own menu (`.dg-tabs`,
  `.files-modebar`) pins at `--bar-top` (under the title bar, and under the side-bar row
  on a narrow window — its height is measured into `--sb-row`). What sticks inside such
  a section uses that section's `--stick` (`#pane-files` sets it below its menu). A
  sticky box as tall as the window must also be capped by the room left at the very end
  of the page (`fitFilesNav` measures what sits below the column), or it rides up under
  the menus there.
- **Two palettes.** `graphite` (dark, default) and `slate` (light, also the print
  palette). `bond` was retired: `RETIRED_PALETTE` maps a saved one to `slate`. Tests that
  need a light palette switch to `slate`.
- **Section tabs live in the side bar.** `#tabs` is inside `#sidebar`; the Help button is
  in the same list but is not a `.tab` (tests count tabs). Select a section with
  `#tabs .tab[data-pane=…]`. The intent block (`.sub`) is hidden on screen (it is the
  title's hover text) but still carries the prose measure the design test reads.
- **A translation is a catalog over the map, never a rewrite.** `translatableStrings`
  (templates/viewer-logic.mjs) is the one list of reader-facing text; a new prose field in
  the schema must be added to its `TEXT_PATHS` or it stays untranslated. Diagrams are baked
  per language by assemble.mjs into `<template data-dg-lang>`, swapped in at startup before
  anything reads the cards. Node anchors key by the ORIGINAL label (`labelOrigin`), or notes
  vanish when the language changes. An ER relation label is bare in the source: once
  translated into several words it must be quoted, or the diagram falls back.
- **Diagrams on other tabs are `.dg-off`, never `display:none`.** Mermaid must measure a
  diagram to render, fit or re-render it on a palette switch, so an inactive diagram is
  taken out of flow with `visibility:hidden` and height 0. Anything that leads into a
  diagram must call `showDiagram`/`revealDiagramOf` first. Print and the app's PDF export
  (`body.dg-print`, set by `preparePrint`) show every diagram again. In tests, open the
  diagram's tab (`#dgTabs .dg-tab[data-dgkey=…]`) before interacting, and select a
  diagram's SVG with `pre.mermaid > svg`: legend samples are SVGs too.
- **The reading column may not carry a fill, legends included.** `tests/design.mjs`
  fails any filled element in `.main-panel` outside an SVG. Draw a legend sample as a
  small SVG (`swatchSVG`), the way the diagram draws the mark. Storyboard cards are
  outlined (status = `.sb-rail` edge), so design checks of diff fills sample only
  `.diagram:not(.storyboard)`.

- **The design gate covers the desktop shell too.** `tests/design.mjs` checks
  `app/src/renderer/styles.css` with the same rules it applies to the viewer (radius ≤ 5px,
  font ≥ 13px, weights 400/500, colour literals only above the `* { box-sizing… }` marker,
  shadows only on the named overlays, a `prefers-reduced-motion` block). Both appearances
  live in that one token block — Electron drives the renderer's `prefers-color-scheme` from
  `nativeTheme.themeSource`, so the Light/Dark/System switch needs no class plumbing, and a
  colour hard-coded outside the block silently breaks one of the two themes.
- **Design test is a hard gate.** `tests/design.mjs` fails the build on: any
  single `border-radius` > 5px, any `font-size` < 13px, `text-transform: uppercase`,
  a hex colour outside the `:root`/`[data-p]` token block, a shadow on a
  non-overlay, or a second level of box nesting in the reading column. Style new UI
  within these from the start — the big-map work tripped all three of the first
  ones at once.
- **Palette order matters.** Palettes are token blocks selected by `[data-p=…]`,
  and `:root` always matches `<html>` whatever `data-p` says. The default palette
  must be defined FIRST (on `:root, [data-p="…"]`); the others come AFTER it so
  their attribute selector wins by source order. Put a palette on `:root` in the
  middle and it silently overrides the ones above it.
- **Diagrams bake the palette at render.** Mermaid diagrams are compiled with the
  palette's tokens once; switching palette re-renders them (`applyPalette` →
  `runDiagrams`). Since Diagrams is the default tab, they render eagerly at load —
  so a palette switch that sets `data-p` directly (not via `applyPalette`/the
  swatch) will NOT re-render. Tests must switch palette the way the UI does.
- **TDZ across the one big script.** The viewer is a single top-to-bottom script.
  A `const`/arrow function called from code ABOVE its definition throws
  "Cannot access before initialization". If something early (e.g. the story
  render, showOverview at init) calls a helper, that helper must be a hoisted
  `function` declaration — see `canGenerate`, `lazyPane`.
- **Edges are placed from live rects.** Code-map connectors are positioned from
  node `getBoundingClientRect()`. Anything that reflows the layout — collapsing or
  resizing the aside, folding a group, changing column width — must call
  `drawEdges()` (rAF) or the lines point at where nodes used to be.
- **Default tab, not last tab.** A normal load opens on the default tab; it does
  NOT restore the last tab visited. Only a one-shot `flashTab` (set by `generate()`
  before its reload) survives, so Generate returns you to its tab. Don't
  reintroduce last-tab persistence.
- **The Files navigator's height is fitted by JS.** `.files-nav-body` is sticky, but where
  it starts on screen moves (below the header until the page scrolls), so `fitFilesNav()`
  re-fits its `max-height` on scroll, resize, tab and mode switch. Revealing a row must
  happen AFTER the fit (same rAF), or the row lands outside the re-sized box. Scroll a row
  into the navigator with `revealInNav`, never `scrollIntoView`, which scrolls the page too.
- **File status comes from git, read with `-z`.** `collectManifest` returns
  `[path, add, del, isNew, status, from?]`. Plain `--numstat` prints a rename as
  `src/{a => b}.ts`, which used to land in the map as a path.
- **Look at a screenshot baseline before you commit it.** `tests/visual` compares every tab
  against committed PNGs, which locks in whatever they show, bugs included. The first baselines
  showed both reference diagrams clipped on screen, a bug no behaviour test had caught. After
  `make screenshots-update`, open every changed PNG. A full-page capture stamps
  `position: fixed` elements mid-image, and the footer version changes per release. Both are
  neutralised in `tests/visual/capture.css`; add anything similar there, not to the viewer.

## PDF export (`docs/pdf-export.md` is the spec — read it first)

- **The PDF pipeline has a written contract.** `docs/pdf-export.md` holds the acceptance
  checklist, the locator-glyph mechanism, and every invariant tied to the test that
  enforces it. Change the pipeline only with that file open, and update it in the same PR.
- **Chromium print cannot make comment annotations.** `window.print`/`page.pdf`/Electron
  `printToPDF` are one engine that preserves only *link* annotations. Real PDF comments are
  produced after printing: a painted-but-invisible locator glyph → `pdfjs` readback of its
  real position → `pdf-lib` `/Text`. Do not try to compute PDF coordinates from the DOM —
  Chromium's paginated layout (forced page breaks, diagram fit-scaling) is not exposed to JS.
- **The locator glyph must be PAINTED, and styled inline only.** `display:none`/`opacity:0`/
  `font-size:0` drop it from the PDF text stream, so readback can't find it — hide it by
  paper colour instead. And style it via `element.style`, never a stylesheet rule, or the
  design gate (`tests/design.mjs`: font ≥ 13px, hex only in the token block) fails.
- **The locator token must be LETTERS ONLY — no digits.** In some print fonts (the diagram
  caption font, under Electron `printToPDF`) the digit glyphs lose their ToUnicode mapping and
  read back from the produced PDF as NUL, so `WDX000WDX` becomes `WDX\0\0\0WDX` and is never
  found → zero comments, notes silently dropped. This reproduced ONLY on real Electron
  printToPDF, never on Playwright `page.pdf()` — so it slipped past the e2e; `tests/print-pdf.mjs`
  now asserts the token matches `^WDX[A-Za-z]+WDX$`. To debug the packaged engine, drive
  `webContents.printToPDF` from a tiny `electron <script.cjs>` headless run and read the token
  back with pdfjs — that's how this was caught.
- **ESM-only deps crash the PACKAGED app at launch.** The main process is bundled to CJS, so a
  static `import` of an ESM-only module (pdfjs-dist v4 is `.mjs`-only) becomes a top-level
  `require()` of a `.mjs` → `ERR_REQUIRE_ESM`, and the app dies on start (not just on the PDF
  feature). Node/Playwright tests never catch this — only a real bundle does. Load such deps
  with a runtime `import(/* @vite-ignore */ …)` and `asarUnpack` them. `app/test/packaging.test.mjs`
  builds the bundle and guards it; this shipped once (whydiff 0.9.0) before the guard existed.
- **pdfjs in Node: keep `getDocument` options minimal.** `{ data, verbosity: 0 }` works;
  adding `isEvalSupported`/`useSystemFonts` pushes it onto a worker-transfer path that throws
  `DataCloneError` under the fake worker.
- **`beforeprint` fires during printing and re-runs the note build.** Under the desktop
  comment path the body carries `.wdx-comments` and the handler skips the rebuild — otherwise
  it re-adds inline footnotes and fights the comment placement. Do not remove that guard.
- **The e2e is not in `npm test`.** `tests/pdf-comments.mjs` imports the app's annotate module,
  so it spans both dep trees; run it with `make pdf-e2e` (CI: the `pdf-comments-e2e` job). The
  cheaper suites (`print-pdf.mjs`, `app/test/pdf-annotate.test.mjs`) never print — only the
  e2e proves a note survives a real print and lands on the right page.
- **Diagram comments pin to the caption, not the node** — by design (the glyph never goes
  inside the fit-scaled SVG). Text-selection comments pin exactly. Don't "fix" this without a
  robust in-SVG anchor.

## Desktop app (`app/`)

- **Asking the login shell for PATH is slow — never on the critical path.** `$SHELL -lic`
  costs whatever the user's rc files cost (~0.8s here, seconds on a heavy zshrc). The window
  opens on `quickPath()` (inherited PATH ∪ the usual bin dirs) and `pathReady` resolves the
  real one in the background; anything that spawns `claude`/`git` — analyze, clone, the
  preflight — must `await pathReady` first, or it reports a false "not found".
- **Electron is the only way to test the theme.** Playwright's `colorScheme` emulation proves
  the CSS, not the wiring: the app's Light/Dark/System switch works through
  `nativeTheme.themeSource`, which only exists in a real Electron run. Drive it with a tiny
  `electron <script.cjs>` harness that requires `out/main/index.js`, calls the IPC, and reads
  `getComputedStyle(document.body).backgroundColor` back.
- **A stretched link cannot wrap another control.** The project row opens the project AND has
  a Remove button. A `<button>` row wrapping a `<span onClick>` looked fine and was
  unreachable by keyboard; a button inside a button is invalid. The row is a plain element,
  the name is a button with a stretched `::after`, and Remove is a sibling button with
  `z-index` above it.

## Generator (`scripts/`, `agents/`, `skills/`)

- **`.whydiff/` outlives a run.** A map from yesterday sits there until it is overwritten, so
  "the file exists" proves nothing about this run. `run.mjs` checks the diff is non-empty
  before starting Claude and refuses a map whose mtime did not move. A clean working tree on
  a committed branch once failed with 26 "not in the diff" errors from exactly this.
- **`serve.mjs` assembles once at startup.** It builds the served HTML from the
  template when it boots (and on a generate). Editing `templates/viewer.html` while
  a `serve`/`serve-<fixture>` is running shows nothing until you restart it.
- **The schema is enforced, not just documented.** `scripts/schema-check.mjs` holds
  every map to `schema/review-map.schema.json` (required fields, types, enums) inside
  `validateStructure`, so `merge.mjs` and `validate.mjs` refuse a drifted map. Before it,
  only cross-references were checked: a map whose groups had only `{ id, files }` passed
  as "valid" and the viewer printed "undefined" as every group heading; object-form
  `ops.migrations` printed "[object Object]". `assemble.mjs` only warns, so an old saved
  map still opens; the viewer's `normalizeMap` makes it render. A new schema keyword
  must be implemented in the checker (`tests/schema-check.mjs` fails otherwise).
- **`GROUPS:` means `narrative.groups` is mandatory.** A classifier given `GROUPS:` emits
  `{ id, files }` only, by design; the group's name/role/why then exist nowhere but in
  the orchestrator's `narrative.json`. `merge.mjs` refuses the map and says so.
- **`generated` must match content.** The viewer treats a section as present iff
  it's in `map.generated`. `merge.mjs` ties `story`→`generated` to the story array
  being non-empty; keep any new lazy section's presence and its `generated` entry
  in step, or the viewer shows a Generate button over real content (or vice-versa).
- **A lazy section = one file + one SECTIONS entry.** To add a Generate-able pass:
  an `agents/<name>.md` that prints the section's keys, plus a line in `SECTIONS`
  in `serve.mjs` (`{ agent, keys }`). The generic path folds `keys` into the map
  and marks `generated`. The classifier is core; don't put lazy output there.
- **Private polygon is unnamed.** The real test-bed repo (hydron) is private:
  never name it in shipped files, examples, or fixtures. `PLAN.md` calls it "the
  private test-bed project". Leak-scan runs in `make bump`'s release path.

## Process

- **Version-keyed plugin cache.** Installed users get an update only when
  `plugin.json`'s version changes. Merging code to main without a bump reaches
  nobody (this actually happened — 0.10.2 code shipped invisibly). `make bump` +
  the `version-guard` prevent it.
- **`gh` is the wrong account here.** `gh` is signed in as the work account
  (alishervertex); whydiff is smagew's. `git push` uses the smagew SSH key
  (correct), but `gh pr create` / release / repo-settings via `gh` would act as the
  wrong identity. Push the branch; open PRs and toggle repo settings as smagew.
