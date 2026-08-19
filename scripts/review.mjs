#!/usr/bin/env node
// The review journal: the append-only record of everything said and decided about
// a change, plus the projection the viewer and the work skill read.
//
//   node scripts/review.mjs <dir>                       what the review stands at
//   node scripts/review.mjs <dir> --json [--map <f>]     the whole projection
//   node scripts/review.mjs <dir> --next                 the next task + its discussion
//   node scripts/review.mjs <dir> --thread <taskId>      one task + its discussion
//   node scripts/review.mjs <dir> --start <taskId>
//   node scripts/review.mjs <dir> --resolve <taskId> --patch <f> [--files a,b] [--commit sha]
//   node scripts/review.mjs <dir> --verify <taskId> --evidence "<what ran, and its output>"
//   node scripts/review.mjs <dir> --decline <taskId> --reason "…"
//   node scripts/review.mjs <dir> --report <taskId> --text "…"
//
// Why a log and not a mutable review.json: two writers — the served page and a
// Claude Code session in the same repo — append without locking or clobbering, and
// the history the Tasks tab has to show IS the log, so nothing gets reconstructed.
// review.json beside it is a projection: derived, disposable, never hand-edited
// (the same status as `fullFiles` in a map).
//
// Why this lives outside review-map.json: a map is an observation of one snapshot.
// A question does not invalidate it; a finished task does. Tasks stored inside the
// map would make the observation mutable and import GitLab's outdated-comment
// problem by construction. See docs/review-loop.md.

import { readFileSync, writeFileSync, appendFileSync, existsSync, mkdirSync, renameSync } from 'node:fs'
import { randomBytes } from 'node:crypto'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export const REVIEW_LOG = 'review.log.jsonl'
export const REVIEW_STATE = 'review.json'

export const EVENT_TYPES = [
  'map.observed', 'note.added', 'task.opened', 'task.state', 'task.resolved',
  'task.verified', 'anchor.rebound',
]
// `note` is a bare reviewer remark on a place — no model, no reply, not a decision
// about a plan. It exists so a thought can be pinned to the map and read back.
export const NOTE_KINDS = ['question', 'answer', 'instruction', 'proposal', 'decision', 'report', 'note']
export const TASK_STATES = ['proposed', 'open', 'in_progress', 'done', 'verified', 'declined']

// A task can be reopened from `done` (the patch was reviewed and rejected) and from
// `declined` (we changed our mind); `verified` is the only terminal state, because
// it is the one backed by evidence.
const LEGAL_NEXT = {
  proposed: ['open', 'declined'],
  open: ['in_progress', 'done', 'declined'],
  in_progress: ['done', 'open', 'declined'],
  done: ['verified', 'open', 'declined'],
  verified: [],
  declined: ['open'],
}

// Acceptance is mandatory and typed so that `verified` can be re-derived by a pass
// instead of asserted by the model that did the work.
const ACCEPTANCE_FIELD = { test: 'name', story: 'key', finding: 'key', manual: 'what' }

const nonEmpty = (v) => typeof v === 'string' && v.trim().length > 0

/**
 * Opaque ids, not counters: two writers append to the same log with no
 * coordination, so a "next number" would collide. Order comes from position in the
 * log, never from the id.
 */
export const newId = (prefix, taken = new Set()) => {
  for (;;) {
    const id = `${prefix}_${randomBytes(3).toString('hex')}`
    if (!taken.has(id)) return id
  }
}

const anchorErrors = (a, where) => {
  if (!a || typeof a !== 'object') return [`${where}: missing anchor`]
  const errs = []
  if (!nonEmpty(a.kind)) errs.push(`${where}: anchor has no kind`)
  if (!nonEmpty(a.key)) errs.push(`${where}: anchor has no key`)
  return errs
}

const acceptanceErrors = (acc, where) => {
  if (!acc || typeof acc !== 'object') return [`${where}: acceptance is required (how will we know it is done?)`]
  const field = ACCEPTANCE_FIELD[acc.type]
  if (!field) return [`${where}: unknown acceptance type ${JSON.stringify(acc.type)} (expected ${Object.keys(ACCEPTANCE_FIELD).join('|')})`]
  return nonEmpty(acc[field]) ? [] : [`${where}: acceptance of type ${acc.type} needs a non-empty ${field}`]
}

/**
 * Checks one event against the state built from everything before it.
 * Returns error strings; empty means the event may be appended.
 */
