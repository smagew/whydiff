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

// Make a map that drifted from the schema safe to render, in place, once at load. The
// generator now refuses or normalises such maps (merge.mjs), but a map saved by an older
// run still opens here, and every template literal that interpolates a missing field
// prints "undefined", an object prints "[object Object]". Seen for real: groups with
// only { id, files } (every Files heading read "undefined") and ops.migrations as
// { name, note } objects. A nameless group falls back to its id; a missing role, tag or
// why to empty; an object list entry to its string fields joined.
export function normalizeMap(rm) {
  if (!rm || typeof rm !== 'object') return rm
  const str = (v) => typeof v === 'string' ? v : v == null ? '' : String(v)
  const line = (e) => e && typeof e === 'object' && !Array.isArray(e)
    ? Object.values(e).filter(v => typeof v === 'string' && v.trim()).join(' — ')
    : str(e)
  for (const g of Array.isArray(rm.groups) ? rm.groups : []) {
    if (!g || typeof g !== 'object') continue
    g.id = str(g.id)
    g.name = str(g.name).trim() || g.id
    g.role = str(g.role)
    g.why = str(g.why)
    if (g.tag != null) g.tag = str(g.tag)
    if (!Array.isArray(g.files)) g.files = []
  }
  if (rm.ops && typeof rm.ops === 'object') {
    for (const k of ['migrations', 'deploy']) if (Array.isArray(rm.ops[k])) rm.ops[k] = rm.ops[k].map(line)
  }
  return rm
}
