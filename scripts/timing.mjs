#!/usr/bin/env node
// Timing instrumentation for the /whydiff pipeline.
//
//   timing.mjs log <event> [--repo <path>] [--meta k=v ...]   append an event
//   timing.mjs report [--repo <path>]                          write timing-report.md
//
// Events go to <repo>/.whydiff/timing.jsonl with a script-side timestamp, so
// wall-clock math never depends on the model. `report` summarizes the LAST run
// (everything after the most recent run_start) into a markdown file the user
// can share when discussing performance.
//
// Measurement only: this must never change what the pipeline analyzes.

import { readFileSync, writeFileSync, existsSync, statSync, readdirSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { logTiming } from './lib.mjs'

const args = process.argv.slice(2)
const cmd = args[0]
const opt = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : null }
const repo = resolve(opt('--repo') || '.')
const dir = join(repo, '.whydiff')

if (cmd === 'log') {
  const event = args[1]
  if (!event || event.startsWith('--')) { console.error('usage: timing.mjs log <event> [--repo <path>] [--meta k=v ...]'); process.exit(1) }
  const meta = {}
  for (let i = 0; i < args.length; i++) {
    if (args[i] !== '--meta') continue
    for (let j = i + 1; j < args.length && !args[j].startsWith('--'); j++) {
      const eq = args[j].indexOf('=')
      if (eq > 0) meta[args[j].slice(0, eq)] = args[j].slice(eq + 1)
    }
  }
  logTiming(dir, event, meta, { create: true })
  console.log(`logged: ${event}`)
  process.exit(0)
}

if (cmd !== 'report') {
  console.error('usage: timing.mjs log|report [--repo <path>]')
  process.exit(1)
}

// ── report ────────────────────────────────────────────────────────────────────
const logPath = join(dir, 'timing.jsonl')
if (!existsSync(logPath)) { console.error(`no timing log at ${logPath}`); process.exit(1) }
const all = readFileSync(logPath, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l))
const lastStart = all.map((e) => e.event).lastIndexOf('run_start')
const events = all.slice(Math.max(lastStart, 0))
if (!events.length) { console.error('timing log is empty'); process.exit(1) }

const fmt = (ms) => ms >= 60000 ? `${Math.floor(ms / 60000)}m ${Math.round((ms % 60000) / 1000)}s` : `${(ms / 1000).toFixed(1)}s`
const total = events[events.length - 1].t - events[0].t
const metaStr = (m) => Object.entries(m || {}).map(([k, v]) => `${k}=${v}`).join(' ')

const lines = []
lines.push('# whydiff timing report')
lines.push('')
lines.push(`- run started: ${new Date(events[0].t).toISOString()}`)
lines.push(`- total wall-clock: **${fmt(total)}**`)
if (events[0].meta && Object.keys(events[0].meta).length) lines.push(`- run meta: ${metaStr(events[0].meta)}`)
lines.push('')
lines.push('## Timeline (each step = time since the previous event)')
lines.push('')
lines.push('| # | event | step took | share | meta |')
lines.push('|---|---|---|---|---|')
for (let i = 0; i < events.length; i++) {
  const delta = i === 0 ? 0 : events[i].t - events[i - 1].t
  const share = total ? `${Math.round((delta / total) * 100)}%` : '—'
  lines.push(`| ${i} | ${events[i].event} | ${i === 0 ? '—' : fmt(delta)} | ${i === 0 ? '—' : share} | ${metaStr(events[i].meta)} |`)
}
lines.push('')

// Aggregates for the phases we know about.
const at = (name) => events.find((e) => e.event === name)?.t
const span = (a, b) => (at(a) !== undefined && at(b) !== undefined ? at(b) - at(a) : null)
const agg = [
  ['Deterministic data (manifest + diff)', span('run_start', 'deterministic_done')],
  ['Main model: read diff, build briefing', span('deterministic_done', 'briefing_done')],
  ['Parallel agents (wall-clock of slowest)', span('agents_spawned', 'agents_done')],
  ['Merge into review-map.json (merge.mjs + fixes)', span('agents_done', 'map_written')],
]
const validates = events.filter((e) => e.event === 'validate_pass' || e.event === 'validate_fail')
const lastValidate = validates.length ? validates[validates.length - 1].t : undefined
if (at('map_written') !== undefined && lastValidate !== undefined) {
  agg.push(['Validation + fixes', lastValidate - at('map_written')])
}
if (at('assembled') !== undefined) {
  const from = lastValidate ?? at('map_written')
  if (from !== undefined) agg.push(['Assemble HTML', at('assembled') - from])
}
lines.push('## Phase summary')
lines.push('')
lines.push('| phase | duration | share of total |')
lines.push('|---|---|---|')
let attributed = 0
const missing = []
for (const [name, ms] of agg) {
  if (ms === null) { missing.push(name); lines.push(`| ${name} | not measured | — |`); continue }
  attributed += ms
  lines.push(`| ${name} | ${fmt(ms)} | ${Math.round((ms / total) * 100)}% |`)
}
lines.push('')
// A phase whose boundary event was never logged used to vanish from this table,
// which silently understated the run. Say what is unaccounted for instead.
const gap = total - attributed
if (gap > 1000) {
  lines.push(`Unattributed: **${fmt(gap)}** (${Math.round((gap / total) * 100)}% of the run)` +
    (missing.length ? ` — no boundary event for: ${missing.join(', ')}.` : '.'))
  lines.push('')
}
if (validates.length) {
  lines.push(`Validation iterations: ${validates.length} (${validates.map((v) => `${v.meta?.errors ?? '?'} errors`).join(' → ')})`)
  lines.push('')
}

// Artifact sizes, straight from disk — no model estimates.
lines.push('## Artifacts')
lines.push('')
const sizeOf = (p) => { try { return statSync(p).size } catch { return null } }
const kb = (b) => b === null ? 'n/a' : `${Math.round(b / 1024)} KB`
lines.push(`- diff.patch: ${kb(sizeOf(join(dir, 'diff.patch')))}`)
lines.push(`- review-map.json: ${kb(sizeOf(join(dir, 'review-map.json')))}`)
const htmls = existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith('.html')) : []
for (const h of htmls) lines.push(`- ${h}: ${kb(sizeOf(join(dir, h)))}`)
const mapPath = join(dir, 'review-map.json')
if (existsSync(mapPath)) {
  try {
    const rm = JSON.parse(readFileSync(mapPath, 'utf8'))
    lines.push(`- map contents: ${Object.keys(rm.files || {}).length} files, ${(rm.groups || []).length} groups, ${(rm.diagrams || []).length} diagrams, ${(rm.standards || []).length} standards findings, ${(rm.edges || []).length} edges`)
  } catch {}
}
lines.push('')

const out = join(dir, 'timing-report.md')
writeFileSync(out, lines.join('\n'))
console.log(`OK: ${out} (total ${fmt(total)}, ${events.length} events)`)
