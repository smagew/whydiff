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

## The development loop (no push required)

Installing from a marketplace copies the plugin into `~/.claude/plugins/cache/…`, so a
*copy* is what runs. To test the working tree instead, load it from disk with
`--plugin-dir`, which overrides an installed copy of the same plugin for that session:

```bash
make check              # contract + viewer + manifest + version checks, no LLM (~20s)
make coverage           # the suite under c8 + the scripts/ coverage floor
make preview            # assemble the reference example and open it
make fixtures           # list the fixture projects
make run-synthetic      # build a fixture and open Claude there with THIS working tree
make serve-synthetic    # serve the map that run produced, with the live UI
make map-synthetic      # open the HTML file instead
make report-synthetic   # per-phase timing of the last run there
```

Inside that session: `/whydiff HEAD~1..HEAD`. Skill edits apply immediately; after
editing `agents/` or `hooks/`, run `/reload-plugins`.

Prerequisites: `npm install` (mermaid + highlight.js for the assembler) and
`npx playwright install chromium` (for `npm test`).

**Fixtures** (`tests/fixtures/fixtures.json`) are real diffs from open-source repos,
pinned by SHA and fetched with `--depth 2`, so the diff to analyse is always
`HEAD~1..HEAD`. Their recorded GitHub stats are cross-checked against our own
manifest, so a fixture doubles as a test of `manifest.mjs`:

| fixture | diff | what it exercises |
|---|---|---|
| `synthetic` | 10 files, TS/PHP/SQL/MD (generated locally, no network) | scope tags, language dots, `er-diff`, ops/migrations |
| `quick` | expressjs/express — 3 files | smallest end-to-end sanity run |
| `feature` | honojs/hono — 4 files | cause groups, story chain, tests tab |
| `migration` | zulip/zulip — 8 files, Django migration | schema diagram, cross-layer edges |
| `big` | mastodon/mastodon — 63 files, Rails migration | classifier sharding, blast radius |

They land in `.fixtures/` (gitignored); `make clean-fixtures` removes them. `migration`
and `big` pull ~150–200 MB each, because those repos are large even at depth 2.

## Where things live

```
skills/                      # /whydiff (the pipeline) and /whydiff-work (the queue)
agents/                      # the analysis passes: 2 core, 4 optional
scripts/                     # the deterministic layer: gather → merge → validate → assemble,
                             #   plus serve.mjs (the live map) and review.mjs (the journal)
templates/viewer.html        # the whole viewer in one file (+ viewer-logic.mjs, inlined at assemble)
schema/review-map.schema.json# the generator↔viewer contract — everything a map can carry
examples/rate-limit/         # a hand-authored reference map
tests/                       # unit + Playwright; `npm test` runs them all
app/                         # the desktop host (Electron) — see app/README.md
```

[`CLAUDE.md`](CLAUDE.md) describes each piece and the conventions the tests enforce;
[`.claude/rules/gotchas.md`](.claude/rules/gotchas.md) lists the surprises that have
cost real time in each area.

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
