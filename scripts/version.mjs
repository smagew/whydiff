#!/usr/bin/env node
// Bump the whydiff version in every place it lives, and date the changelog.
//
// Usage: node scripts/version.mjs <patch|minor|major|X.Y.Z>
//
// The plugin cache is keyed by version: unless plugin.json changes, installed
// users keep the old assembled template no matter what merged to main. So the
// version is the release contract, and it lives in FOUR places that must never
// drift — this script is the only sanctioned way to move it.
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
if (!arg) { console.error('usage: version.mjs <patch|minor|major|X.Y.Z>'); process.exit(1) }

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

// Move everything under "## [Unreleased]" into a dated section, leave Unreleased empty.
const today = new Date().toISOString().slice(0, 10)
const log = read(CHANGELOG)
const head = log.indexOf('## [Unreleased]')
if (head === -1) throw new Error('CHANGELOG.md has no "## [Unreleased]" section')
const bodyStart = log.indexOf('\n', head) + 1
const nextHead = log.indexOf('\n## [', bodyStart)
const body = (nextHead === -1 ? log.slice(bodyStart) : log.slice(bodyStart, nextHead)).trim()
if (!body) throw new Error('nothing under "## [Unreleased]" to release — add changelog entries first')
const rest = nextHead === -1 ? '' : log.slice(nextHead + 1)
const rebuilt = log.slice(0, head)
  + `## [Unreleased]\n\n`
  + `## [${ver}] — ${today}\n\n${body}\n\n`
  + rest
write(CHANGELOG, rebuilt)

console.log(`${curStr} → ${ver}`)
console.log(`bumped: ${VERSION_FILES.join(', ')}, CHANGELOG.md`)