export function validateEvent(ev, state) {
  const errs = []
  if (!ev || typeof ev !== 'object') return ['event is not an object']
  const at = `${ev.type || '?'}`
  if (!EVENT_TYPES.includes(ev.type)) return [`${at}: unknown event type (appending an unknown type would make the log unreadable to this version)`]
  if (!nonEmpty(ev.at)) errs.push(`${at}: missing timestamp`)
  if (!['reviewer', 'claude'].includes(ev.by)) errs.push(`${at}: author must be reviewer or claude, got ${JSON.stringify(ev.by)}`)

  const task = (id) => state.tasks.find(t => t.taskId === id)

  switch (ev.type) {
    case 'map.observed':
      if (!nonEmpty(ev.mapId)) errs.push('map.observed: missing mapId')
      break
    case 'note.added':
      errs.push(...anchorErrors(ev.anchor, 'note.added'))
      if (!NOTE_KINDS.includes(ev.kind)) errs.push(`note.added: unknown note kind ${JSON.stringify(ev.kind)}`)
      // A proposal carries its variants as payload; its prose is a summary and may
      // be empty. Every other kind is the utterance itself.
      if (ev.kind === 'proposal') {
        const p = ev.proposal
        if (!p || typeof p !== 'object') errs.push('note.added: a proposal needs a proposal payload')
        else {
          if (!nonEmpty(p.finding)) errs.push('note.added: a proposal must cite the finding it descends from')
          const variants = Array.isArray(p.variants) ? p.variants : []
          if (!variants.length && !nonEmpty(p.noFixNeeded)) {
            errs.push('note.added: a proposal needs variants, or noFixNeeded with a reason')
          }
          variants.forEach((v, i) => {
            if (!['local', 'root', 'document'].includes(v?.kind)) errs.push(`note.added: variant ${i} has no kind (local|root|document)`)
            if (!nonEmpty(v?.what)) errs.push(`note.added: variant ${i} says nothing`)
            // A variant is what a task opens from, so it needs the criterion that
            // task would be judged by — chosen now, not invented later.
            errs.push(...acceptanceErrors(v?.acceptance, `note.added: variant ${i}`))
          })
        }
      } else if (!nonEmpty(ev.text)) errs.push(`note.added: empty ${ev.kind}`)
      // A plan is what the reviewer approves to open a task, so it has to carry
      // enough to open one — otherwise the Agree button would have nothing to do.
      if (ev.plan) {
        if (!nonEmpty(ev.plan.spec)) errs.push('note.added: a plan needs a spec')
        errs.push(...acceptanceErrors(ev.plan.acceptance, 'note.added: plan'))
      }
      if (ev.taskId && !task(ev.taskId)) errs.push(`note.added: unknown taskId ${ev.taskId}`)
      break
    case 'task.opened':
      if (!nonEmpty(ev.taskId)) errs.push('task.opened: missing taskId')
      else if (task(ev.taskId)) errs.push(`task.opened: ${ev.taskId} already exists`)
      errs.push(...anchorErrors(ev.anchor, 'task.opened'))
      if (!nonEmpty(ev.spec)) errs.push('task.opened: empty spec')
      if (!['reviewer', 'proposal'].includes(ev.origin)) errs.push(`task.opened: origin must be reviewer or proposal, got ${JSON.stringify(ev.origin)}`)
      if (ev.origin === 'proposal' && !nonEmpty(ev.finding)) errs.push('task.opened: a task born from a proposal must keep the finding it descends from')
      if (!['proposed', 'open'].includes(ev.state)) errs.push(`task.opened: a task opens at proposed or open, got ${JSON.stringify(ev.state)}`)
      errs.push(...acceptanceErrors(ev.acceptance, 'task.opened'))
      break
    case 'task.state': {
      const t = task(ev.taskId)
      if (!t) { errs.push(`task.state: unknown taskId ${ev.taskId}`); break }
      if (!TASK_STATES.includes(ev.state)) { errs.push(`task.state: unknown state ${JSON.stringify(ev.state)}`); break }
      if (!LEGAL_NEXT[t.state].includes(ev.state)) errs.push(`task.state: ${ev.taskId} cannot go ${t.state} → ${ev.state}`)
      // A declined proposal is information: the next run must not re-propose it,
      // and a reviewer weeks later must see the decision was deliberate.
      if (ev.state === 'declined' && !nonEmpty(ev.reason)) errs.push('task.state: declining needs a reason')
      break
    }
    case 'task.resolved': {
      const t = task(ev.taskId)
      if (!t) { errs.push(`task.resolved: unknown taskId ${ev.taskId}`); break }
      if (t.state === 'verified') errs.push(`task.resolved: ${ev.taskId} is already verified`)
      if (!Array.isArray(ev.files)) errs.push('task.resolved: files must be an array')
      if (!nonEmpty(ev.patch)) errs.push('task.resolved: missing patch — a resolution nobody can look at is not one')
      break
    }
    case 'task.verified': {
      const t = task(ev.taskId)
      if (!t) { errs.push(`task.verified: unknown taskId ${ev.taskId}`); break }
      if (t.state !== 'done') errs.push(`task.verified: ${ev.taskId} is ${t.state}, not done`)
      if (!nonEmpty(ev.evidence)) errs.push('task.verified: verification without evidence is an assertion')
      break
    }
    case 'anchor.rebound':
      if (!nonEmpty(ev.oldKey)) errs.push('anchor.rebound: missing oldKey')
      if (!['exact', 'quote', 'stale'].includes(ev.how)) errs.push(`anchor.rebound: how must be exact|quote|stale, got ${JSON.stringify(ev.how)}`)
      if (ev.how !== 'stale' && !nonEmpty(ev.newKey)) errs.push('anchor.rebound: a non-stale rebind needs a newKey')
      break
  }
  return errs.filter(Boolean)
}

