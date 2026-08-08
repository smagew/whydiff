# whydiff — a change map for reviewing LLM code

**Problem.** An LLM writes code 5–7× faster than a human can meaningfully read it.
On medium-plus projects with long-term involvement you have to review everything —
and the speed gain evaporates ("comprehension debt"). A linear git diff is the worst
format for understanding: it answers "what changed line by line", but not "why",
"how it works now", and "what might have broken".

**Solution.** A tool that, after an LLM session (or for any diff/PR), generates an
interactive change map: a causal chain of "what because of what", diff diagrams of
the logic, architectural flows, a standards and tests report — with drill-down to a
code fragment and to the whole file from any point.

---

## Principles (learned on prototypes, 2026-07-30)

1. **Text explains, but structure saves time.** Explanations — lazily, on click;
   the main flow carries structure only. Diff + inlined text = slower than the diff.
2. **Groups are review roles, not file types.** "Cause" = read carefully,
   "wave" = check the completeness of a list, "config" = pre-deploy checklist,
   "tests" = specification on request.
3. **A link without a label carries no information.** Every edge is a triplet
   `(from, to, why)`. Unlabeled arrows are noise.
4. **A causal chain reads easier than a causal graph.** Story top to bottom
   ("↓ therefore…") is the default view; the link graph is on demand.
5. **Completeness is guaranteed by a script, not by the LLM.** The manifest "N of N
   files on the map" is checked deterministically; the LLM cannot silently drop a hunk.
6. **Visualization budget.** A diagram is justified only where a control/data flow
   changes. A pinpoint edit is served by text + fragment. A diagram for the diagram's
   sake — "dry visualization" — was dropped.
7. **"Before / after" is one graph with diff marking** (green added,
   red removed, yellow changed), not two schematics side by side: comparing two
   schematics is the same work as reading the diff.
8. **Language.** The tool's source code (comments, identifiers, log strings) is
   English only. The report language (`meta.lang`) = the chat conversation language;
   if it cannot be determined — English. `meta.lang` controls both the map content
   and the viewer interface (the i18n dictionary in the template).
9. **Viewer autonomy.** No external dependencies at view time:
   mermaid.js is embedded into the HTML at build — the map works from file://, from
   artifact hosting, and from CI identically.

## What matters to us in a review (needs model)

| # | Need | Format on the map |
|---|------------|-----------------|
| 1 | What exactly this code changes (+ why, + what might have broken) | Text: intent paragraph + story causal chain |
| 1.1 | …but reading it takes time → graphically | Mermaid flowchart with diff-marked nodes (before/after in one graph) |
| 2 | Architecture: how it works now, how data flows, where things are stored | Sequence diagram (flows between services) + component schematic (stores). Two questions — two diagrams |
| 3 | Standards, patterns, best practices | Aggregation (linters, /code-review, own reviewers) on one screen + LLM check against project conventions ("repeats pattern X from Y / deviates") |
| 4 | Tests: written or not, what coverage | Not % coverage, but: (a) which assertions are pinned down — in plain language; (b) gap analysis: which branches/scenarios are NOT covered |
| 5 | Blast radius | Reverse dependencies: what depends on the changed code but is not in the diff |
| 6 | Operational checklist | env variables (±), migrations, config, deploy steps |
| 7 | Completeness guarantee | Manifest N/N + deterministic check |

**Cross-cutting requirement:** from every item — an instant jump to the code fragment
and to the whole file.

---

## Implementation: a Claude Code plugin

Decision: a **plugin** (not a single skill in `~/.claude/skills`, not a standalone utility).

Why:
- Work happens across several projects — a plugin is installed once and
  available everywhere; a skill inside a project would have to be copied.
- A plugin bundles everything needed: skills + subagents + scripts + the viewer template + (later)
  hooks — as one versioned artifact.
- Distribution to a team — via a plugin marketplace (a git repo with
  `marketplace.json`), updates centralized.
- Precedents in our own environment: `understand-anything`, `plannotator` are built
  exactly this way.

### Plugin contents

```
whydiff/
├── .claude-plugin/plugin.json      # manifest (name, version, description)
├── skills/
│   ├── whydiff/SKILL.md         # /whydiff — the main generator
│   └── whydiff-view/SKILL.md    # /whydiff-view — open a ready map
├── agents/
│   ├── classifier.md               # group hunks by cause + story
│   ├── diagrammer.md               # mermaid diagrams (flowchart diff, sequence)
│   ├── standards-reviewer.md       # project patterns/conventions
│   └── tests-analyst.md            # test assertions + gap analysis
├── scripts/
│   ├── manifest.sh                 # git diff --numstat → manifest (determinism)
│   ├── validate.mjs                # completeness: every file/hunk assigned; mermaid parses
│   └── assemble.mjs                # review-map.json + template → self-contained HTML
└── templates/viewer.html           # the generic viewer (from the prototype)
```

