#!/usr/bin/env node
// Contract for scripts/run.mjs, the headless runner. `claude` is stubbed with a
// script that writes a valid map for a tiny real repo (so the runner's own steps —
// spawn, validate against the real diff, assemble, exit codes — are exercised for
// real without calling a model).

import { writeFileSync, mkdtempSync, chmodSync, existsSync, mkdirSync } from 'node:fs'
import { spawnSync, execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const fail = (m) => { console.error(`FAIL: ${m}`); process.exit(1) }
const ok = (c, m) => { if (!c) fail(m) }

// A tiny repo whose HEAD~1..HEAD diff is one file, +1/-1, not new.
const repo = mkdtempSync(join(tmpdir(), 'whydiff-runrepo-'))
const git = (...a) => execFileSync('git', ['-C', repo, ...a], { encoding: 'utf8' })
git('init', '-q'); git('config', 'user.email', 't@e'); git('config', 'user.name', 'T')
writeFileSync(join(repo, '.gitignore'), '.whydiff/\n')
writeFileSync(join(repo, 'f.txt'), 'line1\n')
git('add', '-A'); git('commit', '-qm', 'one')
writeFileSync(join(repo, 'f.txt'), 'line2\n')
git('add', '-A'); git('commit', '-qm', 'two')
writeFileSync(join(repo, 'f.txt'), 'line3\n') // an uncommitted change → the working-tree diff is also f.txt +1/-1

// A map that matches that diff, written by the stub into <repo>/.whydiff/.
const MAP = {
  meta: { project: 'run-test', ref: 'HEAD~1..HEAD', generatedAt: '2026-08-12T00:00:00Z', lang: 'en' },
  intent: 'Change the line.', story: [],
  groups: [{ id: 'g', name: 'g', role: 'read', why: 'w', files: ['f.txt'] }],
  files: { 'f.txt': { add: 1, del: 1, why: 'the change', service: 'backend' } },
  edges: [], manifest: [['f.txt', 1, 1, 'g', false]],
}

// Stubs live OUTSIDE the repo so they don't show up as untracked files in the
// working-tree diff (which would make the no-range case mismatch the map).
const stubs = mkdtempSync(join(tmpdir(), 'whydiff-runstubs-'))
const mkStub = (body) => {
  const p = join(stubs, `stub-${Math.abs([...body].reduce((a, c) => a + c.charCodeAt(0), 0))}.mjs`)
  writeFileSync(p, `#!/usr/bin/env node\n${body}\n`)
  chmodSync(p, 0o755)
  return p
}
// The happy stub: assert the runner's contract (whydiff prompt, --plugin-dir,
// stream-json), then write the map and emit the same event shapes claude -p does.
const goodStub = mkStub(`
import { writeFileSync, mkdirSync } from 'node:fs'
const a = process.argv.slice(2)
const prompt = a[a.indexOf('-p') + 1] || ''
if (!/\\/whydiff(\\s|$)/.test(prompt)) { console.error('bad prompt: ' + prompt); process.exit(3) }
if (a.indexOf('--plugin-dir') < 0) { console.error('no --plugin-dir'); process.exit(4) }
if (!a.includes('stream-json')) { console.error('no stream-json'); process.exit(5) }
mkdirSync('.whydiff', { recursive: true })
writeFileSync('.whydiff/review-map.json', ${JSON.stringify(JSON.stringify(MAP))})
const say = (o) => process.stdout.write(JSON.stringify(o) + '\\n')
say({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Task', input: { subagent_type: 'classifier' } }] } })
say({ type: 'result', subtype: 'success', result: 'Built the map.' })
`)
// A stub that only succeeds when the prompt asked for a "full" report — proves
// --full reaches the skill.
const fullStub = mkStub(`
import { writeFileSync, mkdirSync } from 'node:fs'
const a = process.argv.slice(2)
const prompt = a[a.indexOf('-p') + 1] || ''
if (!/\\bfull\\b/.test(prompt)) { console.error('prompt not full: ' + prompt); process.exit(7) }
mkdirSync('.whydiff', { recursive: true })
writeFileSync('.whydiff/review-map.json', ${JSON.stringify(JSON.stringify(MAP))})
process.stdout.write(JSON.stringify({ type: 'result', subtype: 'success', result: 'full' }) + '\\n')
`)
// A stub that finishes successfully but produces nothing.
const emptyStub = mkStub(`
const say = (o) => process.stdout.write(JSON.stringify(o) + '\\n')
say({ type: 'result', subtype: 'success', result: 'did nothing' })
`)

const run = (args) => spawnSync('node', [join(root, 'scripts', 'run.mjs'), ...args], { encoding: 'utf8' })

// ── the happy path: run → validate against the real diff → assemble → OK ─────
{
  const r = run([repo, 'HEAD~1..HEAD', '--claude-cmd', goodStub, '--plugin-dir', root])
  ok(r.status === 0, `happy run exited ${r.status}: ${r.stderr}`)
  ok(/OK: 1 files, 1 groups/.test(r.stdout), `the summary is missing: ${r.stdout}`)
  ok(existsSync(join(repo, '.whydiff', 'review-map.html')), 'the portable HTML was not assembled')
  ok(/· Task classifier/.test(r.stderr), `per-step progress was not streamed: ${r.stderr}`)
}

// ── no range = the working tree (whydiff's default): validates with no --ref ──
{
  execFileSync('rm', ['-rf', join(repo, '.whydiff')])
  const r = run([repo, '--claude-cmd', goodStub, '--plugin-dir', root])
  ok(r.status === 0, `working-tree run exited ${r.status}: ${r.stderr}`)
  ok(/OK: 1 files/.test(r.stdout), `working-tree summary missing: ${r.stdout}`)
  ok(/working tree/.test(r.stderr), `working-tree run should say so: ${r.stderr}`)
}

// ── --full asks the skill for every section ──────────────────────────────────
{
  execFileSync('rm', ['-rf', join(repo, '.whydiff')])
  const withFull = run([repo, 'HEAD~1..HEAD', '--full', '--claude-cmd', fullStub, '--plugin-dir', root, '--no-assemble', '--quiet'])
  ok(withFull.status === 0, `--full run should pass the full stub, exited ${withFull.status}: ${withFull.stderr}`)
  execFileSync('rm', ['-rf', join(repo, '.whydiff')])
  const noFull = run([repo, 'HEAD~1..HEAD', '--claude-cmd', fullStub, '--plugin-dir', root, '--quiet'])
  ok(noFull.status === 1, 'without --full the prompt should not say "full", so the full stub fails the run')
}

// ── --no-assemble skips the HTML but still validates ─────────────────────────
{
  execFileSync('rm', ['-rf', join(repo, '.whydiff')])
  const r = run([repo, 'HEAD~1..HEAD', '--claude-cmd', goodStub, '--plugin-dir', root, '--no-assemble', '--quiet'])
  ok(r.status === 0, `--no-assemble run exited ${r.status}: ${r.stderr}`)
  ok(!existsSync(join(repo, '.whydiff', 'review-map.html')), '--no-assemble still wrote the HTML')
  ok(!/· Task/.test(r.stderr), '--quiet still streamed progress')
}

// ── a run that produces no map fails with a clear message, exit 1 ────────────
{
  execFileSync('rm', ['-rf', join(repo, '.whydiff')])
  const r = run([repo, 'HEAD~1..HEAD', '--claude-cmd', emptyStub])
  ok(r.status === 1, `an empty run should exit 1, got ${r.status}`)
  ok(/produced no .+review-map\.json|no .whydiff/.test(r.stdout + r.stderr), `the failure does not explain itself: ${r.stderr}`)
}

// ── usage errors: missing repo, and a non-git path, exit 2 ───────────────────
{
  ok(run([]).status === 2, 'a missing repo should exit 2')
  const notGit = mkdtempSync(join(tmpdir(), 'whydiff-notgit-'))
  ok(run([notGit]).status === 2, 'a non-git repo should exit 2')
}

console.log('OK: run.mjs (drives claude -p /whydiff with --plugin-dir + stream-json, validates the map against the real diff, assembles the portable HTML, streams steps, and uses clear exit codes: 0 ok / 1 run-or-validate failure / 2 usage)')
