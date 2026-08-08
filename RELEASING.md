# Releasing whydiff

whydiff ships as a Claude Code plugin from this repo's marketplace. The plugin
cache is keyed by **version**: if `.claude-plugin/plugin.json` doesn't change,
installed users keep the old assembled template no matter what merged to `main`.
So the version bump *is* the release — forget it and the change reaches nobody.

## Branching

- **`main` is the only long-lived branch.** It is always releasable and
  protected: changes land through a PR with a green `version-guard` check.
- **One topic → one short-lived branch → one PR → delete.** Name by intent,
  not by version: `feat/big-map-scaling`, `fix/edge-labels`, `docs/…`,
  `chore/release-X.Y.Z`. Squash-merge so each feature is one clean commit.
- Never reuse a long-lived `assets-*`-style branch across many PRs — it drifts
  from `main` and is how a bump gets lost.

## While you work

Add a bullet under `## [Unreleased]` in `CHANGELOG.md` in the same PR as the
change. `make release` turns that section into the dated release notes.

## Versioning (SemVer)

- **patch** — fixes; the map output doesn't change in meaning.
- **minor** — new viewer/analysis features (e.g. 0.11.0, big-map scaling).
- **major** — breaking: a `review-map` schema change old maps can't read, or a
  CLI break.

## Cut a release

From an in-sync `main`, with the smagew git identity:

```bash
make release BUMP=minor HEADLINE="readable big maps"
```

This runs `make check`, scans for private ("hydron") references, bumps the
version in all four places (`plugin.json`, `package.json`, `marketplace.json`,
`CHANGELOG.md`), and opens a `chore/release-X.Y.Z` PR. Merge it (squash), then
tag:

```bash
git tag vX.Y.Z && git push origin vX.Y.Z
```

## Verify it landed

```bash
claude plugin update whydiff
ls ~/.claude/plugins/cache/whydiff/whydiff/   # a fresh X.Y.Z/ dir appears
```

## The guard

`scripts/check-version.mjs` enforces two things, so a missed bump can't merge:

1. the version string is identical across all four files;
2. if any **shipped** path changed vs `main`
   (`templates/ agents/ skills/ schema/ hooks/ scripts/`, minus the release
   tooling itself), `plugin.json`'s version must differ from `main`'s.

It runs in `make check`, in the `.githooks/pre-push` hook (`make hooks` to
install; `git push --no-verify` to bypass in a pinch), and as the required CI
check on PRs into `main`.
