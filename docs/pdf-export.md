# PDF export — the spec

How a whydiff review turns into a PDF, and the invariants that must not silently regress.
This is the contract: change the PDF pipeline only with this file (and its tests) in front of
you, and update both together. Every acceptance item below names the test that enforces it —
if an item has no test, it is not "fixed", it is a hope.

## One mechanism, and why the button behaves by context

Real PDF export = **print the viewer to PDF bytes in a Chromium we control, then annotate those
bytes with `pdf-lib`**. The annotate step needs the raw bytes; `window.print()` never hands them
over, so it is NOT our mechanism — it is dropped. Only a Chromium we drive can give us the bytes,
and only the **desktop app** has one (Electron). Hence the single pipeline lives in the app, and
the viewer's PDF button behaves by where it runs:

- **In the desktop app** (`IN_APP`, Electron UA): the content button calls `window.whydiff.exportPdf()`
  (bridge from the map window's preload) → `analysis:exportPdf` → Electron `printToPDF` →
  `annotatePdf`. Notes become real PDF **comment annotations**; questions become **in-document
  links**. This is the real deliverable.
- **In the browser / served map / a standalone file**: no controlled Chromium, so the button
  does **not** print. It stays visible, carries an "app only" tooltip, and on click shows a
  popover with an OS-detected **download link** to the desktop app (`appDownloadUrl()`; the
  footer carries the same link). We do not ship a headless Chromium to `serve`/CLI — that would
  add a ~350 MB browser to every plugin user for an optional feature.
  - **The download link targets the app, not the plugin.** The desktop app has its own version
    (`app-v*` tags), separate from the plugin (`v*`), so GitHub's repo-wide `/releases/latest`
    is the WRONG target — it is usually a plugin release with no installer. `desktop.yml`
    publishes a moving **`app-latest`** release holding the current installers under stable
    version-less names (`whydiff-<os>-<arch>.<ext>`, set by `app/electron-builder.yml`), so
    `appDownloadUrl()` links to `/releases/download/app-latest/…` and always resolves. Unknown
    OS (and "All versions") → the releases list. These three — the artifact names, the
    `app-latest` publish step, and `appDownloadUrl()` — must stay in sync.
- **A standalone HTML opened as a file, if the user hits Cmd-P themselves**: the browser's own
  print runs (we can't stop it). `beforeprint` still lays notes out as **footnotes at their
  place** and questions as in-document links, so that raw print is not ugly — but this is a
  by-necessity last resort, not an export path we offer.

## Acceptance checklist (`Done =`)

| # | Outcome | Enforced by |
|---|---------|-------------|
| 1 | No wasted header page — content starts on page 1 (title/intent/stats hidden in print). | `tests/print-pdf.mjs` (`#title`, `.kicker` hidden in print media) |
| 2 | Each diagram starts on its own page, whole, scaled to fit that page (never split, never clipped past its SVG). | `tests/print-pdf.mjs` (no `.node` hangs past the SVG edge after `beforeprint`) |
| 3 | **Notes → real PDF `/Text` comment annotations** (marker on the page, listed in the reader's Comments panel), each on the page where its fragment printed. | `app/test/pdf-annotate.test.mjs` (injection + coordinate) · `tests/pdf-comments.mjs` (real print, one comment per diagram page, `located == total`) |
| 4 | **A note's comment lands at its EXACT anchor** — a text/code selection at the highlight, a diagram node at the node, a diagram region at the framed area — never at the caption or top of the diagram. | `tests/pdf-comments.mjs` (comments on different anchors land at different, anchor-tracking positions) |
| 4a | **The framed region is drawn into the PDF** (an outline at the region), and **text/code highlights print** as they show in the report — everything highlighted in the report is visible in the PDF. | `tests/pdf-comments.mjs` (region `<rect>` injected; `.askquote` highlight prints) |
| 5 | **Questions → an in-document link** at the place + a **"Questions"** appendix (question + answer), linked both ways. | `tests/print-pdf.mjs` (link targets + back-links resolve; appendix titled "Questions") |
| 6 | There is **no combined "Notes & questions"** heading anywhere. | `tests/print-pdf.mjs` |
| 7 | The PDF button appears only where there is content (hidden on an un-generated tab). | `tests/print-pdf.mjs` (`.content-tools` hidden on the lazy tab) |
| 8 | Browser fallback: notes print as footnotes at their place; the comment path suppresses that. | `tests/print-pdf.mjs` (`.pn-inline-note` present in the fallback, absent under `forComments`) |
| 9 | A note whose tab did not print produces no comment, and no stray locator glyph. | `app/test/pdf-annotate.test.mjs` (missing token skipped, warned, not fabricated) |

## Mechanism — how a note becomes a comment (do not reinvent this)

Chromium's print-to-PDF (`window.print`, `page.pdf()`, Electron `printToPDF` — one engine)
**cannot** create comment annotations; it preserves only link annotations. So real comments are
produced by **locator-glyph readback**, entirely in the desktop path:

1. **Viewer** (`templates/viewer.html`): `preparePrint({ forComments: true })` lays the chosen
   scope out for print, then `placeLocators()` drops one invisible-but-painted glyph
   (`WDXnnnWDX`, paper-coloured, `font-size:6px`, styled **inline only**) at each note's place
   and returns a manifest `[{ token, anchorKey, notes:[{contents, author, nm}] }]`.
2. **App** (`app/src/main/index.js` → `pdf-annotate.mjs`): prints the page with `printToPDF`,
   then `annotatePdf(bytes, manifest)` reads each glyph's **real rendered position** back out of
   the produced PDF with `pdfjs-dist` (`locateTokens`), and injects a `/Text` (+`/Popup`)
   annotation there with `pdf-lib`.

Reading the position from the finished PDF is the whole point: it survives forced page breaks
(`break-before: page` per diagram) and diagram fit-scaling with **no** px→point/page math to get
wrong. Do not replace it with DOM-coordinate computation — Chromium's paginated layout is not
exposed to JavaScript, so that approach cannot be made correct (see the architect spec that led
here).

### Invariants the mechanism rests on

- **Coordinate identity**: `pdfjs` text-item `transform[4],[5]` is the glyph's point in PDF user
  space, **origin bottom-left, no flip** — fed straight into pdf-lib's `Rect`. Empirically
  pinned by `app/test/pdf-annotate.test.mjs` (draws a token at a known point, asserts readback
  matches). If pdfjs ever changes this, that test fails loudly instead of misplacing comments.
- **The glyph must be painted**: `display:none` / `visibility:hidden` / `opacity:0` /
  `font-size:0` all drop it from the PDF text stream, so readback can't find it. It is hidden by
  colour, not by removal. `tests/print-pdf.mjs` asserts it is painted.
- **Glyph styling stays inline, never a stylesheet rule** — a `font-size:6px` / paper-hex rule in
  the template would trip the design gate (`tests/design.mjs`: font-size ≥ 13px, hex only in the
  token block).
- **`beforeprint` must not fight the comment path**: under `forComments` the body carries
  `.wdx-comments`, and the `beforeprint` handler skips rebuilding notes (it would otherwise
  re-add inline footnotes). Covered indirectly by `tests/pdf-comments.mjs` (no duplicate/dropped
  comments through a real print).

## printToPDF options (fixed for stable geometry)

`{ pageSize/format: 'A4', landscape: false, printBackground: true, scale: 1, margins/margin:
0.4in all sides, preferCSSPageSize: false, displayHeaderFooter: false }`. Because the position is
read back from the produced PDF, these need only be **fixed and consistent**, not fed into any
hand computation — but keep `printBackground` on (the light palette / diagram ink) and do not set
a `pageRanges` that could drop a page a glyph lives on.

## Known limitations (honest, not bugs to hide)

- **How exact placement works (not a limitation — the mechanism).** Diagram locators are SVG
  `<text>` injected INTO the diagram's SVG at the node's centre (screen→user coords via
  `getScreenCTM().inverse()`) or the region's stored user-space rect, so they scale and re-fit
  WITH the diagram; the region's outline is an SVG `<rect>` (`.wdx-region`) drawn there too.
  Text/code locators are an HTML glyph in the highlight. If a diagram node/region can't be
  resolved, the glyph falls back to the caption rather than being lost.
- **Comments are top-level, flat.** A question's reply thread is not modelled as PDF `/IRT`
  reply chains; each note is one `/Text`.
- **Real comments are desktop-only.** A plain browser print has no annotation API; that path
  falls back to footnotes. This is a hard browser constraint, not a gap to close.

## When you change the PDF pipeline

1. Update this file's checklist first if the intended behaviour changes.
2. `make check` (viewer + unit contracts) **and** `make pdf-e2e` (real print → annotate). The
   e2e spans both dep trees, so install app deps too (`cd app && npm ci`); CI runs it in the
   `pdf-comments-e2e` job.
3. `templates/viewer.html` and `scripts/` are version-watched — a shipped change bumps the
   plugin. `app/`, `tests/`, `docs/`, `.github/` are not.
