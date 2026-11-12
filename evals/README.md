# Analysis evals

`npm test` proves the viewer and the scripts work. It cannot tell whether the
**analysis** is right: whether the classifier grouped files by their real cause,
whether ops lists what a deploy actually needs, whether the map warns about the
defect a reviewer must not miss. These evals do. Run them after any change to
`agents/*.md` or `skills/whydiff/SKILL.md`, and compare against the last score.

```bash
make eval                         # all cases, 1 run each
make eval CASES="quick" RUNS=3    # one case, 3 runs (scores vary run to run)
node evals/run.mjs synthetic --no-judge --min 1
```

**This costs money.** Each run is a full `/whydiff` pipeline on your Claude
credential (~3 min). It is on demand only. Never add it to `make check` or CI.

## A case

`evals/<case>/expect.json`. The case name is a fixture name from
`tests/fixtures/fixtures.json`. It states what a correct map of that diff must
say, as **meaning, not shape**:

- the files the diff really touches (the map covers exactly these);
- which files belong together and which belong apart (`sameGroup`, `splitGroups`, `roleIn`);
- what ops must list, or must leave empty (`env`, `migrations`);
- which diagram kinds the diff earns, and the most it may have (`diagrams`);
- facts the prose must state (`mentions`) or must not claim (`absent`);
- `judge`: yes/no questions for a small model (haiku). Use these for facts a regex can't pin down.

The field reference is at the top of `_lib/grade.mjs`.

## Scoring

1. **Deterministic** (`_lib/grade.mjs`): this is the score, `passed/total`. On
   every case it also checks that the map references no invented path and that
   every edge says why.
2. **Judge** (haiku, advisory): the `judge` questions, plus "does the prose claim
   anything the diff contradicts". It is reported next to the score and never
   mixed into it.

`tests/eval-grade.mjs` (in `npm test`) keeps the grader honest. A known-good
synthetic map must score 1.0, and each deliberately broken copy (one group for
everything, a missing env var, an invented path, a vanished er-diff, …) must
fail the check that guards that mistake.

Results land in `evals/results/<timestamp>/<case>-<run>/`, which is git-ignored.
Each holds `review-map.json`, `grade.txt` and the run's `timing-report.md`.

## Why not `claude plugin eval`

It was the first choice, but it has no script grader. Its graders read the
agent's last message, the trace, or a produced file through regex or an LLM, and
cannot run code against the output. The checks here need code: group
membership, set equality on ops, path existence. The headless runner
(`scripts/run.mjs`) already drives the real pipeline, so the evals reuse it.
