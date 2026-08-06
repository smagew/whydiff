#!/usr/bin/env node
// Contract test for scripts/review.mjs — the review journal.
//
// What it pins down: an append-only log survives a torn line, refuses an event it
// cannot later read back, enforces the task state machine and typed acceptance,
// tolerates events from a newer whydiff, resolves rebind chains, and brings a
// pre-journal threads.json forward exactly once.

import { readFileSync, writeFileSync, appendFileSync, existsSync, mkdtempSync, mkdirSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  REVIEW_LOG, REVIEW_STATE, appendEvents, readLog, readReview, project,
  validateEvent, turns, migrateThreads, newId, mapFindings, coverage,
} from '../scripts/review.mjs'

const fail = (msg) => { console.error(`FAIL: ${msg}`); process.exit(1) }
const ok = (cond, msg) => { if (!cond) fail(msg) }
const fresh = () => { const d = mkdtempSync(join(tmpdir(), 'whydiff-review-')); mkdirSync(d, { recursive: true }); return d }
const throws = (fn, re, msg) => {
  try { fn() } catch (e) { if (!re.test(e.message)) fail(`${msg} — wrong error: ${e.message}`); return }
  fail(`${msg} — nothing thrown`)
}

const ANCHOR = { kind: 'story', key: 'story:3', label: 'customer: I get my money back', files: ['api/refunds.py'] }
const ACC = { type: 'story', key: 'story:3', becomes: 'delivered' }

// ── notes: ids, threads, answered-tracking ────────────────────────────────────
{
  const dir = fresh()
  const qid = newId('n')
  const { events, state } = appendEvents(dir, [
    { type: 'note.added', noteId: qid, by: 'reviewer', kind: 'question', anchor: ANCHOR, text: 'Why is this broken?' },
    { type: 'note.added', by: 'claude', kind: 'answer', anchor: ANCHOR, text: 'Settlement never runs.', steps: ['read api/refunds.py'], replyTo: qid },
  ])
  ok(events.length === 2, 'two notes were not appended')
  ok(events.every(e => /^ev_[0-9a-f]{6}$/.test(e.id)), `event ids are not opaque tokens: ${events.map(e => e.id)}`)
  ok(events.every(e => e.at), 'events were not timestamped')
  ok(state.notes[0].answered === true, 'the answer did not close its question')
  ok(state.counts.unanswered === 0, `unanswered miscounted: ${state.counts.unanswered}`)
  ok(state.threads['story:3'].noteIds.length === 2, 'the thread did not collect both notes')

  // The projection file is written beside the log, and the log is the source.
  ok(existsSync(join(dir, REVIEW_LOG)), 'no journal file')
  const written = JSON.parse(readFileSync(join(dir, REVIEW_STATE), 'utf8'))
  ok(written.counts.notes === 2, 'projection file does not match the log')

  // A second question on the same anchor, unanswered, is what blocks a merge.
  const after = appendEvents(dir, { type: 'note.added', kind: 'question', anchor: ANCHOR, text: 'And the migration?' }).state
  ok(after.counts.unanswered === 1 && after.counts.blocking === 1, `an unanswered question must block: ${JSON.stringify(after.counts)}`)
  ok(turns(after).length === 1, 'an unanswered question leaked into the panel shape')
  const [turn] = turns(after)
  ok(turn.kind === 'ask' && turn.anchorKey === 'story:3' && turn.request && turn.response && turn.steps.length === 1,
    `turn shape lost a field: ${JSON.stringify(turn)}`)
  ok(turn.plan === null && turn.task === null, 'a plain question came back with a plan or a task')
}

