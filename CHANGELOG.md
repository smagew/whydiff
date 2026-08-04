# Changelog

Notable changes to the whydiff plugin. Versions follow semver; the plugin
version in `.claude-plugin/plugin.json` must be bumped for installed users
to receive an update.

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