/**
 * Reads the journal. A half-written line — the page died mid-append, the disk
 * filled — must cost that one line and nothing else, so unparseable lines are
 * counted and skipped rather than thrown.
 */
export function readLog(dir) {
  const file = join(dir, REVIEW_LOG)
  if (!existsSync(file)) return { events: [], skipped: 0 }
  const events = []
  let skipped = 0
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    if (!line.trim()) continue
    try { events.push(JSON.parse(line)) } catch { skipped++ }
  }
  return { events, skipped }
}

const mergeAnchor = (into, from) => {
  for (const k of ['label', 'files', 'quote', 'context', 'mapId', 'lang']) {
    if (into[k] === undefined && from?.[k] !== undefined) into[k] = from[k]
  }
  return into
}

/**
 * Folds the journal into the state the Tasks tab and the work skill read.
 *
 * An event type this version does not know is collected in `unknown` instead of
 * throwing: appending an unknown type is refused (validateEvent), but *reading* a
 * log written by a newer whydiff must never take the review down.
 */
export function project(events) {
  const state = { maps: [], notes: [], threads: {}, tasks: [], rebinds: [], unknown: [], counts: {} }
  const taskById = new Map()

  const thread = (anchor) => {
    const key = anchor.key
    if (!state.threads[key]) state.threads[key] = { anchorKey: key, anchor: { ...anchor }, noteIds: [], taskIds: [] }
    else mergeAnchor(state.threads[key].anchor, anchor)
    return state.threads[key]
  }

  for (const ev of events) {
    switch (ev.type) {
      case 'map.observed':
        state.maps.push({ mapId: ev.mapId, ref: ev.ref, base: ev.base, head: ev.head, generatedAt: ev.generatedAt || ev.at, stats: ev.stats })
        break
      case 'note.added': {
        const note = {
          noteId: ev.noteId || ev.id, at: ev.at, by: ev.by, kind: ev.kind,
          anchor: { ...ev.anchor }, text: ev.text || '',
          ...(ev.proposal ? { proposal: ev.proposal } : {}),
          ...(ev.plan ? { plan: ev.plan } : {}),
          // Set when a patch was applied to the working tree: the fact belongs on
          // the note that recorded the decision, not on a new event type.
          ...(ev.applied ? { applied: ev.applied } : {}),
          ...(ev.steps?.length ? { steps: ev.steps } : {}),
          ...(ev.replyTo ? { replyTo: ev.replyTo } : {}),
          ...(ev.taskId ? { taskId: ev.taskId } : {}),
          ...(ev.from ? { from: ev.from } : {}),
        }
        if (note.kind === 'question') note.answered = false
        state.notes.push(note)
        const th = thread(ev.anchor)
        th.noteIds.push(note.noteId)
        if (note.kind === 'answer') {
          // Prefer the question the answer names; otherwise the newest open
          // question on the same anchor, which is what a reader assumes.
          const named = note.replyTo && state.notes.find(n => n.noteId === note.replyTo && n.kind === 'question')
          const target = named || [...state.notes].reverse().find(n => n.kind === 'question' && n.anchor.key === note.anchor.key && !n.answered)
          if (target) target.answered = true
        }
        break
      }
      case 'task.opened': {
        const task = {
          taskId: ev.taskId, threadKey: ev.threadKey || ev.anchor?.key, anchor: { ...ev.anchor },
          origin: ev.origin, from: ev.from || null, finding: ev.finding || null,
          spec: ev.spec, acceptance: ev.acceptance, state: ev.state,
          declinedReason: null, resolution: null, evidence: null,
          supersedes: ev.supersedes || null, openedAt: ev.at, history: [[ev.at, ev.state]],
        }
        state.tasks.push(task)
        taskById.set(task.taskId, task)
        thread(ev.anchor).taskIds.push(task.taskId)
        break
      }
      case 'task.state': {
        const t = taskById.get(ev.taskId)
        if (!t) break
        t.state = ev.state
        t.declinedReason = ev.state === 'declined' ? (ev.reason || null) : null
        t.history.push([ev.at, ev.state, ev.reason].filter(v => v !== undefined))
        break
      }
      case 'task.resolved': {
        const t = taskById.get(ev.taskId)
        if (!t) break
        t.resolution = { files: ev.files || [], patch: ev.patch, commit: ev.commit || null, followUpMapId: ev.followUpMapId || null }
        // Resolving IS reaching done — a separate task.state would be ceremony.
        if (t.state !== 'done') { t.state = 'done'; t.history.push([ev.at, 'done']) }
        break
      }
      case 'task.verified': {
        const t = taskById.get(ev.taskId)
        if (!t) break
        t.evidence = ev.evidence
        t.state = 'verified'
        t.history.push([ev.at, 'verified'])
        break
      }
      case 'anchor.rebound':
        state.rebinds.push({ oldKey: ev.oldKey, newKey: ev.newKey || null, how: ev.how, mapId: ev.mapId || null })
        break
      default:
        state.unknown.push({ type: ev.type, id: ev.id })
    }
  }

  // Rebinds are applied last so a chain (a → b → stale) resolves in one pass and
  // the order events arrived in cannot change the answer.
  if (state.rebinds.length) {
    const hop = new Map(state.rebinds.map(r => [r.oldKey, r]))
    const resolve = (key) => {
      let k = key, stale = false
      for (let i = 0; i < 32 && hop.has(k); i++) {
        const r = hop.get(k)
        if (r.how === 'stale') { stale = true; break }
        if (!r.newKey || r.newKey === k) break
        k = r.newKey
      }
      return { key: k, stale }
    }
    const rebind = (holder) => {
      const { key, stale } = resolve(holder.anchor.key)
      if (stale) { holder.anchor.stale = true; return }
      if (key !== holder.anchor.key) { holder.anchor.reboundFrom = holder.anchor.key; holder.anchor.key = key }
    }
    for (const n of state.notes) rebind(n)
    for (const t of state.tasks) rebind(t)
  }

  const byState = (s) => state.tasks.filter(t => t.state === s).length
  const unanswered = state.notes.filter(n => n.kind === 'question' && !n.answered).length
  state.counts = {
    // Blocking is what stops a merge: work agreed or under way, plus questions
    // nobody has answered. A `proposed` task is a suggestion, not a blocker.
    blocking: byState('open') + byState('in_progress') + unanswered,
    proposed: byState('proposed'), open: byState('open'), in_progress: byState('in_progress'),
    done: byState('done'), verified: byState('verified'), declined: byState('declined'),
    questions: state.notes.filter(n => n.kind === 'question').length,
    unanswered,
    notes: state.notes.length, tasks: state.tasks.length,
  }
  return state
}

