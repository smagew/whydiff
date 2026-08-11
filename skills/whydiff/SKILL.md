---
name: whydiff
description: Generate an interactive review map for a git diff so the reviewer can follow the MEANING of a change — its architectural and logical decisions — without reading every file an LLM touched: causal story, cause-grouped changes, diff-marked flow and schema diagrams, standards/tests/ops reports, blast radius, all with drill-down to code. Use when the user asks to build a change map, review a diff/PR visually, or understand what recent changes do and why.
---

# whydiff: generate a review map for a diff

You are building a `review-map.json` (contract: `${CLAUDE_PLUGIN_ROOT}/schema/review-map.schema.json`)
and rendering it to a self-contained HTML page.

**What the map is for.** The reviewer must be able to follow the *meaning* of the
change — which architectural and logical decisions were made, and why — without
reading every file the LLM touched. So: decisions and causal structure first,
code lazily behind a click; every claim traceable to a real line of the diff.

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

Create `<repo>/.whydiff/` for intermediate and output files. The manifest excludes
this directory, so the map never reviews the run's own artifacts even in a repo
whose `.gitignore` does not cover it — but suggest adding `.whydiff/` anyway so the
files stay out of the user's commits (do not edit `.gitignore` without a go-ahead).

## Pipeline

### 1. Deterministic data

```bash
node ${CLAUDE_PLUGIN_ROOT}/scripts/gather.mjs --repo <repo> [--ref <spec>]
```

One bundled command creates `.whydiff/`, writes `manifest.json` and `diff.patch`,
logs the `run_start`/`deterministic_done` timing events, and prints a per-file
summary. Run it as a SINGLE command (do not re-expand it into a shell chain) — the
plugin's own scripts are auto-approved, so this step needs no permission prompt.

Every pipeline run is timed (events land in `.whydiff/timing.jsonl`). This is
measurement ONLY — never skip or shorten an analysis step to make the numbers look
better. `timing.mjs log <event>` remains available for the later per-stage marks
(`briefing_done`, and each pass), and `timing.mjs report` writes the summary.

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

You are done reading: `timing.mjs log briefing_done --repo <repo>`.

**Core by default; the rest are lazy.** A default run spawns only the two CORE
agents — `classifier` and `diagrammer` — which give the reviewer the Code map,
Diagrams and Ops (env). The four OPTIONAL passes — `summariser`,
`standards-reviewer`, `tests-analyst`, `story-writer` — are NOT spawned by default:
their tabs render as a one-line explanation with a **Generate** button that runs
that pass on demand (served mode), and `merge.mjs` records which passes ran in the
map's `generated` list. The `summariser` writes the **Summary** (the map's `story`,
a plain-language causal walkthrough); the classifier no longer authors it, so a
default run leaves `story` empty and the Summary tab lazy. Spawn the optional
passes up front ONLY when the user asked for a **full** report (words like "full",
"everything", "all sections", or a `--full`/`full` argument to the skill). When in
doubt, run core and say the rest are one click away.

Spawn the chosen agents IN ONE MESSAGE (they are independent), logging
`timing.mjs log agents_spawned --repo <repo>` right before the spawn message and
`timing.mjs log agents_done --repo <repo>` in your first tool call after they all
return. **Never skip `agents_done`** — without it the timing report cannot
separate agent time from your own, and 80% of the run becomes unattributable.

**Every agent writes its own output file; you never retype an agent's answer.**
Each returns one confirmation line, and `merge.mjs` reads the files. Retyping a
150 KB answer into a file costs more wall-clock than the entire merge.

| Agent | Tier | Writes (`OUT:`) | Contents |
|---|---|---|---|
| `whydiff:classifier` | core | `.whydiff/classifier.json` | `intent`, `attentionFiles`, `groups`, `files`, `edges`, `ops` |
| `whydiff:diagrammer` | core | `.whydiff/diagrammer.json` | `diagrams` |
| `whydiff:summariser` | full only | `.whydiff/story.json` | `story` |
| `whydiff:standards-reviewer` | full only | `.whydiff/standards.json` | `standards`, `blastRadius` |
| `whydiff:tests-analyst` | full only | `.whydiff/tests.json` | `tests` |
| `whydiff:story-writer` | full only | `.whydiff/stories.json` | `userStories` |

Each agent prompt MUST include:
- `REPO: <absolute repo path>`
- `OUT: <repo>/.whydiff/<name>.json` — where it writes its JSON (absolute path)
- `DIFF: <repo>/.whydiff/diff.patch`
- `MANIFEST: <repo>/.whydiff/manifest.json`
- `REPORT_LANGUAGE: <lang>` (e.g. `ru`, `en`)
- `BRIEFING:` — your per-file one-liners from step 2 (this is the main speed lever:
  agents verify instead of re-discovering)
- `SKIP:` — generated/vendored paths whose hunks must not be read
- `GROUPS:` (classifier only) — the group ids you decided on, with `name`, `role`
  and `why` for each. Shards then emit `{id, files}` instead of re-authoring the
  same group three times, and cannot describe one group three different ways.
