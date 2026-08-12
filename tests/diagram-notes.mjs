#!/usr/bin/env node
// Diagram annotations (a served feature — the panel needs a live model to exist):
// a plain click on a block opens the panel for that block instead of the file
// drill-down; a note pins a badge on the block that survives a reload; and a
// dragged region opens a region anchor whose frame + badge redraw from the journal.
// No `claude` is invoked (opening the panel and adding a note call no model).

import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs'
import { spawn } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const fail = (m) => { console.error(`FAIL: ${m}`); process.exit(1) }
const ok = (c, m) => { if (!c) fail(m) }

const work = mkdtempSync(join(tmpdir(), 'whydiff-dgnotes-'))
const rm = JSON.parse(readFileSync(join(root, 'examples', 'rate-limit', 'review-map.json'), 'utf8'))
for (const f of Object.values(rm.files)) delete f.embedFull
const mapPath = join(work, 'review-map.json')
writeFileSync(mapPath, JSON.stringify(rm))

const port = 7830 + (process.pid % 40)
const proc = spawn('node', [join(root, 'scripts', 'serve.mjs'), mapPath, '--repo', root, '--port', String(port)], { stdio: ['ignore', 'pipe', 'pipe'] })
let out = ''; proc.stdout.on('data', d => { out += d }); proc.stderr.on('data', d => { out += d })
process.on('exit', () => { try { proc.kill('SIGKILL') } catch {} })
const base = `http://127.0.0.1:${port}`
for (let i = 0; i < 100; i++) { try { if ((await fetch(base + '/')).ok) break } catch {} await new Promise(r => setTimeout(r, 100)) }

const browser = await chromium.launch()
const errors = []
const page = await browser.newPage({ viewport: { width: 1500, height: 1000 } })
page.on('pageerror', e => errors.push(`pageerror: ${e.message}`))
page.on('console', m => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) errors.push(`console: ${m.text()}`) })
await page.goto(base + '/')
await page.locator('#tabs .tab[data-pane="diagrams"]').click()
await page.waitForSelector('#pane-diagrams svg', { timeout: 15000 })
await page.waitForTimeout(700)

// ── a block click opens the panel for that block, not the file drill-down ─────
const node = page.locator('#pane-diagrams .clickable').first()
const nb = await node.boundingBox()
await page.mouse.click(nb.x + nb.width / 2, nb.y + nb.height / 2)
await page.waitForTimeout(300)
ok(await page.locator('.askpanel.on').count(), 'clicking a diagram block did not open the ask panel')
ok(/diagram-node/.test(await page.locator('.askpanel .dk-anchor').textContent() || ''), 'the block click did not open a diagram-node anchor')
const inspH3 = await page.locator('#inspector h3').first().textContent({ timeout: 1500 }).catch(() => '')
ok(!(inspH3 || '').includes('/'), 'the block click also opened the file drill-down (mermaid directive not preempted)')

// ── a note pins a badge on the block, and it survives a reload ────────────────
await page.locator('.askpanel .dk-mode button[data-mode="note"]').click()
await page.locator('.askpanel textarea').fill('This block gates the whole search by role.')
await page.locator('.askpanel .dk-send').click()
await page.waitForFunction(() => document.querySelectorAll('#pane-diagrams .dg-badge').length >= 1, null, { timeout: 10000 })
  .catch(() => fail('a note on a block did not pin a badge'))

await page.reload()
await page.locator('#tabs .tab[data-pane="diagrams"]').click()
await page.waitForSelector('#pane-diagrams svg', { timeout: 15000 })
await page.waitForFunction(() => document.querySelectorAll('#pane-diagrams .dg-badge').length >= 1, null, { timeout: 10000 })
  .catch(() => fail('the block badge did not survive a reload'))
// The badge opens the thread it stands for.
await page.locator('#pane-diagrams .dg-badge').first().click()
await page.waitForTimeout(300)
ok(await page.locator('.askpanel.on').count(), 'clicking a block badge did not open its thread')

// ── a dragged region opens a region anchor; a note draws a frame + badge ──────
const box = await page.locator('#pane-diagrams .mermaid-box').first().boundingBox()
await page.mouse.move(box.x + 8, box.y + 8)
await page.mouse.down()
await page.mouse.move(box.x + box.width - 8, box.y + box.height / 2, { steps: 8 })
await page.mouse.up()
await page.waitForTimeout(300)
ok(await page.locator('.askpanel.on').count(), 'dragging a region did not open the ask panel')
ok(/diagram-region|→/.test(await page.locator('.askpanel .dk-anchor').textContent() || ''), 'the drag did not open a region anchor')
await page.locator('.askpanel .dk-mode button[data-mode="note"]').click()
await page.locator('.askpanel textarea').fill('This whole branch is the external-manager path.')
await page.locator('.askpanel .dk-send').click()
await page.waitForFunction(() => document.querySelector('#pane-diagrams .dg-region'), null, { timeout: 10000 })
  .catch(() => fail('a note on a region did not draw its frame'))

if (errors.length) fail('page errors:\n' + errors.join('\n'))
await browser.close()
proc.kill('SIGKILL')
console.log('OK: diagram annotations (block click opens the panel not the file; a note pins a badge that survives reload and opens its thread; a dragged region draws a persisted frame)')
