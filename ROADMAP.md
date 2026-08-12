# Roadmap

A living list of where whydiff is going. Not a promise of dates — a place to
formulate and keep direction so decisions stay consistent. Anything open-ended
starts in [Discussions](https://github.com/smagew/whydiff/discussions); when it's
concrete it becomes an issue and moves here.

## The direction: one core, many hosts

The organising idea, borrowed from how revdiff frames itself:

> One core, many plugins.

whydiff should follow the same shape — **a single, uniform core, reused by thin
host integrations** — so the same review map can be produced not only in Claude
Code but also in Codex and other agent hosts.

What that means concretely is a clean split between what is universal and what is
host-specific:

**The core (host-agnostic, must stay uniform):**
- **The analysis prompts** — `agents/*.md` (classifier, diagrammer, summariser,
  standards-reviewer, tests-analyst, story-writer). These are just instructions;
  they don't depend on Claude Code.
- **The contract** — `schema/review-map.schema.json`, the `review-map.json` that
  every pass writes and the viewer reads. This is the real interface, and the main
  lever for reaching more tools.
- **The renderer** — `templates/viewer.html` plus `scripts/assemble.mjs` and
  `scripts/serve.mjs`. Given a valid `review-map.json`, they produce and serve the
  self-contained map with no knowledge of who generated it.

**Host-specific (thin, per-integration):**
- Orchestration — the `skills/` SKILL.md that sequences the passes.
- Spawning the passes as that host's subagents.
- The permission/approve glue (`hooks/`, `scripts/approve.mjs` for Claude Code).

The bet: keep the split honest and a new host is a thin adapter — sequence the
same prompts, write the same JSON, hand it to the same assembler — not a fork.

### Steps toward it

1. **Name and document the boundary.** Mark in `CLAUDE.md`/docs which paths are
   core vs host glue, so a change doesn't quietly couple the renderer to Claude
   Code. Nothing in the core should import a Claude-only assumption.
2. **Make the assembler runnable from a raw `review-map.json`.** It mostly is —
   confirm `assemble`/`serve` need only the JSON + templates, and document the
   entry point as a supported contract (input → self-contained HTML).
3. **Publish `review-map.json` as a stable, versioned contract.** Schema version,
   compatibility notes. This is what lets a non-Claude generator target the same
   viewer.
4. **First second host: a Codex integration.** A Codex-side skill/flow that runs
   the same `agents/*` prompts, emits `review-map.json`, and calls the shared
   assembler. Prove the core survives a second host with no renderer changes.
5. **Fold the differences back.** Whatever the Codex adapter forced apart becomes
   the template for host #3.

## Related work / positioning

Where whydiff sits, so the difference stays deliberate:

- **revdiff** — a *diff reader*. A fast local TUI for navigating a raw diff. No
  LLM, agent-agnostic. Adjacent niche, not ours.
- **[plannotator](https://github.com/backnotprop/plannotator)** — *annotate and
  route*. A browser surface where a human marks up an agent's plan or diff and
  sends structured feedback back to the agent to revise. Multi-agent (Claude Code,
  Codex, Gemini, …), human-in-the-loop. The closest neighbour.
- **whydiff** — *explain the change*. The LLM does the comprehension work and emits
  a self-contained map (causal story, diff-marked diagrams, proven-complete file
  list). The human reads a generated understanding rather than authoring notes on a
  blank surface.

Two takeaways this pins down:

- **Multi-host is table stakes, not a differentiator.** plannotator already spans
  many agents — so "works in Codex too" validates the direction above but can't be
  our headline. Our claim is the **generated map itself**.
- **They may be complementary, not rival.** plannotator annotates HTML artifacts;
  a whydiff map *is* one. "whydiff explains the diff → plannotator annotates it and
  routes feedback" is a plausible seam worth keeping in view.

## Near-term

- **(high) Tighten the feedback → agent loop.** The handoff from a decision made in
  the map to the agent doing it is our weakest seam next to plannotator's one-click
  round-trip. The journal (`review.log.jsonl`) is already the shared bus between the
  served panel and a `/whydiff-work` session; the gap is the *trigger*. Two moves,
  both reusing what exists: (a) expose serve's `--work` worker as a per-task **Do
  it** button in the Tasks tab — it already runs `claude -p` in a throwaway
  worktree and streams NDJSON, so this is UI + an apply-gate over built machinery;
  (b) let `/whydiff-work` **poll** the journal when the queue is empty, so the
  reviewer invokes it once and then just clicks in the browser instead of re-pasting
  the queue prompt each time. Its own plan is being drafted separately.
- **(high) Share a map.** The output is a self-contained HTML *file*, which is hard
  to hand to a teammate. Add a way to share a review by link (host the assembled
  map, or lean on the Claude artifact path). Needed before whydiff is useful to a
  team rather than one reviewer.
- **(high) Notes on the map (`ask` → a visible annotation).** We already persist
  every anchored remark in the journal — that *is* a notes substrate. The missing
  half is rendering: mark blocks/nodes/files that carry discussion, show the remarks
  back on the map, and allow a bare note (not only a question or an instruction).
  Mostly a viewer feature over data we already store.
- Land the Codex integration spike (step 4 above), even rough, to test the split.
- Re-shoot the remaining screenshots (Ops & risks, Options) at current version and
  finish the README refresh.
- A short demo (gif or a hosted sample map) on the README so the tool is legible
  before install.

## Presentation / README (high, cheap wins)

The README leads with *how* before *why*; plannotator's does the reverse and reads
better on first contact. Close that gap:

- A hero: one-line thesis + one screenshot of a map + a plain
  "runs locally · self-contained · explains the change" line.
- A short privacy/local callout near the top (the three lines from `SECURITY.md`) —
  turn "nothing leaves your machine" from a buried fact into a visible advantage.
- A "How it works" diagram instead of / alongside the prose Pipeline list — we're a
  diagramming tool; explaining ourselves in text is the wrong look.

## Later

- Standalone assembler entry point / CLI, so `review-map.json → map.html` runs
  without a host at all (useful for CI and for third-party generators).
- Bigger-map ergonomics beyond what's shipped (search across nodes, deep links
  into a specific block/file).
- More host integrations once the Codex one has paid for the abstraction.
- **A desktop app** — a host over the core: pick a project (local or a GitHub URL),
  browse its commits/PRs, run whydiff on any of them, and keep a saved, searchable
  index of analyses, all in one window on macOS/Linux/Windows. Reuses `serve.mjs` as
  the viewer; its precondition is the standalone runner above. Full plan, stack
  decision (Electron for the MVP), and MVP sequence in
  [`docs/desktop-app.md`](docs/desktop-app.md).
- Small ops polish: a documented "serving over SSH" note + a `--no-open` mode
  (serve assumes it can open a local browser), and a documented way to clear
  `<repo>/.whydiff/` (our only on-disk state — the closest thing we have to
  plannotator's `uninstall --purge`).

## Ideas (unfiled)

Kept here so they aren't lost; each still has to earn its place under the scope in
[CONTRIBUTING.md](CONTRIBUTING.md) (a local, self-contained review map — not a bug
finder, not a PR bot).

- **(low) Review the *plan*, not only the diff.** plannotator intercepts an agent's
  plan before it writes code; our "explain + structure" approach could produce a
  map of a plan the same way. Interesting, not urgent.
- **(low) Unified installer with agent autodetect.** plannotator's `curl | bash`
  auto-detects installed agents and wires each. If we grow past one host this is the
  shape to copy — but it folds into "one core, many hosts" above, so no separate
  push yet.
- **(low) A landing page.** Only if the project grows; premature for a personal repo.
- Posting a map to a PR from CI. Tempting, but pulls toward "PR bot" — needs a
  scope answer before it's real work.
- Remembering a project's own conventions across runs to sharpen the standards
  pass.
- Locale coverage in the viewer beyond `en`/`ru`.