- `GRAPH: <path>` — only if a prebuilt code graph exists (see step 2); note that
  the graph predates the diff, so on any conflict the diff wins

**Large diffs (> ~30 substantive files): shard the classifier, and let the script
decide the split.** A classifier's wall-clock is set by how many bytes it writes
and nothing else — measured at 102–119 bytes/sec across three shards of one run.
Splitting by service area produced a 17× imbalance there (5 KB against 86 KB) and
the whole run waited on the big one.

```bash
node ${CLAUDE_PLUGIN_ROOT}/scripts/shards.mjs --repo <repo> [--ref <spec>] \
  --budget 300 --skip <comma-separated SKIP paths>
```

It writes `.whydiff/shards.json`: balanced file lists plus a per-shard time
estimate. Spawn one classifier per shard, in the same message, each with:

- `SCOPE:` — that shard's file list, verbatim from `shards.json`
- `OUT: <repo>/.whydiff/classifier-<id>.json` — the id from the plan

Filenames must start with `classifier`; `merge.mjs` picks up every
`classifier*.json`. Each shard covers `files` plus group membership and `edges`
for its scope, and skips `intent`/`story`/`ops`.

If the plan warns that even `--max-shards` does not fit the budget, the input is
too big rather than the split wrong: extend `SKIP:` or narrow the diff. Say so in
the final summary instead of silently taking longer.

You do NOT merge the shards by hand — `merge.mjs` unifies groups, keeps only edges
whose both ends survived, and holds every file to one group. The other three agents
are never sharded.

### 4. Write the narrative, then merge by script

The only things you author here are what no agent supplies on a default run: the
map's `meta`, and any correction to the classifier's output. Write
`<repo>/.whydiff/narrative.json`:

```json
{
  "meta": { "lang": "ru", "ref": "working tree (main)", "title": "short feature name" },
  "intent": "one paragraph: what + why + what could break",
  "groups": [{ "id": "…", "name": "…", "role": "read", "tag": "…", "why": "…" }],
  "attentionFiles": 8,
  "embedFull": ["path/a.ts", "path/b.ts"],
  "skip": ["path/to/generated.json"],
  "ops": { … },
  "strings": { "unclassifiedGroup": "…", "unclassified": "…" }
}
```

`meta.project`, `meta.generatedAt` and `stats` are filled in for you. On an
unsharded run the classifier already wrote `intent`/`ops`, so omit them here
unless you are correcting it — `meta` is what only you can supply. The Summary
(`story`) is a lazy pass now (`summariser`); do not author it here. `ops` is
optional — omitted, the shards' `ops` are concatenated.

- `groups` carries the same list you passed to the shards as `GROUPS:` — metadata
  only, no `files`. A group nobody assigned a file to is dropped.
- `skip` is your `SKIP:` list. Those files get no code fragment; everything else
  gets one lifted from the patch.
- `strings` supplies the report-language wording for the fallback group
  `merge.mjs` creates if some diff file was described by no pass; omit it for an
  English report.

Nothing else goes in this file. Do not copy `files`, `edges`, `diagrams`,
`standards`, `tests`, group membership, or code lines into it — all of that is
already on disk or derived from the patch.

Then merge:

```bash
node ${CLAUDE_PLUGIN_ROOT}/scripts/merge.mjs --repo <repo> [--ref <spec>]
```

It re-collects the manifest from git (files can appear mid-run), takes
`add`/`del`/`isNew` from git and each file's `frag`/`preview` from the patch rather
than from the model, unifies the shards, validates, logs `map_written`, and refuses
to write a map that would not validate.
Its warnings are worth reading: a file described by no pass, or described by two
shards, usually means the `SCOPE:` split was wrong.

You have read the diff — so review the result critically: fix agent claims the diff
contradicts, drop diagrams that do not show a flow change. Edit
`review-map.json` in place for that, or fix the agent's own file and re-run
`merge.mjs`.

### 5. Validate — script, not judgment

`merge.mjs` already ran the structural checks. Confirm against git too:

```bash
node ${CLAUDE_PLUGIN_ROOT}/scripts/validate.mjs <repo>/.whydiff/review-map.json --repo <repo> [--ref <spec>]
```

(validate.mjs and assemble.mjs log their own timing events automatically.)

Fix every reported error and re-run until clean. Never hand-wave a failure: the
whole point is that completeness is enforced deterministically.

Then re-attach any review discussion from a previous run of this map — always, even
on a first run, when it prints one line and does nothing:

```bash
node ${CLAUDE_PLUGIN_ROOT}/scripts/rebind.mjs --repo <repo>
```

A journal of questions, plans and agreed tasks (`.whydiff/review.log.jsonl`) outlives
the map it discusses. Regenerating moves the places those remarks were attached to,
so this decides per anchor whether its place still exists: moved → rebound, gone →
kept and marked `stale` with its original text, back again → revived. **Nothing is
dropped**, and if it reports anything stale, say so in the final summary: the user
had a remark on something that is no longer in the report.

### 6. Deliver — serve the live report (default)

Both serving and assembling inline the mermaid bundle from the plugin's
`node_modules`. On a fresh install it is missing — check once and install if needed:

