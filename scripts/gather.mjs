#!/usr/bin/env node
// One-shot deterministic gather for a /whydiff run: create .whydiff/, log the
// run_start and deterministic_done timing events, write manifest.json and
// diff.patch, and print a short summary. Folding step 1's four commands into a
// single bundled script means the run opens with ONE auto-approved command
// instead of an `&&` chain the permission prompt cannot recognise.
//
//   node scripts/gather.mjs --repo <path> [--ref <rev-or-range>]
//
// Without --ref: working tree vs HEAD (untracked included). With --ref: anything
// `git diff <ref>` accepts. Measurement is a side effect only — never let it
// change what the pipeline analyzes.

import { execFileSync } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { collectManifest, logTiming } from './lib.mjs'

const args = process.argv.slice(2)
const opt = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : null }
const repo = resolve(opt('--repo') || '.')
const ref = opt('--ref') || undefined
const dir = join(repo, '.whydiff')

mkdirSync(dir, { recursive: true })
logTiming(dir, 'run_start', { ref: ref || 'working tree' }, { create: true })

const { rows, totals } = collectManifest(repo, ref)
writeFileSync(join(dir, 'manifest.json'), JSON.stringify({ repo, ref: ref || 'working tree', totals, rows }, null, 2))

const diffArgs = ['-C', repo, 'diff', ...(ref ? [ref] : [])]
const patch = execFileSync('git', diffArgs, { maxBuffer: 256 * 1024 * 1024 })
writeFileSync(join(dir, 'diff.patch'), patch)

logTiming(dir, 'deterministic_done', {})

// Summary, so the model does not need a follow-up `node -e` to read the manifest.
const patchLines = patch.toString('utf8').split('\n').length
console.log(`manifest: ${rows.length} files (${totals.filesChanged} mod. + ${totals.filesNew} new) · +${totals.added}/-${totals.deleted} lines · diff.patch ${patchLines} lines · ref ${ref || 'working tree'}`)
for (const r of rows) console.log(`  ${r[0]}  +${r[1]}/-${r[2]}${r[3] ? '  NEW' : ''}`)