/** The journal plus its projection. */
export function readReview(dir) {
  const { events, skipped } = readLog(dir)
  return { events, skipped, state: project(events) }
}

export function writeState(dir, state) {
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, REVIEW_STATE), JSON.stringify(state, null, 1))
}

/**
 * Stamps, validates and appends events, then refreshes the projection.
 *
 * Validation runs against the state as of each event, so a batch that opens a task
 * and immediately moves it is checked the way it will later be read. One append
 * write per call keeps a concurrent writer from interleaving inside a line.
 * Throws on the first invalid event and writes nothing.
 */
export function appendEvents(dir, incoming, { by = 'reviewer', now = null } = {}) {
  const list = Array.isArray(incoming) ? incoming : [incoming]
  if (!list.length) return { events: [], state: readReview(dir).state }
  const { events } = readLog(dir)
  let state = project(events)
  const taken = new Set(events.map(e => e.id))
  const stamped = []
  for (const raw of list) {
    const ev = { id: newId('ev', taken), at: now || new Date().toISOString(), by, ...raw }
    taken.add(ev.id)
    if (ev.type === 'note.added' && !ev.noteId) {
      ev.noteId = newId('n', taken)
      taken.add(ev.noteId)
    }
    const errs = validateEvent(ev, state)
    if (errs.length) throw new Error(`rejected ${ev.type}: ${errs.join('; ')}`)
    stamped.push(ev)
    // Fold as we go: the next event in the batch is checked against this one.
    state = project([...events, ...stamped])
  }
  mkdirSync(dir, { recursive: true })
  appendFileSync(join(dir, REVIEW_LOG), stamped.map(e => JSON.stringify(e) + '\n').join(''))
  const finalState = project([...events, ...stamped])
  writeState(dir, finalState)
  return { events: stamped, state: finalState }
}

