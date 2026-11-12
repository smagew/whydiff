#!/usr/bin/env node
// Contract test for scripts/timing.mjs report: every stretch of a run lands in a
// named phase. The model's review of the merged map used to hide inside
// "Validation + fixes" (22s of a 58s run looked like a slow validator), so it is
// now its own phase, bounded by the `review_done` event the skill logs.

import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
let failures = 0
const check = (ok, msg) => { if (!ok) { console.error(`FAIL: ${msg}`); failures++ } }

const report = (events) => {
  const repo = mkdtempSync(join(tmpdir(), 'whydiff-timing-'))
  mkdirSync(join(repo, '.whydiff'))
  const t0 = 1_700_000_000_000
  writeFileSync(join(repo, '.whydiff', 'timing.jsonl'), events.map(([s, event]) => JSON.stringify({ t: t0 + s * 1000, event, meta: {} })).join('\n') + '\n')
  execFileSync(process.execPath, [join(root, 'scripts', 'timing.mjs'), 'report', '--repo', repo], { stdio: 'ignore' })
  return readFileSync(join(repo, '.whydiff', 'timing-report.md'), 'utf8')
}
const row = (md, phase) => md.split('\n').find((l) => l.startsWith(`| ${phase} |`))

const base = [[0, 'run_start'], [0.1, 'deterministic_done'], [5, 'briefing_done'], [5.2, 'agents_spawned'], [33, 'agents_done'], [34, 'map_written']]

// With review_done: the 22s review is its own phase, validation is only the script.
const md = report([...base, [56, 'review_done'], [56.5, 'validate_pass'], [58.5, 'assembled']])
check(/\| 22\.0s \|/.test(row(md, 'Main model: review the merged map') || ''), `review phase should be 22.0s:\n${row(md, 'Main model: review the merged map')}`)
check(/\| 0\.5s \|/.test(row(md, 'Validation + fixes') || ''), `validation should be 0.5s once review is split out:\n${row(md, 'Validation + fixes')}`)
check(!/Unattributed/.test(md), 'nothing should be unattributed when every boundary was logged')

// No validate after the review (merge already validated): the review still shows,
// and the assemble span starts from the review, not from map_written.
const md2 = report([...base, [56, 'review_done'], [58, 'assembled']])
check(/\| 22\.0s \|/.test(row(md2, 'Main model: review the merged map') || ''), 'review phase without a validate step')
check(/\| 2\.0s \|/.test(row(md2, 'Assemble HTML') || ''), `assemble should start at review_done:\n${row(md2, 'Assemble HTML')}`)
check(!/Unattributed/.test(md2), 'no gap when validation was skipped')

if (failures) { console.error(`\ntiming: ${failures} failure(s)`); process.exit(1) }
console.log('OK: timing report (model review is its own phase; validation and assemble measured after it)')
