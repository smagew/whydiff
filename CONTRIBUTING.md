# Contributing to whydiff

Thanks for looking. whydiff is a focused tool — a diff/PR **change map** for
reviewing LLM-written code — and staying focused is the point. This keeps
contributions easy to land.

## Before you build

Open an issue first for anything more than a small fix, and say two things
plainly:

- **What is the problem?** The situation you hit, not just the fix you have in mind.
- **How does this solve it?** And why it belongs in whydiff.

Whether a change fits comes down to: does it help most reviewers, stay within
scope (a local, self-contained review map — not a bug finder, not a PR bot), and
carry its own weight in maintenance? For open-ended questions or ideas, use
Discussions rather than an issue.

## Making the change

1. Branch from `main`, named by intent: `feat/…`, `fix/…`, `chore/…`.
2. Make it work, and keep it inside the conventions in [`CLAUDE.md`](CLAUDE.md) —
   especially the design-system rules the tests enforce.
3. `make check` must pass (contract validation, the version guard, and the unit +
   Playwright suites). Add or update tests when you change behaviour.
4. Add a `CHANGELOG.md` entry and, if your change ships (touches `templates/`,
   `agents/`, `skills/`, `schema/`, `hooks/`, `scripts/`), bump the version in the
   same PR with `make bump BUMP=<patch|minor|major>`. The `version-guard` check
   enforces this — a shipped change with no bump reaches no installed user.
5. Update the README or docs if the change is user-facing.

## Pull requests

One topic per PR, squash-merged. In the description, answer the same two questions
(problem / solution). CI runs the tests and the version guard; both must be green.
Merging a version bump to `main` tags and releases it automatically — see
[`RELEASING.md`](RELEASING.md).

## Language

All source, comments, docs and prompts are **English**. The viewer ships an `en`/`ru`
interface locale; that is the only place other languages belong.
