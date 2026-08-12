# ADR: hardening the feedback → agent loop (Track A) — buy vs build

Status: proposed (2026-08-12). Extends `review-loop.md` (tier-3 worktree
execution, already shipped). No code change yet — this records the failure modes we
must cover, and what we **reuse** vs **reject** vs **spike**, so the "childhood
diseases" of this pattern are decided deliberately rather than rediscovered.

## Context

Track A — execute an agreed task in a throwaway worktree, review the produced
patch, apply it behind a gate — is already implemented: `/api/work` +
`/api/apply` in `scripts/serve.mjs`, and the Tasks-tab UI (`Do it` / `show the
patch` / `Apply`) in `templates/viewer.html`, all behind the `--work` flag. Before
we lean on it as the primary feedback path, we surveyed its failure modes and asked
the only question that matters here: **do the fragile parts have reusable prior art,
so we don't re-solve well-charted problems?** The goal is reliable, stable,
predictable — not novel.

Two findings shaped the decision:

1. **Our design is the industry-standard shape.** temp worktree → run agent →
   review diff → apply-or-discard is exactly what the current wave of tools does
   (parallel-code, Parallel Code, Nimbalyst, Dagger container-use, and the Cursor
   worktree flow). That is reassuring: we are on the charted path, not a weird one.
2. **The reusable pieces are git built-ins and one first-party SDK — not third-party
   packages.** The whole-loop tools are *applications/orchestrators*, not embeddable
   libraries; adopting one is an architecture swap, not a dependency. The fragile
   primitives are mostly solved by commands git already ships.

## Decision — buy vs build, per concern

| Concern (failure mode) | Reusable solution | Verdict |
|---|---|---|
| **Patch doesn't apply** — reviewed tree moved on, or patch already in it | `git apply --3way` (built-in three-way merge) | **Adopt.** `applyPatch` (`serve.mjs:595`) does `--check` then a plain apply and 409s on any drift; switch to `--3way` and surface conflict markers instead of a hard failure. Our patch comes from `git diff --cached` (carries index lines) and the blobs are local — both preconditions for `--3way` are met. |
| **Worktree leak on hard kill** | `git worktree prune` + sweep of stale tmp dirs | **Build, small.** `makeWorktree`/`dropWorktree` (`serve.mjs:457`,`:471`) clean up in `finally`, but a SIGKILL of the server leaks the tmp worktree and its registration. Add `git worktree prune` + removal of stale `whydiff-work-*` dirs at startup. ~10 lines; no package (pure-JS git libs like isomorphic-git don't cover worktrees). |
| **Agent run + structured diff + streaming + permissions** | Claude Agent SDK (TypeScript, first-party) | **Spike, then a follow-up ADR.** May replace the hand-rolled `run()` (`serve.mjs:287`) and patch reconstruction (`git add -A` + `git diff --cached`, `serve.mjs:558`) with a supported API that returns a structured `gitDiff` and models tool allowlists natively. See the spike section — it is the one real dependency decision, and it touches portability. |
| **Reconnect to an in-flight stream** | SSE `Last-Event-ID` / a job store | **Build tiny, or skip.** Single-process local server; "close the tab, reload shows the final journalled state" already holds (writes to a dead socket are swallowed and the worker finishes). Not worth a queue library. |
| **Two workers at once** | — | **Keep ours.** The `working` lock (`serve.mjs:531`, 409 on a second `/api/work`) already covers it. |
| **Process (not just file) isolation** — worker can touch files outside the task's scope | Dagger container-use pattern (worktree + container) | **Out of scope now.** Our worker isolates *files*, not the *process*; the apply-gate + human patch review is the current backstop. Noted as the upgrade path if we ever need a hard boundary. |
| **All-or-nothing apply** | per-file review/apply, as the parallel-worktree tools do | **Backlog UX.** Our `Apply` is atomic; partial apply is a nice-to-have, not a reliability fix. |

## The Claude Agent SDK spike (the one real "adopt a package")

Today the worker shells out to `claude -p`, parses NDJSON, and reconstructs the
patch from the worktree. The first-party Agent SDK reportedly hands back a
structured `gitDiff` (file, status, +/−, patch string), models tool allowlists
natively (which is exactly our `READ_ONLY_TOOLS` / `WRITE_TOOLS` split), and bundles
the Claude Code binary. It could remove hand-rolled code and make the worker more
predictable.

Verify before adopting — do not thread it in mid-change:

- multi-file `gitDiff` parity with `git diff --cached` (renames, new files, mode
  changes);
- behaviour with `cwd` pointed at a throwaway worktree;
- the permission model maps cleanly onto our allowlist/deny split;
- footprint is acceptable for a self-contained plugin.

Portability note: adopting the SDK **couples the worker to Claude.** That is
acceptable because the worker is *host glue*, not the portable core — the core is
`agents/*` + `review-map.json` + the renderer (see `ROADMAP.md`, "one core, many
hosts"). A future Codex adapter gets its own worker; the SDK does not leak into the
core.

## Rejected alternatives

- **Adopting a whole worktree orchestrator** (claude-squad, conductor, vibe-kanban,
  parallel-code) as a dependency. They are alternative *surfaces*, not libraries;
  taking one on discards our thesis that the **map is the review surface**.
- **A job queue** (BullMQ and similar). Needs Redis; overkill for a local,
  single-process, human-watched queue.
- **LLM / fuzzy patch-apply services** (e.g. morphllm). Adds a vendor for something
  `git apply --3way` handles locally and deterministically.
- **isomorphic-git for worktree management.** Pure-JS git reimplementations don't
  meaningfully cover worktrees; native `git worktree` stays the tool.

## Next

Two zero-dependency git fixes, both before the end-to-end run because they change
what "as is" even means:

1. `git apply --3way` in `applyPatch`, with conflict surfaced rather than forced.
2. `git worktree prune` + `whydiff-work-*` sweep at server startup.

Then run the loop on a live diff (`serve --work`) to turn the failure-mode list
above into observed facts. The Agent SDK is a separate spike and its own ADR.

## Prior art referenced

parallel-code (`github.com/johannesjo/parallel-code`); Parallel Code
(`parallelcode.app`); "Best Git Worktree Tools for AI Coding 2026" (Nimbalyst);
`git-apply` docs (`git-scm.com/docs/git-apply`); `git worktree prune`
(`gitworktree.org`); isomorphic-git (`github.com/isomorphic-git/isomorphic-git`);
Claude Agent SDK (`github.com/anthropics/claude-agent-sdk-typescript`); Claude Code
headless docs (`code.claude.com/docs/en/headless`).
