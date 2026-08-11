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
