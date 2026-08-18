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
await node.scrollIntoViewIfNeeded() // diagrams fill the width now, so a node can sit below the fold
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
const boxLoc = page.locator('#pane-diagrams .mermaid-box').first()
await boxLoc.evaluate((el) => el.scrollIntoView({ block: 'start' })) // put the box top near the viewport top
await page.waitForTimeout(100)
const box = await boxLoc.boundingBox()
const svgAtDrag = await page.locator('#pane-diagrams .diagram .mermaid-box svg').first().boundingBox()
const vh = page.viewportSize().height
// Drag a rectangle over the top of the diagram, clamped to the viewport (the diagram
// can be taller than the screen now that it fills the width).
const drag = { x1: box.x + 8, y1: box.y + 8, x2: box.x + box.width - 8, y2: Math.min(box.y + box.height - 8, vh - 8) }
await page.mouse.move(drag.x1, drag.y1)
await page.mouse.down()
await page.mouse.move(drag.x2, drag.y2, { steps: 8 })
await page.mouse.up()
await page.waitForTimeout(300)
ok(await page.locator('.askpanel.on').count(), 'dragging a region did not open the ask panel')
ok(/diagram-region|→/.test(await page.locator('.askpanel .dk-anchor').textContent() || ''), 'the drag did not open a region anchor')
// The drag must NOT have turned into a native text selection (the old hijack).
ok((await page.evaluate(() => (window.getSelection()?.toString() || '').trim())) === '', 'the region drag left a native text selection (hijack not suppressed)')
await page.locator('.askpanel .dk-mode button[data-mode="note"]').click()
await page.locator('.askpanel textarea').fill('This whole branch is the external-manager path.')
await page.locator('.askpanel .dk-send').click()
await page.waitForFunction(() => document.querySelector('#pane-diagrams .dg-region'), null, { timeout: 10000 })
  .catch(() => fail('a note on a region did not draw its frame'))

// The frame must survive a reload — redrawn from the journal — and land back on the
// area that was dragged (geometry anchor), not merely somewhere. This is what proves the
// hybrid rect round-trips and positions the frame independently of any node detection.
await page.reload()
await page.locator('#tabs .tab[data-pane="diagrams"]').click()
await page.waitForSelector('#pane-diagrams svg', { timeout: 15000 })
await page.waitForFunction(() => document.querySelector('#pane-diagrams .dg-region'), null, { timeout: 10000 })
  .catch(() => fail('the region frame did not survive a reload'))
const fr = await page.locator('#pane-diagrams .dg-region').first().boundingBox()
const svg2 = await page.locator('#pane-diagrams .diagram .mermaid-box svg').first().boundingBox()
// Compare in SVG-fraction space — invariant to scroll/layout shifts across the reload.
const clamp01 = (v) => Math.max(0, Math.min(1, v))
const want = { x1: clamp01((drag.x1 - svgAtDrag.x) / svgAtDrag.width), y1: clamp01((drag.y1 - svgAtDrag.y) / svgAtDrag.height),
               x2: clamp01((drag.x2 - svgAtDrag.x) / svgAtDrag.width), y2: clamp01((drag.y2 - svgAtDrag.y) / svgAtDrag.height) }
const got = { x1: (fr.x - svg2.x) / svg2.width, y1: (fr.y - svg2.y) / svg2.height,
              x2: (fr.x + fr.width - svg2.x) / svg2.width, y2: (fr.y + fr.height - svg2.y) / svg2.height }
const near = (a, b) => Math.abs(a - b) <= 0.06 // ~6px frame pad over an ~900px svg, plus edge clamp
ok(near(got.x1, want.x1) && near(got.y1, want.y1) && near(got.x2, want.x2) && near(got.y2, want.y2),
  `the reloaded frame ${JSON.stringify(Object.fromEntries(Object.entries(got).map(([k, v]) => [k, +v.toFixed(3)])))} does not match the dragged area ${JSON.stringify(Object.fromEntries(Object.entries(want).map(([k, v]) => [k, +v.toFixed(3)])))}`)

if (errors.length) fail('page errors:\n' + errors.join('\n'))
await browser.close()
proc.kill('SIGKILL')
console.log('OK: diagram annotations (block click opens the panel not the file; a note pins a badge that survives reload; a dragged region opens without hijacking text, and its geometry frame round-trips a reload onto the dragged area)')
