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
const proc = spawn('node', [join(root, 'scripts', 'serve.mjs'), '--no-open', mapPath, '--repo', root, '--port', String(port)], { stdio: ['ignore', 'pipe', 'pipe'] })
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
await page.waitForSelector('#pane-diagrams .mermaid-box svg', { timeout: 15000 })
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
await page.waitForSelector('#pane-diagrams .mermaid-box svg', { timeout: 15000 })
await page.waitForFunction(() => document.querySelectorAll('#pane-diagrams .dg-badge').length >= 1, null, { timeout: 10000 })
  .catch(() => fail('the block badge did not survive a reload'))
// The badge opens the thread it stands for.
await page.locator('#pane-diagrams .dg-badge').first().click()
await page.waitForTimeout(300)
ok(await page.locator('.askpanel.on').count(), 'clicking a block badge did not open its thread')

// ── a dragged region opens a region anchor; its frame lands on the dragged area ──
// Correctness is checked by which nodes the frame COVERS, not by pixels: the frame must
// cover every node the drag covered — before and after a reload — which is invariant to
// the diagram's scale, centring and scroll (all of which change when the ask panel opens
// and refits the diagram; a pixel/fraction check missed exactly that). It is coverage, not
// exact equality, because the frame's small pad may also catch a close neighbour.
// The set of DISTINCT element labels a viewport rect overlaps (deduped: a sequence
// participant has both a top and a bottom `.actor` box, so a tall frame hits each twice).
const overlap = (sel, x1, y1, x2, y2) => page.evaluate(([sel, x1, y1, x2, y2]) =>
  [...new Set([...document.querySelectorAll(sel)].filter((n) => { const b = n.getBoundingClientRect(); return b.width && b.height && b.left < x2 && b.right > x1 && b.top < y2 && b.bottom > y1 })
    .map((n) => (n.textContent || '').replace(/\s+/g, ' ').trim()).filter(Boolean))].sort(), [sel, x1, y1, x2, y2])
// The frame lives inside its own diagram — scope to it, or a leftover frame on an
// earlier diagram (from a prior region()) would be picked up instead.
const frameActors = async (dgIndex, sel) => { const f = await page.locator(`#pane-diagrams .diagram[data-anchor="diagram:${dgIndex}"] .dg-region`).first().boundingBox(); return overlap(sel, f.x, f.y, f.x + f.width, f.y + f.height) }

// Drag over a diagram, note it, and assert the frame COVERS the elements the drag covered
// — immediately, and again after a reload (redrawn from the journal). Coverage (superset),
// not exact equality: the frame carries a small pad, so it may also catch a neighbour that
// sits within a few px of the dragged rectangle — legitimate, and layout/DPI dependent. The
// invariant that matters (and that catches a mis-placed or collapsed frame) is that every
// dragged node is inside the frame, and that the frame has not ballooned to the whole diagram.
const region = async (dgIndex, sel, label) => {
  const boxLoc = page.locator('#pane-diagrams .diagram').nth(dgIndex).locator('.mermaid-box')
  await boxLoc.evaluate((el) => el.scrollIntoView({ block: 'start' }))
  await page.waitForTimeout(150)
  const box = await boxLoc.boundingBox()
  const vh = page.viewportSize().height
  const drag = { x1: box.x + box.width * 0.28, y1: box.y + 24, x2: box.x + box.width * 0.72, y2: Math.min(box.y + box.height - 12, vh - 12) }
  const draggedOver = await overlap(sel, drag.x1, drag.y1, drag.x2, drag.y2)
  const allNodes = await overlap(sel, -1e6, -1e6, 1e6, 1e6) // every node in this diagram
  ok(draggedOver.length > 0, `[${label}] test setup: the drag covered no ${sel} to compare against`)
  ok(draggedOver.length < allNodes.length, `[${label}] test setup: the drag should cover only part of the diagram, not all ${allNodes.length} nodes`)
  const covers = (frame, when) => {
    const missing = draggedOver.filter((n) => !frame.includes(n))
    ok(missing.length === 0, `[${label}] ${when}: the frame missed ${JSON.stringify(missing)} the drag covered (frame: ${JSON.stringify(frame)})`)
    ok(frame.length < allNodes.length, `[${label}] ${when}: the frame ballooned to the whole diagram (${JSON.stringify(frame)})`)
  }
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
  covers(await frameActors(dgIndex, sel), 'after note')
  await page.reload()
  await page.locator('#tabs .tab[data-pane="diagrams"]').click()
  await page.waitForSelector('#pane-diagrams .mermaid-box svg', { timeout: 15000 })
  await page.waitForFunction(() => document.querySelector('#pane-diagrams .dg-region'), null, { timeout: 10000 })
    .catch(() => fail(`[${label}] the region frame did not survive a reload`))
  await page.waitForTimeout(300)
  covers(await frameActors(dgIndex, sel), 'after reload')
  // Reflow must not leave the frame behind (the recurring "zones jump" bug). The badges/frames
  // are placed from live rects, so a window resize or a sidebar collapse/expand reflows the
  // diagram and must trigger a redraw. Assert the frame STILL covers the same dragged nodes.
  await page.setViewportSize({ width: 1080, height: 900 })
  await page.waitForTimeout(500)
  covers(await frameActors(dgIndex, sel), 'after shrink resize')
  await page.setViewportSize({ width: 1500, height: 1000 })
  await page.waitForTimeout(500)
  covers(await frameActors(dgIndex, sel), 'after grow resize')
  // Collapse then reopen the sidebar (drives setAsideCollapsed both ways).
  await page.evaluate(() => document.getElementById('asideToggle')?.click())
  await page.waitForTimeout(400)
  await page.evaluate(() => document.getElementById('asideReopen')?.click())
  await page.waitForTimeout(500)
  covers(await frameActors(dgIndex, sel), 'after sidebar toggle')
}

await region(0, '#pane-diagrams .diagram[data-anchor="diagram:0"] svg .node', 'flowchart')  // flowchart nodes
await region(2, '#pane-diagrams .diagram[data-anchor="diagram:2"] svg .actor', 'sequence')  // sequence actors (no `.node`)

if (errors.length) fail('page errors:\n' + errors.join('\n'))
await browser.close()
proc.kill('SIGKILL')
console.log('OK: diagram annotations (block click opens the panel not the file; a note pins a badge that survives reload; a region opens without hijacking text; its frame covers the elements it was dragged over — on a flowchart AND a wide sequence diagram — and survives a reload, a window resize, and a sidebar toggle)')
