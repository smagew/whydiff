#!/usr/bin/env node
// Validates a review-map.json: structural integrity plus (with --repo) a
// cross-check of the manifest against the real git diff.
//
//   node scripts/validate.mjs <review-map.json> [--repo <path>] [--ref <rev-or-range>]
//
// Exit code 0 = valid. Errors are printed one per line, prefixed with "- ".

import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { validateStructure, crossCheckManifest, logTiming } from './lib.mjs'

const args = process.argv.slice(2)
const jsonPath = args.find(a => !a.startsWith('--'))
if (!jsonPath) {
  console.error('usage: validate.mjs <review-map.json> [--repo <path>] [--ref <rev-or-range>]')
  process.exit(1)
}
const opt = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : null }
const repo = opt('--repo')
const ref = opt('--ref') || undefined

let rm
try { rm = JSON.parse(readFileSync(jsonPath, 'utf8')) } catch (e) {
  console.error(`- JSON parse error: ${e.message}`)
  process.exit(1)
}

const errors = validateStructure(rm)
if (repo) errors.push(...crossCheckManifest(rm, repo, ref))

// Timing instrumentation: appends to an existing timing.jsonl only (see lib.mjs).
logTiming(dirname(resolve(jsonPath)), errors.length ? 'validate_fail' : 'validate_pass', { errors: errors.length })

if (errors.length) {
  console.error(errors.map(e => '- ' + e).join('\n'))
  console.error(`\nFAILED: ${errors.length} error(s)`)
  process.exit(1)
}
console.log(`OK: structure valid${repo ? ', manifest matches the real diff' : ''} (${rm.manifest.length} files)`)
