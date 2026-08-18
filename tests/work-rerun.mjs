#!/usr/bin/env node
// The client half of the moved-on fix: when a worked patch no longer fits the tree
// (the reviewer changed it in between), the Tasks tab does not dead-end on an error
// — it offers Re-run, which reopens the task and re-works it against the tree as it
// stands, producing a patch the gate can then apply.

import { readFileSync, writeFileSync, mkdtempSync, chmodSync, mkdirSync } from 'node:fs'
import { spawn, execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'
import { appendEvents, readReview } from '../scripts/review.mjs'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const fail = (msg) => { console.error(`FAIL: ${msg}`); process.exit(1) }
const ok = (cond, msg) => { if (!cond) fail(msg) }

const repo = mkdtempSync(join(tmpdir(), 'whydiff-rerunrepo-'))
const git = (...a) => execFileSync('git', ['-C', repo, ...a], { encoding: 'utf8' })
git('init', '-q'); git('config', 'user.email', 't@e'); git('config', 'user.name', 'T')
writeFileSync(join(repo, 'f.js'), 'export const settle = () => true\nconst VALUE = "orig"\nexport { VALUE }\n')
writeFileSync(join(repo, '.gitignore'), '.whydiff/\n')
git('add', '-A'); git('commit', '-qm', 'initial')

const reviewDir = join(repo, '.whydiff')
mkdirSync(reviewDir, { recursive: true })
const mapPath = join(reviewDir, 'review-map.json')
writeFileSync(mapPath, JSON.stringify({
  meta: { project: 'rerun-test', ref: 'working tree', generatedAt: '2026-08-12T00:00:00Z', lang: 'en' },
  intent: 'x', story: [], groups: [{ id: 'g', name: 'g', role: 'write', why: 'w', files: ['f.js'] }],
  files: { 'f.js': { add: 1, del: 1, why: 'value', service: 'backend' } },
  edges: [], manifest: [['f.js', 1, 1, 'g', false]],
}))
const anchor = { kind: 'file', key: 'file:f.js', label: 'f.js', files: ['f.js'] }
appendEvents(reviewDir, { type: 'task.opened', taskId: 't_r1', anchor, threadKey: 'file:f.js', origin: 'reviewer', spec: 'Set VALUE to worked.', acceptance: { type: 'manual', what: 'read it' }, state: 'open' })

// A worker that always sets the VALUE line to "worked", whatever it currently is —
// so a re-run against a changed tree still produces an applicable patch.
const stub = join(repo, 'fake-claude')
writeFileSync(stub, `#!/usr/bin/env node
import { writeFileSync, readFileSync } from 'node:fs'
const args = process.argv.slice(2)
if (!/THE TASK/.test(args[args.indexOf('-p') + 1] || '')) { console.error('not a work prompt'); process.exit(3) }
const out = readFileSync('f.js', 'utf8').split('\\n').map(l => l.startsWith('const VALUE') ? 'const VALUE = "worked"' : l).join('\\n')
writeFileSync('f.js', out)
process.stdout.write(JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Edit', input: { file_path: 'f.js' } }] } }) + '\\n')
process.stdout.write(JSON.stringify({ type: 'result', subtype: 'success', result: 'Set VALUE to worked.' }) + '\\n')
`)
chmodSync(stub, 0o755)

const port = 7900 + (process.pid % 30)
const proc = spawn('node', [join(root, 'scripts', 'serve.mjs'), '--no-open', mapPath, '--repo', repo, '--port', String(port), '--claude-cmd', stub, '--work'], { stdio: ['ignore', 'pipe', 'pipe'] })
let out = ''; proc.stdout.on('data', d => { out += d }); proc.stderr.on('data', d => { out += d })
process.on('exit', () => { try { proc.kill('SIGKILL') } catch {} })
const base = `http://127.0.0.1:${port}`
for (let i = 0; i < 150; i++) { try { if ((await fetch(base + '/')).ok) break } catch {} await new Promise(r => setTimeout(r, 100)) }

const browser = await chromium.launch()
const errors = []
const page = await browser.newPage({ viewport: { width: 1500, height: 1000 } })
page.on('pageerror', e => errors.push(`pageerror: ${e.message}`))
// The moved-on apply returns 409 on purpose; the browser logs that as a failed
// resource load, which is network status, not a page error. Uncaught JS still fails.
page.on('console', m => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) errors.push(`console: ${m.text()}`) })
await page.goto(base + '/')
await page.waitForTimeout(400)
await page.locator('.modebar .modetab').nth(1).click()
await page.waitForTimeout(300)

const card = page.locator('.tkcard[data-id="t_r1"]')

// Work the task, then move the tree out from under the patch.
await card.locator('.tk-run').click()
await page.waitForFunction(() => document.querySelector('.tkcard[data-id="t_r1"] .tkpatch'), null, { timeout: 60000 })
  .catch(() => fail('working the task produced no patch'))
writeFileSync(join(repo, 'f.js'), readFileSync(join(repo, 'f.js'), 'utf8').replace('const VALUE = "orig"', 'const VALUE = "moved"'))

// Apply now fails — and the page offers Re-run instead of dead-ending on an error.
await card.locator('.tk-apply').click()
await page.waitForSelector('.tkcard[data-id="t_r1"] .tk-rerun', { timeout: 20000 })
  .catch(() => fail('a moved-on apply did not offer Re-run'))
ok((await card.locator('.dk-err').count()) === 0, 'a moved-on apply showed a raw error instead of the Re-run affordance')
ok(/const VALUE = "moved"/.test(readFileSync(join(repo, 'f.js'), 'utf8')), 'the refused apply disturbed the working tree')

// Re-run rebases the patch on the tree as it stands, and the new patch applies.
await card.locator('.tk-rerun').click()
await page.waitForFunction(() => document.querySelector('.tkcard[data-id="t_r1"] .tkpatch .tk-apply'), null, { timeout: 60000 })
  .catch(() => fail('Re-run did not produce a fresh, applicable patch'))
await card.locator('.tk-apply').click()
await page.waitForFunction(() => /in your working tree/.test(document.querySelector('.tkcard[data-id="t_r1"] .tkpline')?.textContent || ''), null, { timeout: 20000 })
  .catch(() => fail('applying the rebased patch never reported success'))

const now = readFileSync(join(repo, 'f.js'), 'utf8')
ok(/const VALUE = "worked"/.test(now), `the rebased patch did not land: ${now}`)
const task = readReview(reviewDir).state.tasks.find(t => t.taskId === 't_r1')
ok(task.state === 'done' && readReview(reviewDir).state.notes.some(n => n.applied && n.taskId === 't_r1'), `the applied re-run was not journalled: ${JSON.stringify(task)}`)

if (errors.length) fail('page errors:\n' + errors.join('\n'))
await browser.close()
proc.kill('SIGKILL')
console.log('OK: moved-on recovery (apply refused → Re-run offered → task reopened and re-worked against the changed tree → rebased patch applies)')
