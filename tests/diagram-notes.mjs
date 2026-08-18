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
// Append a wide SEQUENCE diagram (no `.node` elements; scaled to fit, so opening the ask
// panel refits it between the drag and the redraw). This is the type the geometry anchor
// must survive — a flowchart alone would not have caught the region bug.
const seqParts = ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H']
rm.diagrams.push({
  kind: 'flow-diff', title: 'Boot sequence',
  caption: 'who writes the token, and when',
  mermaid: 'sequenceDiagram\n' + seqParts.map((p) => ` participant ${p} as ${p}_service_with_a_long_name`).join('\n') + '\n' +
    seqParts.slice(0, -1).map((p, i) => ` ${p}->>${seqParts[i + 1]}: call step ${i} with a fairly long message label`).join('\n'),
})
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

// ── a dragged region opens a region anchor; its frame lands on the dragged area ──
// Correctness is checked by IDENTITY, not pixels: the set of nodes/actors the frame
// overlaps must equal the set the drag covered — before and after a reload. This is
// invariant to the diagram's scale, centring and scroll, all of which change when the
// ask panel opens and refits the diagram (a pixel/fraction check missed exactly that).
// The set of DISTINCT element labels a viewport rect overlaps (deduped: a sequence
// participant has both a top and a bottom `.actor` box, so a tall frame hits each twice).
const overlap = (sel, x1, y1, x2, y2) => page.evaluate(([sel, x1, y1, x2, y2]) =>
  [...new Set([...document.querySelectorAll(sel)].filter((n) => { const b = n.getBoundingClientRect(); return b.width && b.height && b.left < x2 && b.right > x1 && b.top < y2 && b.bottom > y1 })
    .map((n) => (n.textContent || '').replace(/\s+/g, ' ').trim()).filter(Boolean))].sort(), [sel, x1, y1, x2, y2])
// The frame lives inside its own diagram — scope to it, or a leftover frame on an
// earlier diagram (from a prior region()) would be picked up instead.
const frameActors = async (dgIndex, sel) => { const f = await page.locator(`#pane-diagrams .diagram[data-anchor="diagram:${dgIndex}"] .dg-region`).first().boundingBox(); return overlap(sel, f.x, f.y, f.x + f.width, f.y + f.height) }

// Drag over a diagram, note it, and assert the frame overlaps the same elements as the
// drag — immediately, and again after a reload (redrawn from the journal).
const region = async (dgIndex, sel, label) => {
  const boxLoc = page.locator('#pane-diagrams .diagram').nth(dgIndex).locator('.mermaid-box')
  await boxLoc.evaluate((el) => el.scrollIntoView({ block: 'start' }))
  await page.waitForTimeout(150)
  const box = await boxLoc.boundingBox()
  const vh = page.viewportSize().height
  const drag = { x1: box.x + box.width * 0.28, y1: box.y + 24, x2: box.x + box.width * 0.72, y2: Math.min(box.y + box.height - 12, vh - 12) }
  const draggedOver = await overlap(sel, drag.x1, drag.y1, drag.x2, drag.y2)
  ok(draggedOver.length > 0, `[${label}] test setup: the drag covered no ${sel} to compare against`)
  await page.mouse.move(drag.x1, drag.y1); await page.mouse.down(); await page.mouse.move(drag.x2, drag.y2, { steps: 8 }); await page.mouse.up()
  await page.waitForTimeout(300)
  ok(await page.locator('.askpanel.on').count(), `[${label}] dragging a region did not open the ask panel`)
  ok((await page.evaluate(() => (window.getSelection()?.toString() || '').trim())) === '', `[${label}] the region drag left a native text selection (hijack not suppressed)`)
  await page.locator('.askpanel .dk-mode button[data-mode="note"]').click()
  await page.locator('.askpanel textarea').fill(`region note on ${label}`)
  await page.locator('.askpanel .dk-send').click()
  await page.waitForFunction(() => document.querySelector('#pane-diagrams .dg-region'), null, { timeout: 10000 })
    .catch(() => fail(`[${label}] a note on a region did not draw its frame`))
  await page.waitForTimeout(900) // let the panel-open refit + redraws settle before measuring
  const now = await frameActors(dgIndex, sel)
  ok(JSON.stringify(now) === JSON.stringify(draggedOver), `[${label}] the frame overlaps ${JSON.stringify(now)} but the drag covered ${JSON.stringify(draggedOver)}`)
  await page.reload()
  await page.locator('#tabs .tab[data-pane="diagrams"]').click()
  await page.waitForSelector('#pane-diagrams svg', { timeout: 15000 })
  await page.waitForFunction(() => document.querySelector('#pane-diagrams .dg-region'), null, { timeout: 10000 })
    .catch(() => fail(`[${label}] the region frame did not survive a reload`))
  await page.waitForTimeout(300)
  const after = await frameActors(dgIndex, sel)
  ok(JSON.stringify(after) === JSON.stringify(draggedOver), `[${label}] after reload the frame overlaps ${JSON.stringify(after)} but the drag covered ${JSON.stringify(draggedOver)}`)
}

await region(0, '#pane-diagrams .diagram[data-anchor="diagram:0"] svg .node', 'flowchart')  // flowchart nodes
await region(2, '#pane-diagrams .diagram[data-anchor="diagram:2"] svg .actor', 'sequence')  // sequence actors (no `.node`)

if (errors.length) fail('page errors:\n' + errors.join('\n'))
await browser.close()
proc.kill('SIGKILL')
console.log('OK: diagram annotations (block click opens the panel not the file; a note pins a badge that survives reload; a region opens without hijacking text; its frame overlaps the same elements it covered — on a flowchart AND a wide sequence diagram — and survives a reload)')
