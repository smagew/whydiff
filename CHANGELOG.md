# Changelog

Notable changes to the whydiff plugin. Versions follow semver; the plugin
version in `.claude-plugin/plugin.json` must be bumped for installed users
to receive an update.

## [0.34.0] — 2026-08-19

### Changed
- **PDF output is legible now — light, not a black page of overlapping debris.** Printing
  a report (Cmd-P, or the app) had been unusable: the dark palette printed as a near-black
  page, the code-map connector lines and floating link labels landed on top of the content,
  and the palette swatches leaked in. Now the print path switches to a **light palette** (a
  `beforeprint` swap for Cmd-P, and an awaitable `preparePrint()` the app/headless path
  calls so diagrams re-render light before capture); the code-map overlay (connectors, link
  labels, the "show all links" toggle) and the swatches are hidden; colours print faithfully;
  and overlapping diagram renders are serialized so a good diagram no longer drops to its
  "invalid source" fallback. Code-map, notes and the text tabs come out clean. Known
  residual: a wide flowchart diagram can still clip on the right edge — tracked for the app
  Export-PDF work.

## [0.33.0] — 2026-08-18

### Changed
- **The served map opens in your browser, and the terminal stays quiet.** Three fixes to
  the end of a `/whydiff` run: (1) `serve.mjs` now opens the report in your default browser
  on startup (`--no-open` to suppress — CI, or the desktop app, which loads it itself); (2)
  it prints the `http://127.0.0.1:<port>/` URL as its **last** line, so it is what is left on
  screen instead of being buried; (3) the skill now ends with a short handoff (what the diff
  is, how many files to read, one timing line) instead of transcribing the whole report into
  the terminal — the analysis lives in the map, which is the point of building it.

## [0.32.0] — 2026-08-18

### Added
- **A PDF button in the report header.** The print/PDF path existed but had no
  visible control (only Cmd-P). Every report now shows a **PDF** button in the tab bar:
  click it on any tab to save that tab — with its notes appendix — as a PDF via the
  print dialog. The button sits in the tab bar, which the print stylesheet hides, so it
  never lands in the PDF itself.

## [0.31.0] — 2026-08-18

### Added
- **Print a tab to PDF — with its notes.** A print stylesheet turns any tab into a
  clean PDF via the browser/print dialog (Cmd-P): the interactive chrome (tabs, ask
  panel, rail, aside, footers) drops away, the reading column runs full width, and a
  **Notes & questions** appendix — built from the review threads — prints at the end, so
  the discussion travels into the PDF (the panel itself never prints). By default only
  the active tab prints; `body.print-all` prints the whole report. Colours follow the
  active palette, so pick a light one for ink on paper. (A one-click "Export PDF" button
  in the desktop app — which switches to a light palette and prints headlessly — follows.)

### Fixed
- The diagram-region test asserted the frame overlapped *exactly* the dragged nodes;
  the frame's small pad can also catch a close neighbour on a denser layout (CI), so it
  now asserts the frame **covers** the dragged nodes (and hasn't ballooned to the whole
  diagram) — the honest invariant, robust to layout/DPI. Test-only.

## [0.30.0] — 2026-08-18