/**
 * Brings a pre-journal .whydiff forward: every stored question/answer pair becomes
 * two notes. Idempotent — the migrated events carry `from: 'threads.json'`, so a
 * second run finds them and does nothing. The old file is kept, renamed, rather
 * than deleted: it is the only copy of those answers.
 */
export function migrateThreads(dir) {
  const legacy = join(dir, 'threads.json')
  if (!existsSync(legacy)) return 0
  const { events } = readLog(dir)
  if (events.some(e => e.from === 'threads.json')) return 0
  let threads = []
  try { threads = JSON.parse(readFileSync(legacy, 'utf8')).threads || [] } catch { return 0 }
  const batch = []
  for (const t of threads) {
    if (!t?.question || !t?.answer) continue
    const anchor = { kind: t.anchor?.kind || (t.anchorKey || '').split(':')[0] || 'unknown', key: t.anchorKey || t.anchor?.key || 'unanchored', ...t.anchor }
    anchor.key = t.anchorKey || anchor.key
    const noteId = newId('n')
    // Both notes carry the legacy timestamp: the old record never stored when the
    // answer landed, and inventing a time would be worse than repeating one.
    batch.push({ type: 'note.added', noteId, by: 'reviewer', at: t.at, kind: 'question', anchor, text: t.question, from: 'threads.json' })
    batch.push({ type: 'note.added', by: 'claude', at: t.at, kind: 'answer', anchor, text: t.answer, replyTo: noteId, steps: t.steps || [], from: 'threads.json' })
  }
  if (!batch.length) return 0
  appendEvents(dir, batch)
  renameSync(legacy, join(dir, 'threads.migrated.json'))
  return batch.length / 2
}

/**
 * Completed exchanges, in the shape the viewer's panel renders. Three kinds — a
 * question answered (`ask`), an instruction planned (`instruct`) and a set of fix
 * variants offered (`proposal`) — so one renderer covers all of them.
 *
 * Only complete exchanges appear. A request whose reply never arrived was never
 * journalled (see serve.mjs), and an *open* item belongs to the Tasks tab, which
 * reads the projection instead of this.
 */
const REPLY_OF = { question: 'answer', instruction: 'report' }

export function turns(state) {
  const out = []
  const tailOf = (noteId) => ({
    task: state.tasks.find(t => t.from === noteId) || null,
    decision: state.notes.find(n => n.kind === 'decision' && n.replyTo === noteId) || null,
  })
  for (const req of state.notes) {
    // A bare reviewer note is a turn on its own — a remark with no reply to wait
    // for. It surfaces so the map can mark its place and the panel can read it back.
    if (req.kind === 'note') {
      out.push({
        anchorKey: req.anchor.key, anchor: req.anchor, at: req.at, kind: 'note', by: req.by,
        requestId: req.noteId, request: req.text, response: null, steps: [],
        plan: null, proposal: null, decision: null, task: null,
      })
      continue
    }
    // A proposal has no request to pair with: Claude speaks first, prompted by a
    // finding rather than by something the reviewer typed.
    if (req.kind === 'proposal') {
      const { task, decision } = tailOf(req.noteId)
      out.push({
        anchorKey: req.anchor.key, anchor: req.anchor, at: req.at, kind: 'proposal',
        requestId: req.noteId, request: null, response: req.text, steps: req.steps || [],
        proposal: req.proposal, plan: null, decision: decision?.text || null,
        task: task && { taskId: task.taskId, state: task.state, spec: task.spec, acceptance: task.acceptance, declinedReason: task.declinedReason },
      })
      continue
    }
    const replyKind = REPLY_OF[req.kind]
    if (!replyKind) continue
    const reply = state.notes.find(n => n.kind === replyKind && n.replyTo === req.noteId)
      || state.notes.find(n => n.kind === replyKind && !n.replyTo && n.anchor.key === req.anchor.key && n.at >= req.at)
    if (!reply) continue
    const task = state.tasks.find(t => t.from === req.noteId) || null
    // "Not now" on a plan is a decision, and it has to stay visible: otherwise the
    // page would keep offering to open a task that was already turned down.
    const decision = state.notes.find(n => n.kind === 'decision' && n.replyTo === req.noteId) || null
    out.push({
      anchorKey: req.anchor.key, anchor: req.anchor, at: req.at,
      kind: req.kind === 'question' ? 'ask' : 'instruct',
      requestId: req.noteId, request: req.text,
      response: reply.text, steps: reply.steps || [],
      plan: reply.plan || null,
      decision: decision?.text || null,
      task: task && { taskId: task.taskId, state: task.state, spec: task.spec, acceptance: task.acceptance, declinedReason: task.declinedReason },
    })
  }
  return out
}

