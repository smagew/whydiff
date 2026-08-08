#!/usr/bin/env node
// Bump the whydiff version everywhere it lives, and open a dated CHANGELOG entry.
//
// Usage: node scripts/version.mjs <patch|minor|major|X.Y.Z> [--note "one-line summary"]
//
// The plugin cache is keyed by version: unless plugin.json changes, installed
// users keep the old assembled template no matter what merged to main. So a
// shipped change and its version bump ride together in the same PR — this script
// bumps the four places the version lives and seeds the changelog section you fill
// in before committing.
import { readFileSync, writeFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const rootDir = join(dirname(fileURLToPath(import.meta.url)), '..')
// plugin.json is the source of truth — assemble.mjs stamps its version into the map.
const VERSION_FILES = ['.claude-plugin/plugin.json', 'package.json', '.claude-plugin/marketplace.json']
const CHANGELOG = 'CHANGELOG.md'

const read = (p) => readFileSync(join(rootDir, p), 'utf8')
const write = (p, s) => writeFileSync(join(rootDir, p), s)

const current = () => {
  const m = read(VERSION_FILES[0]).match(/"version":\s*"(\d+)\.(\d+)\.(\d+)"/)
  if (!m) throw new Error(`no semver "version" in ${VERSION_FILES[0]}`)
  return m.slice(1, 4).map(Number)
}
const next = (arg, [maj, min, pat]) => {
  if (arg === 'major') return `${maj + 1}.0.0`
  if (arg === 'minor') return `${maj}.${min + 1}.0`
  if (arg === 'patch') return `${maj}.${min}.${pat + 1}`
  if (/^\d+\.\d+\.\d+$/.test(arg)) return arg
  throw new Error(`bump must be patch|minor|major|X.Y.Z, got "${arg}"`)
}

const arg = process.argv[2]
if (!arg) { console.error('usage: version.mjs <patch|minor|major|X.Y.Z> [--note "…"]'); process.exit(1) }
const ni = process.argv.indexOf('--note')
const note = ni !== -1 ? process.argv[ni + 1] : ''

const cur = current()
const curStr = cur.join('.')
const ver = next(arg, cur)
if (ver === curStr) { console.error(`already at ${ver}`); process.exit(1) }

// Replace only the exact current version string, so file formatting is untouched.
for (const f of VERSION_FILES) {
  const before = read(f)
  const after = before.replace(`"version": "${curStr}"`, `"version": "${ver}"`)
  if (after === before) throw new Error(`did not find "version": "${curStr}" in ${f}`)
  write(f, after)
}

// Insert a dated section above the newest existing version heading.
const today = new Date().toISOString().slice(0, 10)
const log = read(CHANGELOG)
const at = log.indexOf('\n## [')
if (at === -1) throw new Error('CHANGELOG.md has no "## [version]" section to insert above')
const bullet = note || 'TODO: describe the change'
const section = `\n## [${ver}] — ${today}\n\n### Changed\n- ${bullet}\n`
write(CHANGELOG, log.slice(0, at) + section + log.slice(at))

console.log(`${curStr} → ${ver}`)
console.log(`bumped ${VERSION_FILES.join(', ')} and opened CHANGELOG.md [${ver}]`)
if (!note) console.log('→ fill in the CHANGELOG bullet before committing')
