#!/usr/bin/env node
// Plans how to split the classifier pass across shards so the SLOWEST shard fits
// a wall-clock budget.
//
//   node scripts/shards.mjs --repo <path> [--ref <spec>] [--budget <sec>] [--skip a,b]
//
// Why a script: a classifier's wall-clock is set by how many bytes it writes, and
// nothing else. Measured across the three shards of one instrumented run, all
// three produced 102–119 bytes/sec — so time is predictable from output volume,
// and splitting by "service area" (the old advice) produced a 17x imbalance:
// 5 KB in one shard against 86 KB in another, with the run waiting on the latter.
//
// The estimate is a planning heuristic calibrated on that run, not a law. Output
// per file turned out to be roughly constant and almost independent of how many
// lines changed — a 128k-line generated JSON gets a one-line description just like
// a 3-line config edit. So the model is: every file costs a base, and every
// file a reviewer will actually read costs a lot more.

import { writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { collectManifest, WORKDIR } from './lib.mjs'

const args = process.argv.slice(2)
const opt = (name, dflt) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : dflt }
const num = (name, dflt) => Number(opt(name, dflt))

const repo = resolve(opt('--repo', '.'))
const ref = opt('--ref') || undefined
const budget = num('--budget', 300)          // seconds allowed for the slowest shard
const rate = num('--rate', 110)              // bytes/sec of generated output (measured)
const perFile = num('--per-file', 300)       // JSON scaffolding + a one-line why
const perSubstantive = num('--per-substantive', 1600)  // a file that gets a real explanation
const maxLines = num('--max-lines', 2000)    // above this a file is generated in practice
const maxShards = num('--max-shards', 6)
const skip = new Set(String(opt('--skip', '')).split(',').map(s => s.trim()).filter(Boolean))
const outPath = opt('--out', join(repo, WORKDIR, 'shards.json'))

const { rows } = collectManifest(repo, ref)
const targetBytes = Math.round(budget * rate)

const weighed = rows.map(([path, add, del]) => {
  const lines = add + del
  const substantive = !skip.has(path) && lines > 0 && lines <= maxLines
  return { path, lines, substantive, weight: perFile + (substantive ? perSubstantive : 0) }
}).sort((a, b) => b.weight - a.weight || a.path.localeCompare(b.path))

const totalBytes = weighed.reduce((s, f) => s + f.weight, 0)
const ids = 'abcdefghij'.split('')

// Longest-processing-time first: hand each file to the lightest shard so far.
const pack = (n) => {
  const bins = Array.from({ length: n }, (_, i) => ({ id: ids[i], files: [], estBytes: 0 }))
  for (const f of weighed) {
    const lightest = bins.reduce((a, b) => (b.estBytes < a.estBytes ? b : a))
    lightest.files.push(f.path)
    lightest.estBytes += f.weight
  }
  return bins
}

// The ideal count can still overflow once real files are packed into it (a single
// heavy file cannot be split), so add shards until it fits or we run out.
let count = Math.min(maxShards, Math.max(1, Math.ceil(totalBytes / targetBytes)))
let shards = pack(count)
while (Math.max(...shards.map(s => s.estBytes)) > targetBytes && count < maxShards) {
  shards = pack(++count)
}
for (const s of shards) {
  s.files.sort()
  s.estSeconds = Math.round(s.estBytes / rate)
}

const slowest = Math.max(...shards.map(s => s.estSeconds))
const plan = {
  repo, ref: ref || 'working tree',
  rate, budgetSeconds: budget, targetBytes,
  files: weighed.length,
  substantiveFiles: weighed.filter(f => f.substantive).length,
  skipped: [...skip].filter(p => rows.some(r => r[0] === p)).length,
  totalBytes, shardCount: count,
  estSlowestSeconds: slowest,
  shards,
}

writeFileSync(outPath, JSON.stringify(plan, null, 1))

const fmt = (s) => `${Math.floor(s / 60)}m${String(s % 60).padStart(2, '0')}s`
console.log(`OK: ${outPath}`)
console.log(`${weighed.length} files (${plan.substantiveFiles} substantive) → ${count} shard(s), est. slowest ${fmt(slowest)} of ${fmt(budget)} budget`)
for (const s of shards) console.log(`  ${s.id}: ${String(s.files.length).padStart(3)} files, est. ${String(Math.round(s.estBytes / 1024)).padStart(3)} KB / ${fmt(s.estSeconds)}`)
if (slowest > budget) {
  console.error(`\nwarning: even ${count} shards do not fit the ${fmt(budget)} budget (est. ${fmt(slowest)}).`)
  console.error('Raise --max-shards, or cut the input: more paths in --skip, or a narrower diff.')
}
