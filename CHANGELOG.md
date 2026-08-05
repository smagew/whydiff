# Changelog

Notable changes to the whydiff plugin. Versions follow semver; the plugin
version in `.claude-plugin/plugin.json` must be bumped for installed users
to receive an update.

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