### Added
- **Export a shareable review — notes included.** `assemble.mjs --journal <dir>`
  folds the review journal (notes, questions/answers, the Review tab's tasks) into the
  self-contained HTML, so the exported map reads offline with its annotations intact —
  the artifact you send to someone. Until now notes only existed in a served map (loaded
  live from `/api/threads`); a plain export had none. The exported map opens **read-only
  (view-only)**: badges/frames and threads render and read back, but every affordance
  that would ask, decide, or run work is removed — there is no server behind them, and a
  click on an un-annotated diagram node falls through to its normal file drill-down.
  (The desktop app's Export button that produces this file, and PDF-per-tab, follow.)

## [0.29.1] — 2026-08-18

### Changed
- **Internal: viewer logic is becoming unit-testable.** The viewer is one large
  in-browser script that until now could only be covered end-to-end. Its pure,
  DOM-free helpers are moving into `templates/viewer-logic.mjs`, unit-tested in node
  (`tests/viewer-logic.mjs`); `assemble.mjs` inlines that module into the viewer's
  single script (exports stripped) so the map stays self-contained. First helpers
  moved: `nslug` and the generation progress-estimate math. No behaviour change — the
  seam just lets this logic grow under fast unit coverage instead of only e2e.

## [0.29.0] — 2026-08-18

### Changed
- **The on-demand generation bar shows approximate progress, not just "busy".**
  0.26.0's bar was indeterminate — it never advanced, so it told you nothing about how
  far along a Generate was (and under "reduce motion" it sat full, looking done). A
  section is one open-ended agent, so there is no exact percentage — but two real
  signals give a fair estimate: elapsed time, and the moment the pass stops reading
  files and starts writing its answer. `serve.mjs` now emits that read→write transition;
  the bar eases toward ~70% while the pass reads, jumps and eases toward ~97% once it is
  writing, and completes on done. It is an estimate, grounded in real signals — it never
  fabricates 100% before the work is finished.

## [0.28.0] — 2026-08-18

### Fixed
- **The diagram region frame no longer drifts on sequence (and other non-flowchart)
  diagrams.** 0.27.0 anchored the region as a fraction of the diagram's screen box,
  which held on a flowchart but broke wherever opening the ask panel refits the
  diagram to a very different size — e.g. a wide sequence diagram squeezed into the
  narrowed column: the frame collapsed to a sliver or jumped to a corner, detached
  from what was selected. The region is now anchored in the diagram's **own SVG
  coordinate space** (`getScreenCTM`), which is invariant to scale, centring and
  scroll, so the frame returns to the exact selected area through any re-layout, on
  every diagram type. Regression-tested by asserting the frame overlaps the same
  nodes/actors the drag covered — on a flowchart and a wide sequence diagram, before
  and after a reload.

## [0.27.0] — 2026-08-18

### Fixed
- **Asking about a region of a diagram works on every diagram type, and always
  shows where you asked.** Dragging a region looked for covered `.node` elements
  (flowchart-only), so on any other diagram the drag found nothing: the ask panel
  never opened, no frame was drawn, and the gesture sometimes turned into a native
  text selection with a stray "ask about this text" hint. Now the drag suppresses
  native selection, and the region is anchored **geometrically** — stored as a
  fraction of the diagram's own box — so the ask panel opens even when the region
  covers no discrete nodes, and the dashed frame redraws onto the exact area after a
  reload or a re-layout (palette switch, resize). Covered node labels still ride
  along as context for the model, best-effort. This makes "show me where each note
  or question lives" a property that holds for diagram regions the way it already
  does for text and code selections.

## [0.26.0] — 2026-08-18

### Added
- **A live progress bar when you generate a section from the map.** Clicking
  Generate on a lazy pane (Summary / User stories / Standards / Tests) — or
  Regenerate on a broken diagram — now shows a moving bar with the pass's current
  step and elapsed time, instead of a single line of text. The bar is
  indeterminate on purpose: one open-ended agent does the work, so there is no
  honest percentage to show, and it never fakes one.

## [0.25.4] — 2026-08-14

### Fixed
- **The "Syntax error" bomb can't slip through any longer.** The 0.23.0 fallback
  validated with `mermaid.parse`, but a diagram can pass parse and still fail to
  render — and `mermaid.run` then injects its bomb graphic in place without throwing,
  so the guard missed it. Each diagram now renders on its own and both failure modes
  are caught — an exception, or the bomb detected after the run (by its own "mermaid
  version" text) — and swapped for the readable fallback. Rendering per-diagram also
  means one bad diagram no longer aborts the render of the good ones beside it.

## [0.25.3] — 2026-08-14

### Fixed
- **A collapsed aside re-opens itself for a sidebar action.** After collapsing the
  aside, a click or selection that needs it (a Code-map/diagram file drill-down, an
  ask/note) went into a force-hidden column and looked like nothing happened. Any such
  action now un-collapses the aside first (`revealAside`), so the drill-down or panel
  appears without reopening it by hand.

### Changed
- **The Options tab is hidden when there are no options.** Options is only meaningful
  on a problem the map found (a finding, a test gap, a broken/partial story); elsewhere
  it was shown disabled, which read as broken. It's now hidden where it doesn't apply
  and appears only where it does.

## [0.25.2] — 2026-08-14

### Fixed
- **Diagram annotation marks follow a panel resize.** The badges and region frames on a
  diagram stayed pinned to their old positions when the ask/note panel was resized —
  the diagram reflowed under them but they didn't move. Dragging the `rc-grip` now
  refits the diagram and redraws the marks from the live node positions, so they stay
  put on the right blocks.

### Changed
- **A diagram annotation badge is always visible.** The badge glyph is now the accent
  colour at rest (so an annotated place reads at a glance, not only on hover); hovering
  the badge highlights its border instead.

## [0.25.1] — 2026-08-14

### Changed
- **The ask/note panel is resizable while you ask.** The drag handle between the
  reading column and the aside (`rc-grip`) now works when the ask/note panel is open —
  its width was fixed before, so the grip did nothing. Drag it to widen or narrow the
  panel (and so the diagram beside it); the width is remembered for the window. Most
  useful in the single-diagram pop-out, where you read and work with one diagram.

## [0.25.0] — 2026-08-14

### Changed
- **"Open in new window" gives the whole diagram view, not a bare picture.** The
  pop-out (⧉) used to copy just the SVG into a blank window — losing the palette
  styling (the diff colouring is applied by the viewer's CSS, absent there) and any
  way to ask or note. It now opens this same page in a new window focused on that one
  diagram (`#dg=<i>`): a full viewer, so it keeps the palette and the diff colouring,
  and in served mode the ask / note panel works there too — the whole point of
  opening a diagram in its own window to read and work with it.

## [0.24.1] — 2026-08-14

### Changed
- **Diagrams use the whole row.** They sat left at natural size with the aside's
  column reserved-but-empty beside them, wasting the width. Now every non-Code-map tab
  runs the reading column full width (the aside reclaims its space and slides back in
  only for a file drill-down), and each diagram grows toward that width — centred, the
  upscale capped at 1.6× so a small diagram doesn't balloon, and a wide one just fits.
  Re-fits on resize and when the aside opens.

## [0.24.0] — 2026-08-14

### Added
- **Syntax highlighting for code.** Code in the viewer — the full-file drill-down,
  the diff fragments, the card previews, and markdown fences — is now syntax-
  highlighted (highlight.js, inlined like mermaid, so the map stays self-contained
  and needs no network). The language comes from the file extension, not auto-detect.
  The theme is a **muted, few-hue set of palette tokens** (per palette), so the
  highlight follows the active palette and stays within the design system rather than
  being a fixed rainbow. Diff rows keep their signal — a background tint for
  added/removed, a strike-through for removed — while the code itself carries the
  syntax colours. Falls back to plain text when the language is unknown or a line
  won't parse, so a highlighter-less file still reads.

## [0.23.1] — 2026-08-14

### Changed
- **Code-map file cards use the full width.** The cards were fixed at 320px and the
  code preview capped at 292px, so rows left empty space and a card left alone on its
  row stayed half-width. Cards now grow to fill the row (a one-file group, or the last
  of an odd count, takes the whole width) and the preview uses the card's width — so
  more of each changed line is visible.

## [0.23.0] — 2026-08-14

### Changed
- **An unrenderable diagram no longer shows mermaid's "Syntax error" bomb.** The
  generator can emit invalid mermaid; the viewer now validates each diagram
  (`mermaid.parse`) before rendering and, on failure, shows a readable fallback —
  a short message, the diagram source (collapsible), a **Copy source** button, and,
  when served, a **Regenerate diagrams** button — in place of mermaid's built-in error
  graphic. Valid diagrams render exactly as before.

### Added
- **Regenerate diagrams on demand (served).** `serve.mjs` exposes the diagrammer as a
  section through `/api/generate`, so the fallback's **Regenerate diagrams** button
  re-runs that pass against the same diff and replaces the map's diagrams in place.

## [0.22.0] — 2026-08-13

### Added
- **Choose which optional sections to generate up front.** Alongside `--full` (all
  optional passes), `run.mjs --sections <ids>` and a `sections:<ids>` argument to the
  skill generate just a subset — ids `story`, `standards`, `tests`, `stories` — while
  the core passes (Code map, Diagrams, Ops) always run and the rest stay one click
  away in the viewer. `--sections` and `--full` are mutually exclusive; neither means
  a core-only run.
- **Structured run progress.** `run.mjs --progress-json` emits one `@stage {…}` line
  per stage transition (prepare, each pass, merge, assemble; start/done), so a host UI
  can show which passes are planned, running and done. Off by default — the plain CLI
  output is unchanged.

## [0.21.2] — 2026-08-13

### Changed
- **A map still assembles (and serves) when an embedded file is unreadable.** With
  `embedFull`, `assemble.mjs` reads each such file from the repo; if it isn't there —
  a commit range that renamed/deleted it, or a relocated repo — it now degrades that
  file to a plain drill-down (a warning) instead of aborting. This is what lets
  `serve.mjs` re-assemble a saved map for the desktop app's live mode without
  crashing. Regression test: `tests/assemble-degrade.mjs`.

## [0.21.1] — 2026-08-13

### Changed
- run.mjs runs its sub-steps with process.execPath (not a literal node), so a packaged host running it under Electron's node works

## [0.21.0] — 2026-08-13

### Changed
- **The Diagrams tab says when there is nothing to draw.** A change that alters no
  control or data flow produces no diagrams; the tab used to show only the generic
  "how a node is marked" hint over a blank pane. It now says so plainly and points at
  the Code map. (Diagrams are a core pass — empty means no flow changed, not "not
  generated yet".)
- **`run.mjs --full` generates every section.** With `--full`, the runner asks the
  skill for the optional passes (Summary, user stories, standards, tests) up front, so
  the produced map is complete — no Generate button needed. The desktop app runs full
  by default (a "Full report" toggle in the project view), because a standalone map
  file cannot generate lazily (that needs the live server).

## [0.20.0] — 2026-08-13

### Changed
- **A saved or shared map file renders correctly when opened directly.** The
  assembled HTML now starts with `<!doctype html><meta charset="utf-8">`, so a map
  opened as a file (the desktop app's window, a shared `.html`, artifact hosting)
  shows non-ASCII text — arrows, em-dashes, Cyrillic — right, not just when served
  with a charset header. Fixes mojibake in the desktop app's map window.

## [0.19.0] — 2026-08-12

### Changed
- **`run.mjs` with no range maps the working tree.** `node scripts/run.mjs <repo>`
  (no `<base..head>`) now analyses the working tree vs HEAD — staged, unstaged and
  untracked — the same default `/whydiff` uses, and validates with no `--ref`. A range
  is still passed through. This is what lets the desktop app offer "analyze my
  uncommitted changes".

## [0.18.0] — 2026-08-12

### Added
- **A standalone headless runner.** `node scripts/run.mjs <repo> [<base..head>]`
  produces a change map with no interactive session: it drives `claude -p "/whydiff
  <range>"` (streaming which pass is running), then validates the map against the
  real diff and assembles the portable `review-map.html`. Clear exit codes (0 ok / 1
  run-or-validate failure / 2 usage). This is the headless core a CI job or a desktop
  host builds on — the first stone of the desktop-app plan
  ([`docs/desktop-app.md`](docs/desktop-app.md)) and the ROADMAP "standalone CLI"
  item. Path (A) — shell the skill — so it needs Claude Code + the plugin present.

## [0.17.0] — 2026-08-12

### Added
- **Diagrams are an annotation surface.** The cursor now tells you what a diagram
  affords: a **crosshair** over the field (drag to select a region) and a **pointer**
  over a block (click it). A plain click on a block opens the panel to **ask or
  note** about that block — the file it links to stays reachable from the chips below
  — and dragging a rectangle asks about a whole **region**. An annotated block or
  region carries a small **badge** — a chat glyph where a discussion is pinned, a note
  glyph where a note is — and a region keeps its **dashed frame**. Both are redrawn
  from the review journal on every render (so they survive a palette switch and a
  reload), and clicking a badge opens its thread. Served-only, like the rest of the
  ask UI.

## [0.16.1] — 2026-08-12

### Fixed
- **The Overview | Call graph aside belongs to the Code map.** It was showing on
  every tab, including Diagrams; now it appears only on the Code map, and every other
  tab runs the reading column full width. A cross-link or a diagram node still
  reveals the aside on demand for a file drill-down, which collapses again on Back or
  when you switch tabs.

## [0.16.0] — 2026-08-12

### Added
- **Notes on the map — `ask` becomes a visible annotation.** The ask panel gains a
  fourth mode, **Note**: pin a bare reviewer remark to any place (a story, a diagram
  node, a file, a finding, a selection) with no model involved. Like a question, a
  note marks its anchor on the map, reads back in the panel, and is saved to the
  review journal so it survives a reload — making the map a surface you annotate,
  not only read. A new `note` journal kind carries it (distinct from a `decision`,
  which is a verdict on a plan).

## [0.15.2] — 2026-08-12

### Changed
- **A *moved-on* patch no longer dead-ends.** When applying a worked patch fails
  because the reviewed tree changed since the task was worked, the Tasks tab offers
  **Re-run to rebase** — it reopens the task and re-works it against the tree as it
  stands, producing a patch the gate can apply. Already-applied is shown as a plain
  note, not an error. (Client half of the 0.15.1 server-side classification.)

## [0.15.1] — 2026-08-12

### Changed
- **serve --work is steadier at the edges.** On startup it reclaims worktrees a
  killed run left behind (`whydiff-work-*`) and prunes stale registrations — ours
  only, never another worktree. And a patch that no longer fits the working tree is
  refused with the case named: *already applied* (nothing to do) vs *moved on*
  (re-run the task to rebase it), instead of one ambiguous message. The apply gate
  stays clean-or-refuse — the tree is never left half-applied.

## [0.15.0] — 2026-08-11

### Added
- **A per-language file icon next to every file, everywhere it is listed.** Real
  language logos (php, js, ts, python, ruby, go, java, css, html, vue, docker …
  from devicon, MIT — brand colours stripped so they inherit the palette and stay
  monochrome, within the design system), with a monochrome category glyph
  (database, config, docs, shell, locale, template, file) where no logo exists.
  Shown on the Code-map cards, the Overview and Call-graph rows, the manifest, the
  drill-down Links, and the story/cross-link chips. Static (extension → icon, no
  model cost). Replaces a broken language dot that rendered nothing.

## [0.14.2] — 2026-08-11

### Fixed
- **erDiagram rows are readable in a dark palette.** Mermaid 11 draws attribute
  rows as `.row-rect-odd`/`.row-rect-even` and ignores the theme's attribute-
  background variables, so its default light "odd" row rendered light text on a
  light fill in graphite. Both rows are now forced onto dark surface tokens (light
  in a light palette), so the text contrasts on either.
- **Hovering a connection label shows its full title and description.** The label
  on an edge is ellipsised to a short pill; hovering it now opens a popover with
  the whole title (which the pill cut off) plus the description — previously the
  popover carried only the description, and a title-only label had none at all, so
  a cut-off title was unreadable.

## [0.14.1] — 2026-08-11

### Fixed
- **A normal load always opens on the default tab (Diagrams).** The map restored
  the last tab you visited, so a stale session could open on Summary instead of the
  intended default. The last-tab restore is gone; only a one-shot flag survives, so
  clicking Generate still returns you to that tab with its new content, while every
  other load opens on Diagrams (or the Code map when a diff changed no flow).

## [0.14.0] — 2026-08-11

### Added
- **A Call graph in the aside, beside the Overview.** The right panel now has two
  sub-tabs: the per-group **Overview**, and a **Call graph** — the map's file
  connections (`edges`) laid out as a dependency tree with monospace guides, a node
  shown once and folded (↩) if it recurs. Clicking a node jumps the Code map to its
  block and flashes it; each node keeps a `view` button for the drill-down. Empty
  when the change tracks no connections.

## [0.13.0] — 2026-08-11

### Changed
- **Tabs reordered, renamed, and Summary is now optional.** The order leads with
  the strongest view: **Diagrams · Code map · User stories · Summary · Ops & risks
  · Standards · Tests**. "Logic" is renamed **Summary** (a plain-language causal
  walkthrough) and joins the lazy passes — a map without it shows the section blurb
  and a Generate button, like User stories. "Files" is renamed **Code map**. The
  map opens on Diagrams, falling back to the Code map when a diff changed no flow.
- **The Summary is generated on demand.** The classifier no longer authors the
  `story`, so a default run omits it and the Summary tab is lazy. A new
  `summariser` agent writes it — from the built map plus the diff — on a full run
  or when you click Generate (a new `story` section in the serve endpoint). Present
  story is marked in `generated`, so the viewer shows it rather than the button.

## [0.12.1] — 2026-08-11

### Changed
- **Graphite is the default palette.** The dark-first graphite theme now ships on
  `:root` (previously slate, with graphite only auto-selected under a dark OS
  preference). Slate and bond remain one swatch-click away.

## [0.12.0] — 2026-08-09

### Added
- **The inspector is resizable, and opens wide for a file.** A file drill-down
  (the `view` button) now opens the right panel at half the width instead of the
  narrow overview column, since it carries more prose. Drag the pill on its left
  edge to set any width; the choice is remembered per map and wins over the
  per-view default. Files-tab connectors redraw as it resizes.

## [0.11.3] — 2026-08-09

### Fixed
- **A long file explanation no longer stretches the inspector.** The drill-down
  `why` block is capped (~3–4 sentences) and scrolls inside itself instead of
  growing the whole panel.

## [0.11.2] — 2026-08-09

### Fixed
- **Viewer honors the design system again.** The 0.11.0 big-map work slipped in
  three violations the design test catches: border-radius above 5px (the Overview
  edge tab and the cross-group link chips), type below the 13px floor (chips,
  buttons, the role label), and an ALL-CAPS role label. Radii pulled to ≤5px, all
  type raised to ≥13px, and the role tag is a plain muted label again.

## [0.11.1] — 2026-08-09

### Changed
- **English-only source.** The shipped `review-map` JSON schema descriptions,
  `PLAN.md`, and `docs/competitive-analysis.md` are now in English, per the
  source-language policy for this public project. The viewer keeps its `en`/`ru`
  interface locale (report language follows `meta.lang`, default `en`).

## [0.11.0] — 2026-08-09

### Added
- **A big change map stays readable.** On a large map (>24 files, >6 groups, or
  >18 links) the Files tab adapts: links default to hover-only (small maps still
  open with every link shown), groups open collapsed so the map reads as a
  scannable table of contents, and cross-group links render as chips on the node
  (click to jump to the file) instead of lines across the canvas — only same-group
  links stay drawn as lines. When "show all links" is on, overlapping edge labels
  are thinned so no two pile up.
- **Per-group reading progress** in each group header (`x/N read`), a ✓ button to
  mark the whole group read at once, and a done-tint when a group is complete.
- **Focus a single group** (⤢ in the header) to read it without the rest — Esc
  exits.
- **The overview panel navigates.** A group title jumps the reading column to that
  group's block; a file's path jumps to its node; each file row has a `view`
  button that opens the change with its explanation. The panel can collapse to
  hand its width to the reading column, and its group note collapses to one line.

### Changed
- File nodes show the basename in full weight with the directory greyed, so
  lookalike paths stop blurring together; the role tag is a quieter micro-label.
- The file drill-down shows a **Back** button at the top and bottom (renamed from
  "← overview").

## [0.10.2] — 2026-08-08

### Fixed
- **Generating a lazy section no longer times out at 180s on a large diff.** The
  Generate button (user stories, standards, tests) runs a FULL analysis pass — it
  reads the whole diff and repo — but it was sharing the 180-second budget meant for
  a quick ask, so on a big diff it failed with "timed out after 180s". Section
  generation now has its own budget: `--gen-timeout`, default 600s. A timeout message
  points at the flag so it can be raised further when a diff is very large.

## [0.10.1] — 2026-08-08

Fewer permission prompts on a first run.

### Added
- **`gather.mjs` folds step 1 into one command.** The deterministic setup used to be
  four commands the model chained with `&&`; the permission prompt could not
  recognise the chain, so it asked. It is now a single bundled script — create
  `.whydiff/`, write `manifest.json` and `diff.patch`, log the timing events, print a
  per-file summary — and bundled scripts are auto-approved, so the run opens without
  a prompt.

### Changed
- **The approve hook understands the shell the run actually uses.** It now parses a
  command quote-aware, splits it on `&&`, `||`, `;` and `|`, and auto-approves when
  every segment is one of the pipeline's own operations — the plugin's scripts,
  read-only `git`/`gh`, or read-only text tools (`cat`, `sed`, `awk`, `head`, `tail`,
  `wc`, `grep`, `diff`, …) reading the diff. A write redirect is allowed only into a
  temp location (`.whydiff/`, a `scratchpad/`, `/tmp`), resolved against any `cd`.
  Command substitution, a background `&`, `sed -i`, writes into source, and any
  reference to a sensitive path still defer to the normal prompt. Covered by a new
  `tests/approve.mjs`.

## [0.10.0] — 2026-08-07

The overview panel becomes a per-group index, and the Files map stops fighting the
reader.

### Added
- **The overview panel now maps every cause group to its files.** The right-hand
  panel used to be a bare legend (group names and roles). It now walks each group in
  turn — its tag and name, the one-line reason in a note box, then its files as rows
  (type label, path, `+/-` counts). Every row opens that file's diff, so the overview
  doubles as an index. The file map on the left is unchanged.

### Changed
- **A connection label carries a title and a description.** A short title rides the
  line; hovering it opens the full description, with a "more" toggle when the text is
  long — instead of one label stretched across the map.
- **"Show all links" is on by default** on the Files map, so every connection is
  visible when the tab opens rather than only on hover or select.
- **The user-stories tab drops its intro paragraph.** The verdict is already clear
  from the traffic-light badges and the problems-first ordering, so the summary and
  explainer above the cards only took space.

### Fixed
- **The content no longer shifts sideways between tabs.** The floating bookmark rail
  reserved a left gutter only on the tabs that had anchored questions, so the reading
  column jumped whenever you switched. Questions are now counted on each tab's own
  button; the rail is gone and the column keeps the same width on every tab.

## [0.9.2] — 2026-08-07

More fixes to the chrome, and to how a run is handed over.

### Fixed
- **The page no longer jumps when you switch tabs.** The right column collapsed on
  the prose tabs and came back on Logic/Diagrams/Files, so the reading column
  resized every time — the whole page appeared to stretch and shrink. The grid is
  now the same on every tab (a prose tab leaves the reserved area empty instead of
  growing into it), the responsive single-column collapse still applies because
  `.solo` no longer out-specifies the media query, and `scrollbar-gutter: stable`
  keeps a scrollbar appearing on a long tab from shifting everything sideways.
- **A long connection label no longer stretches across the map.** An edge's label
  can be a whole sentence; drawn full-length on the line it spanned the entire
  window. It is now capped and ellipsised on the line, with the full text on hover
  and in the inspector's Links. The schema and classifier also now ask for a short
  phrase, not a sentence, so the label fits the line in the first place.
- **The Tests tab stops wasting half its width.** When no tests are fixed (or no
  gaps), the empty side no longer holds an idle half-column — the populated list
  takes the full width and the empty one stays as its count line.

### Changed
- **A run serves the live report by default; the static file is now opt-in.** With
  the report gone interactive — ask, instruct, options, and Generate for the lazy
  sections — a static HTML can do none of that (its buttons are inert), so handing
  one over left the reviewer with a dead page. `SKILL.md` now serves unless the
  user explicitly wants a file to keep or an artifact to publish.

## [0.9.1] — 2026-08-07

Two small fixes to the chrome around the map.

### Fixed
- **Thread bookmarks no longer pile over the header.** A question's marker belongs
  beside its own content or, when that content is on another tab, as a count on
  that tab — and a thread whose anchor is gone (the map was regenerated) has
  nothing to sit beside at all. The rail had been dropping those lost markers at
  the top-left corner, on top of the title. Now they are not floated: detached
  threads live in the Review view (their `questions` group), and the rail — with
  the left margin reserved for it — appears only when a bookmark can actually sit
  beside content on the current tab.

### Added
- **The footer names the version that produced the map** — `whydiff <version>`,
  stamped by `assemble.mjs` from `.claude-plugin/plugin.json`, so a served or
  exported report says which whydiff built it.

## [0.9.0] — 2026-08-07

**The report generates lazily.** A default run now builds only the core — Logic,
Diagrams, Files and Ops (env) — and leaves the heavier passes for when they are
actually wanted. The other tabs stay in the menu, but opening one that has not run
shows what it is and a **Generate** button that produces just that section and
folds it into the existing map. A big diff no longer pays for standards, tests and
user-story analysis it may never look at; a reviewer who wants the whole picture is
one click (or one word — "full") away.

### Added
- **Lazy sections with on-demand generation.** The default pipeline spawns only the
  two core agents (`classifier` + `diagrammer`). The three optional passes —
  `standards-reviewer`, `tests-analyst`, `story-writer` — are not run up front:
  their tabs render a one-line explanation and, in served mode, a **Generate**
  button. Clicking it runs that pass against the same diff and adds its section to
  the report without re-running anything else.
- **`POST /api/generate` (`scripts/serve.mjs`).** Runs the section's own agent
  through `claude -p` with the read-only allowlist, streams its progress to the
  page, parses the section JSON, patches `review-map.json`, re-assembles the served
  HTML, and the viewer reloads to show it. It writes only the report's own JSON in
  `.whydiff/` — never the repo — so it keeps the same read-only guarantee as ask,
  instruct and propose.
- **`generated` on the map.** `merge.mjs` records which optional passes actually
  ran — by whether their agent file exists, so "ran and found nothing" stays
  distinct from "not run" — and the viewer offers Generate for the rest. The schema
  documents the field; maps written before it fall back to key presence.
- **A bounded board, and connections that say what they are.** The tab strip and
  the content beneath it now read as one outlined, filled card, so it is
  unmistakable that the content belongs to the selected tab. On the Files map every
  dependency line carries its relationship in words — on a solid pill so it stays
  legible over a card — shown with its edge on hover/select or with "show all links".

### Changed
- **The skill defaults to core; the optional passes are opt-in.** `SKILL.md`
  documents core vs full-only in the agent table and spawns the three optional
  passes only when the user asks for a **full** report.

### Fixed
- **The permission hook stops interrupting a run.** `hooks/hooks.json` now also
  matches `Task`, and `scripts/approve.mjs` auto-approves the plugin's own bundled
  agents (`whydiff:*`) and read-only `gh pr diff|view`. Under *accept edits* a
  `/whydiff` run no longer prompts on each of the agent spawns or a PR fetch;
  anything outside the plugin's own operations still defers to the normal flow.

## [0.8.0] — 2026-08-07

Housekeeping, and the reason it needed a version: the screenshots.

### Changed
- **Screenshots carry the version they show** — `assets/story-0.8.png` and friends.
  The 0.7.0 shots replaced the old files at the same paths, so a browser (and any
  CDN in front of it) kept serving the previous picture: the README looked stale
  when the repository was not. A changed picture now gets a new filename, which is
  a URL nothing can have cached, and the README says so where whoever re-shoots
  will read it.
- No behaviour changes. The version bump exists so an installed copy picks up the
  0.7.0 review loop even if it was installed while that release was in flight.

## [0.7.0] — 2026-08-06

**The map becomes a review, not just a report.** Until now whydiff explained a
change and could answer questions about it. This release lets the reviewer act:
instruct, weigh options, agree on work, watch it happen in a throwaway worktree,
and apply the result — with every remark, decision and result kept in an
append-only journal that survives regenerating the map. The design is
`docs/review-loop.md`; the guarantees it is built on are that a map is an
observation of one snapshot, that verification is earned rather than asserted, and
that nothing an LLM writes reaches the working tree unlooked-at.

### Added
- **`docs/review-loop.md` — the ADR for turning the map from a report into a review
  loop**: the reviewer instructing Claude, Claude proposing typed fix variants, and
  a Tasks tab holding every request, its conversation and what it produced. The
  load-bearing decision is that a map is an *observation of one snapshot*: a
  question does not invalidate it, a finished task does, so tasks live outside the
  map in four separate aggregates (Map / Note / Task / Revision). Execution ships
  as a queue first and a git-worktree agent behind an apply gate second — never a
  write-enabled endpoint pointed at the reviewed tree.
- **`scripts/review.mjs` — the review journal, first step of that ADR.** An
  append-only `.whydiff/review.log.jsonl` plus the projection (`review.json`) the
  Tasks tab and the work skill will read.
  - **A log, not a mutable file**, because two writers — the served page and a
    Claude Code session in the same repo — append without locking, and the history
    the Tasks tab must show *is* the log rather than something reconstructed from it.
  - Refuses what it could not read back later: unknown event types, an anchor with
    no key, an empty utterance, a proposal that cites no finding or offers no real
    variants, a task with no typed `acceptance`, an illegal state transition, a
    decline with no reason, a resolution with no patch, a verification with no
    evidence. A batch is all-or-nothing.
  - Tolerates what it *reads*: an event kind only a newer whydiff knows is kept
    aside instead of throwing, and a line torn by a mid-write crash costs that one
    line. Rebind chains resolve in one pass and cycles cannot hang it.
  - `serve.mjs` now writes questions and answers as notes and serves the whole
    projection at `/api/review`; the viewer's own `/api/threads` shape is unchanged,
    so the ask UI is byte-for-byte the same. A pre-journal `threads.json` is
    migrated exactly once and kept as `threads.migrated.json` — it is the only copy
    of those answers. `node scripts/review.mjs <dir>` reads the journal from a
    terminal.
  - `tests/review.mjs` covers all of the above; `tests/serve.mjs` now asserts the
    journal (question, answer, `replyTo` link, steps, anchor) and the projected
    counts instead of `threads.json`.
- **Instruct mode — the reviewer can now say what should change, not only ask.**
  The ask panel gains one segmented control: *Ask* answers a question about the
  anchored place, *Instruct* takes an instruction about it and replies with a
  **plan** — file by file, what will prove it done, what could break, what must be
  answered before starting. Then two buttons: agree, which opens a task in the
  journal with the plan's spec and acceptance, or not now, which is journalled as a
  decision so the same plan is not offered again.
  - **A plan, not an edit.** The reply is something to decide on; the task it opens
    is a queue entry the user's own session drains. Nothing here executes.
  - **Read-only by construction:** the answering, planning and options runs are
    spawned with a `Read,Grep,Glob` allowlist *and* an explicit
    `--disallowedTools Edit,Write,NotebookEdit,Bash,Task,Agent`, so "this server does
    not change the repo" is a property of the process rather than a sentence in a
    prompt. The deny list is the part that matters: an allowlist only pre-approves,
    and the first live run showed the "read-only" path shelling out to `ls` and
    `grep` quite happily. Subagents are denied too — otherwise they are the way
    around it. `tests/serve.mjs` asserts the deny list reaches the CLI.
  - The plan's machine-readable tail (spec, typed acceptance, files, risks,
    questions) is split off the prose and never streamed to the page — the reviewer
    reads a plan, not a JSON block. A model that ignores the format costs the
    structured fields, not the plan: the task can still be opened from the
    instruction itself.
  - Questions and instructions pair into one `turn` shape (`turns()` in
    `review.mjs`), so the panel keeps a single renderer and the journal a single
    shape. Markers, bookmarks and tab badges count notes of both kinds, and their
    wording changed accordingly.
  - `POST /api/instruct`, `/api/task`, `/api/task-state`, `/api/note`. Every one of
    them validates through the journal, so an endpoint cannot write what the log
    would refuse — `tests/serve.mjs` asserts a task with no acceptance is a 400 and
    an illegal state jump is refused, in the browser as well as over HTTP.
- **A Tasks tab — and it is a merge gate, not a to-do list.** Second in the row,
  present only on the served copy (built in the ask module, so the standalone file
  and the published artifact have no such tab rather than an empty one).
  - The header is a **verdict**: `blocking N` in the warning colour, or `nothing
    blocking` when that is true, then done/verified/declined counts only when they
    are non-zero. The tab badge counts what *blocks*, not what exists.
  - Cards are grouped **by where the problem came from** — your own instructions, a
    broken user story, a standards finding, a test gap — because the same status on
    a defect and on a request means different things. Blocking states sort first.
  - **Unanswered questions are in the same list.** A question nobody answered is an
    open item of the review, and that is what separates this tab from a task list.
  - Every card links back to its place in the report through the same `jumpTo` the
    bookmark rail uses, so it opens the right tab, scrolls to the anchor and opens
    the thread. Declining asks for the reason inline, since the journal refuses a
    decline without one; a declined card can be reopened.
  - **Copy the queue as a prompt** is the handoff: the agreed tasks with their
    acceptance criteria, anchors and files, plus the journal path, as text to paste
    into a Claude Code session — useful now, and replaced by `/whydiff-work` later.
    It refuses to pretend, saying "nothing agreed to copy yet" when the queue is
    empty.
- **Options: Claude offers ways to deal with a finding, and the manifest counts
  whether anything was decided.** A third panel mode (`POST /api/propose`), offered
  only where the map itself reported a problem — a standards `warn`, a test gap, or
  a story that is not `delivered`. Those are now anchors too, so they can be asked
  about and instructed on as well.
  - **Two or three options that differ in KIND, not in wording:** `local` fixes the
    symptom, `root` fixes the invariant that allowed it, `document` declines to
    change behaviour and pins it with a test instead. Each carries cost, risk, blast
    radius and the criterion it would be judged by; choosing one opens a task whose
    spec is that option and which keeps the finding it descends from.
  - **A proposal must cite a finding**, in the UI as well as in the log: the mode is
    disabled anywhere there is no finding to cite (a Logic block, a text selection)
    and says why. `noFixNeeded` with a reason is a first-class answer.
  - Variants are **normalised server-side** — an invented kind dropped, a duplicate
    kind dropped, a missing criterion filled — so a sloppy reply costs the
    structured fields rather than the proposal the reviewer just paid for. The
    journal then insists every stored variant has a typed acceptance.
  - **Criteria name keys, not prose.** The first live run had the model answer
    `{"type":"story","key":"customer: I can get my money back…"}` — reads well,
    verifies nothing. Both prompts now carry the menu of keys the map actually
    offers, and whatever comes back is matched against it: a wording that belongs to
    a known key is rewritten to that key, and anything unmatchable degrades to
    `manual` rather than being stored as a criterion no pass could ever close.
  - **The decision manifest** (`mapFindings` / `coverage` in `review.mjs`): the
    Tasks header reads `decided 3/7`, undecided findings are *listed* rather than
    just counted, and `node scripts/review.mjs <dir> --map <map>` prints the same
    from a terminal. Coverage is a read model, not journal state — it needs the map,
    which the journal deliberately knows nothing about.
- **`/whydiff-work` — the other half of the loop: the agreed work actually gets
  done, in your own session.** A second skill (`skills/whydiff-work/SKILL.md`) that
  drains the review queue one task at a time, and the write half of the
  `review.mjs` CLI it drives the journal through: `--next` / `--thread` (a task plus
  the whole discussion that produced its spec), `--start`, `--resolve`, `--verify`,
  `--decline`, `--report`.
  - **In the interactive session, not behind an endpoint**: full context, the
    ordinary permission flow for source edits, and no write-enabled agent reachable
    over HTTP. The plugin's hook still only auto-approves its own scripts and writes
    inside `.whydiff/`.
  - **The spec is the boundary.** Work that turns out to need something nobody
    agreed to stops and reports on the thread instead of widening silently — that is
    the failure the review exists to catch, so the skill must not commit it either.
  - **Verification is earned, not asserted.** `done` means changed; `verified`
    requires the command and its real output, and only a `test` criterion is the
    session's to close — `story` and `finding` criteria are closed by regenerating
    the map and seeing them flip, `manual` by the reviewer. Every CLI write goes
    through the journal, so `--verify` with no evidence is refused rather than
    recorded, and `tests/review.mjs` asserts exactly that.
  - A blocking question in the discussion stops the task instead of being guessed
    past; the patch for each task lands in `.whydiff/tasks/<taskId>.patch` so the
    reviewer can read the result as a change.
- **`serve.mjs --work` — the loop closes: an agreed task can be worked from the
  report, and its patch reaches the tree only through a gate.** Opt-in flag; without
  it `/api/work` and `/api/apply` are refused with a message saying this server reads
  and plans. A task card gains *do it in a worktree*, streams the agent's steps while
  it runs, then shows the produced patch — file by file, with the report's own
  add/del styling — above **Apply to the working tree**.
  - **The worktree is seeded from the working tree as it stands**, not from HEAD, via
    `git stash create`. The reviewed change is often the working tree itself, so HEAD
    would hand the worker a copy missing the very diff under review. Untracked files
    cannot ride on a stash, so they are named to the worker and to the reviewer
    rather than being quietly absent. `tests/work.mjs` builds a real git repo with an
    uncommitted change and asserts the worker saw it.
  - **The reviewed tree is untouched until the reviewer says otherwise** — asserted
    directly: the stubbed worker writes files into whatever directory it runs in, so
    if the run were not isolated, the test fails. The worktree is removed afterwards.
  - **An empty patch is not a resolution.** The report is journalled, the task goes
    back to `open`, and the page says the run produced no changes — a
    `task.resolved` with nothing in it would be a lie.
  - **A patch that no longer applies is reported, never forced** (`git apply --check`
    first): applying twice, or after the tree moved on, is a 409 that explains
    itself. Applying is journalled as the reviewer's `decision` note carrying
    `applied`, so no new event type was needed.
  - **The server now re-reads the journal when the log moves**, so a `/whydiff-work`
    session in the terminal and the open page stop disagreeing about what has been
    decided — the multi-writer premise of the log finally holds end to end.
  - Deliberate scope correction to the ADR: the result is shown as the **patch**, not
    as a generated review map of the fix. A real delta map means running the
    five-agent pipeline, which does not belong in an HTTP handler; `/whydiff` after
    applying is how you get one. Worktree isolation protects files, not the machine —
    the worker can run commands, which is why the mode is opt-in.
- **A palette switcher in the corner, so the choice is one click instead of a
  keystroke.** Three swatches top-right, each painted in the palette it selects —
  the active one carries a ring, and the whole control disappears in focus mode.
  - A swatch has to show a palette that is *not* the active one, so it cannot read
    the live CSS variables. It does not restate their values either: a palette is an
    attribute selector, so an offscreen probe carrying `data-p` resolves that
    palette's own `--canvas` and `--mark`. Swatches therefore cannot drift from the
    tokens they advertise, and the "no hardcoded hex outside the token block" rule
    stays absolute — its own test caught the first version of this.
  - The ring is an `outline`, not a `box-shadow`: this system has no shadows outside
    overlays, and `tests/design.mjs` enforces it.
- **`scripts/rebind.mjs` — the journal survives regenerating the map, and says
  honestly when it cannot.** A map is an observation of one snapshot: regenerate it
  and a story sits at a different index, a fixed finding is gone, a Logic block was
  reworded. This decides per anchor what happened — moved → rebound, gone → kept and
  marked `stale` with its original text, back again → revived — and the pipeline runs
  it after `validate.mjs` on every run (with no journal it prints one line and does
  nothing).
  - **Nothing is dropped.** The one moment a review tool has to be trusted is when it
    says a remark no longer applies, so a stale thread still opens, still reads, and
    carries the text it was attached to; the page labels it in the panel and on the
    task card rather than pointing at whatever now occupies that key.
  - Quoted selections have no key to move to, so they are checked against the map's
    whole prose instead. Multi-block anchors and single diagram nodes are never
    guessed about — their identity is not derivable from the map, and guessing would
    be worse than saying nothing.
  - Idempotent by construction (a second run against the same map emits nothing), and
    each observation is recorded as `map.observed`, so the journal holds the chain of
    maps a review has passed through. `--dry` prints the plan without writing.
  - `tests/rebind.mjs` covers moved / stale / revived / untouched, that the offered
    keys are exactly the ones the viewer stamps, idempotence, and the CLI no-op;
    `tests/work.mjs` asserts the stale label and that the discussion still reads.
- **`agents/story-writer.md` — a fifth analysis pass, and the first one that is
  not engineering-facing.** Every other pass describes the change to whoever is
  reading the code; this one reconstructs what changed *outside*, in the actor's
  words. Each story carries a verdict decided from the code rather than the
  intent — `delivered`, `partial`, `broken`, `regressed` — which is what keeps the
  tab from degrading into generated documentation. On the reference refunds diff
  it surfaced the change's worst defect as a story a non-engineer can read:
  *"I get my money back after my refund is agreed" — **broken***, because the API
  only accepts refunds for shipped orders while settlement only runs from the
  fulfilment path, which skips them. `regressed` is the status that earns the tab:
  a destructive migration and a renamed response key are both easy to miss in the
  other tabs' framing and unmissable in this one.
- `userStories` in the schema (`{summary, stories[]}`, mirroring `tests`), read
  from `.whydiff/stories.json` by `merge.mjs`. An empty `stories` list is a real
  answer for a refactor — the pass is told never to pad it.
- `validateStructure` rejects an unknown `status`, an empty story, and any story
  file that is not in the diff. A story that cannot be tied to a diff file is a
  story the pass invented.
- New viewer tab, second in the row so the outside view comes right after the
  causal story. Its badge counts *problems*, not stories, and cards are re-sorted
  problems-first in the viewer as well as in the pass, so bad news cannot end up
  below the fold because of emission order. The tab is **hidden entirely** on maps
  generated before this pass existed: an empty "nothing changed outside" pane
  would assert something the run never checked.
- `tests/smoke.mjs` covers the new tab in a real browser — tab count with and
  without the section, problem badge, sort order, the "no test" marker, and the
  inspector reveal below.

- **`scripts/serve.mjs` — live Q&A about an anchored piece of the report.** Serves
  the map at `127.0.0.1` and answers questions from the page by calling
  `claude -p` in the repo, with the map, the patch and the real code available to
  it. Four anchor kinds: a user-story card, a Logic block (⌘/Ctrl-click several to
  ask one question about the set), a diagram (Alt-click a single node), and any
  text selection.
  - **Why a server exists at all**, when nothing else in this project needs one:
    the report is a self-contained file and a published artifact's CSP blocks every
    outgoing request, so the page cannot reach a model by itself. This mode trades
    self-containment for a live answer, and only the served copy gets it.
  - The ask UI is gated on a token the server injects into the page it serves, so
    the file on disk and the published artifact are **unchanged and show no ask
    controls** — absent rather than broken. `tests/serve.mjs` asserts that
    directly, and also covers token refusal, the anchor surviving into the CLI
    prompt, and the browser round-trip, with the CLI stubbed so the suite never
    calls a model.
  - Answers are appended to `.whydiff/threads.json` and reloaded on the next
    serve. A live answer that vanished with the tab would make the same question
    get asked, and paid for, twice.
  - Anchors carry a story's **original** index, not its display position, so a
    question stays attached after the problems-first sort reorders the cards.
- `make serve-<fixture>` runs it against a prepared fixture.
- **Questions leave a mark where they were asked**, the way a comment does in a
  document: a numbered pin on the story card, Logic block or diagram, and — for a
  question about selected text — the text itself stays highlighted with the pin at
  the end of the phrase. The highlight wraps each intersecting text node
  separately rather than calling `surroundContents`, which throws the moment a
  selection crosses an inline `<code>` — the common case in this prose, so the
  simple version would have silently dropped most highlights.
- **A rail of bookmarks down the left edge**, each at the height of its anchor and
  positioned in **document** coordinates, so it scrolls with the content it marks.
  A first cut pinned them to the viewport and clamped them into view; they then
  drifted against the text they belonged to and read as stray chrome. The page
  reserves a left margin while bookmarks exist, so they never sit on the text.
  Questions on other tabs are counted on that tab's button instead of floating in
  a corner. A thread whose anchor text no longer exists says so rather than
  vanishing — and a diagram question is attributed to the Diagrams tab even before
  mermaid has drawn it, instead of being reported as lost.
- **Streaming answers.** `--output-format stream-json --include-partial-messages`
  feeds an NDJSON channel to the page, so the wait shows the model's actual steps
  (`read worker/src/refunds.ts`, `grep payout`) and its text as it arrives. The
  trace folds itself away when the answer lands and stays one click from view.
  Steps are stored on the thread, so a reopened conversation still shows what the
  answer was based on.
- **Markdown in answers** — a ~40-line renderer rather than a library, since the
  page must stay self-contained and a CDN would be blocked by the artifact CSP.
  Escaping happens before any markup is produced, so an answer cannot inject HTML;
  `tests/serve.mjs` asserts that an `<img onerror=…>` in an answer stays inert.

### Fixed
- `claude -p` was waiting 3 seconds for stdin on **every** question. Its stdin is
  now closed, which is pure latency off each ask.
- The chat panel scrolled away instead of staying put. Wrapping the inspector in a
  right-hand column had left that column sized to its content — `.layout` sets
  `align-items: start` — so a sticky child had no room to travel. The column now
  stretches to the row.
- Opening a thread jumped to the end of the last answer, hiding the question that
  produced it. Only a freshly arrived answer scrolls the conversation now.

### Changed
- **Design system v2 — replaces the paper/serif pass below.** That earlier look is
  now explicitly banned: cream canvas with a terracotta accent reads as Anthropic's
  own palette, and serif prose on a warm background is the loudest machine-written
  tell there is. Both are gone.
  - Three palettes behind `data-p`, **slate** shipping: monochrome, with `--flag`
    the only chromatic mark in the view so it can mean "risk" and nothing else.
    Interaction is carried by weight, underline and background shift.
  - Two families, no serif anywhere. Nothing renders below 13px; prose is 16/1.62
    at a **64ch measure that holds at 3840px**. Inline code has no chip, box or
    padding — mono at 0.92em in the inherited colour.
  - 1px borders (not sub-pixel), radii 3px/5px, and **one level of nesting**: the
    reading column sits directly on the canvas and callouts are a 2px left rule.
    Only the tab strip, the two rails and the bottom strip are surfaces.
  - The row of metric cards is gone — one line of tabular numerals instead.
  - Two tokens moved for contrast, both because the specified values break the
    system's own 10–14:1 ceiling: slate `--ink` `#15181B` → `#282D31` (15.6 → 12.2)
    and bond `--ink` `#191919` → `#2F2F2E` (17.0 → 12.9). Graphite already complied
    at 13.8, and `--mark` keeps its original value — it is a signal, not body text.
  - `⇧A` marks every file read; `t` cycles palette.
- `tests/design.mjs` now gates all three palettes on: no stray hex, no serif, no
  metric cards, no gradient or blur, weights, radii, the 13px floor, one nesting
  level, bare inline code, the 64ch measure at 3840px, the three contrast floors,
  and the guard that no literal `<code>` string ever reaches the DOM.

- (superseded) The viewer follows the paper design system: warm paper canvas, two
  chromatic accents only (pine `--accent`, ember `--flag`), hairline separation
  instead of shadows, radii capped at 6px, weights 400/500, sentence case, three
  type roles (sans chrome / mono identifiers / serif prose at a 66ch measure),
  and 140ms ease-out limited to hover and disclosure with `prefers-reduced-motion`
  honoured. Every hex now lives in the token block; the old names (`--bg`,
  `--surface`, `--muted`, …) survive as aliases so no rule resolves to a stale
  literal.
  - **Diff colours are colourblind-safe by default** (blue / terracotta) with the
    classic red/green available as a setting, persisted per reader.
  - Deviations, both because the alternative loses information:
    **(1)** the eight-hue group palette became a tonal ladder — group identity is
    carried by the group's name and its band, since eight hues would be six more
    accents than the system allows; **(2)** the per-language colour dots are gone,
    labels only, for the same reason.
  - One token changed: `--ink` `#1E1C19` → `#2D2A26`. The specified value measures
    15.5:1 on `--canvas`, above the 10–14:1 band the system's own checklist sets;
    the new value lands at 13.0:1, which is the "~13:1" its comment asks for.
- **Reading-session features.** Per-file read state, a footer strip with a 2px
  progress bar, focus mode, restored tab/scroll/settings, and a keyboard path to
  every action — `j`/`k` step, `]`/`[` file, `s` mark read, `n` first question,
  `f` focus, `g`/`G` ends, `1`–`7` tabs, `t` theme, `?` sheet. The shortcut sheet
  and the settings live in the `?` dialog.
- `tests/design.mjs` enforces the parts of the system a script can decide — no
  stray hex, weights, radii, no non-overlay shadow, serif prose measure, and the
  body contrast band — in **both** themes.

- **The inspector collapses on the tabs that never write to it.** It cost ~40% of
  the width permanently while its idle state was a group legend duplicating the
  page title and the Files tab's colors. Now it is present on Logic, Diagrams and
  Files, and Standards / Tests / Ops / User stories get the full width — which also
  un-cramps the two-column Tests pane. Collapsing had to be reversible: Standards
  and Tests carry `data-goto` links *into* the inspector, so a file click from any
  tab reveals it again, and "back" on a prose tab gives the width back instead of
  rendering the legend. No new affordance — the loop closes with the controls that
  were already there.

## [0.6.0] — 2026-08-05

Continues 0.5.0: cutting what the model generates, since a pass's wall-clock is
set by output volume and nothing else. Measured across three shards of one
instrumented run, all three wrote at 102–119 bytes/sec.

### Added
- **`scripts/shards.mjs`** — plans the classifier split against a wall-clock
  budget instead of by service area. Splitting by area produced a 17× imbalance
  on the reference run (5 KB in one shard, 86 KB in another) with everything
  waiting on the big one. The planner weights each file, packs longest-first into
  balanced shards, adds shards until the slowest fits, and says plainly when no
  split can fit — that means the input is too big, not the split wrong. Weights
  are calibrated on the reference run (predicted 166 KB against 173 KB measured)
  and adjustable via `--rate`, `--per-file`, `--per-substantive`.
- `tests/shards.mjs` — balance, full coverage, `--skip`, and budget overflow.

### Changed
- **Code fragments are lifted from the patch, not retyped by the model.** The
  classifier no longer emits `frag` or `preview`; `merge.mjs` extracts them in a
  single indexed scan of the patch — 107 fragments out of a 52 MB patch in 0.3s,
  replacing ~32 KB the model used to generate. It picks the hunk with the most
  changed code (not merely the first, which tends to be file-top boilerplate) and
  starts the window at real code rather than a docblock.
- **`fragAnchor`** — a new optional per-file field: a short distinctive string
  from the line worth showing. A dozen characters instead of a dozen lines, for
  the case the heuristic cannot get right — one small important change in a file
  that also gained a large unrelated block.
- **Group metadata is authored once.** `narrative.json` carries the group list
  (`id`, `name`, `role`, `why`) and shards emit `{id, files}`. Previously every
  shard re-authored the same groups, and could describe one group three different
  ways. A group nobody assigned a file to is dropped.
- `narrative.json` gains `skip` — files that get no code fragment.

## [0.5.0] — 2026-08-05

Performance. A 29m20s run was measured event by event from the session
transcripts; two of its blocks were duplicated work, not analysis.

### Changed
- **Agents write their own output files.** Each analysis pass gets a `Write` tool
  and an `OUT:` path in `.whydiff/`, writes its JSON there and replies with one
  confirmation line. Previously an agent returned its JSON in the reply and the
  orchestrator retyped it into a file — a second full generation of the same
  text. Measured on the reference run: 6m53s for 79 KB across three files, while
  the one answer that was copied by script instead took 9 seconds.
- **`scripts/merge.mjs` replaces hand-rolled merging.** It re-collects the
  manifest from git, unifies the classifier shards, takes `add`/`del`/`isNew`
  from git rather than from the model, holds every file to exactly one group,
  prunes edges whose ends did not survive, validates, and refuses to write a map
  that would not validate. The orchestrator now authors only
  `.whydiff/narrative.json` (meta, intent, story, `embedFull`). On the reference
  run, improvising this merge cost 3m30s including two failed attempts.
- The classifier no longer emits `add`/`del`/`isNew` per file — `merge.mjs` fills
  them from git, so those bytes were being generated and then discarded.

### Fixed
- The manifest excludes the pipeline's own `.whydiff/` directory, so a repo that
  does not `.gitignore` it no longer gets a map that reviews its own scratch
  files. On the reference run 8 such files reached the map, including its own
  `diff.patch` and `review-map.json`, and caused the single validation error that
  cost 2m01s to chase.
- The timing report no longer drops a phase whose boundary event was never
  logged. Missing phases are marked `not measured` and the remainder is reported
  as `Unattributed`, with the names of the missing events. Previously 83% of a
  run could vanish from the phase table while the totals still looked complete.
- The report now accounts for HTML assembly as its own phase.

## [0.4.1] — 2026-08-05

### Development (no change to plugin behavior)
- `Makefile` with the local development loop: `make check` (contract + viewer +
  manifest checks, no LLM), `make preview`, `make fixtures`, `make run-<name>`
  (prepares a fixture and opens Claude with the working tree via
  `--plugin-dir`), `make report-<name>`, `make map-<name>`, `make clean-fixtures`.
- `tests/fixtures/`: fixture projects for end-to-end runs before pushing.
  `synthetic` is generated locally (10 files across TS/PHP/SQL/MD with a schema
  migration that adds a table and renames a column); `quick`, `feature`,
  `migration` and `big` are real commits from expressjs/express, honojs/hono,
  zulip/zulip and mastodon/mastodon, pinned by SHA and fetched with `--depth 2`.
  Each fixture's recorded GitHub stats are cross-checked against our own
  manifest, so preparing one also tests `manifest.mjs` in ref mode.

## [0.4.0] — 2026-08-05

### Added
- **Scope bar**: logical scope tags (`backend`, `frontend`, `api`, `docs`, …)
  with file counts above the tabs — one glance shows which parts of the
  project a change touches. Clicking a tag jumps to the Files tab and dims
  everything outside that scope. `service` is now required for every file in
  the contract, and the classifier must keep the tags consistent.
- **Language indicators**: language dots/badges in GitHub-linguist colors,
  aggregated in the scope bar and per file card (TS, JS, PHP, PY, SQL, …).
- **Diagram viewing**: every diagram gets a fullscreen button (`⛶`, uses the
  whole viewport) and a pop-out button (`⧉`, opens the rendered SVG alone in a
  new window) — large graphs are readable without squinting at a column.
- **Permission hook** (`hooks/hooks.json` + `scripts/approve.mjs`): a
  `PreToolUse` hook auto-approves only the pipeline's own operations — bundled
  scripts, read-only git, writes into `.whydiff/`, opening the built map — so a
  run no longer needs a dozen confirmations. Chained/substituted commands
  (`;`, `&`, `|`, backticks, `$(`) are never auto-approved; everything else
  falls through to the normal permission flow.

### Changed
- Project description sharpened everywhere (README, manifests, skill): whydiff
  is for following the *meaning* of a change — its architectural and logical
  decisions — without reading every file an LLM touched.
- README: added a "What the map answers" table mapping reviewer questions to
  tabs.

## [0.3.0] — 2026-08-04

### Added
- `er-diff` diagram kind: when the diff contains schema-changing migrations,
  the diagrammer must produce a mermaid `erDiagram` of the affected tables
  (diff marking via attribute comments: `"+ added"` / `"- removed"` /
  `"~ was: …"`), only the affected tables and their direct relations.

### Changed
- Viewer: the "How to read this map" prose moved out of the default inspector
  into a help dialog (the `?` button in the tabs row and a link under the
  legend). The default inspector is now a compact clickable group legend with
  reviewer roles and the completeness line.

## [0.2.0] — 2026-08-04

### Added
- Timing instrumentation for every `/whydiff` run: `scripts/timing.mjs` logs
  pipeline events to `.whydiff/timing.jsonl` (script-side timestamps;
  `validate.mjs`/`assemble.mjs` log their events automatically) and
  `timing.mjs report` renders `.whydiff/timing-report.md` — a per-phase
  wall-clock breakdown with artifact sizes, meant to be shared when
  discussing performance. Measurement only: analysis steps are unchanged.

## [0.1.0] — 2026-08-04

First public release.

### Added
- `/whydiff` skill: builds an interactive review map for a git diff
  (working tree, revision range, or PR) via four parallel analysis agents
  (classifier, diagrammer, standards-reviewer, tests-analyst).
- `review-map.json` contract (`schema/review-map.schema.json`) between the
  generator and the viewer; completeness is enforced by script
  (`scripts/validate.mjs` cross-checks the manifest against the real
  `git diff --numstat`), never asserted by the LLM.
- Self-contained HTML viewer (`templates/viewer.html`): causal story,
  cause-grouped file map with labeled edges, standards/tests/ops tabs,
  drill-down inspector with code fragments and full files, en/ru i18n,
  light/dark themes, inlined mermaid bundle.
- Clickable diff-marked mermaid diagrams: `click <id> call whydiffOpen("<path>")`
  opens the file in the inspector; click targets are validated against the diff.
- Repo doubles as a plugin marketplace (`.claude-plugin/marketplace.json`):
  `/plugin marketplace add smagew/whydiff` + `/plugin install whydiff@whydiff`.