// ── refusals: an event that could not be read back is never written ───────────
{
  const dir = fresh()
  throws(() => appendEvents(dir, { type: 'note.pondered', kind: 'question', anchor: ANCHOR, text: 'x' }),
    /unknown event type/, 'an unknown event type was accepted')
  throws(() => appendEvents(dir, { type: 'note.added', kind: 'question', anchor: { kind: 'story' }, text: 'x' }),
    /anchor has no key/, 'an anchor without a key was accepted')
  throws(() => appendEvents(dir, { type: 'note.added', kind: 'question', anchor: ANCHOR, text: '   ' }),
    /empty question/, 'an empty question was accepted')
  throws(() => appendEvents(dir, { type: 'note.added', kind: 'question', anchor: ANCHOR, text: 'x', by: 'nobody' }),
    /author must be/, 'an unknown author was accepted')
  ok(!existsSync(join(dir, REVIEW_LOG)), 'a rejected batch still created the journal')

  // A batch is all-or-nothing: the valid first event must not survive the invalid second.
  throws(() => appendEvents(dir, [
    { type: 'note.added', kind: 'question', anchor: ANCHOR, text: 'fine' },
    { type: 'task.state', taskId: 't_nope', state: 'open' },
  ]), /unknown taskId/, 'a batch with a bad event was accepted')
  ok(!existsSync(join(dir, REVIEW_LOG)), 'a partially valid batch wrote the good half')
}

// ── proposals must descend from a finding and offer real variants ─────────────
{
  const dir = fresh()
  throws(() => appendEvents(dir, { type: 'note.added', by: 'claude', kind: 'proposal', anchor: ANCHOR, proposal: { variants: [{ kind: 'local', what: 'guard it' }] } }),
    /must cite the finding/, 'a proposal without a finding was accepted')
  throws(() => appendEvents(dir, { type: 'note.added', by: 'claude', kind: 'proposal', anchor: ANCHOR, proposal: { finding: 'story:3', variants: [] } }),
    /needs variants, or noFixNeeded/, 'an empty proposal was accepted')
  throws(() => appendEvents(dir, { type: 'note.added', by: 'claude', kind: 'proposal', anchor: ANCHOR, proposal: { finding: 'story:3', variants: [{ kind: 'cheap', what: 'x' }] } }),
    /variant 0 has no kind/, 'a variant with an invented kind was accepted')
  const { state } = appendEvents(dir, { type: 'note.added', by: 'claude', kind: 'proposal', anchor: ANCHOR, proposal: { finding: 'story:3', noFixNeeded: 'the path is unreachable in production' } })
  ok(state.notes[0].proposal.noFixNeeded, 'noFixNeeded is a valid answer and was dropped')
}