/**
 * The problems the map itself reported, as anchors. Keys are `<kind>:<index>` — the
 * same format the viewer puts on those elements, so a remark made on screen and a
 * finding counted here are the same thing. Reordering across a regeneration is what
 * `anchor.rebound` is for; a key is not a content hash.
 */
export function mapFindings(rm) {
  const out = []
  ;(rm.standards || []).forEach((s, i) => {
    if (s.severity === 'warn') out.push({ key: `finding:${i}`, kind: 'finding', text: s.finding, file: s.file || null })
  })
  ;(rm.tests?.gaps || []).forEach((g, i) => out.push({ key: `gap:${i}`, kind: 'gap', text: g, file: null }))
  ;(rm.userStories?.stories || []).forEach((s, i) => {
    if (s.status !== 'delivered') out.push({ key: `story:${i}`, kind: 'story', text: s.story, file: (s.files || [])[0] || null })
  })
  return out
}

/**
 * Every place in a map that a remark can attach to, with the text that identifies
 * it — the offer side of rebinding. Keys match what the viewer stamps on those
 * elements, which is what lets a script decide whether a note's place still exists.
 *
 * Left out on purpose: multi-block selections (`blocks:1+2`), single diagram nodes
 * (`diagram:0:label`) and `unanchored`. Their identity is not derivable from the
 * map alone, so rebinding would be guessing — they are never touched.
 */
export function anchorOffers(rm) {
  const out = []
  ;(rm.userStories?.stories || []).forEach((s, i) => out.push({ key: `story:${i}`, kind: 'story', text: s.story }))
  ;(rm.standards || []).forEach((s, i) => {
    if (s.severity === 'warn') out.push({ key: `finding:${i}`, kind: 'finding', text: s.finding })
  })
  ;(rm.tests?.gaps || []).forEach((g, i) => out.push({ key: `gap:${i}`, kind: 'gap', text: g }))
  ;(rm.diagrams || []).forEach((d, i) => out.push({ key: `diagram:${i}`, kind: 'diagram', text: d.title }))
  // Logic blocks are positional over the story's steps, exactly as the viewer numbers them.
  let block = 0
  for (const item of rm.story || []) {
    if (item.link) continue
    out.push({ key: `block:${block++}`, kind: 'block', text: item.text })
  }
  return out
}

const norm = (s) => String(s || '').replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim().toLowerCase()
const MIN_MATCH = 12

/** Everything human-readable in a map, for deciding whether a quoted phrase survived. */
const corpusOf = (rm) => norm([
  rm.intent,
  ...(rm.story || []).flatMap(s => [s.link, s.label, s.text, ...(s.branches || []).flat()]),
  ...(rm.groups || []).flatMap(g => [g.name, g.why, g.tag]),
  ...Object.values(rm.files || {}).map(f => f.why),
  ...(rm.edges || []).map(e => e[2]),
  ...(rm.diagrams || []).flatMap(d => [d.title, d.caption]),
  ...(rm.standards || []).flatMap(s => [s.finding, s.pattern]),
  rm.tests?.summary, ...(rm.tests?.fixed || []), ...(rm.tests?.gaps || []),
  rm.userStories?.summary, ...(rm.userStories?.stories || []).flatMap(s => [s.story, s.why]),
  ...(rm.blastRadius || []).map(b => b.why), rm.ops?.note,
].filter(Boolean).join(' ␟ '))

/**
 * What regenerating the map does to the journal's anchors. Returns the events that
 * record it — never a mutation, so the caller can print the plan instead of writing.
 *
 * The rule that matters: nothing is dropped. A place that moved is rebound, a place
 * that is gone is marked `stale` with its original text intact, and a stale place
 * whose text came back is revived. The one moment a review tool has to be trusted is
 * when it says a remark no longer applies.
 */
