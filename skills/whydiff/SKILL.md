---
name: whydiff
description: Generate an interactive review map for a git diff — cause-grouped changes, a causal story, diff-marked mermaid diagrams, standards/tests/ops reports, all with drill-down to code. Use when the user asks to build a change map, review a diff/PR visually, or understand what recent changes do and why.
---

# whydiff: generate a review map for a diff

You are building a `review-map.json` (contract: `${CLAUDE_PLUGIN_ROOT}/schema/review-map.schema.json`)
and rendering it to a self-contained HTML page. The map exists to make reviewing
LLM-written code faster than reading the raw diff: structure first, text lazily.

## Inputs

- **Target repo**: the current working directory unless the user names another path.
- **Diff source** (from the user's request):
  - nothing specified → working tree vs HEAD (staged + unstaged + untracked);
  - a revision or range (`HEAD~3`, `main..feature`, a SHA) → pass it as `--ref`;
  - a PR number/URL → `gh pr diff <n>` for the diff text; use `--ref` with the PR's
    merge-base range when the branch is checked out locally, otherwise warn that
    file drill-down may not match the working tree.
- **Report language**: the language the user converses in. If unclear, use English.
  This becomes `meta.lang` and governs ALL human-readable text in the map.
  Code identifiers, paths, and code fragments always stay as-is.

## Working directory

Create `<repo>/.whydiff/` for intermediate and output files. If the repo has a
`.gitignore` that does not cover it, suggest adding `.whydiff/` (do not edit
without the user's go-ahead).

## Pipeline

### 1. Deterministic data

```bash
node ${CLAUDE_PLUGIN_ROOT}/scripts/manifest.mjs --repo <repo> [--ref <spec>] > <repo>/.whydiff/manifest.json
git -C <repo> diff [<spec>] > <repo>/.whydiff/diff.patch
```

For working-tree mode also capture untracked file contents (they are absent from
the patch): list them from the manifest (`isNew: true`) — agents will Read them
directly from the repo.

### 2. Read and understand

Read the full diff yourself. If the diff adds or changes documentation/spec files,
read them completely — they are the best source of "why". Skim `git -C <repo> log
--oneline -10` for context. You need this understanding to brief the agents and to
merge their output critically.

While reading, prepare two speed inputs for the agents:

- **BRIEFING** — one line per changed file: `path — what changed and why (your
  read)`. Agents start from your briefing instead of cold discovery; they still
  verify against the diff, but they stop re-deriving what you already know.
- **SKIP list** — generated/vendored files (lockfiles, dist/build output, large
  snapshots/fixtures). They stay in the manifest and get a `plumbing`-role group,
  but agents must not read their hunks.

Also check for a prebuilt code graph: if `<repo>/graphify-out/` or an
understand-anything knowledge graph exists, pass its path as `GRAPH:` — agents
consult it before exploratory grepping.

### 3. Parallel analysis passes

Spawn all four plugin agents IN ONE MESSAGE (they are independent):

| Agent | Returns (JSON) |
|---|---|
| `whydiff:classifier` | `intent`, `attentionFiles`, `story`, `groups`, `files`, `edges`, `ops` |
| `whydiff:diagrammer` | `diagrams` |
| `whydiff:standards-reviewer` | `standards`, `blastRadius` |
| `whydiff:tests-analyst` | `tests` |

Each agent prompt MUST include:
- `REPO: <absolute repo path>`
- `DIFF: <repo>/.whydiff/diff.patch`
- `MANIFEST: <repo>/.whydiff/manifest.json`
- `REPORT_LANGUAGE: <lang>` (e.g. `ru`, `en`)
- `BRIEFING:` — your per-file one-liners from step 2 (this is the main speed lever:
  agents verify instead of re-discovering)
- `SKIP:` — generated/vendored paths whose hunks must not be read
- `GRAPH: <path>` — only if a prebuilt code graph exists (see step 2); note that
  the graph predates the diff, so on any conflict the diff wins

**Large diffs (> ~30 substantive files):** shard the classifier. Spawn 2–3
classifier instances in the same message, each with a `SCOPE:` line listing its
subset of files (split by service/area; every non-skipped manifest file in exactly
one scope). Each returns `files`, candidate `groups` and `edges` for its scope; you
merge: unify duplicate groups, keep edges whose both ends survived, and write
`intent`/`story`/`ops` yourself from the classifier outputs plus your own step-2
reading. The other three agents are never sharded.

### 4. Merge into review-map.json

Assemble `<repo>/.whydiff/review-map.json`:

- `meta`: `project` = repo directory name; `lang`; `ref` = human label
  (`"working tree (main)"`, `"HEAD~3..HEAD"`, `"PR #14"`); `generatedAt` = today
  (`date +%F`); `title` = short feature name you derive from the intent;
  `stats` = manifest totals + `attentionFiles` from the classifier.
- `manifest`: rows from manifest.json with the classifier's group id appended:
  `[path, add, del, groupId, isNew]`.
- Everything else from the agents — but merge critically: you have read the diff;
  fix agent claims that contradict it, drop diagrams that do not show a flow
  change, and make sure `files` referenced by story/edges/diagrams/tests all exist.
- Mark 2–4 highest-attention files with `embedFull: true` so reviewers can open
  them whole.

### 5. Validate — script, not judgment

```bash
node ${CLAUDE_PLUGIN_ROOT}/scripts/validate.mjs <repo>/.whydiff/review-map.json --repo <repo> [--ref <spec>]
```

Fix every reported error and re-run until clean. Never hand-wave a failure: the
whole point is that completeness is enforced deterministically.

### 6. Assemble and deliver

The assembler inlines the mermaid bundle from the plugin's `node_modules`. On a
fresh plugin install it is missing — check once and install if needed:

```bash
[ -d ${CLAUDE_PLUGIN_ROOT}/node_modules/mermaid ] || npm install --prefix ${CLAUDE_PLUGIN_ROOT} --omit=dev
```

```bash
node ${CLAUDE_PLUGIN_ROOT}/scripts/assemble.mjs <repo>/.whydiff/review-map.json \
  --repo <repo> --out <repo>/.whydiff/<date>-<slug>.html
```

Then: `open` the HTML locally, and if artifact publishing is available, publish it
too. Finish with a chat summary in the report language: the intent paragraph, how
many files need careful reading and which, the test gaps, and any deploy notes.

## Quality bar (from the project principles)

1. Groups are **reviewer roles** (`read`, `verify-pattern`, `context`, `ops`,
   `spec`, `plumbing`), not file types.
2. Every edge is a labeled triple — an unlabeled arrow carries no information.
3. The story is a causal chain; each `link` says WHY the next block exists.
4. Diagrams only where control/data flow changes; one graph with diff marking,
   never two side-by-side versions.
5. Empty ops sections are information ("no env changes") — never omit `ops`.
6. Completeness is proven by `validate.mjs`, not asserted.