// ── proposals become turns, and coverage counts what has been decided ─────────
{
  const dir = fresh()
  const RM = {
    standards: [{ severity: 'warn', finding: 'the guard runs after the counter' }, { severity: 'ok', finding: 'naming matches' }],
    tests: { gaps: ['nothing covers the unshipped path', 'no test for the burst window'] },
    userStories: { stories: [{ status: 'broken', story: 'I get my money back' }, { status: 'delivered', story: 'I see an error' }] },
  }
  const found = mapFindings(RM)
  ok(found.map(f => f.key).join(',') === 'finding:0,gap:0,gap:1,story:0',
    `only the map's actual problems are findings: ${found.map(f => f.key).join(',')}`)

  let cov = coverage(RM, project([]))
  ok(cov.total === 4 && cov.decided === 0, `nothing is decided on an empty journal: ${JSON.stringify(cov)}`)

  const gap = { kind: 'gap', key: 'gap:0', label: 'nothing covers the unshipped path' }
  const variant = { kind: 'local', what: 'Guard the unshipped path.', cost: 'an hour', risk: 'none', blast: [], acceptance: { type: 'test', name: 'test_guard' } }
  throws(() => appendEvents(dir, { type: 'note.added', by: 'claude', kind: 'proposal', anchor: gap, text: 'p', proposal: { finding: 'gap:0', variants: [{ kind: 'local', what: 'guard it' }] } }),
    /variant 0: acceptance is required/, 'a variant with no criterion was accepted')

  const pid = newId('n')
  let state = appendEvents(dir, { type: 'note.added', noteId: pid, by: 'claude', kind: 'proposal', anchor: gap, text: 'The guard runs too late.', proposal: { finding: 'gap:0', variants: [variant] } }).state
  const [pt] = turns(state)
  ok(pt.kind === 'proposal' && pt.request === null, `a proposal is its own turn with no request: ${JSON.stringify(pt.kind)}`)
  ok(pt.proposal.variants[0].kind === 'local', 'the variants did not survive onto the turn')
  ok(pt.task === null, 'a proposal opened a task by itself')
  ok(coverage(RM, state).decided === 0, 'an offered option counts as a decision, which it is not')

  // Choosing one is the decision; the task keeps the finding it came from.
  state = appendEvents(dir, { type: 'task.opened', taskId: 't_p1', anchor: gap, threadKey: 'gap:0', origin: 'proposal', finding: 'gap:0', from: pid, spec: variant.what, acceptance: variant.acceptance, state: 'open' }).state
  ok(turns(state)[0].task?.taskId === 't_p1', 'the chosen option did not attach to its proposal')
  cov = coverage(RM, state)
  ok(cov.decided === 1 && !cov.open.some(f => f.key === 'gap:0'), `a chosen option settles its finding: ${JSON.stringify(cov.open.map(f => f.key))}`)

  // "No fix needed" is also a decision — that is the point of storing it.
  const dir2 = fresh()
  const s2 = appendEvents(dir2, { type: 'note.added', by: 'claude', kind: 'proposal', anchor: gap, text: 'nothing to do', proposal: { finding: 'gap:0', noFixNeeded: 'the path is unreachable in production' } }).state
  ok(coverage(RM, s2).decided === 1, 'an explicit "no fix needed" left the finding undecided')
  ok(turns(s2)[0].proposal.noFixNeeded, 'noFixNeeded did not reach the turn')
}

// ── instruct: instruction → plan → the reviewer's decision ───────────────────
{
  const dir = fresh()
  const iid = newId('n')
  const plan = { spec: 'Settle refunds for unshipped orders.', acceptance: { type: 'test', name: 'test_settles' }, files: ['api/refunds.py'], risks: [], questions: [] }
  throws(() => appendEvents(dir, { type: 'note.added', by: 'claude', kind: 'report', anchor: ANCHOR, text: 'p', plan: { spec: 'x' } }),
    /plan: acceptance is required/, 'a plan with no acceptance was accepted')
  throws(() => appendEvents(dir, { type: 'note.added', by: 'claude', kind: 'report', anchor: ANCHOR, text: 'p', plan: { acceptance: plan.acceptance } }),
    /a plan needs a spec/, 'a plan with no spec was accepted')

  let state = appendEvents(dir, [
    { type: 'note.added', noteId: iid, by: 'reviewer', kind: 'instruction', anchor: ANCHOR, text: 'Make refunds settle.' },
    { type: 'note.added', by: 'claude', kind: 'report', anchor: ANCHOR, text: 'I would guard the unshipped path.', plan, replyTo: iid },
  ]).state
  let [t] = turns(state)
  ok(t.kind === 'instruct', `an instruction did not pair into an instruct turn: ${t.kind}`)
  ok(t.plan.acceptance.name === 'test_settles', 'the plan was not carried onto the turn')
  ok(t.task === null && t.decision === null, 'an instruction opened a task before anyone agreed')
  ok(state.counts.blocking === 0, 'an unapproved plan blocks a merge, which it should not')

  // Agreeing opens the task, and the turn it came from now carries it.
  state = appendEvents(dir, { type: 'task.opened', taskId: 't_c1', anchor: ANCHOR, threadKey: ANCHOR.key, origin: 'reviewer', from: iid, spec: plan.spec, acceptance: plan.acceptance, state: 'open' }).state
  ;[t] = turns(state)
  ok(t.task?.taskId === 't_c1' && t.task.state === 'open', `the task did not attach to its turn: ${JSON.stringify(t.task)}`)
  ok(state.counts.blocking === 1, 'an agreed task does not block a merge, which it should')

  // Turning a plan down instead: recorded on the instruction, so it is not re-offered.
  const dir2 = fresh()
  const iid2 = newId('n')
  let s2 = appendEvents(dir2, [
    { type: 'note.added', noteId: iid2, by: 'reviewer', kind: 'instruction', anchor: ANCHOR, text: 'Rename the field.' },
    { type: 'note.added', by: 'claude', kind: 'report', anchor: ANCHOR, text: 'plan', plan, replyTo: iid2 },
    { type: 'note.added', by: 'reviewer', kind: 'decision', anchor: ANCHOR, text: 'Plan not taken up.', replyTo: iid2 },
  ]).state
  ok(turns(s2)[0].decision === 'Plan not taken up.', 'a turned-down plan left no decision on its turn')
  ok(turns(s2)[0].task === null && s2.counts.tasks === 0, 'declining a plan opened a task')
}