export function planRebinds(rm, state, { mapId = null } = {}) {
  const offers = anchorOffers(rm)
  const corpus = corpusOf(rm)
  const seen = new Map()
  for (const holder of [...state.notes, ...state.tasks]) {
    const a = holder.anchor
    if (!seen.has(a.key)) seen.set(a.key, a)
  }
  const events = []
  const summary = { unchanged: 0, moved: 0, stale: 0, revived: 0, skipped: 0 }
  const matches = (stored, text) => {
    const s = norm(stored), t = norm(text)
    if (!s || !t) return false
    if (s === t) return true
    return (s.length >= MIN_MATCH && t.includes(s)) || (t.length >= MIN_MATCH && s.includes(t))
  }

  for (const [key, a] of seen) {
    const kind = key.split(':')[0]
    if (kind === 'sel') {
      // A quoted phrase has no key to move to: it either still reads somewhere in
      // the report or it does not.
      const alive = norm(a.quote || a.label).length >= MIN_MATCH && corpus.includes(norm(a.quote || a.label))
      if (alive && a.stale) { events.push({ oldKey: key, newKey: key, how: 'quote' }); summary.revived++ }
      else if (!alive && !a.stale) { events.push({ oldKey: key, how: 'stale' }); summary.stale++ }
      else summary.unchanged++
      continue
    }
    const candidates = offers.filter(o => o.kind === kind)
    if (!candidates.length && !['story', 'finding', 'gap', 'diagram', 'block'].includes(kind)) { summary.skipped++; continue }
    const stored = kind === 'block' ? (a.context || a.label) : a.label
    const hit = candidates.find(o => o.key === key && matches(stored, o.text))
      || candidates.find(o => matches(stored, o.text))
    if (!hit) {
      if (!a.stale) { events.push({ oldKey: key, how: 'stale' }); summary.stale++ } else summary.unchanged++
      continue
    }
    if (hit.key !== key) { events.push({ oldKey: key, newKey: hit.key, how: 'quote' }); summary.moved++ }
    else if (a.stale) { events.push({ oldKey: key, newKey: key, how: 'quote' }); summary.revived++ }
    else summary.unchanged++
  }
  return {
    summary,
    events: events.map(e => ({ type: 'anchor.rebound', by: 'claude', ...e, ...(mapId ? { mapId } : {}) })),
  }
}

/**
 * The completeness manifest for decisions, the counterpart of the file manifest:
 * every problem the map found either has a decision or is openly undecided. It is a
 * report, not a gate — proposals are generated on demand, so a run with none is
 * normal, and what matters is that the number is stated rather than implied.
 *
 * A finding counts as decided when something on its anchor says so: a task (of any
 * origin), a declined proposal, a `noFixNeeded`, or a reviewer decision.
 */
export function coverage(rm, state) {
  const decided = new Set()
  for (const t of state.tasks) decided.add(t.finding || t.anchor.key)
  for (const n of state.notes) {
    if (n.kind === 'decision') decided.add(n.anchor.key)
    if (n.kind === 'proposal' && n.proposal?.noFixNeeded) decided.add(n.proposal.finding || n.anchor.key)
  }
  const findings = mapFindings(rm)
  const open = findings.filter(f => !decided.has(f.key))
  return { total: findings.length, decided: findings.length - open.length, open }
}

/** The next task to work: blocking first, oldest first. */
export const nextTask = (state) => [...state.tasks]
  .filter(t => t.state === 'in_progress' || t.state === 'open')
  .sort((a, b) => (a.state === b.state ? 0 : a.state === 'in_progress' ? -1 : 1) || a.openedAt.localeCompare(b.openedAt))[0] || null

/** Everything said on a task's anchor, oldest first — the context behind its spec. */
export const threadOf = (state, task) => state.notes.filter(n => n.anchor.key === (task.threadKey || task.anchor.key))

const accLine = (a = {}) => `${a.type}: ${a.name || a.key || a.what || ''}`

