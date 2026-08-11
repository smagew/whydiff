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

## Near-term

- Land the Codex integration spike (step 4 above), even rough, to test the split.
- Re-shoot the remaining screenshots (Ops & risks, Options) at current version and
  finish the README refresh.
- A short demo (gif or a hosted sample map) on the README so the tool is legible
  before install.

## Later

- Standalone assembler entry point / CLI, so `review-map.json → map.html` runs
  without a host at all (useful for CI and for third-party generators).
- Bigger-map ergonomics beyond what's shipped (search across nodes, deep links
  into a specific block/file).
- More host integrations once the Codex one has paid for the abstraction.

## Ideas (unfiled)

Kept here so they aren't lost; each still has to earn its place under the scope in
[CONTRIBUTING.md](CONTRIBUTING.md) (a local, self-contained review map — not a bug
finder, not a PR bot).

- Posting a map to a PR from CI. Tempting, but pulls toward "PR bot" — needs a
  scope answer before it's real work.
- Remembering a project's own conventions across runs to sharpen the standards
  pass.
- Locale coverage in the viewer beyond `en`/`ru`.