```bash
[ -d ${CLAUDE_PLUGIN_ROOT}/node_modules/mermaid ] || npm install --prefix ${CLAUDE_PLUGIN_ROOT} --omit=dev
```

**Serve it. This is the default way to hand the map over — not a static file.**
The report only earns its keep live: the reviewer selects anything and asks about
it, instructs a change, weighs options, and — because a default run builds only the
core — clicks **Generate** on the Summary, standards, tests and user-story tabs to
add those passes on demand. A static file can do NONE of that: its Generate buttons and ask
panel are inert. So unless the user explicitly wants a file to keep or an artifact
to publish, serve — do not assemble.

```bash
node ${CLAUDE_PLUGIN_ROOT}/scripts/serve.mjs <repo>/.whydiff/review-map.json \
  --repo <repo> [--port 7777]
```

Give the user the printed `http://127.0.0.1:<port>/`. The server injects a per-run
token and answers from the page by calling `claude -p` in the repo (read-only).
Anchors: a user-story card, a Summary block (⌘/Ctrl-click several for one question
about the set), a diagram (Alt-click one node), or any text selection. Every remark
is appended to the review journal at `<repo>/.whydiff/review.log.jsonl` and reloaded
on the next serve, so it is not lost when the tab closes. To read that journal from a
terminal: `node ${CLAUDE_PLUGIN_ROOT}/scripts/review.mjs <repo>/.whydiff`.

The same panel has an **Instruct** mode: the user says what should change at the
anchored place, and the reply is a plan (files, what proves it done, blast radius,
open questions) they agree to or turn down. Agreeing opens a task in the journal.
Nothing runs and nothing is edited — the CLI is spawned with a read-only tool
allowlist, and the tasks are a queue this session drains when the user asks.

On a problem the map itself reported — a standards `warn`, a test gap, a story that
is not `delivered` — a third mode, **Options**, asks for two or three ways to deal
with it that differ in kind: fix the symptom, fix the invariant, or leave the
behaviour alone and pin it with a test. Each option carries cost, risk, blast radius
and the criterion it would be judged by; the one the user chooses becomes the task.

Agreed tasks and unanswered questions collect in a **Tasks** tab (served copy only):
`blocking N` in the header, `decided d/t` for the findings the map reported, grouped
by where each problem came from, every card linking back to its place in the report. Its *Copy the queue as a prompt* button produces the
handoff to paste into a session — when the user does that, work the tasks one at a
time against the acceptance criterion each one carries, and do not call anything
verified yourself.

When the user wants that queue done, there are two ways, and they do the same work
in different places:
- `/whydiff-work` (a separate skill in this plugin) — in this session, one task at a
  time, against the criterion each task carries;
- `serve.mjs --work` — from the report itself: each agreed task gets a *do it in a
  worktree* button, the agent works a throwaway copy of the tree, and the resulting
  patch reaches the real tree only when the user applies it. Mention this only if
  they ask for it: it spends tokens per task and lets an agent edit files (in the
  worktree), so it must be their choice.

Three things to tell the user plainly when you start it: the ask UI exists **only**
on this served copy — the file on disk and the published artifact are unchanged
and show no ask controls; every question and every plan spends tokens through the
CLI; and an agreed task is a queue entry, not work in progress.

### 6b. Static export — only when asked

When the user wants a file to keep or an artifact to publish rather than an
interactive session, assemble a self-contained HTML:

```bash
node ${CLAUDE_PLUGIN_ROOT}/scripts/assemble.mjs <repo>/.whydiff/review-map.json \
  --repo <repo> --out <repo>/.whydiff/<date>-<slug>.html
```

`open` it locally and, if artifact publishing is available, publish it. It is a
snapshot: the ask/instruct panel and the Generate buttons are inert (a published
artifact's CSP blocks every outgoing request), so any optional section not generated
before export stays a placeholder — generate what they want included first, on the
served copy, then export.

Generate the timing report (do this on any run):

```bash
node ${CLAUDE_PLUGIN_ROOT}/scripts/timing.mjs report --repo <repo>
```

Finish with a chat summary in the report language: the intent paragraph, how
many files need careful reading and which, any story that is not `delivered`,
the test gaps, any deploy notes — and one line pointing at
`.whydiff/timing-report.md` (total time + slowest phase) so performance can be
discussed with data.

## Quality bar (from the project principles)

1. Groups are **reviewer roles** (`read`, `verify-pattern`, `context`, `ops`,
   `spec`, `plumbing`), not file types.
2. Every edge is a labeled triple — an unlabeled arrow carries no information.
3. The story is a causal chain; each `link` says WHY the next block exists.
4. Diagrams only where control/data flow changes; one graph with diff marking,
   never two side-by-side versions. Exception that is REQUIRED, not optional:
   schema-changing migrations get an `er-diff` (tables/columns before/after).
5. Empty ops sections are information ("no env changes") — never omit `ops`.
6. Completeness is proven by `validate.mjs`, not asserted.
7. Every user story carries a verdict (`delivered`/`partial`/`broken`/`regressed`)
   backed by the diff. A story without one is documentation, not review. An empty
   `stories` list is a real answer for a refactor — never pad it.
