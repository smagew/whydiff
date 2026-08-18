// Renderer logic (app/src/renderer/logic.mjs) — the pure, DOM-free functions behind the
// project list and project view: analysis labels, the generation stage model, and the
// review-activity pills. No React, no DOM — just data in, data out.
import { refLabel, OPTIONAL, AGENT_OF, STAGE_LABEL, plannedStages, statusOf, applyStageEvent, reviewPills } from '../src/renderer/logic.mjs'

const fail = (m) => { console.error(`FAIL: ${m}`); process.exit(1) }
const ok = (c, m) => { if (!c) fail(m) }
const eq = (a, b, m) => ok(JSON.stringify(a) === JSON.stringify(b), `${m}\n  got: ${JSON.stringify(a)}\n  want: ${JSON.stringify(b)}`)

// ── refLabel ─────────────────────────────────────────────────────────────────
eq(refLabel({ kind: 'working', ref: '' }), 'working tree', 'working tree label')
eq(refLabel({ kind: 'pr', ref: 'pr:42' }), 'PR #42', 'pr label')
eq(refLabel({ kind: 'commit', ref: 'abcdef1234567890' }), 'abcdef12', 'commit label (short hash)')
eq(refLabel({ kind: 'commit', ref: '' }), '', 'commit label tolerates empty ref')

// ── the generation stage model ───────────────────────────────────────────────
// A quick (core-only) run plans just the core stages, in order.
eq(plannedStages([]).map((s) => s.name), ['prepare', 'classifier', 'diagrammer', 'merge', 'assemble'], 'quick run stages')
// Picking optional sections inserts their passes (by AGENT_OF) between diagrammer and merge.
eq(plannedStages(['story', 'tests']).map((s) => s.name),
  ['prepare', 'classifier', 'diagrammer', 'summariser', 'tests-analyst', 'merge', 'assemble'], 'custom run stages')
ok(OPTIONAL.every((o) => AGENT_OF[o.id] === o.agent && STAGE_LABEL[o.agent]), 'every optional pass maps to an agent with a stage label')

// statusOf: pending until a start arrives, running until finished catches up, then done.
eq(statusOf({ started: 0, finished: 0 }), 'pending', 'pending before any start')
eq(statusOf({ started: 2, finished: 1 }), 'running', 'running while a start is outstanding (sharded pass)')
eq(statusOf({ started: 2, finished: 2 }), 'done', 'done when finished catches up to started')

// applyStageEvent folds @stage markers immutably; an unknown stage is appended.
let stages = plannedStages(['story'])
stages = applyStageEvent(stages, { stage: 'classifier', status: 'start' })
eq(statusOf(stages.find((s) => s.name === 'classifier')), 'running', 'a start marks the stage running')
stages = applyStageEvent(stages, { stage: 'classifier', status: 'done' })
eq(statusOf(stages.find((s) => s.name === 'classifier')), 'done', 'a matching done marks the stage done')
const before = JSON.stringify(stages)
const grown = applyStageEvent(stages, { stage: 'mystery', status: 'start' })
ok(JSON.stringify(stages) === before, 'applyStageEvent does not mutate its input')
ok(grown.find((s) => s.name === 'mystery'), 'an unknown stage is appended, not dropped')

// ── review pills ─────────────────────────────────────────────────────────────
eq(reviewPills(null), [], 'no counts → no pills')
eq(reviewPills({ discussions: 0, notes: 0, blocking: 0 }), [], 'all-zero → no pills')
eq(reviewPills({ discussions: 2, notes: 3, blocking: 0 }),
  [{ kind: 'discussions', n: 2, attn: false }, { kind: 'notes', n: 3, attn: false }], 'both pills, nothing blocking')
eq(reviewPills({ discussions: 1, notes: 0, blocking: 1 }),
  [{ kind: 'discussions', n: 1, attn: true }], 'blocking flags the discussions pill, notes pill omitted at 0')
eq(reviewPills({ discussions: 0, notes: 5, blocking: 0 }),
  [{ kind: 'notes', n: 5, attn: false }], 'notes only')

console.log('OK: renderer logic (refLabel; stage model plans/statuses/folds @stage immutably; review pills reflect counts + blocking)')
