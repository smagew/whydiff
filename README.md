# whydiff

[![validate](https://github.com/smagew/whydiff/actions/workflows/validate.yml/badge.svg)](https://github.com/smagew/whydiff/actions/workflows/validate.yml)
[![license: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

A Claude Code plugin that turns a git diff into an interactive **review map**:
changes grouped by cause (not by file), a causal story of *why* each change
exists, diff-marked mermaid diagrams, standards/tests/ops reports, and a blast
radius — all with drill-down to code fragments and full files.

Built for reviewing LLM-written code without losing comprehension of the project
(see `PLAN.md` for the problem statement and design principles).

![The Logic tab: a causal story of the change, every block linked by why](assets/story.png)

| Diff-marked diagrams — click a node to open the file | Cause groups with labeled links between files |
|---|---|
| ![Diagrams tab](assets/diagrams.png) | ![Files tab](assets/files.png) |

## Usage

```
/whydiff                    # working tree vs HEAD (incl. untracked)
/whydiff HEAD~3             # a commit range
/whydiff main..feature      # any git range
```

The skill produces `<repo>/.whydiff/<date>-<slug>.html` — a self-contained
page (mermaid inlined, no network needed) — and opens it.

The report language follows the conversation language; source code and
identifiers are always English (see principle 8 in `PLAN.md`).

## Install

The repo doubles as a plugin marketplace (`.claude-plugin/marketplace.json`),
so a normal persistent install works from a local path or from GitHub —
no `--plugin-dir` needed, the plugin is then available in every session:

```
/plugin marketplace add smagew/whydiff       # straight from GitHub
/plugin marketplace add /path/to/whydiff     # or a local clone
/plugin install whydiff@whydiff
```

The mermaid bundle for the assembler is installed automatically on first
`/whydiff` run (`npm install` inside the plugin directory).

Plugin skills are namespaced: invoke as `/whydiff:whydiff` (the bare
`/whydiff` form also resolves when unambiguous).

Local development (changes picked up without reinstalling):

```bash
cd /path/to/whydiff && npm install   # pulls mermaid for the assembler
claude --plugin-dir /path/to/whydiff
# inside the session: /reload-plugins after edits
claude plugin validate /path/to/whydiff   # schema check before distributing
npx playwright install chromium && npm test   # browser smoke test (CI runs it too)
```

To update an installed copy after new commits: `/plugin marketplace update whydiff`.

Releasing: bump `version` in `.claude-plugin/plugin.json` **and**
`.claude-plugin/marketplace.json`, add a `CHANGELOG.md` entry, tag `vX.Y.Z` —
installed users only receive updates when the version changes.

## Layout

```
.claude-plugin/plugin.json   # plugin manifest
skills/whydiff/SKILL.md      # the /whydiff pipeline (orchestration)
agents/                      # parallel analysis passes
  classifier.md              #   groups, story, files, edges, ops
  diagrammer.md              #   diff-marked mermaid diagrams
  standards-reviewer.md      #   project-convention findings + blast radius
  tests-analyst.md           #   fixed behaviors + gap analysis
scripts/
  manifest.mjs               # deterministic diff manifest from git
  validate.mjs               # structure + manifest-vs-git cross-check
  assemble.mjs               # review-map.json + viewer template → HTML
  lib.mjs                    # shared validation/git helpers
templates/viewer.html        # the generic viewer (i18n, mermaid, 6 tabs)
schema/review-map.schema.json# the generator↔viewer contract
examples/rate-limit/         # hand-authored reference sample (synthetic project)
```

## Pipeline (what /whydiff does)

1. `manifest.mjs` — deterministic file list from git (incl. untracked).
2. The main model reads the diff, then fans out four plugin agents in parallel.
3. Their JSON is merged into `review-map.json` per the schema.
4. `validate.mjs` — structural integrity + cross-check against the real diff;
   errors are fixed and re-validated until clean (completeness is proven by
   script, never asserted by the LLM).
5. `assemble.mjs` — self-contained HTML with the mermaid bundle inlined.
