# Gotchas

Surprises that cost real time on this repo. Add one whenever something bites you —
future agents (and you) read this before touching the area.

## Viewer (`templates/viewer.html`)

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

## Generator (`scripts/`, `agents/`, `skills/`)

- **`serve.mjs` assembles once at startup.** It builds the served HTML from the
  template when it boots (and on a generate). Editing `templates/viewer.html` while
  a `serve`/`serve-<fixture>` is running shows nothing until you restart it.
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
