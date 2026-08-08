#!/usr/bin/env node
// One button to cut a release. main is protected, so a release rides a PR:
// this bumps the version on a chore/release-X.Y.Z branch and opens the PR;
// you merge it (squash) and the marketplace picks up the new version.
//
// Usage: node scripts/release.mjs <patch|minor|major|X.Y.Z> [--headline "..."]
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const rootDir = join(dirname(fileURLToPath(import.meta.url)), '..')
const run = (cmd, args, opts = {}) => execFileSync(cmd, args, { cwd: rootDir, stdio: 'inherit', ...opts })
const cap = (cmd, args) => { try { return execFileSync(cmd, args, { cwd: rootDir, encoding: 'utf8' }).trim() } catch { return null } }
const die = (m) => { console.error('✗ release: ' + m); process.exit(1) }
const step = (m) => console.log('\n▶ ' + m)

const bump = process.argv[2]
if (!bump) die('usage: release.mjs <patch|minor|major|X.Y.Z> [--headline "..."]')
const hi = process.argv.indexOf('--headline')
const headline = hi !== -1 ? process.argv[hi + 1] : ''

// ── guards ───────────────────────────────────────────────────────────────────
step('preflight')
if (cap('git', ['rev-parse', '--abbrev-ref', 'HEAD']) !== 'main') die('run from main (it holds the merged work being released)')
if (cap('git', ['status', '--porcelain'])) die('working tree not clean — commit or stash first')
// whydiff is pushed from the personal account only (two-identity setup).
const email = cap('git', ['config', 'user.email']) || ''
if (!/smagew/.test(email)) die(`git user.email is "${email}", expected the smagew identity for whydiff`)
run('git', ['fetch', 'origin', 'main', '--quiet'])
if (cap('git', ['rev-parse', 'HEAD']) !== cap('git', ['rev-parse', 'origin/main'])) die('local main is not in sync with origin/main — pull/push first')

// ── checks ─────────────────────────────────────────────────────────────────--
step('make check')
run('make', ['check'])

// ── private-data leak scan (hydron is the private polygon; never ships) ───────
step('leak scan')
const tracked = cap('git', ['ls-files']).split('\n').filter(Boolean).filter(f => !f.startsWith('node_modules/'))
const hits = []
for (const f of tracked) {
  let t = ''
  try { t = readFileSync(join(rootDir, f), 'utf8') } catch { continue }
  if (/hydron/i.test(t)) hits.push(f)
}
if (hits.length) die('possible private ("hydron") references in:\n' + hits.map(f => '    ' + f).join('\n'))

// ── bump ───────────────────────────────────────────────────────────────────--
step('bump version + date changelog')
run('node', ['scripts/version.mjs', bump])
const ver = (readFileSync(join(rootDir, '.claude-plugin/plugin.json'), 'utf8').match(/"version":\s*"([^"]+)"/) || [])[1]
const branch = `chore/release-${ver}`

// ── branch, commit, push, PR ─────────────────────────────────────────────────
step(`branch ${branch} + commit + push`)
run('git', ['checkout', '-b', branch])
run('git', ['add', '.claude-plugin/plugin.json', 'package.json', '.claude-plugin/marketplace.json', 'CHANGELOG.md'])
const subject = `${ver}: ${headline || 'release'}`
run('git', ['commit', '-m', subject, '-m', 'Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>'])
run('git', ['push', '-u', 'origin', branch])

step('open PR')
// whydiff is a personal (smagew) repo; never open a PR from the work account that
// gh might be signed into. Only auto-create when gh is smagew.
const ghUser = cap('gh', ['--version']) ? cap('gh', ['api', 'user', '--jq', '.login']) : null
if (ghUser && /smagew/i.test(ghUser)) {
  run('gh', ['pr', 'create', '--base', 'main', '--head', branch, '--title', subject,
    '--body', `Release ${ver}. Merge (squash) to publish; the marketplace picks up the new version.`])
  console.log(`\n✓ release PR opened for ${ver}. Merge it, then: git tag v${ver} && git push origin v${ver}`)
} else {
  const why = ghUser ? `gh is signed in as "${ghUser}", not smagew` : 'gh not available'
  console.log(`\n✓ pushed ${branch} (${why}). Open the PR into main manually:`)
  console.log(`    https://github.com/smagew/whydiff/pull/new/${branch}`)
}
