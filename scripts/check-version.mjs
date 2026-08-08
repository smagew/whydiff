#!/usr/bin/env node
// The guard that would have caught the 0.10.2 miss: a shipped change with no
// version bump reaches nobody, because the plugin cache is keyed by version.
//
// Two checks:
//   1. the version string is identical across all the files that carry it;
//   2. if any file that ships in the plugin changed relative to a base ref
//      (default origin/main), then plugin.json's version must differ from the
//      base's version — i.e. the bump was not forgotten.
//
// Usage: node scripts/check-version.mjs [--base <ref>]
// Exit 0 = ok, 1 = violation. Wired into `make check`, the pre-push hook, and CI.
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFileSync } from 'node:child_process'

const rootDir = join(dirname(fileURLToPath(import.meta.url)), '..')
const VERSION_FILES = ['.claude-plugin/plugin.json', 'package.json', '.claude-plugin/marketplace.json']
// Paths whose contents end up in the assembled map / installed plugin. A change
// here is user-facing and must ride a version bump. Dev tooling below is exempt.
const WATCHED = ['templates/', 'agents/', 'skills/', 'schema/', 'hooks/', 'scripts/']
const EXEMPT = ['scripts/version.mjs', 'scripts/check-version.mjs', 'scripts/release.mjs']

const git = (...a) => { try { return execFileSync('git', a, { cwd: rootDir, encoding: 'utf8' }).trim() } catch { return null } }
const verOf = (text) => (text?.match(/"version":\s*"(\d+\.\d+\.\d+)"/) || [])[1]
const fail = (msg) => { console.error('✗ version guard: ' + msg); process.exit(1) }

// 1. all version files agree
const versions = VERSION_FILES.map(f => [f, verOf(readFileSync(join(rootDir, f), 'utf8'))])
const distinct = [...new Set(versions.map(([, v]) => v))]
if (distinct.length !== 1 || !distinct[0]) {
  fail('version strings disagree:\n' + versions.map(([f, v]) => `    ${v || '(none)'}  ${f}`).join('\n'))
}
const version = distinct[0]

// 2. shipped change since base ⇒ version must have moved
const baseArg = process.argv.indexOf('--base')
const base = baseArg !== -1 ? process.argv[baseArg + 1] : 'origin/main'
const baseSha = git('rev-parse', '--verify', '--quiet', base)
const head = git('rev-parse', 'HEAD')
if (baseSha && baseSha !== head) {
  const changed = (git('diff', '--name-only', `${base}...HEAD`) || '').split('\n').filter(Boolean)
  const shipped = changed.filter(f => WATCHED.some(w => f.startsWith(w)) && !EXEMPT.includes(f))
  if (shipped.length) {
    const baseVer = verOf(git('show', `${base}:.claude-plugin/plugin.json`) || '')
    if (baseVer && baseVer === version) {
      fail(`shipped files changed but version is still ${version} (same as ${base}).\n`
        + `    Bump it: make bump BUMP=<patch|minor|major>\n`
        + '    changed:\n' + shipped.map(f => `      ${f}`).join('\n'))
    }
  }
}

console.log(`✓ version guard: ${version} consistent` + (baseSha ? ` and bumped vs ${base} where needed` : ''))
