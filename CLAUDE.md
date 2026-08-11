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

Viewer tabs, in order: **Diagrams · Code map · User stories · Summary · Ops &
risks · Standards · Tests**. Diagrams is the default (Code map when a diff changed
no flow). The aside carries an **Overview | Call graph** switcher and, when a file
is opened, its drill-down.

## Conventions (enforced — do not relearn them the hard way)

- **Design system** (`tests/design.mjs` fails the build otherwise): hex colours
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
