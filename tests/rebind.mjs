#!/usr/bin/env node
// Contract test for rebinding a journal onto a regenerated map (scripts/rebind.mjs,
// planRebinds in scripts/review.mjs).
//
// The property under test: nothing is dropped. A place that moved is rebound, a
// place that is gone is kept and labelled stale, and a stale place whose text came
// back is revived — and running it twice changes nothing.

import { writeFileSync, mkdtempSync, existsSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { appendEvents, readReview, planRebinds, anchorOffers, REVIEW_LOG } from '../scripts/review.mjs'

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), '..', 'scripts', 'rebind.mjs')
const fail = (msg) => { console.error(`FAIL: ${msg}`); process.exit(1) }
const ok = (cond, msg) => { if (!cond) fail(msg) }
const fresh = () => mkdtempSync(join(tmpdir(), 'whydiff-rebind-'))

const mapV1 = {
  meta: { project: 'p', ref: 'working tree', generatedAt: '2026-08-06T10:00:00Z' },
  intent: 'Refunds settle on agreement.',
  story: [
    { label: 'Goal', text: 'The API accepts a refund for an agreed order.' },
    { link: 'so that' },
    { label: 'Step 1', text: 'Settlement runs from the fulfilment path only.' },
  ],
  groups: [], files: {}, edges: [], manifest: [],
  standards: [
    { severity: 'warn', finding: 'The 60-second window is a literal inside the middleware.' },
    { severity: 'ok', finding: 'Naming matches the project.' },
  ],
  tests: { gaps: ['nothing covers an unshipped order', 'no test for the burst window'] },
  userStories: { stories: [
    { actor: 'customer', story: 'I get my money back after my refund is agreed', status: 'broken', why: 'settlement is skipped' },
    { actor: 'operator', story: 'I see why a refund failed', status: 'delivered', why: 'logged' },
  ] },
  diagrams: [{ kind: 'flow-diff', title: 'Refund settlement', mermaid: 'graph TD' }],
}

// ── the offers a map makes ───────────────────────────────────────────────────
{
  const keys = anchorOffers(mapV1).map(o => o.key)
  ok(keys.join(',') === 'story:0,story:1,finding:0,gap:0,gap:1,diagram:0,block:0,block:1',
    `the map does not offer the keys the viewer stamps: ${keys.join(',')}`)
  // A delivered story is not a finding but is still a place to attach a remark to.
  ok(anchorOffers(mapV1).some(o => o.key === 'story:1'), 'a delivered story cannot be remarked on')
}

