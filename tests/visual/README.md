# Viewer screenshot baselines

`viewer.spec.mjs` screenshots the reference example (`examples/rate-limit`) in every
tab × the dark (`graphite`) and light (`slate`) palettes × a wide (1440) and a narrow
(900) window, and compares each against a committed PNG. The behaviour suites prove
things *work*. This one proves they *look* right: no clipped diagram, no overlapping
strip, no shifted layout.

It runs in `npm test` (`npx playwright test -c tests/visual`).

## When it fails

Open the diff Playwright wrote under `test-results/` (expected / actual / diff).
- **An unintended change:** fix the code, not the baseline.
- **A deliberate visual change:** run `make screenshots-update`, then **look at every
  changed PNG** before committing (`git diff --stat tests/visual/__screenshots__`).
  A baseline recorded over a bug locks the bug in. That is how the clipped diagrams
  fixed in 0.47.1 were found: by looking at the first baselines.

## Platforms

Fonts differ per OS, so each baseline exists per platform: `-darwin` (recorded on a
Mac) and `-linux` (recorded in `mcr.microsoft.com/playwright:v<version>-noble`).
CI's `validate` job runs in that same image, so its pixels match. `make
screenshots-update` records both; it needs docker. Keep the image tag equal to
`@playwright/test`'s version. A test fails when they drift.

## What is held still

- Animations off, caret hidden, reduced motion, a fixed locale and timezone.
- `capture.css`: the fixed footer strip is laid out at the end of the page, because a
  full-page capture would stamp it across the middle. The plugin version is hidden,
  because every release changes it.

## Tolerance

Same-platform renders are byte-identical run to run, so the budget is an absolute
`maxDiffPixels: 100` — room for a stray anti-aliased pixel, small enough to catch a
one-word change. It used to be a ratio (0.2% of the page, ~3,900px on a full-page
capture), and a real change — muting the directory of every path in the Files
navigator, ~2,700px — passed under it. For the same reason `make screenshots-update`
re-records with `--update-snapshots=all`: the default mode rewrites only baselines
that fail, so a change inside the budget would never reach the committed PNGs.
