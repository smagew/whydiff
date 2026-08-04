#!/usr/bin/env node
// Prints the deterministic diff manifest as JSON.
//
//   node scripts/manifest.mjs --repo <path> [--ref <rev-or-range>]
//
// Without --ref: working tree vs HEAD, untracked files included (isNew: true).
// With --ref: anything `git diff <ref>` accepts ("HEAD~3", "main..feat", a SHA).

import { collectManifest } from './lib.mjs'

const args = process.argv.slice(2)
const opt = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : null }
const repo = opt('--repo') || process.cwd()
const ref = opt('--ref') || undefined

const { rows, totals } = collectManifest(repo, ref)
console.log(JSON.stringify({ repo, ref: ref || 'working tree', totals, rows }, null, 2))
