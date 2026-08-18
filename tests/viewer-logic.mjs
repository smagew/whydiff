#!/usr/bin/env node
// Unit tests for templates/viewer-logic.mjs — the viewer's pure, DOM-free helpers,
// extracted from the single big script so they can be covered here instead of only via
// the browser e2e. assemble.mjs inlines this same module into the viewer (exports
// stripped), so what we test is what ships.

import { nslug, genProgressEstimate } from '../templates/viewer-logic.mjs'

const fail = (m) => { console.error(`FAIL: ${m}`); process.exit(1) }
const ok = (c, m) => { if (!c) fail(m) }
const eq = (a, b, m) => ok(a === b, `${m}\n  got: ${JSON.stringify(a)}\n  want: ${JSON.stringify(b)}`)

// ── nslug ──────────────────────────────────────────────────────────────────
eq(nslug('Request to /api/*'), 'request-to-api', 'slug lowercases and folds non-alnum runs to single dashes')
eq(nslug('  Trim — Me!  '), 'trim-me', 'slug trims leading/trailing dashes')
eq(nslug('A_b.C'), 'a-b-c', 'slug folds punctuation')
eq(nslug(''), '', 'slug of empty is empty')
eq(nslug(123), '123', 'slug tolerates a non-string')

// ── genProgressEstimate ──────────────────────────────────────────────────────
const G = genProgressEstimate
// Defaults are safe and start low.
ok(G() >= 0.04 && G() < 0.1, `default estimate starts low, got ${G()}`)
// Reading: strictly increases with elapsed, and is capped below 0.70 (leaves room for writing).
const r0 = G({ elapsedS: 0 }), r10 = G({ elapsedS: 10 }), r60 = G({ elapsedS: 60 }), rHuge = G({ elapsedS: 100000 })
ok(r10 > r0 && r60 > r10, `reading estimate must increase with time (${r0} → ${r10} → ${r60})`)
ok(rHuge < 0.70 + 1e-9 && rHuge > 0.65, `reading estimate must plateau just under 0.70, got ${rHuge}`)
// Writing: jumps above where reading caps, increases with write time, capped below 0.97.
const w0 = G({ phase: 'writing', writeElapsedS: 0 }), w10 = G({ phase: 'writing', writeElapsedS: 10 }), wHuge = G({ phase: 'writing', writeElapsedS: 100000 })
ok(w0 >= 0.76 && w0 > rHuge, `writing estimate must start above the reading cap, got ${w0}`)
ok(w10 > w0, `writing estimate must increase with write time (${w0} → ${w10})`)
ok(wHuge < 0.97 + 1e-9 && wHuge > 0.95, `writing estimate must plateau just under 0.97, got ${wHuge}`)
// The invariant that matters: it NEVER reports 100% until the caller says it ended.
for (const s of [{ elapsedS: 1e9 }, { phase: 'writing', writeElapsedS: 1e9 }]) ok(G(s) < 1, `estimate must never reach 1 before ended (${JSON.stringify(s)} → ${G(s)})`)
eq(G({ ended: true }), 1, 'ended completes to exactly 1')
eq(G({ phase: 'writing', writeElapsedS: 3, ended: true }), 1, 'ended overrides the phase estimate')

console.log('OK: viewer-logic (nslug folds/trims/tolerates non-strings; genProgressEstimate rises while reading<0.70, jumps and rises while writing<0.97, never hits 1 before ended)')
