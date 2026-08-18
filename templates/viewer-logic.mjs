// Pure, DOM-free helpers for the viewer. Authored as an ES module so it can be unit
// tested in node (tests/viewer-logic.mjs); assemble.mjs strips the `export` keywords and
// inlines the body into the viewer's single classic <script>, so the shipped map stays
// self-contained. Keep this file DOM-free and dependency-free — anything that touches the
// DOM or viewer state belongs in the template. This is the seam that lets viewer logic
// grow under unit coverage instead of only end-to-end.

// A URL/anchor-safe slug for a label (diagram node/region anchor keys, etc.).
export const nslug = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')

// The approximate progress (0..1) of an on-demand section generation. There is no exact
// percentage — one open-ended agent does the work — so it eases over two real signals:
// elapsed time while the pass reads, then the read→write transition (the server sends a
// `writing` phase on the pass's first output). Capped strictly below 1 until `ended`, so
// it never fabricates completion; the caller keeps it monotonic and renders the width.
export function genProgressEstimate({ elapsedS = 0, phase = 'reading', writeElapsedS = 0, ended = false } = {}) {
  if (ended) return 1
  if (phase === 'writing') return Math.min(0.97, 0.76 + 0.21 * (1 - Math.exp(-writeElapsedS / 9)))
  return Math.min(0.70, 0.04 + 0.66 * (1 - Math.exp(-elapsedS / 20)))
}