// ── tasks: acceptance, state machine, resolution, verification ────────────────
{
  const dir = fresh()
  const base = { type: 'task.opened', taskId: 't_a1', anchor: ANCHOR, origin: 'reviewer', spec: 'Settle refunds for unshipped orders.', state: 'open' }
  throws(() => appendEvents(dir, { ...base }), /acceptance is required/, 'a task without acceptance was accepted')
  throws(() => appendEvents(dir, { ...base, acceptance: { type: 'vibes', what: 'looks fine' } }), /unknown acceptance type/, 'an untyped acceptance was accepted')
  throws(() => appendEvents(dir, { ...base, acceptance: { type: 'test' } }), /needs a non-empty name/, 'a test acceptance without a test name was accepted')
  throws(() => appendEvents(dir, { ...base, acceptance: ACC, origin: 'proposal' }), /must keep the finding/, 'a proposal-born task lost its finding')
  throws(() => appendEvents(dir, { ...base, acceptance: ACC, state: 'done' }), /opens at proposed or open/, 'a task was opened straight into done')

  let { state } = appendEvents(dir, { ...base, acceptance: ACC })
  ok(state.tasks[0].state === 'open' && state.counts.blocking === 1, 'an open task must block a merge')

  throws(() => appendEvents(dir, { type: 'task.verified', taskId: 't_a1', evidence: 'trust me' }), /is open, not done/, 'a task was verified before it was done')
  throws(() => appendEvents(dir, { type: 'task.state', taskId: 't_a1', state: 'verified' }), /cannot go open → verified/, 'the state machine let open jump to verified')
  throws(() => appendEvents(dir, { type: 'task.state', taskId: 't_a1', state: 'declined' }), /declining needs a reason/, 'a task was declined without a reason')
  throws(() => appendEvents(dir, { type: 'task.resolved', taskId: 't_a1', files: ['api/refunds.py'] }), /missing patch/, 'a resolution with no patch was accepted')

  state = appendEvents(dir, { type: 'task.resolved', taskId: 't_a1', files: ['api/refunds.py'], patch: '.whydiff/tasks/t_a1.patch', followUpMapId: 'm_2' }).state
  ok(state.tasks[0].state === 'done', 'resolving did not reach done')
  ok(state.tasks[0].resolution.followUpMapId === 'm_2', 'the follow-up map was dropped')
  throws(() => appendEvents(dir, { type: 'task.verified', taskId: 't_a1', evidence: '  ' }), /without evidence/, 'verification without evidence was accepted')

  state = appendEvents(dir, { type: 'task.verified', taskId: 't_a1', evidence: 'test_refund_unshipped_order_settles passes' }).state
  ok(state.tasks[0].state === 'verified' && state.counts.blocking === 0, 'a verified task still blocks')
  throws(() => appendEvents(dir, { type: 'task.state', taskId: 't_a1', state: 'open' }), /cannot go verified → /, 'verified is not terminal')
  ok(state.tasks[0].history.length >= 3, `the task kept no history: ${JSON.stringify(state.tasks[0].history)}`)

  // A declined proposal is information: it stays, with its reason.
  const dir2 = fresh()
  let s2 = appendEvents(dir2, { type: 'task.opened', taskId: 't_b1', anchor: ANCHOR, origin: 'proposal', finding: 'story:3', spec: 'Rewrite settlement.', state: 'proposed', acceptance: ACC }).state
  ok(s2.counts.blocking === 0 && s2.counts.proposed === 1, 'a proposal must not block a merge on its own')
  s2 = appendEvents(dir2, { type: 'task.state', taskId: 't_b1', state: 'declined', reason: 'out of scope for this change' }).state
  ok(s2.tasks[0].declinedReason === 'out of scope for this change', 'the decline reason was dropped')
  ok(s2.counts.declined === 1 && s2.counts.blocking === 0, 'a declined task still counted')
}