// ── CLI: read and drive the journal from a terminal, without writing JS to do it ─
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2)
  const dir = resolve(args.find(a => !a.startsWith('--')) || '.whydiff')
  const mapArg = args.indexOf('--map') >= 0 ? args[args.indexOf('--map') + 1] : join(dir, 'review-map.json')
  const flag = (name) => args.indexOf(name) >= 0
  const val = (name) => (args.indexOf(name) >= 0 ? args[args.indexOf(name) + 1] : null)
  const die = (msg) => { console.error(msg); process.exit(1) }

  // Writes. Every one goes through appendEvents, so the CLI cannot record what the
  // journal would refuse — a work session gets the same rules the page gets.
  const write = (ev, said) => {
    try { appendEvents(dir, ev, { by: 'claude' }) } catch (e) { die(`refused: ${e.message}`) }
    console.log(said)
    process.exit(0)
  }
  if (flag('--start')) {
    const id = val('--start')
    write({ type: 'task.state', taskId: id, state: 'in_progress' }, `${id} → in progress`)
  }
  if (flag('--resolve')) {
    const id = val('--resolve')
    write({
      type: 'task.resolved', taskId: id, patch: val('--patch'),
      files: (val('--files') || '').split(',').map(s => s.trim()).filter(Boolean),
      commit: val('--commit') || undefined,
    }, `${id} → done, patch ${val('--patch')}`)
  }
  if (flag('--verify')) {
    // Evidence is the output of something that ran. The work skill is told never to
    // pass its own opinion here, and `story`/`finding`/`manual` criteria are not
    // its to close — see skills/whydiff-work.
    const id = val('--verify')
    write({ type: 'task.verified', taskId: id, evidence: val('--evidence') }, `${id} → verified`)
  }
  if (flag('--decline')) {
    const id = val('--decline')
    write({ type: 'task.state', taskId: id, state: 'declined', reason: val('--reason') }, `${id} → declined`)
  }
  if (flag('--report')) {
    const id = val('--report')
    const { state } = readReview(dir)
    const task = state.tasks.find(t => t.taskId === id) || die(`unknown task ${id}`)
    write({
      type: 'note.added', kind: 'report', anchor: task.anchor, taskId: id, text: val('--text'),
    }, `noted on ${id}`)
  }

  const { state, skipped } = readReview(dir)
  let cov = null
  if (existsSync(mapArg)) {
    try { cov = coverage(JSON.parse(readFileSync(mapArg, 'utf8')), state) } catch {}
  }
  if (args.includes('--json')) {
    process.stdout.write(JSON.stringify(cov ? { ...state, coverage: cov } : state, null, 1) + '\n')
  } else if (flag('--next') || flag('--thread')) {
    // What a work session needs and nothing else: one task, its criterion, and the
    // discussion that produced it.
    const task = flag('--thread')
      ? state.tasks.find(t => t.taskId === val('--thread')) || die(`unknown task ${val('--thread')}`)
      : nextTask(state)
    if (!task) { console.log('nothing to work: no open task in the journal'); process.exit(0) }
    console.log(`task     ${task.taskId} (${task.state})`)
    console.log(`spec     ${task.spec}`)
    console.log(`proof    ${accLine(task.acceptance)}`)
    console.log(`place    ${task.anchor.label || task.anchor.key}${task.anchor.stale ? ' [stale: its place in the report is gone]' : ''}`)
    if (task.anchor.files?.length) console.log(`files    ${task.anchor.files.join(', ')}`)
    if (task.finding) console.log(`finding  ${task.finding}`)
    if (task.resolution) console.log(`patch    ${task.resolution.patch}`)
    console.log('discussion:')
    for (const n of threadOf(state, task)) {
      console.log(`  [${n.by} ${n.kind}] ${n.text.replace(/\s+/g, ' ').slice(0, 400)}`)
      for (const v of n.proposal?.variants || []) console.log(`    (${v.kind}) ${v.what} — ${accLine(v.acceptance)}`)
    }
  } else {
    const c = state.counts
    console.log(`review journal: ${join(dir, REVIEW_LOG)}`)
    console.log(`  notes    ${c.notes} (${c.questions} question(s), ${c.unanswered} unanswered)`)
    console.log(`  tasks    ${c.tasks} — blocking ${c.blocking} · proposed ${c.proposed} · open ${c.open} · in progress ${c.in_progress} · done ${c.done} · verified ${c.verified} · declined ${c.declined}`)
    console.log(`  maps     ${state.maps.length}`)
    if (cov) {
      console.log(`  decided  ${cov.decided} of ${cov.total} finding(s) the map reported`)
      for (const f of cov.open) console.log(`    · ${f.key} ${f.text.slice(0, 78)}`)
    }
    if (state.rebinds.length) console.log(`  rebinds  ${state.rebinds.length}`)
    if (state.unknown.length) console.log(`  unknown  ${state.unknown.length} event(s) from a newer whydiff, kept as-is`)
    if (skipped) console.log(`  skipped  ${skipped} unparseable line(s)`)
  }
}
