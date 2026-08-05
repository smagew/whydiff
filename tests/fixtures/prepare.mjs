#!/usr/bin/env node
// Prepares a fixture repository for testing the plugin locally, before pushing.
//
//   node tests/fixtures/prepare.mjs --list
//   node tests/fixtures/prepare.mjs <name>
//
// A fixture is a real commit from a popular open-source repo, pinned by SHA in
// fixtures.json, fetched with --depth 2 into .fixtures/<name>. The diff to
// analyze is therefore always HEAD~1..HEAD. Our own manifest is cross-checked
// against the GitHub stats recorded in fixtures.json, so preparing a fixture
// also verifies that manifest.mjs counts what GitHub counts.

import { readFileSync, existsSync, mkdirSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { join, dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { collectManifest } from '../../scripts/lib.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const root = resolve(here, '..', '..')
const reg = JSON.parse(readFileSync(join(here, 'fixtures.json'), 'utf8')).fixtures
const args = process.argv.slice(2)

if (!args.length || args[0] === '--list') {
  const w = Math.max(...Object.keys(reg).map((k) => k.length))
  console.log('Fixtures (make fixture-<name> / make run-<name>):\n')
  for (const [name, f] of Object.entries(reg)) {
    const size = f.expect ? `${f.expect.files} files, +${f.expect.added}/-${f.expect.deleted}` : 'generated'
    console.log(`  ${name.padEnd(w)}  ${f.repo || 'local'} — ${size}`)
    console.log(`  ${' '.repeat(w)}  ${f.title}`)
    console.log(`  ${' '.repeat(w)}  ${f.why}\n`)
  }
  process.exit(0)
}

const name = args[0]
const f = reg[name]
if (!f) { console.error(`unknown fixture: ${name}\nknown: ${Object.keys(reg).join(', ')}`); process.exit(1) }

const dir = join(root, '.fixtures', name)
const run = (cmd, cmdArgs, cwd) => execFileSync(cmd, cmdArgs, { cwd, stdio: ['ignore', 'pipe', 'inherit'], encoding: 'utf8' })

if (f.generator) {
  execFileSync('node', [join(root, f.generator), dir], { stdio: 'inherit' })
} else {
  const at = (d) => (p) => run('git', ['-C', d, ...p])
  if (existsSync(join(dir, '.git'))) {
    const head = at(dir)(['rev-parse', 'HEAD']).trim()
    if (head === f.sha) {
      console.log(`${name}: already at ${f.sha.slice(0, 10)} (${dir})`)
    } else {
      console.log(`${name}: re-fetching ${f.sha.slice(0, 10)}…`)
      at(dir)(['fetch', '--depth', '2', 'origin', f.sha])
      at(dir)(['checkout', '--force', '--detach', f.sha])
    }
  } else {
    mkdirSync(dir, { recursive: true })
    console.log(`${name}: fetching ${f.repo} @ ${f.sha.slice(0, 10)} (2 commits only)…`)
    run('git', ['init', '--quiet', dir])
    at(dir)(['remote', 'add', 'origin', `https://github.com/${f.repo}.git`])
    at(dir)(['fetch', '--depth', '2', 'origin', f.sha])
    at(dir)(['checkout', '--quiet', '--detach', f.sha])
  }

  // Cross-check our manifest against the GitHub stats recorded at pinning time.
  const { totals } = collectManifest(dir, 'HEAD~1..HEAD')
  const got = { files: totals.filesChanged + totals.filesNew, added: totals.added, deleted: totals.deleted }
  const bad = Object.entries(f.expect).filter(([k, v]) => got[k] !== v)
  if (bad.length) {
    console.error(`\nMANIFEST MISMATCH for ${name}: expected ${JSON.stringify(f.expect)}, got ${JSON.stringify(got)}`)
    console.error('Either manifest.mjs regressed, or the pinned expectations need updating.')
    process.exit(1)
  }
  console.log(`manifest cross-check OK: ${got.files} files, +${got.added}/-${got.deleted}`)
}

console.log(`
${name} ready: ${dir}
  ${f.title}

Run the plugin against it (from a terminal):
  cd ${dir} && claude --plugin-dir ${root}
  > /whydiff HEAD~1..HEAD

Then look at the timing:
  node ${join(root, 'scripts', 'timing.mjs')} report --repo ${dir} && cat ${join(dir, '.whydiff', 'timing-report.md')}`)
