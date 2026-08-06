#!/usr/bin/env node
// Contract test for scripts/shards.mjs: the split must be balanced by expected
// output volume, cover every file exactly once, and say so when the input cannot
// fit the budget at all.

import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const repo = mkdtempSync(join(tmpdir(), 'whydiff-shards-'))
const git = (...a) => execFileSync('git', ['-C', repo, ...a], { encoding: 'utf8' })

let failures = 0
const check = (ok, msg) => { if (!ok) { console.error(`FAIL: ${msg}`); failures++ } }

git('init', '-q')
git('config', 'user.email', 't@e.com')
git('config', 'user.name', 't')
writeFileSync(join(repo, 'seed.txt'), 'x\n')
git('add', '-A')
git('commit', '-qm', 'base')

// 40 ordinary files plus one huge generated blob — the shape that used to put a
// whole shard's wall-clock into files nobody reads.
for (let i = 0; i < 40; i++) writeFileSync(join(repo, `file${String(i).padStart(2, '0')}.ts`), `export const v${i} = ${i}\n`.repeat(5))
writeFileSync(join(repo, 'generated.json'), 'x\n'.repeat(50000))   // too big to be substantive on its own
writeFileSync(join(repo, 'vendor.lock'), 'dep\n'.repeat(500))      // normal size, skipped by name

// The plan must land outside the repo — writing it inside would add an untracked
// file to the very diff being planned.
const planDir = mkdtempSync(join(tmpdir(), 'whydiff-plans-'))
const run = (...extra) => {
  const out = join(planDir, 'plan.json')
  execFileSync('node', [join(root, 'scripts', 'shards.mjs'), '--repo', repo, '--out', out, ...extra],
    { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] })
  return JSON.parse(readFileSync(out, 'utf8'))
}

// ── a budget that needs several shards ────────────────────────────────────────
const plan = run('--budget', '120', '--max-shards', '10')
const all = plan.shards.flatMap(s => s.files)

check(plan.shards.length > 1, `a 42-file diff at a 120s budget should shard, got ${plan.shards.length}`)
check(plan.substantiveFiles === 41,
  `a 50k-line blob must not count as substantive, expected 41 got ${plan.substantiveFiles}`)
check(all.length === plan.files, `shards must cover every file: ${all.length} of ${plan.files}`)
check(new Set(all).size === all.length, 'a file must appear in exactly one shard')

const est = plan.shards.map(s => s.estSeconds)
const spread = Math.max(...est) / Math.min(...est)
check(spread <= 1.35, `shards must be balanced, got estimates ${JSON.stringify(est)} (spread ${spread.toFixed(2)}x)`)
check(plan.estSlowestSeconds <= 120, `slowest shard must fit the budget, got ${plan.estSlowestSeconds}s`)

// A normal-sized file the orchestrator marked generated must stop costing output.
const skipped = run('--budget', '120', '--max-shards', '10', '--skip', 'vendor.lock')
check(skipped.substantiveFiles === plan.substantiveFiles - 1,
  `--skip must drop a file from the substantive count, got ${skipped.substantiveFiles} vs ${plan.substantiveFiles}`)
check(skipped.totalBytes < plan.totalBytes, 'skipping a file must lower the estimate')

// ── a budget nothing fits ─────────────────────────────────────────────────────
const tight = run('--budget', '5', '--max-shards', '2')
check(tight.shards.length === 2, `--max-shards must cap the split, got ${tight.shards.length}`)
check(tight.estSlowestSeconds > 5, 'an impossible budget must be reported as exceeded, not silently accepted')

// ── one shard when the diff is small ──────────────────────────────────────────
const roomy = run('--budget', '3600')
check(roomy.shards.length === 1, `a generous budget needs no sharding, got ${roomy.shards.length}`)

rmSync(repo, { recursive: true, force: true })
rmSync(planDir, { recursive: true, force: true })
if (failures) { console.error(`\n${failures} check(s) failed`); process.exit(1) }
console.log(`OK: shards.mjs contract (${plan.files} files → ${plan.shards.length} balanced shards, spread ${spread.toFixed(2)}x)`)
