#!/usr/bin/env node
// Re-attaches a review journal to a freshly generated map.
//
//   node scripts/rebind.mjs --repo <path> [--map <file>] [--dry]
//
// A map is an observation of one snapshot. Regenerate it and the places remarks were
// attached to have moved: a story is at a different index, a finding was resolved
// and is gone, a Logic block was rewritten. The journal outlives all of that, so
// something has to decide, per anchor, whether its place still exists.
//
// The rule is that nothing is dropped. A place that moved is rebound; a place that
// is gone is marked `stale` with its original text kept, so the thread still reads
// and says plainly that its home in the report is gone; a stale place whose text
// came back is revived. Silently discarding a remark is the one thing a review tool
// cannot do and stay trustworthy.
//
// Run it after merge.mjs/validate.mjs. With no journal in the repo it does nothing,
// which is why the pipeline can call it unconditionally.

import { readFileSync, existsSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { join, resolve } from 'node:path'
import { appendEvents, planRebinds, readReview, REVIEW_LOG } from './review.mjs'

const args = process.argv.slice(2)
const opt = (name, dflt = null) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : dflt }
const repo = resolve(opt('--repo') || '.')
const dir = resolve(opt('--dir') || join(repo, '.whydiff'))
const mapPath = resolve(opt('--map') || join(dir, 'review-map.json'))
const dry = args.includes('--dry')

if (!existsSync(join(dir, REVIEW_LOG))) {
  console.log(`rebind: no review journal in ${dir} — nothing to rebind`)
  process.exit(0)
}
if (!existsSync(mapPath)) {
  console.error(`rebind: no map at ${mapPath}`)
  process.exit(1)
}

const rm = JSON.parse(readFileSync(mapPath, 'utf8'))
const { state } = readReview(dir)

// The map's identity, so the journal records which observations this review has seen.
const mapId = 'm_' + createHash('sha1')
  .update([rm.meta?.project, rm.meta?.ref, rm.meta?.generatedAt].join('|'))
  .digest('hex').slice(0, 6)

const { events, summary } = planRebinds(rm, state, { mapId })
const observed = state.maps.some(m => m.mapId === mapId)
  ? []
  : [{
    type: 'map.observed', by: 'claude', mapId,
    ref: rm.meta?.ref, generatedAt: rm.meta?.generatedAt, stats: rm.meta?.stats,
  }]

const say = (line) => console.log(`  ${line}`)
console.log(`rebind: ${mapPath}`)
say(`map      ${mapId}${observed.length ? ' (new to this journal)' : ' (already recorded)'}`)
say(`anchors  ${summary.unchanged} unchanged · ${summary.moved} moved · ${summary.stale} now stale · ${summary.revived} revived${summary.skipped ? ` · ${summary.skipped} not rebindable` : ''}`)
for (const e of events) {
  say(e.how === 'stale' ? `stale    ${e.oldKey}` : `moved    ${e.oldKey} → ${e.newKey}`)
}

if (dry) { say('--dry: nothing written'); process.exit(0) }
if (!events.length && !observed.length) { say('journal already matches this map'); process.exit(0) }
try {
  appendEvents(dir, [...observed, ...events], { by: 'claude' })
} catch (e) {
  console.error(`rebind: refused — ${e.message}`)
  process.exit(1)
}
say(`written to ${join(dir, REVIEW_LOG)}`)