### Pipeline `/whydiff [ref|PR|worktree]`

1. **Deterministically:** diff, numstat, manifest, affected services.
2. **LLM passes** (agents, in parallel where possible): classification → story →
   diagrams (only where a flow changes — principle 6) → standards → tests →
   blast radius (grep of reverse dependencies + LLM assessment).
3. **Validation by script:** manifest completeness, mermaid syntax, fragment↔file
   links.
4. **Render:** `review-map.json` → self-contained HTML → a file in
   `.whydiff/<date>-<slug>.html` + published as an artifact (optional).

### Data model `review-map.json` (the generator↔viewer contract)

```jsonc
{
  "meta": { "project": "", "ref": "", "generatedAt": "", "stats": {} },
  "intent": "the gist in one paragraph",
  "story": [ { "step": "…", "files": [], "branches": [] }, { "link": "why ↓" } ],
  "groups": [ { "id": "", "role": "read|verify-list|ops|spec", "why": "", "files": [] } ],
  "files": { "<path>": { "add": 0, "del": 0, "why": "", "frag": [], "preview": [], "full": false } },
  "edges": [ ["from", "to", "why the link exists"] ],
  "diagrams": [ { "kind": "flow-diff|sequence|components", "title": "", "mermaid": "", "anchors": {"nodeId": "path"} } ],
  "standards": [ { "severity": "", "finding": "", "file": "", "line": 0, "pattern": "" } ],
  "tests": { "fixed": ["assertions in plain language"], "gaps": ["what is not covered"], "files": [] },
  "ops": { "env": [], "migrations": [], "deploy": [] },
  "blastRadius": [ { "path": "", "why": "" } ],
  "manifest": [ ["path", add, del, "groupId", isNew] ]
}
```

### Viewer tabs ↔ needs

Logic (story, default) · Diagrams (1.1) · Architecture (2) · Standards (3) ·
Tests (4) · Ops (6) · Files by group + manifest (7) · Blast radius (5).

---

## Stages

**Stage 1 — contract.** ✅ (2026-08-01) JSON schema + a sample `review-map.json`,
filled in by hand from a real diff of a private test-bed project; the format was validated on a real case. The repo carries a synthetic example (examples/rate-limit).

**Stage 2 — viewer.** ✅ (2026-08-01) `templates/viewer.html` renders an arbitrary
`review-map.json`: 6 tabs, i18n (en/ru), mermaid embedded at build, drill-down.
The stage-1 sample displays in full with no viewer edits.

**Stage 3 — generator.** Skeleton ready (2026-08-01): the `whydiff` plugin
(`plugin.json` valid), the `/whydiff` skill, 4 pass agents (classifier,
diagrammer, standards-reviewer, tests-analyst), scripts `manifest.mjs` /
`validate.mjs` / `assemble.mjs` — the deterministic layer verified on a private test-bed project
(working tree and ref mode, the cross-check catches divergence in both directions).
*Done when:* a live `/whydiff` run on a real diff (for example,
a large real feature diff of ~50 files in the test-bed project) without manual
edits produces a map comparable to the hand-made sample and passes validation.
Run: `claude --plugin-dir /Users/ag/www/spy` in the target repo.

**Stage 4 — shakedown.** 2–3 fresh real diffs; a feedback → schema/prompt edit loop.
*Done when:* the map is consistently faster than reading the diff (a subjective judgment on a real review).

*Speed optimizations (2026-08-01, without loss of functionality):*
- model tiering: diagrammer and tests-analyst on `model: sonnet` (frontmatter),
  classifier and standards-reviewer inherit the session model;
- BRIEFING: the orchestrator passes agents per-file one-liners from its own
  reading of the diff — agents verify rather than re-open;
- SKIP: generated/vendored files are not read by agents (they stay in the manifest
  as a plumbing group);
- SCOPE sharding of the classifier on diffs >30 files (2–3 instances by service,
  merged by the orchestrator; intent/story/ops written by the orchestrator);
- GRAPH: optional integration with a prebuilt graph (graphify-out/,
  understand-anything) — agents read the graph before greps; the graph lags the diff,
  the diff is always right.
Expectation: minus 30–50% wall time on a large diff; measure on `42d050f`.

**Stage 5 — integration (optional).** A "map after every LLM session" hook,
a marketplace repo for the team, PR mode (`gh pr diff`).

## Open questions

- ~~Plugin name~~ — decided (2026-08-04): `whydiff` (working name was `change-map`).
- Blast radius: grep heuristic only, or + graph knowledge from `understand-anything`
  if it is installed in the project?
- Standards: which external sources to aggregate in the first version (LLM pass only
  or + eslint/tsc output)?
- Store `review-map.json` in the project repo (a history of maps) or only the HTML in
  `.whydiff/` under gitignore?