// ── forward compatibility and a torn line ────────────────────────────────────
{
  const dir = fresh()
  appendEvents(dir, { type: 'note.added', kind: 'question', anchor: ANCHOR, text: 'first' })
  // An event kind only a newer whydiff knows, plus a line cut off mid-write.
  appendFileSync(join(dir, REVIEW_LOG), JSON.stringify({ id: 'ev_ffffff', at: '2026-08-06T00:00:00Z', by: 'claude', type: 'review.summarised', text: 'x' }) + '\n')
  appendFileSync(join(dir, REVIEW_LOG), '{"id":"ev_broke","type":"note.ad')
  const { state, skipped } = readReview(dir)
  ok(skipped === 1, `the torn line was not counted as skipped: ${skipped}`)
  ok(state.notes.length === 1, 'the torn line took a good note down with it')
  ok(state.unknown.length === 1 && state.unknown[0].type === 'review.summarised', 'an event from a newer whydiff was not preserved')
  // And appending still works after the torn line.
  const after = appendEvents(dir, { type: 'note.added', kind: 'question', anchor: ANCHOR, text: 'second' }).state
  ok(after.notes.length === 2, 'could not append after a torn line')
}

// ── rebinding: exact, quote, stale, and a chain ───────────────────────────────
{
  const sel = { kind: 'selection', key: 'selection:abc', quote: 'settlement only runs from the fulfilment path' }
  const events = [
    { type: 'note.added', id: 'ev_1', noteId: 'n_1', at: '2026-08-06T10:00:00Z', by: 'reviewer', kind: 'question', anchor: sel, text: 'q' },
    { type: 'note.added', id: 'ev_2', noteId: 'n_2', at: '2026-08-06T10:00:01Z', by: 'reviewer', kind: 'question', anchor: ANCHOR, text: 'q2' },
    { type: 'anchor.rebound', id: 'ev_3', at: '2026-08-06T11:00:00Z', by: 'claude', oldKey: 'selection:abc', newKey: 'selection:def', how: 'quote', mapId: 'm_2' },
    { type: 'anchor.rebound', id: 'ev_4', at: '2026-08-06T11:00:01Z', by: 'claude', oldKey: 'selection:def', newKey: 'selection:ghi', how: 'exact', mapId: 'm_3' },
    { type: 'anchor.rebound', id: 'ev_5', at: '2026-08-06T11:00:02Z', by: 'claude', oldKey: 'story:3', how: 'stale', mapId: 'm_3' },
  ]
  const state = project(events)
  const moved = state.notes.find(n => n.noteId === 'n_1')
  ok(moved.anchor.key === 'selection:ghi', `rebind chain not followed: ${moved.anchor.key}`)
  ok(moved.anchor.reboundFrom === 'selection:abc', 'a rebound anchor did not keep where it came from')
  const lost = state.notes.find(n => n.noteId === 'n_2')
  ok(lost.anchor.stale === true, 'a stale anchor was not marked')
  ok(lost.anchor.label === ANCHOR.label && lost.anchor.files?.length === 1,
    'a stale anchor must keep what it was attached to, not be emptied')

  // A rebind cycle must not hang the projection.
  const cyclic = project([
    ...events.slice(0, 2),
    { type: 'anchor.rebound', id: 'ev_6', at: '2026-08-06T12:00:00Z', by: 'claude', oldKey: 'selection:abc', newKey: 'story:3', how: 'exact' },
    { type: 'anchor.rebound', id: 'ev_7', at: '2026-08-06T12:00:01Z', by: 'claude', oldKey: 'story:3', newKey: 'selection:abc', how: 'exact' },
  ])
  ok(cyclic.notes.length === 2, 'a rebind cycle broke the projection')

  ok(validateEvent({ type: 'anchor.rebound', at: 'x', by: 'claude', oldKey: 'a', how: 'quote' }, project([]))
    .some(e => /needs a newKey/.test(e)), 'a quote rebind without a target was accepted')
}

