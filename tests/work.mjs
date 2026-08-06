#!/usr/bin/env node
// Contract test for `serve.mjs --work`: an agreed task is worked in a throwaway git
// worktree, comes back as a patch, and reaches the reviewed tree only when applied.
//
// A real (tiny) git repo is created for this, because the whole guarantee is about
// what happens to a working tree. `claude` is stubbed with a script that edits a
// file inside whatever directory it is run in — so the isolation is tested for real:
// if the worker ran in the repo instead of a worktree, the assertions below fail.

import { readFileSync, writeFileSync, mkdtempSync, chmodSync, existsSync, mkdirSync } from 'node:fs'
import { spawn, execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'
import { appendEvents, readReview } from '../scripts/review.mjs'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const fail = (msg) => { console.error(`FAIL: ${msg}`); process.exit(1) }
const ok = (cond, msg) => { if (!cond) fail(msg) }

// ── a repo to review ─────────────────────────────────────────────────────────
const repo = mkdtempSync(join(tmpdir(), 'whydiff-workrepo-'))
const git = (...a) => execFileSync('git', ['-C', repo, ...a], { encoding: 'utf8' })
git('init', '-q')
git('config', 'user.email', 'test@example.com')
git('config', 'user.name', 'Test')
writeFileSync(join(repo, 'refunds.js'), 'export const settle = (order) => order.shipped\n')
writeFileSync(join(repo, '.gitignore'), '.whydiff/\n')
git('add', '-A')
git('commit', '-qm', 'initial')
// The reviewed change is the working tree, the case where seeding from HEAD would
// hand the worker a tree without the diff under review.
writeFileSync(join(repo, 'refunds.js'), 'export const settle = (order) => order.shipped // reviewed change\n')

const reviewDir = join(repo, '.whydiff')
mkdirSync(reviewDir, { recursive: true })
const mapPath = join(reviewDir, 'review-map.json')
writeFileSync(mapPath, JSON.stringify({
  meta: { project: 'work-test', ref: 'working tree', generatedAt: '2026-08-06T00:00:00Z', lang: 'en' },
  intent: 'Settle refunds.', story: [], groups: [{ id: 'g', name: 'g', role: 'read', why: 'w', files: ['refunds.js'] }],
  files: { 'refunds.js': { add: 1, del: 1, why: 'the guard', service: 'backend' } },
  edges: [], manifest: [['refunds.js', 1, 1, 'g', false]],
  tests: { gaps: ['nothing covers an unshipped order'] },
}))

// ── one agreed task in the journal ───────────────────────────────────────────
const anchor = { kind: 'gap', key: 'gap:0', label: 'nothing covers an unshipped order', files: ['refunds.js'] }
appendEvents(reviewDir, [
  { type: 'note.added', by: 'reviewer', kind: 'instruction', anchor, text: 'Settle unshipped orders too.' },
  { type: 'task.opened', taskId: 't_w1', anchor, threadKey: 'gap:0', origin: 'reviewer', spec: 'Settle unshipped orders too.', acceptance: { type: 'test', name: 'test_unshipped' }, state: 'open' },
])

// ── a worker that actually edits its working directory ───────────────────────
const stub = join(repo, 'fake-claude')
writeFileSync(stub, `#!/usr/bin/env node
import { writeFileSync, readFileSync, existsSync } from 'node:fs'
const args = process.argv.slice(2)
const prompt = args[args.indexOf('-p') + 1] || ''
const say = (o) => process.stdout.write(JSON.stringify(o) + '\\n')
if (!/THE TASK/.test(prompt)) { console.error('not a work prompt'); process.exit(3) }
// Prove the worker got the reviewed working tree, not a clean HEAD.
if (!/reviewed change/.test(readFileSync('refunds.js', 'utf8'))) { console.error('worktree was not seeded from the working tree'); process.exit(4) }
if (!/--allowedTools/.test(args.join(' '))) { console.error('no tool allowlist'); process.exit(5) }
// Three shapes of run, chosen by what the task asks for: an edit, a new file, and
// one that honestly changes nothing.
if (/produce nothing/.test(prompt)) {
  say({ type: 'result', subtype: 'success', result: 'Nothing to do: the behaviour the task asks for is already there.' })
  process.exit(0)
}
if (/a note file/.test(prompt)) {
  writeFileSync('NOTES.md', '# why the guard runs first\\n')
  say({ type: 'result', subtype: 'success', result: 'Added NOTES.md explaining the order.' })
  process.exit(0)
}
writeFileSync('refunds.js', 'export const settle = (order) => true // reviewed change\\n')
writeFileSync('refunds.test.js', 'test("test_unshipped", () => {})\\n')
say({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Edit', input: { file_path: 'refunds.js' } }] } })
say({ type: 'result', subtype: 'success', result: 'Changed \`refunds.js\` to settle unshipped orders and added \`refunds.test.js\`. Ran the test: 1 passed.' })
`)
chmodSync(stub, 0o755)

const startServer = (extra) => {
  const port = 7881 + (process.pid % 60) + (extra.includes('--work') ? 0 : 1)
  const proc = spawn('node', [join(root, 'scripts', 'serve.mjs'), mapPath, '--repo', repo, '--port', String(port), '--claude-cmd', stub, ...extra],
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

// ── without --work the endpoints do not exist as capabilities ────────────────
{
  const s = startServer([])
  await wait(s.port, s.log)
  const page = await (await fetch(`http://127.0.0.1:${s.port}/`)).text()
  const token = page.match(/__WHYDIFF_SERVE__=\{"token":"([a-f0-9]+)"/)?.[1]
  if (!/"work":false/.test(page)) fail('a read-only server did not tell the page so')
  const H = { 'x-whydiff-token': token, 'content-type': 'application/json' }
  const refused = await fetch(`http://127.0.0.1:${s.port}/api/work`, { method: 'POST', headers: H, body: JSON.stringify({ taskId: 't_w1' }) })
  if (refused.status !== 403) fail(`expected 403 for /api/work without --work, got ${refused.status}`)
  if (!/does not change the repo/.test((await refused.json()).error || '')) fail('the refusal does not say why')
  s.proc.kill('SIGKILL')
}

// ── with --work: worktree → patch → gate → apply ─────────────────────────────
const s = startServer(['--work'])
await wait(s.port, s.log)
process.on('exit', () => { try { s.proc.kill('SIGKILL') } catch {} })
const base = `http://127.0.0.1:${s.port}`
const served = await (await fetch(base + '/')).text()
const token = served.match(/__WHYDIFF_SERVE__=\{"token":"([a-f0-9]+)"/)?.[1]
if (!/"work":true/.test(served)) fail('work mode was not announced to the page')
const H = { 'x-whydiff-token': token, 'content-type': 'application/json' }

const unknown = await fetch(base + '/api/work', { method: 'POST', headers: H, body: JSON.stringify({ taskId: 't_nope' }) })
if (unknown.status !== 404) fail(`expected 404 for an unknown task, got ${unknown.status}`)

const before = readFileSync(join(repo, 'refunds.js'), 'utf8')
const res = await fetch(base + '/api/work', { method: 'POST', headers: H, body: JSON.stringify({ taskId: 't_w1' }) })
if (!res.ok) fail(`work failed: ${res.status} ${await res.text()}`)
const evs = (await res.text()).split('\n').filter(Boolean).map(l => JSON.parse(l))
const done = evs[evs.length - 1]
if (done.kind !== 'done') fail(`work did not finish: ${JSON.stringify(done).slice(0, 300)}\n${s.log()}`)
ok(evs.some(e => e.kind === 'step' && /worktree from the working tree/.test(e.text)), `the worktree was not seeded from the working tree: ${JSON.stringify(evs.filter(e => e.kind === 'step'))}`)

// The reviewed tree is untouched until the reviewer says otherwise.
ok(readFileSync(join(repo, 'refunds.js'), 'utf8') === before, 'the worker edited the tree under review')
ok(!existsSync(join(repo, 'refunds.test.js')), 'the worker created a file in the tree under review')

// The patch is on disk, parsed for reading, and journalled as the resolution.
const paths = done.files.map(f => f.path).sort()
ok(paths.join(',') === 'refunds.js,refunds.test.js', `the patch does not carry both files: ${paths.join(',')}`)
const added = done.files.find(f => f.path === 'refunds.test.js')
ok(added.isNew && added.add === 1, `a new file was not reported as new: ${JSON.stringify(added)}`)
ok(done.files.find(f => f.path === 'refunds.js').hunks.some(([cls, text]) => cls === 'add' && /=> true/.test(text)),
  'the changed line is not in the patch view')
ok(existsSync(done.patch), `the patch file was not written: ${done.patch}`)
const task = readReview(reviewDir).state.tasks.find(t => t.taskId === 't_w1')
ok(task.state === 'done' && task.resolution?.patch === done.patch, `the resolution was not journalled: ${JSON.stringify(task)}`)
ok(readReview(reviewDir).state.notes.some(n => n.kind === 'report' && /refunds\.test\.js/.test(n.text)), 'the worker report was not journalled')
// A worktree is a throwaway: nothing of it survives the run.
ok(!git('worktree', 'list').includes('whydiff-work-'), `a worktree was left behind:\n${git('worktree', 'list')}`)

// ── the gate ─────────────────────────────────────────────────────────────────
const applied = await fetch(base + '/api/apply', { method: 'POST', headers: H, body: JSON.stringify({ taskId: 't_w1' }) })
if (!applied.ok) fail(`apply failed: ${applied.status} ${await applied.text()}`)
const now = readFileSync(join(repo, 'refunds.js'), 'utf8')
ok(/=> true/.test(now) && /reviewed change/.test(now), `apply did not land the change while keeping the reviewed one: ${now}`)
ok(existsSync(join(repo, 'refunds.test.js')), 'apply did not create the new file')
const decision = readReview(reviewDir).state.notes.find(n => n.applied)
ok(decision?.taskId === 't_w1' && decision.by === 'reviewer', `the apply was not journalled as the reviewer's decision: ${JSON.stringify(decision)}`)

// Applying twice is refused, not forced: the patch no longer applies.
const again = await fetch(base + '/api/apply', { method: 'POST', headers: H, body: JSON.stringify({ taskId: 't_w1' }) })
if (again.status !== 409) fail(`expected 409 applying a patch twice, got ${again.status}`)
if (!/already be applied/.test((await again.json()).error || '')) fail('the conflict does not explain itself')

// A task that is already done is not worked again.
const redo = await fetch(base + '/api/work', { method: 'POST', headers: H, body: JSON.stringify({ taskId: 't_w1' }) })
if (redo.status !== 400) fail(`expected 400 re-working a done task, got ${redo.status}`)

// ── the same loop from the page ──────────────────────────────────────────────
appendEvents(reviewDir, [
  { type: 'task.opened', taskId: 't_w2', anchor, threadKey: 'gap:0', origin: 'reviewer', spec: 'Add a note file about the guard order.', acceptance: { type: 'manual', what: 'read it' }, state: 'open' },
  { type: 'task.opened', taskId: 't_w3', anchor, threadKey: 'gap:0', origin: 'reviewer', spec: 'Check the limiter and produce nothing if it is already right.', acceptance: { type: 'manual', what: 'read the report' }, state: 'open' },
])
const browser = await chromium.launch()
const errors = []
const page = await browser.newPage({ viewport: { width: 1500, height: 1000 } })
page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`))
page.on('console', (m) => { if (m.type() === 'error') errors.push(`console: ${m.text()}`) })
await page.goto(base + '/')
await page.waitForTimeout(500)
await page.locator('.modebar .modetab').nth(1).click()
await page.waitForTimeout(300)

const card2 = page.locator('.tkcard[data-id="t_w2"]')
// The page picked up two tasks a terminal session appended after the server
// started: the projection is re-read when the log moves, not cached forever.
if (!(await card2.locator('.tk-run').count())) fail('work mode did not offer to do an open task appended by another writer')
if (await card2.locator('.tk-run').isDisabled()) fail('the work button is disabled while --work is on')
// A done task offers no run button, and shows its patch with the gate instead.
if (await page.locator('.tkcard[data-id="t_w1"] .tk-run').count()) fail('a finished task still offered to be worked')
if (!/in your working tree/.test(await page.locator('.tkcard[data-id="t_w1"] .tkpline').textContent())) {
  fail('an applied task does not say so where its patch is')
}
if (await page.locator('.tkcard[data-id="t_w1"] .tk-apply').count()) fail('an applied patch still offered to be applied again')

await card2.locator('.tk-run').click()
await page.waitForFunction(() => document.querySelector('.tkcard[data-id="t_w2"] .tkpatch'), null, { timeout: 60000 })
  .catch(() => fail('working a task from the page produced no patch view'))
if (!/1 file changed/.test(await card2.locator('.tkpline b').textContent())) fail('the patch view does not say what it holds')
await card2.locator('.tk-toggle').click()
const shown = await card2.locator('.tkfile code').textContent()
if (shown !== 'NOTES.md') fail(`the patch view shows the wrong file: ${shown}`)
if (!(await card2.locator('.tkfile .cl.add').count())) fail('the added lines are not rendered as added')
if (existsSync(join(repo, 'NOTES.md'))) fail('the page landed a patch in the tree before it was applied')

await card2.locator('.tk-apply').click()
await page.waitForFunction(() => /in your working tree/.test(document.querySelector('.tkcard[data-id="t_w2"] .tkpline')?.textContent || ''), null, { timeout: 20000 })
  .catch(() => fail('applying from the page never reported success'))
if (!existsSync(join(repo, 'NOTES.md'))) fail('apply from the page did not land the file')

// A run that changes nothing says so and hands the task back.
const card3 = page.locator('.tkcard[data-id="t_w3"]')
await card3.locator('.tk-run').click()
await page.waitForFunction(() => /no changes/.test(document.querySelector('.tkcard[data-id="t_w3"] .tkwork')?.textContent || ''), null, { timeout: 60000 })
  .catch(() => fail('an empty run did not say it produced nothing'))
if (await page.locator('.tkcard[data-id="t_w3"] .tkpatch').count()) fail('an empty run rendered a patch view')
const t3 = readReview(reviewDir).state.tasks.find(t => t.taskId === 't_w3')
if (t3.state !== 'open' || t3.resolution) fail(`an empty run did not hand the task back: ${JSON.stringify(t3)}`)
// ── a remark whose place is gone is kept, and says so ────────────────────────
// This is what rebind.mjs writes when a regenerated map no longer has the place a
// task was discussed on; the page must label it instead of pointing at nothing.
appendEvents(reviewDir, { type: 'anchor.rebound', by: 'claude', oldKey: 'gap:0', how: 'stale', mapId: 'm_next' })
await page.reload()
await page.waitForTimeout(400)
await page.locator('.modebar .modetab').nth(1).click()
await page.waitForTimeout(300)
// t_w1 is applied, so it has folded into the decided history — which must still be
// reachable and still carry what the remark was attached to.
await page.locator('.tkdone > summary').click()
await page.waitForTimeout(200)
if (!(await page.locator('.tkcard[data-id="t_w1"] .tkmeta .stale').count())) fail('a task whose place in the report is gone is not labelled stale')
if (!/kept/.test(await page.locator('.tkcard[data-id="t_w1"] .stale').getAttribute('title') || '')) fail('the stale label does not explain itself')
if (!/nothing covers an unshipped order/.test(await page.locator('.tkcard[data-id="t_w1"] .tkmeta').textContent())) {
  fail('a stale card lost the text the remark was attached to')
}
await page.locator('.tkcard[data-id="t_w1"] .tk-open').click()
await page.waitForTimeout(500)
if (!(await page.locator('.askpanel.on').count())) fail('a stale anchor cannot open its thread')
if (!(await page.locator('.askpanel .dk-anchor .stale').count())) fail('the thread of a stale anchor does not say its place is gone')
if (!(await page.locator('.askpanel .dk-t').count())) fail('a stale thread lost its discussion')

if (errors.length) fail('page errors:\n' + errors.join('\n'))
await browser.close()

s.proc.kill('SIGKILL')
console.log(`OK: serve --work (403 without the flag, worktree seeded from the working tree, ${paths.length} files patched, reviewed tree untouched until applied, worktree cleaned up, double apply refused, page worked+gated+applied, empty run handed back, stale anchor labelled and still readable)`)
