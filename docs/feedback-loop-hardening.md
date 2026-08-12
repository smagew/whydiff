# ADR: hardening the feedback → agent loop (Track A) — buy vs build

Status: accepted (2026-08-12). Extends `review-loop.md` (tier-3 worktree
execution, already shipped). Records the failure modes we must cover and what we
**reuse** vs **reject** vs **spike**, so the "childhood diseases" of this pattern
are decided deliberately rather than rediscovered.

> **Update (2026-08-12), after an empirical check:** the "patch doesn't apply" row
> below originally said *adopt `git apply --3way`*. A quick experiment killed that:
> `--3way` implies `--index`, and the reviewed tree is **dirty** (the change under
> review is uncommitted), so git refuses with *"does not match index"* before it
> ever tries to merge. A working-tree 3-way would mean a hand-rolled `git merge-file`
> pipeline (reconstruct base/other per file, handle new/renamed/binary) — exactly the
> fragile code this ADR exists to avoid. Decision revised: **keep the clean-or-refuse
> gate, and make re-running the task the recovery.** The row and the "Next" section
> reflect the shipped behaviour; a true auto-merge is parked in the backlog below.

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
| **Patch doesn't apply** — reviewed tree moved on, or patch already in it | `git apply --reverse --check` to classify; git's own gate to refuse | **Shipped (revised).** `git apply --3way` does **not** fit a dirty reviewed tree (see the update above). Instead: keep `--check`-then-apply, and when it fails, use `git apply --reverse --check` to tell *already-applied* (nothing to do) from *moved-on* (re-run the task to rebase it). The gate stays clean-or-refuse — the tree is never left half-applied or with conflict markers. |
| **Worktree leak on hard kill** | `git worktree prune` + sweep of stale tmp dirs | **Build, small.** `makeWorktree`/`dropWorktree` (`serve.mjs:457`,`:471`) clean up in `finally`, but a SIGKILL of the server leaks the tmp worktree and its registration. Add `git worktree prune` + removal of stale `whydiff-work-*` dirs at startup. ~10 lines; no package (pure-JS git libs like isomorphic-git don't cover worktrees). |
| **Agent run + structured diff + streaming + permissions** | Claude Agent SDK (TypeScript, first-party) | **Spiked → rejected** ([`agent-sdk-worker.md`](agent-sdk-worker.md)). The premise — a structured `gitDiff` — does not exist in the SDK; edits are just `tool_use` + text `tool_result`, so the caller still reconstructs the diff (as `run()` already does). Everything else it offers, `run()` already covers; adopting only adds a dependency + platform binary + an auth mismatch. |
| **Reconnect to an in-flight stream** | SSE `Last-Event-ID` / a job store | **Build tiny, or skip.** Single-process local server; "close the tab, reload shows the final journalled state" already holds (writes to a dead socket are swallowed and the worker finishes). Not worth a queue library. |
| **Two workers at once** | — | **Keep ours.** The `working` lock (`serve.mjs:531`, 409 on a second `/api/work`) already covers it. |
| **Process (not just file) isolation** — worker can touch files outside the task's scope | Dagger container-use pattern (worktree + container) | **Out of scope now.** Our worker isolates *files*, not the *process*; the apply-gate + human patch review is the current backstop. Noted as the upgrade path if we ever need a hard boundary. |
| **All-or-nothing apply** | per-file review/apply, as the parallel-worktree tools do | **Backlog UX.** Our `Apply` is atomic; partial apply is a nice-to-have, not a reliability fix. |

## The Claude Agent SDK spike (the one real "adopt a package")

> **Resolved (2026-08-12): rejected.** The spike ran and the answer is no — the SDK
> exposes no structured diff, so the reconstruction stays and adoption buys nothing.
> Full reasoning in [`agent-sdk-worker.md`](agent-sdk-worker.md). The section below is
> the pre-spike framing, kept for the record.

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
what "as is" even means — **shipped** (`scripts/serve.mjs`, tests in
`tests/work-harden.mjs`):

1. `applyPatch` classifies a non-applying patch as *already-applied* vs *moved-on*
   (`git apply --reverse --check`) and refuses with the matching guidance; the gate
   stays clean-or-refuse. (Not `--3way` — see the update at the top.)
2. `sweepWorktrees()` at startup: `git worktree prune` + a force-remove of leftover
   `whydiff-work-*` worktrees, ours only.

Then run the loop on a live diff (`serve --work`) to turn the failure-mode list
above into observed facts. The Agent SDK is a separate spike and its own ADR.

### Backlog

- **True auto-merge of a moved-on patch.** If re-running the task proves too coarse
  in practice, revisit a working-tree 3-way via `git merge-file`, fed by the result
  blobs recorded at resolve time (they already live in the shared object store after
  the worker's `git add`), so no fragile per-file reconstruction is needed. Low
  priority — the "moved-on" case is uncommon, and re-work is a clean recovery.

## Prior art referenced

parallel-code (`github.com/johannesjo/parallel-code`); Parallel Code
(`parallelcode.app`); "Best Git Worktree Tools for AI Coding 2026" (Nimbalyst);
`git-apply` docs (`git-scm.com/docs/git-apply`); `git worktree prune`
(`gitworktree.org`); isomorphic-git (`github.com/isomorphic-git/isomorphic-git`);
Claude Agent SDK (`github.com/anthropics/claude-agent-sdk-typescript`); Claude Code
headless docs (`code.claude.com/docs/en/headless`).