// ── migration from threads.json, exactly once ────────────────────────────────
{
  const dir = fresh()
  writeFileSync(join(dir, 'threads.json'), JSON.stringify({
    map: '/x/review-map.json',
    threads: [
      { anchorKey: 'story:0', anchor: { kind: 'story', key: 'story:0', label: 'caller' }, question: 'Why partial?', answer: 'The guard is missing.', steps: ['read x.ts'], at: '2026-08-05T09:00:00Z' },
      { anchorKey: 'diagram:1', anchor: { kind: 'diagram', key: 'diagram:1' }, question: 'What changed here?', answer: 'The retry edge.', steps: [], at: '2026-08-05T09:10:00Z' },
      { anchorKey: 'story:0', question: 'Half a record', at: '2026-08-05T09:20:00Z' },
    ],
  }))
  ok(migrateThreads(dir) === 2, 'migration did not convert both complete threads')
  const { state } = readReview(dir)
  ok(state.notes.length === 4, `expected 4 notes after migration, got ${state.notes.length}`)
  ok(state.counts.unanswered === 0, 'migrated questions came back unanswered')
  ok(state.notes[0].from === 'threads.json', 'migrated notes are not marked as migrated')
  ok(state.notes[0].at === '2026-08-05T09:00:00Z', 'migration invented a timestamp')
  ok(state.notes[1].steps?.length === 1, 'migration dropped the answer steps')
  ok(!existsSync(join(dir, 'threads.json')), 'threads.json was left in place to be migrated again')
  ok(existsSync(join(dir, 'threads.migrated.json')), 'the old answers were deleted instead of kept')

  // Idempotent even if the old file comes back (a stash pop, a restored backup).
  writeFileSync(join(dir, 'threads.json'), readFileSync(join(dir, 'threads.migrated.json'), 'utf8'))
  ok(migrateThreads(dir) === 0, 'migration ran twice')
  ok(readReview(dir).state.notes.length === 4, 'a second migration duplicated the notes')

  // Nothing to migrate is not an error.
  ok(migrateThreads(fresh()) === 0, 'migrating an empty directory failed')
}

