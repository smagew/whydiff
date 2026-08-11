# Security Policy

## Reporting a vulnerability

Please report security issues **privately**, not in a public issue:

- Open a [GitHub security advisory](https://github.com/smagew/whydiff/security/advisories/new), or
- email the maintainer (see the profile at [github.com/smagew](https://github.com/smagew)).

Include what you found, how to reproduce it, and the impact you see. You'll get an
acknowledgement, and a fix or an explanation. Please give a reasonable window before
disclosing publicly.

Supported: the **latest released version**. Fixes land there; update the installed
plugin with `/plugin marketplace update whydiff`.

## What whydiff does, security-wise

whydiff is a local Claude Code plugin. Understanding its boundaries helps you judge
a report:

- **It runs on your machine.** The diff, the map, and the served copy never leave
  it except through your own Claude session — there is no whydiff server or vendor
  endpoint, and the plugin holds no credentials of its own.
- **The generation passes are read-only.** The `PreToolUse` hook
  (`scripts/approve.mjs`) auto-approves **only** the pipeline's own operations —
  its bundled scripts, read-only `git` (`diff`/`log`/`show`/`ls-files`/`status`),
  writes confined to `.whydiff/`, and opening the built map. Command chaining or
  substitution (`;`, `&`, `|`, `` ` ``, `$(`) is never auto-approved; everything
  else goes through the normal permission prompt.
- **The served map is read-only and token-gated.** `serve.mjs` answers questions
  and plans changes via `claude -p` under a read-only tool allowlist (`Edit`,
  `Write`, `Bash`, `Task`, `Agent` are denied). Its `/api/*` routes require a token
  injected only into the served page. It never edits the repo — `--work` is a
  separate, explicit opt-in that applies an agreed patch in a throwaway worktree,
  never in the tree under review.
- **The map is self-contained HTML.** It inlines its assets and needs no network to
  view. Treat a map's *contents* as you would any generated document — it can quote
  your diff and code.

Good things to look at: a way to make the approve hook auto-approve something
outside the pipeline, a path that lets the served UI write to the repo without
`--work`, a token leak from the served page, or map content that could execute in a
viewer's browser.
