# CLAUDE.md — working on whydiff

whydiff is a Claude Code plugin that turns a git diff into an interactive,
self-contained HTML **change map**, so a reviewer follows the *meaning* of a
change (its causal story, cause-grouped files, diff-marked diagrams, standards /
tests / ops passes) instead of reading every file an LLM touched. See `PLAN.md`
for the product rationale and `RELEASING.md` for the release flow.

## Commands

```bash
make check            # contract validation + version guard + npm test + plugin validate
make run-<fixture>    # prepare a fixture and open Claude there with THIS working tree
make serve-<fixture>  # serve a fixture's map with the live ask/Generate UI
make bump BUMP=minor  # bump the version everywhere + open a CHANGELOG section
make hooks            # install the pre-push version guard (.githooks)
```

`npm test` runs the unit + Playwright suites (`tests/*.mjs`); `make check` adds
`scripts/validate.mjs` and `claude plugin validate`. Run `make check` before every
push.

## Architecture

The plugin is a pipeline: a git diff → agent passes → JSON map → a self-contained
HTML viewer.

- `skills/whydiff/SKILL.md` — the `/whydiff` orchestrator (what it spawns, when).
- `agents/*.md` — the analysis passes. **Core** (every run): `classifier`
  (groups, files, edges, intent, ops), `diagrammer` (diagrams). **Lazy** (full run
  or the Generate button): `summariser` (the Summary `story`), `standards-reviewer`,
  `tests-analyst`, `story-writer` (userStories).
- `scripts/` — deterministic layer: `gather`/`manifest` (diff → manifest),
  `merge.mjs` (agent outputs → one `review-map.json`, sets `generated`),
  `assemble.mjs` (map + `templates/viewer.html` → self-contained HTML),
  `serve.mjs` (the live ask/plan/Generate server), `validate.mjs`.
- `templates/viewer.html` — the whole viewer (CSS + JS + i18n) in one file.
- `schema/review-map.schema.json` — the generator↔viewer contract. Everything the
  map carries is documented there.
- `docs/pdf-export.md` — the PDF-export contract (acceptance checklist, the locator-glyph
  comment mechanism, invariants ↔ tests). Read it before touching the print/PDF path.

Viewer tabs, in order: **Diagrams · Code map · User stories · Summary · Ops &
risks · Standards · Tests**. Diagrams is the default (Code map when a diff changed
no flow). The aside carries an **Overview | Call graph** switcher and, when a file
is opened, its drill-down.

## Delivery flow (how we stop shipping half-baked work)

Locked after the PDF-export work went out half-done, round after round, with the
user finding the flaws. For ANY non-trivial change, follow these steps in order —
do not jump to code, and do not claim "done" until step 5 passes. This is
acceptance-first (spec-driven), not a framework: the discipline is the point.

**This applies to "small" interactive UI too — that exemption is the recurring trap.**
A zoom button, a resize handler, a drag — these went out as first-pass hacks (scale the
`width` and toggle overflow; place marks once and never on reflow) that "rendered" but did
not *work*, and the user found it every time. So for anything interactive (zoom/pan, drag,
resize, sticky/anchored overlays): (a) name the standard mechanism first — transform-based
pan/zoom, `ResizeObserver`, pointer capture — do not invent a width/scroll approximation;
(b) the acceptance test asserts the **user goal** ("a diagram taller than the screen can be
shrunk until the whole of it is visible"; "the frame still covers the same nodes after a
resize"), **never a pixel proxy** ("width grew by 200px" passed while the diagram still
overflowed the screen). "It renders" and "the number changed" are not acceptance.

1. **Spec first — an acceptance checklist.** Before coding, write `Done =` as a
   short list of concrete, checkable outcomes and get it agreed. That list is the
   contract; build to it, nothing less. (For the PDF: "no wasted header page; each
   diagram whole, fit to its own page; no leaked annotation frames; notes linked to
   their anchor, not dumped; the PDF button only where there is content".)
2. **Standard before invention.** For layout / format / protocol work, find the
   correct or standard approach first (print page-break rules, footnote-links, …).
   Do not trial-and-error a solved problem.
3. **Behaviour → tests.** Every acceptance item that can be mechanised becomes a
   test — see Testing discipline below (bug → failing test first; assert the
   invariant, not a proxy).
4. **Self-review the WHOLE artifact before showing it.** Generate the complete
   output — every page of the PDF, every tab, every screen — and inspect ALL of it
   against the checklist as a harsh reviewer. Fix everything found. The reviewer who
   finds the flaws must be me, not the user. Reading one slice and shipping is the
   exact failure this rule exists to stop.
5. **"Done" means the checklist is fully met.** Green tests alone are NOT done
   (tests pass ≠ the artifact is good). If the list is not fully met, say so
   plainly: "partial — items X and Y still open", never dress a partial fix as
   complete.

## Conventions (enforced — do not relearn them the hard way)

- **Testing discipline (how we stop shipping regressions).** Three rules, learned
  the hard way on the diagram-region and progress-bar work:
  1. **Bug → failing test first.** Every reported bug gets a test that FAILS on the
     current code, then the fix that turns it green. No fix lands without it.
  2. **Assert the invariant, not a proxy.** A test must fail when the feature is
     actually wrong. Prefer behaviour/identity checks (e.g. "the region frame
     overlaps the same nodes the drag covered") over brittle proxies like pixel
     coordinates or fractions — a proxy can pass while the feature is broken.
  3. **Reproduce the failing variant before claiming a fix works.** If a change
     spans variants (diagram types, palettes, OS, window sizes, reduced-motion),
     verify the one that actually breaks — not the convenient one — and cover it.
     Never write "works on all X" from one sample.
- **Design system** (`tests/design.mjs` fails the build otherwise) — it covers BOTH
  surfaces, `templates/viewer.html` and the desktop shell's
  `app/src/renderer/styles.css`, because the two windows sit side by side: hex colours
  live only in the token block on `:root`/`[data-p=…]` — nowhere else;
  `border-radius` ≤ 5px for any single value; font-size ≥ 13px everywhere; no
  `text-transform: uppercase`; no drop shadows on non-overlays; one level of box
  nesting in the reading column. Colour comes from CSS variables, never literals.
- **English-only source.** All shipped text — code, comments, docs, schema
  descriptions, prompts — is English. Russian appears only in the viewer's `ru`
  interface locale (English is the default; report language follows `meta.lang`).
- **Version = release contract.** The plugin cache is keyed by version: a change
  that ships must bump `plugin.json` (+ `package.json`, `marketplace.json`) in the
  **same PR**, or installed users never see it. `make bump` does all four places;
  `scripts/check-version.mjs` enforces it (pre-push hook + CI).
- **Git identity.** This is a personal repo (`github.com/smagew/whydiff`); commit
  and push as **smagew** over SSH. The `gh` CLI here is signed in as the work
  account — do **not** use it for whydiff PRs, releases, or branch settings.
- **Branching.** Trunk-based: short branches named by intent (`feat/…`, `fix/…`,
  `chore/…`), one PR each, deleted after merge. `main` is protected.

## Release

`make bump` in your PR → merge (squash) → the `release` workflow tags `vX.Y.Z` and
publishes a GitHub Release from the CHANGELOG section automatically. Then
`claude plugin update whydiff` to pull it into the installed cache. Details in
`RELEASING.md`.

## Gotchas

Hard-won; check these before touching the relevant area. See `.claude/rules/gotchas.md`
for the running list — add to it whenever a surprise costs you time.
