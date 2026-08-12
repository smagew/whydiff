# ADR: Claude Agent SDK for the `serve --work` worker — spike result

Status: **rejected** (2026-08-12). Resolves the open spike flagged in
[`feedback-loop-hardening.md`](feedback-loop-hardening.md). Decision is
documentation-based — the premise it turned on is settled by the official reference,
so no prototype was built (a prototype only earns its cost on an *adopt* path).

## Context

The `serve --work` worker runs an agent in a throwaway worktree and hands back a
patch. Today `run()` in `scripts/serve.mjs` shells out to the ambient `claude -p`
(`--output-format stream-json`), parses the event stream (~40 lines), and
reconstructs the patch with `git add -A` + `git diff --cached`.

The spike asked whether `@anthropic-ai/claude-agent-sdk` (TypeScript, first-party)
should replace that. The hypothesis — from an early web summary — was that the SDK
returns a **structured `gitDiff`** for file edits, which would remove our
reconstruction step and be the concrete reason to adopt.

## Findings (from the official TypeScript reference + headless docs)

1. **No structured diff. The premise was wrong.** The SDK streams file edits only as
   a `tool_use` block (`name`, `input`) and a text `tool_result`
   (`SDKToolResultMessage`, `content: [...]`). There is **no** `gitDiff` / `patch` /
   `structuredPatch` / `additions` / `deletions` field anywhere in the message union.
   The caller computes the diff from the filesystem — exactly what we already do.
   (`enableFileCheckpointing` exists, but it is for rewind/state restoration, not
   diff emission.)
2. **Everything else the SDK offers, `run()` already covers.** Streaming
   (`SDKPartialMessage` vs our `stream-json` parse), permissions (`canUseTool`
   callback / `allowedTools` / `disallowedTools` vs our `--allowedTools` /
   `--disallowedTools`), working directory (`cwd`), and cancellation
   (`abortController` / `API_TIMEOUT_MS` vs our `SIGKILL` timeout). No capability gap.
3. **Adopting has real cost.** It adds `@anthropic-ai/claude-agent-sdk` plus a
   platform-specific binary (optional dep, e.g. `@anthropic-ai/claude-agent-sdk-darwin-arm64`)
   to a plugin that currently ships only `mermaid` and otherwise uses whatever
   `claude` the user already runs. Auth is also a mismatch in spirit: the plugin runs
   inside the user's Claude Code on their subscription login; the SDK/`--bare` path
   leans on `ANTHROPIC_API_KEY`.

## Decision

**Do not adopt the SDK.** Keep the worker on the ambient `claude -p` + a
git-reconstructed patch. It is dependency-free, host-aligned (uses the user's own
`claude` and auth), and already covers streaming, permissions, `cwd`, and timeout.
The one thing the SDK was going to buy us — a structured diff — does not exist, so
adoption would add a dependency and a platform binary for no functional gain.

## Adjacent note — `--bare` (considered, not adopted)

The docs say `--bare` skips auto-discovery of hooks, skills, plugins, MCP, auto
memory, and `CLAUDE.md`, is recommended for scripted/SDK calls, and will become the
`-p` default. For our worker that would mean faster, more deterministic runs that
don't inherit the user's unrelated project config. **But** bare mode authenticates
via `ANTHROPIC_API_KEY`, not the subscription login the plugin relies on, so turning
it on would break subscription users. Not adopted now; revisit only if bare gains
subscription auth, or expose it as an opt-in for API-key setups.

## Revisit if

- the SDK starts emitting structured diffs (the reconstruction would then be worth
  dropping), or
- we need one worker across multiple hosts and a single SDK is simpler than several
  per-host CLIs — though per the "one core, many hosts" direction the worker is
  host glue anyway, so each host adapter can keep its own.
