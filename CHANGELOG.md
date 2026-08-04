# Changelog

Notable changes to the whydiff plugin. Versions follow semver; the plugin
version in `.claude-plugin/plugin.json` must be bumped for installed users
to receive an update.

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
