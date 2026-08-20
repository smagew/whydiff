# The "Files" tab — spec (restructure of "Code map")

The old "Code map" tab put the cause-grouped card-map in the centre and drilled a file's diff
into the right sidebar. This restructures it into an IDE-style browser: a **navigator on the
left**, the **file view in the main content area**. Agreed with the user; forks resolved by the
answers noted below.

## Layout (IDE-style)

```
┌─ Files ─────────────────────────────────────────────────────────────┐
│ [Overview | Files list | Call graph]          (switcher, top-left)   │
│ ┌───────────────┬───────────────────────────────────────────────┐   │
│ │ navigator     │  FILE VIEW  (main content area)                │   │
│ │ (the active   │  · path · why · diff hunks (+/−/context)       │   │
│ │  mode's       │  · in/out links · "Open full file"             │   │
│ │  content)     │                                                │   │
│ └───────────────┴───────────────────────────────────────────────┘   │
└──────────────────────────────────────────────────────────────────────┘
```

- **Left navigator** carries the switcher and the active mode's content; **right (main) area**
  is the selected file's view. Both visible at once. (The old right sidebar / `#inspector`
  drill-down is no longer where a file opens.)

## Navigator modes (the left switcher)

- **Overview** — DEFAULT. The cause-grouped file list (today's `overviewGroupsHTML`: groups,
  each with its files). No card-map here. Click a file → it opens in the file view.
- **Files list** — a plain flat list of every file (`RM.manifest` order). Click → file view.
- **Call graph** — BOTH the card-map (groups + file cards + connector edges — today's
  `#map`/`#groups`/`#edges`) AND the dependency tree (`callGraphHTML`). Click a node/card/file →
  file view. **The map renders FULL-WIDTH in the main column** (the narrow left navigator is
  hidden in this mode), with the file view beneath it — a 2D dependency map needs the width, and
  squeezed into the ~340px nav it degrades into a vertical list that just duplicates Overview.
  (Decision confirmed with the user; Overview/Files-list keep the narrow navigator + file view.)

## Behaviour

- **Default on entering Files:** Overview selected, and the **first file** (`RM.manifest[0][0]`)
  shown in the file view.
- **Clicking a file ANYWHERE** — Overview, Files list, Call-graph card/node, cross-links,
  any `[data-goto]`/`[data-gofile]` — opens that file in the **main file view** immediately.
- **Rename** the tab label "Code map" → **"Files"** (pane id stays `files`).

## PDF (#6)

- When a file view is open, the exported PDF shows the **file view** (the file's diff/content),
  not the map. (Today the file drill-down never prints — this is new: the file view must become
  printable, and the navigator chrome hidden in print like other chrome.)

## Done = (acceptance checklist)

1. Tab reads **"Files"** (both locales); pane id unchanged; all `files`-keyed logic still works.
2. The **switcher is on the left**, at the top of the Files tab, with three modes: Overview,
   Files list, Call graph.
3. **Overview** (default) shows the grouped file list, no card-map; clicking a file opens it in
   the file view.
4. **Files list** shows a flat list of all files; clicking opens the file view.
5. **Call graph** shows the card-map (cards + connector edges) AND the dependency tree,
   full-width in the main column (narrow navigator hidden); clicking a card/node opens the file
   view beneath the map.
6. The **file view renders in the main content area** (not the sidebar), showing the selected
   file's diff + links + Open-full-file.
7. On entering Files, the **first file** is shown by default, with Overview active.
8. A file click from **every** entry point (all three modes, cross-links, `[data-goto]`) opens
   the main file view.
9. **PDF**: with a file open, the PDF contains that file's view (diff/content); navigator chrome
   is hidden in print.
10. Tests assert the goals (default first-file view; each mode lists/opens files; a click opens
    the content file view; PDF carries the file view) — not pixel proxies. `make check` green.

## Notes / open mechanics to handle carefully

- The Files tab stops using the right-column aside (`#inspector`) for drill-down; the aside may
  still serve other tabs (a cross-link from Standards/Tests). Keep `revealAside` for those, but
  route Files-tab file opens to the main content file view.
- Edges (`drawEdges`) still need a real layout to place connectors; in Call-graph mode the map is
  visible, so redraw on entering that mode / on resize (as today).
- `setTab` is re-wrapped twice (cursor reset; review-mode) — preserve those when refactoring.
- Keep the pane id `files`; only the label changes.
