#!/usr/bin/env node
// Contract test for the eval grader (evals/_lib/grade.mjs): a grader is only worth
// its score if it FAILS on a wrong map. So: a known-good map of the synthetic fixture
// scores 1.0, and each deliberately broken copy fails exactly the check that guards
// that kind of mistake. No LLM, no network — runs in `npm test`.

import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { grade } from '../evals/_lib/grade.mjs'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const good = JSON.parse(readFileSync(join(root, 'tests/fixtures/eval/synthetic-map.json'), 'utf8'))
const expect = JSON.parse(readFileSync(join(root, 'evals/synthetic/expect.json'), 'utf8'))

let failures = 0
const check = (ok, msg) => { if (!ok) { console.error(`FAIL: ${msg}`); failures++ } }
const clone = () => structuredClone(good)
const failed = (map) => grade(map, expect).checks.filter((c) => !c.pass).map((c) => c.name)

// The reference map is right on every count.
const base = grade(good, expect)
check(base.score === 1, `good map should score 1.0, got ${base.passed}/${base.total}: ${failed(good).join('; ')}`)

// Each mutation is a real way a map can be wrong; the named check must catch it.
const cases = [
  ['every file dumped in one group', (m) => {
    const files = m.groups.flatMap((g) => g.files)
    m.groups = [{ id: 'all', name: 'All', role: 'read', why: '', files }]
  }, /different groups/],
  ['the env vars nothing reads are missing from ops', (m) => { m.ops.env = [] }, /ops\.env lists REFUND_MAX_CENTS/],
  ['an edge points at a file that does not exist', (m) => { m.edges.push(['src/made-up.ts', 'worker/src/db.ts', 'imports']) }, /invented path/],
  ['an edge with no reason', (m) => { m.edges[0][2] = ' ' }, /edge says why/],
  ['the schema diagram is gone', (m) => { m.diagrams = m.diagrams.filter((d) => d.kind !== 'er-diff') }, /er-diff diagram/],
  ['a diff file is missing from the map', (m) => { m.manifest = m.manifest.filter((r) => r[0] !== 'docs/refunds.md') }, /covers every diff file/],
  ['a file outside the diff is listed', (m) => { m.manifest.push(['README.md', 1, 0, 'spec', false]) }, /no file outside the diff/],
  // Scrub the word everywhere the map could carry it, not just the obvious fields.
  ['the undefined payout() is never mentioned', (m) => JSON.parse(JSON.stringify(m).replace(/payout/gi, 'settlement')),
    /payout\(\) is called but never defined/],
  ['the destructive column drop is not flagged', (m) => {
    m.ops.migrations = ['db/migrations/0002_refunds.sql — adds the refunds table.']
  }, /ops\.migrations mentions \/drop/],
]
for (const [what, mutate, guard] of cases) {
  const c = clone()
  const m = mutate(c) || c
  const names = failed(m)
  check(names.some((n) => guard.test(n)), `"${what}" should fail ${guard}, failed instead: ${names.join('; ') || 'nothing'}`)
}

// Phantom-path check accepts a real repo file outside the diff only when --repo says it exists.
const m = clone()
m.edges.push(['package.json', 'worker/src/db.ts', 'depends on'])
check(failed(m).some((n) => /invented path/.test(n)), 'an unknown path without --repo must count as invented')
check(grade(m, expect, { repo: root }).checks.find((c) => /invented path/.test(c.name)).pass,
  'a path that exists in the repo must not count as invented')

// A classifier has emitted ops entries as {name, note} objects instead of strings
// (seen on the migration fixture). The grader judges what they SAY, in either form.
const objOps = clone()
objOps.ops.migrations = [{ name: 'db/migrations/0002_refunds.sql', note: 'creates refunds; DROP COLUMN status loses every order status — no backfill' }]
const objFails = failed(objOps).filter((n) => /ops\.migrations/.test(n))
check(!objFails.length, `object-form migrations must be read by content, failed: ${objFails.join('; ')}`)

if (failures) { console.error(`\neval-grade: ${failures} failure(s)`); process.exit(1) }
console.log(`eval-grade: OK (good map ${base.passed}/${base.total}, ${cases.length} broken maps caught)`)