// ── the CLI a work session drives the journal through ────────────────────────
{
  const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), '..', 'scripts', 'review.mjs')
  const dir = fresh()
  const run = (...a) => execFileSync('node', [SCRIPT, dir, ...a], { encoding: 'utf8' })
  const refuses = (a, re, msg) => {
    try { execFileSync('node', [SCRIPT, dir, ...a], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }) }
    catch (e) { if (!re.test(String(e.stderr || e.stdout))) fail(`${msg} — wrong refusal: ${e.stderr || e.stdout}`); return }
    fail(`${msg} — the CLI accepted it`)
  }

  ok(/nothing to work/.test(run('--next')), 'an empty journal did not say there is nothing to work')

  const iid = newId('n')
  appendEvents(dir, [
    { type: 'note.added', noteId: iid, by: 'reviewer', kind: 'instruction', anchor: ANCHOR, text: 'Make refunds settle.' },
    { type: 'note.added', by: 'claude', kind: 'report', anchor: ANCHOR, text: 'I would guard the unshipped path.', plan: { spec: 'Settle refunds.', acceptance: { type: 'test', name: 'test_settles' } }, replyTo: iid },
    { type: 'task.opened', taskId: 't_cli', anchor: ANCHOR, threadKey: ANCHOR.key, origin: 'reviewer', from: iid, spec: 'Settle refunds for unshipped orders.', acceptance: { type: 'test', name: 'test_settles' }, state: 'open' },
    // A proposed task is not work anyone agreed to; --next must not offer it.
    { type: 'task.opened', taskId: 't_prop', anchor: ANCHOR, origin: 'proposal', finding: 'story:3', spec: 'Rewrite settlement.', acceptance: ACC, state: 'proposed' },
  ])

  const next = run('--next')
  if (!/t_cli/.test(next) || /t_prop/.test(next)) fail(`--next offered the wrong task:\n${next}`)
  if (!/proof\s+test: test_settles/.test(next)) fail('--next did not state the criterion')
  // The discussion behind the spec comes with it: that is the point of the journal.
  if (!/\[reviewer instruction\] Make refunds settle\./.test(next)) fail(`--next dropped the discussion:\n${next}`)

  ok(/in progress/.test(run('--start', 't_cli')), '--start did not report the transition')
  ok(/t_cli \(in_progress\)/.test(run('--thread', 't_cli')), '--thread did not show the claimed state')
  refuses(['--start', 't_nope'], /unknown taskId/, 'starting a task that does not exist')
  refuses(['--resolve', 't_cli'], /missing patch/, 'resolving with no patch')
  ok(/patch/.test(run('--resolve', 't_cli', '--patch', '.whydiff/tasks/t_cli.patch', '--files', 'api/refunds.py')), '--resolve said nothing')

  // Verification is earned: the CLI cannot record it without evidence.
  refuses(['--verify', 't_cli'], /without evidence is an assertion/, 'verifying with no evidence')
  ok(/verified/.test(run('--verify', 't_cli', '--evidence', 'pytest -k test_settles → 1 passed')), '--verify said nothing')
  refuses(['--decline', 't_cli'], /declining needs a reason/, 'declining with no reason')

  const state = readReview(dir).state
  const t = state.tasks.find(x => x.taskId === 't_cli')
  ok(t.state === 'verified' && t.resolution?.patch && t.evidence, `the CLI did not record the work: ${JSON.stringify(t)}`)
  ok(t.resolution.files[0] === 'api/refunds.py', 'the resolved files were dropped')

  // A note from a work session lands on the task's own thread.
  run('--report', 't_prop', '--text', 'blocked: which currency does settlement use?')
  const noted = readReview(dir).state.notes.find(n => n.kind === 'report' && /blocked/.test(n.text))
  ok(noted?.taskId === 't_prop' && noted.by === 'claude', `the report note was not tied to its task: ${JSON.stringify(noted)}`)
  ok(/nothing to work/.test(run('--next')), '--next offered a task after everything agreed was done')
}

// ── the log is the source of truth, not the projection ───────────────────────
{
  const dir = fresh()
  appendEvents(dir, { type: 'note.added', kind: 'question', anchor: ANCHOR, text: 'q' })
  writeFileSync(join(dir, REVIEW_STATE), '{"counts":{"notes":999}}')
  ok(readReview(dir).state.counts.notes === 1, 'a corrupted projection was trusted over the log')
  ok(readLog(dir).events.length === 1, 'the log lost an event')
}

console.log('OK: review journal (append+project, refusals, task machine, typed acceptance, plans+decisions, proposal turns+coverage, forward-compat, torn line, rebind chains, threads.json migrated once, work CLI)')
