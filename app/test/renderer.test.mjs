// Renderer logic (app/src/renderer/logic.mjs) — the pure, DOM-free functions behind the
// project list and project view: analysis labels, the generation stage model, and the
// review-activity pills. No React, no DOM — just data in, data out.
import { refLabel, OPTIONAL, AGENT_OF, STAGE_LABEL, plannedStages, statusOf, applyStageEvent, reviewPills, branchOptions, defaultCompare, filterCommits } from '../src/renderer/logic.mjs'

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

// ── branch picker ────────────────────────────────────────────────────────────
// The checked-out branch comes first (it is what the working tree belongs to), then the
// other local branches, then remote-only ones; nothing is listed twice.
{
  const opts = branchOptions({ current: 'feat/x', local: ['main', 'feat/x'], remote: ['origin/main', 'origin/release'] })
  eq(opts.map((o) => o.value), ['feat/x', 'main', 'origin/main', 'origin/release'], 'current first, then local, then remote')
  eq(opts[0].group, 'Current', 'the checked-out branch is grouped as current')
  eq(opts.filter((o) => o.value === 'feat/x').length, 1, 'the current branch is not repeated under Local')
  eq(branchOptions(undefined), [], 'no branch data → no options, not a crash')
  eq(branchOptions({ current: null, local: ['b', 'a'] }).map((o) => o.value), ['a', 'b'], 'detached HEAD still lists the locals, sorted')
}

// ── commit filter ────────────────────────────────────────────────────────────
{
  const commits = [
    { hash: 'aa11bb22cc', short: 'aa11bb2', subject: 'fix(viewer): stray marks', author: 'Ann' },
    { hash: 'dd33ee44ff', short: 'dd33ee4', subject: 'docs: release notes', author: 'Bo' },
  ]
  eq(filterCommits(commits, '').length, 2, 'an empty query keeps everything')
  eq(filterCommits(commits, 'viewer').map((c) => c.short), ['aa11bb2'], 'matches the subject')
  eq(filterCommits(commits, 'BO').map((c) => c.short), ['dd33ee4'], 'matches the author, case-insensitively')
  eq(filterCommits(commits, 'dd33').map((c) => c.short), ['dd33ee4'], 'matches a hash prefix')
  eq(filterCommits(commits, 'ee44').length, 0, 'a hash MIDDLE is not a match — prefixes are what people type')
  eq(filterCommits(null, 'x'), [], 'no commits loaded → no matches, not a crash')
}

// ── compare defaults ─────────────────────────────────────────────────────────
// The pair must never start as "this branch vs itself", which compares nothing.
{
  const branches = { current: 'feat/x', local: ['main', 'feat/x'], remote: ['origin/release'] }
  eq(defaultCompare(branches, 'feat/x'), { base: 'main', head: 'feat/x' }, 'mainline as base, the browsed branch as head')
  eq(defaultCompare(branches, 'main').base !== 'main', true, 'browsing main picks a different base rather than main…main')
  eq(defaultCompare({ local: ['trunk'], remote: [] }, 'trunk'), { base: 'trunk', head: 'trunk' },
    'a one-branch repo has nothing else to offer — the user edits it')
  eq(defaultCompare(undefined, ''), { base: 'HEAD', head: 'HEAD' }, 'no branch data → no crash')
}