// ── moved, gone, untouched ───────────────────────────────────────────────────
{
  const dir = fresh()
  const A = (key, kind, label, extra = {}) => ({ kind, key, label, ...extra })
  const qid = 'n_q1'
  appendEvents(dir, [
    // On the broken story, which will move to another index.
    { type: 'note.added', noteId: qid, by: 'reviewer', kind: 'question', anchor: A('story:0', 'story', 'customer: I get my money back after my refund is agreed'), text: 'why?' },
    { type: 'note.added', by: 'claude', kind: 'answer', anchor: A('story:0', 'story', 'customer: I get my money back after my refund is agreed'), text: 'because', replyTo: qid },
    // On a gap that gets fixed and disappears from the map.
    { type: 'task.opened', taskId: 't_gap', anchor: A('gap:1', 'gap', 'no test for the burst window'), threadKey: 'gap:1', origin: 'reviewer', spec: 'cover the burst window', acceptance: { type: 'test', name: 'test_burst' }, state: 'open' },
    // On a finding that stays exactly where it is.
    { type: 'note.added', by: 'reviewer', kind: 'question', anchor: A('finding:0', 'finding', 'The 60-second window is a literal inside the middleware.'), text: 'is it?' },
    // A quoted phrase from the intent, and one from a sentence that will be dropped.
    { type: 'note.added', by: 'reviewer', kind: 'question', anchor: A('sel:refunds-settle', 'selection', 'Refunds settle on agreement', { quote: 'Refunds settle on agreement' }), text: 'q' },
    { type: 'note.added', by: 'reviewer', kind: 'question', anchor: A('sel:gone-phrase', 'selection', 'Settlement runs from the fulfilment path only', { quote: 'Settlement runs from the fulfilment path only' }), text: 'q' },
    // A Logic block that will be reworded but keeps its meaning-bearing sentence.
    { type: 'note.added', by: 'reviewer', kind: 'question', anchor: A('block:1', 'block', 'Step 1', { context: 'Step 1 Settlement runs from the fulfilment path only.' }), text: 'q' },
    // Kinds a script must not guess about.
    { type: 'note.added', by: 'reviewer', kind: 'question', anchor: A('blocks:0+1', 'blocks', 'two blocks'), text: 'q' },
  ])

  // The regenerated map: the story moved to index 1, its second gap is fixed, the
  // Logic step and one quoted sentence are gone, the finding is untouched.
  const mapV2 = {
    ...mapV1,
    meta: { ...mapV1.meta, generatedAt: '2026-08-07T10:00:00Z' },
    story: [
      { label: 'Goal', text: 'The API accepts a refund for an agreed order.' },
      { label: 'Step 1', text: 'Settlement now runs from both paths.' },
    ],
    tests: { gaps: ['nothing covers an unshipped order'] },
    userStories: { stories: [
      { actor: 'operator', story: 'I see why a refund failed', status: 'delivered', why: 'logged' },
      { actor: 'customer', story: 'I get my money back after my refund is agreed', status: 'partial', why: 'still slow' },
    ] },
  }

  const plan = planRebinds(mapV2, readReview(dir).state, { mapId: 'm_two' })
  const by = (k) => plan.events.find(e => e.oldKey === k)
  ok(by('story:0')?.newKey === 'story:1' && by('story:0').how === 'quote',
    `the moved story was not rebound: ${JSON.stringify(plan.events)}`)
  ok(by('gap:1')?.how === 'stale', 'a gap that disappeared was not marked stale')
  ok(!by('finding:0'), 'an untouched finding was rebound anyway')
  ok(!by('sel:refunds-settle'), 'a quote that still reads was disturbed')
  ok(by('sel:gone-phrase')?.how === 'stale', 'a quote that is gone was not marked stale')
  ok(by('block:1')?.how === 'stale', 'a reworded Logic block was not marked stale')
  ok(!by('blocks:0+1'), 'a multi-block anchor was guessed about')
  ok(plan.summary.skipped === 1, `unrebindable kinds were not counted: ${JSON.stringify(plan.summary)}`)
  ok(plan.events.every(e => e.mapId === 'm_two'), 'rebinds do not say which map they were decided against')

  // Applying it: the thread follows its story, the stale ones keep their text.
  appendEvents(dir, plan.events)
  const state = readReview(dir).state
  const moved = state.notes.find(n => n.noteId === qid)
  ok(moved.anchor.key === 'story:1' && moved.anchor.reboundFrom === 'story:0',
    `the note did not follow its story: ${JSON.stringify(moved.anchor)}`)
  const staleTask = state.tasks.find(t => t.taskId === 't_gap')
  ok(staleTask.anchor.stale === true, 'the task on a vanished gap is not marked stale')
  ok(staleTask.anchor.label === 'no test for the burst window', 'a stale anchor lost the text it was attached to')
  ok(staleTask.state === 'open', 'a stale anchor silently changed the task state')
  ok(state.notes.every(n => n.text), 'rebinding dropped a note')

  // Idempotent: the same map again decides nothing new.
  ok(planRebinds(mapV2, readReview(dir).state, { mapId: 'm_two' }).events.length === 0,
    'rebinding twice against the same map emitted events again')

  // And a place that comes back is revived rather than staying dead.
  const revive = planRebinds(mapV1, readReview(dir).state, { mapId: 'm_one' })
  const back = revive.events.filter(e => e.how === 'quote').map(e => e.oldKey).sort()
  ok(back.includes('gap:1') && back.includes('sel:gone-phrase') && back.includes('block:1'),
    `places that came back were not revived: ${JSON.stringify(revive.events)}`)
  appendEvents(dir, revive.events)
  const revived = readReview(dir).state.tasks.find(t => t.taskId === 't_gap')
  ok(!revived.anchor.stale, 'a revived anchor is still marked stale')
}

// ── the CLI ──────────────────────────────────────────────────────────────────
{
  const dir = fresh()
  // No journal: the pipeline calls this unconditionally, so it must be a no-op.
  const quiet = execFileSync('node', [SCRIPT, '--dir', dir], { encoding: 'utf8' })
  ok(/nothing to rebind/.test(quiet), `an empty directory was not a no-op: ${quiet}`)
  ok(!existsSync(join(dir, REVIEW_LOG)), 'the no-op created a journal')

  writeFileSync(join(dir, 'review-map.json'), JSON.stringify(mapV1))
  appendEvents(dir, { type: 'note.added', by: 'reviewer', kind: 'question', anchor: { kind: 'gap', key: 'gap:9', label: 'a gap that no longer exists' }, text: 'q' })
  const dryRun = execFileSync('node', [SCRIPT, '--dir', dir, '--dry'], { encoding: 'utf8' })
  ok(/now stale/.test(dryRun) && /nothing written/.test(dryRun), `--dry did not report a plan: ${dryRun}`)
  ok(readReview(dir).state.rebinds.length === 0, '--dry wrote to the journal')

  const out = execFileSync('node', [SCRIPT, '--dir', dir], { encoding: 'utf8' })
  ok(/stale\s+gap:9/.test(out), `the CLI did not name what went stale: ${out}`)
  const state = readReview(dir).state
  ok(state.rebinds.length === 1, 'the CLI wrote no rebind')
  // The journal also records which observation it was rebound against.
  ok(state.maps.length === 1 && /^m_[0-9a-f]{6}$/.test(state.maps[0].mapId), `the map was not recorded: ${JSON.stringify(state.maps)}`)
  const twice = execFileSync('node', [SCRIPT, '--dir', dir], { encoding: 'utf8' })
  ok(/already matches this map/.test(twice), `a second run was not a no-op: ${twice}`)
  ok(readReview(dir).state.maps.length === 1, 'the same map was recorded twice')
}

console.log('OK: rebind (offers match the viewer, moved rebound, gone marked stale with its text, quotes checked against the report, unrebindable kinds untouched, revival, idempotent, CLI no-op without a journal)')
