#!/usr/bin/env node
// Hardening contract for `serve.mjs --work`, on top of tests/work.mjs:
//
//  1. Startup reclaims worktrees a killed run left behind — ours are named
//     `whydiff-work-*` — and prunes registrations whose directory is already gone.
//     It never touches a worktree that is not ours.
//  2. A patch that no longer fits the working tree is refused with a reason that
//     tells the two cases apart: it is *already applied* (nothing to do) versus the
//     *tree moved on* (re-run the task to rebase it). The gate stays clean-or-refuse;
//     no half-applied tree, no conflict markers.

import { readFileSync, writeFileSync, mkdtempSync, chmodSync, existsSync, mkdirSync, rmSync } from 'node:fs'
import { spawn, execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { appendEvents, readReview } from '../scripts/review.mjs'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const fail = (msg) => { console.error(`FAIL: ${msg}`); process.exit(1) }
const ok = (cond, msg) => { if (!cond) fail(msg) }

// ── a repo to review ─────────────────────────────────────────────────────────
const repo = mkdtempSync(join(tmpdir(), 'whydiff-hardenrepo-'))
const git = (...a) => execFileSync('git', ['-C', repo, ...a], { encoding: 'utf8' })
git('init', '-q')
git('config', 'user.email', 'test@example.com')
git('config', 'user.name', 'Test')
writeFileSync(join(repo, 'f.txt'), 'line1\nline2\nline3\nTARGET\nline5\nline6\nline7\n')
writeFileSync(join(repo, '.gitignore'), '.whydiff/\n')
git('add', '-A')
git('commit', '-qm', 'initial')

const reviewDir = join(repo, '.whydiff')
mkdirSync(reviewDir, { recursive: true })
const mapPath = join(reviewDir, 'review-map.json')
writeFileSync(mapPath, JSON.stringify({
  meta: { project: 'harden-test', ref: 'working tree', generatedAt: '2026-08-12T00:00:00Z', lang: 'en' },
  intent: 'x', story: [], groups: [{ id: 'g', name: 'g', role: 'read', why: 'w', files: ['f.txt'] }],
  files: { 'f.txt': { add: 1, del: 1, why: 'the target', service: 'backend' } },
  edges: [], manifest: [['f.txt', 1, 1, 'g', false]],
}))

const anchor = { kind: 'file', key: 'file:f.txt', label: 'f.txt', files: ['f.txt'] }
appendEvents(reviewDir, [
  { type: 'task.opened', taskId: 't_a', anchor, threadKey: 'file:f.txt', origin: 'reviewer', spec: 'Change the TARGET line.', acceptance: { type: 'manual', what: 'read it' }, state: 'open' },
  { type: 'task.opened', taskId: 't_b', anchor, threadKey: 'file:f.txt', origin: 'reviewer', spec: 'Change the TARGET line.', acceptance: { type: 'manual', what: 'read it' }, state: 'open' },
])

// A worker that makes one localized edit inside its working directory.
const stub = join(repo, 'fake-claude')
writeFileSync(stub, `#!/usr/bin/env node
import { writeFileSync, readFileSync } from 'node:fs'
const args = process.argv.slice(2)
const prompt = args[args.indexOf('-p') + 1] || ''
const say = (o) => process.stdout.write(JSON.stringify(o) + '\\n')
if (!/THE TASK/.test(prompt)) { console.error('not a work prompt'); process.exit(3) }
const out = readFileSync('f.txt', 'utf8').split('\\n').map(l => l === 'TARGET' ? 'TARGET-changed' : l).join('\\n')
writeFileSync('f.txt', out)
say({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Edit', input: { file_path: 'f.txt' } }] } })
say({ type: 'result', subtype: 'success', result: 'Changed the TARGET line.' })
`)
chmodSync(stub, 0o755)

// ── plant worktrees for the startup sweep to find ────────────────────────────
// leak1: directory + registration both present (a SIGKILL mid-run).
// leak2: registration lingers, directory already gone (a reboot wiped /tmp).
// keep : someone else's worktree — must survive untouched.
const leak1 = join(tmpdir(), 'whydiff-work-leak1-' + process.pid)
const leak2 = join(tmpdir(), 'whydiff-work-leak2-' + process.pid)
const keep = join(tmpdir(), 'keep-me-' + process.pid)
git('worktree', 'add', '--detach', '-q', leak1, 'HEAD')
git('worktree', 'add', '--detach', '-q', leak2, 'HEAD')
git('worktree', 'add', '--detach', '-q', keep, 'HEAD')
rmSync(leak2, { recursive: true, force: true })   // dir gone, registration remains

const startServer = (extra) => {
  const port = 7940 + (process.pid % 40)
  const proc = spawn('node', [join(root, 'scripts', 'serve.mjs'), '--no-open', mapPath, '--repo', repo, '--port', String(port), '--claude-cmd', stub, ...extra],
    { stdio: ['ignore', 'pipe', 'pipe'] })
  let out = ''
  proc.stdout.on('data', (d) => { out += d })
  proc.stderr.on('data', (d) => { out += d })
  return { proc, port, log: () => out }
}
const wait = async (port, log) => {
  for (let i = 0; i < 150; i++) {
    try { const r = await fetch(`http://127.0.0.1:${port}/`); if (r.ok) return } catch {}
    await new Promise(r => setTimeout(r, 100))
  }
  fail(`server did not come up on ${port}:\n${log()}`)
}

const s = startServer(['--work'])
await wait(s.port, s.log)
process.on('exit', () => { try { s.proc.kill('SIGKILL') } catch {} })
const base = `http://127.0.0.1:${s.port}`
const served = await (await fetch(base + '/')).text()
const token = served.match(/__WHYDIFF_SERVE__=\{"token":"([a-f0-9]+)"/)?.[1]
const H = { 'x-whydiff-token': token, 'content-type': 'application/json' }

// ── 1. the startup sweep ─────────────────────────────────────────────────────
const wl = git('worktree', 'list')
ok(!/whydiff-work-leak1-/.test(wl), `a leftover worktree (dir present) was not reclaimed:\n${wl}`)
ok(!/whydiff-work-leak2-/.test(wl), `a stale worktree registration (dir gone) was not pruned:\n${wl}`)
ok(!existsSync(leak1), 'the leftover worktree directory was not removed from disk')
ok(/keep-me-/.test(wl) && existsSync(keep), `the sweep removed a worktree that was not ours:\n${wl}`)

// ── 2a. moved on: the tree changed since the task was worked ─────────────────
const worked = await fetch(base + '/api/work', { method: 'POST', headers: H, body: JSON.stringify({ taskId: 't_a' }) })
if (!worked.ok) fail(`work t_a failed: ${worked.status} ${await worked.text()}`)
const doneA = (await worked.text()).split('\n').filter(Boolean).map(l => JSON.parse(l)).pop()
if (doneA.kind !== 'done') fail(`work t_a did not finish: ${JSON.stringify(doneA).slice(0, 200)}\n${s.log()}`)

// Edit the very line the patch is about, to a third value: the patch neither
// applies (context gone) nor is already present.
const before = readFileSync(join(repo, 'f.txt'), 'utf8')
writeFileSync(join(repo, 'f.txt'), before.replace('TARGET\n', 'TARGET-conflict\n'))
const moved = await fetch(base + '/api/apply', { method: 'POST', headers: H, body: JSON.stringify({ taskId: 't_a' }) })
if (moved.status !== 409) fail(`expected 409 applying a patch that no longer fits, got ${moved.status}`)
const movedBody = await moved.json()
ok(movedBody.movedOn === true, `a moved-on patch was not flagged as such: ${JSON.stringify(movedBody)}`)
ok(!movedBody.applied, 'a moved-on patch was mislabelled as already applied')
ok(/re-run|rebase/i.test(movedBody.error || ''), `the refusal does not point at re-running the task: ${movedBody.error}`)
// The gate held: the tree was neither half-applied nor left with conflict markers.
const afterMoved = readFileSync(join(repo, 'f.txt'), 'utf8')
ok(afterMoved.includes('TARGET-conflict') && !/[<=>]{7}/.test(afterMoved), `the refused apply disturbed the working tree:\n${afterMoved}`)

// ── 2b. already applied: nothing to do ───────────────────────────────────────
git('checkout', '--', 'f.txt')   // back to the base state the patch expects
const workedB = await fetch(base + '/api/work', { method: 'POST', headers: H, body: JSON.stringify({ taskId: 't_b' }) })
if (!workedB.ok) fail(`work t_b failed: ${workedB.status} ${await workedB.text()}`)
const doneB = (await workedB.text()).split('\n').filter(Boolean).map(l => JSON.parse(l)).pop()
if (doneB.kind !== 'done') fail(`work t_b did not finish: ${JSON.stringify(doneB).slice(0, 200)}`)

const firstApply = await fetch(base + '/api/apply', { method: 'POST', headers: H, body: JSON.stringify({ taskId: 't_b' }) })
if (!firstApply.ok) fail(`first apply of t_b failed: ${firstApply.status} ${await firstApply.text()}`)
ok(/TARGET-changed/.test(readFileSync(join(repo, 'f.txt'), 'utf8')), 'apply did not land the change')

const secondApply = await fetch(base + '/api/apply', { method: 'POST', headers: H, body: JSON.stringify({ taskId: 't_b' }) })
if (secondApply.status !== 409) fail(`expected 409 applying an already-applied patch, got ${secondApply.status}`)
const againBody = await secondApply.json()
ok(againBody.applied === true, `an already-applied patch was not flagged as such: ${JSON.stringify(againBody)}`)
ok(!againBody.movedOn, 'an already-applied patch was mislabelled as moved-on')
ok(/already/i.test(againBody.error || ''), `the refusal does not say the patch is already applied: ${againBody.error}`)

s.proc.kill('SIGKILL')
console.log('OK: serve --work hardening (startup reclaims leaked worktrees and prunes stale ones without touching others; a stale patch is refused as moved-on vs already-applied, gate stays clean-or-refuse)')
