#!/usr/bin/env node
// Diagram pan/zoom, asserted by the USER GOAL — not by a pixel proxy.
//
// The goals a reviewer actually has (and the ones the first width-scaling hack failed):
//   1. A diagram bigger than the screen can be shrunk until the WHOLE of it is visible at once
//      (Fit-the-whole-diagram). "width increased by N px" is NOT this — a hack passed that while
//      the diagram still overflowed the screen. So we assert the whole thing fits the viewport.
//   2. Zoom in gives real magnification for detail…
//   3. …without the page blowing up: a tall zoom stays inside a bounded viewport (you pan by
//      scrolling), it does not stretch the page to the diagram's full height.
//   4. Fit brings the whole diagram back after zooming in.
import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const fail = (m) => { console.error(`FAIL: ${m}`); process.exit(1) }
const ok = (c, m) => { if (!c) fail(m) }

const work = mkdtempSync(join(tmpdir(), 'whydiff-zoom-'))
const rm = JSON.parse(readFileSync(join(root, 'examples', 'rate-limit', 'review-map.json'), 'utf8'))
for (const f of Object.values(rm.files)) delete f.embedFull
// A diagram far TALLER than the viewport — the case a reviewer needs to shrink to see whole.
rm.diagrams = [{
  kind: 'flow-diff', title: 'Tall pipeline', caption: 'a long vertical chain',
  mermaid: 'flowchart TD\n' + Array.from({ length: 20 }, (_, i) => `  N${i}["stage ${i} — a reasonably long node label"] --> N${i + 1}["stage ${i + 1} — a reasonably long node label"]`).join('\n'),
}]
writeFileSync(join(work, 'review-map.json'), JSON.stringify(rm))
const html = join(work, 'review-map.html')
execFileSync('node', [join(root, 'scripts', 'assemble.mjs'), join(work, 'review-map.json'), '--out', html], { stdio: 'inherit' })

const VPW = 1200, VPH = 800, ZOOM_VP = Math.round(VPH * 0.8) // the viewer's zoom viewport = 80vh
const browser = await chromium.launch()
const page = await browser.newPage({ viewport: { width: VPW, height: VPH } })
const errors = []
page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`))
await page.goto('file://' + html)
await page.locator('#tabs .tab[data-pane="diagrams"]').click()
await page.waitForSelector('#pane-diagrams .mermaid-box svg', { timeout: 15000 })
await page.waitForTimeout(400)

const boxSel = '#pane-diagrams .mermaid-box'
const svgSize = () => page.evaluate((s) => { const r = document.querySelector(s + ' svg').getBoundingClientRect(); return { w: r.width, h: r.height } }, boxSel)
const boxInfo = () => page.evaluate((s) => { const b = document.querySelector(s); return { clientH: b.clientHeight, clientW: b.clientWidth } }, boxSel)
const click = (sel) => page.locator(sel).click()

// The fixture is genuinely taller than the screen at the default fit — otherwise the test
// proves nothing.
const natFit = await svgSize()
ok(natFit.h > VPH, `[setup] the diagram must be taller than the viewport (h=${Math.round(natFit.h)} vs ${VPH})`)

// GOAL 1 — Fit the whole diagram on screen: after it, the ENTIRE diagram is within the viewport.
await click('.dg-zoom [data-dg-fit="screen"]')
await page.waitForTimeout(300)
let s = await svgSize(), b = await boxInfo()
ok(s.h <= ZOOM_VP + 4 && s.w <= b.clientW + 4, `fit-to-screen must make the WHOLE diagram fit the viewport (got ${Math.round(s.w)}×${Math.round(s.h)}, viewport ${b.clientW}×${ZOOM_VP})`)

// GOAL 2 — zoom in is real magnification.
const hAtFit = s.h
await click('.dg-zoom [data-dg-zoom="in"]')
await click('.dg-zoom [data-dg-zoom="in"]')
await click('.dg-zoom [data-dg-zoom="in"]')
await page.waitForTimeout(300)
s = await svgSize(); b = await boxInfo()
ok(s.h > hAtFit * 1.5, `zoom in must magnify (h went ${Math.round(hAtFit)} → ${Math.round(s.h)})`)
// GOAL 3 — …but the box stays a bounded viewport (the page does not stretch to the diagram).
ok(b.clientH <= ZOOM_VP + 4, `a zoomed-in box must stay a bounded viewport (clientH=${b.clientH} > ${ZOOM_VP}) so the page doesn't blow up`)
ok(s.h > b.clientH, 'a zoomed-in diagram taller than the box should scroll (pan), not shrink to fit')

// GOAL 4 — Fit brings the whole thing back.
await click('.dg-zoom [data-dg-fit="screen"]')
await page.waitForTimeout(300)
s = await svgSize(); b = await boxInfo()
ok(s.h <= ZOOM_VP + 4 && s.w <= b.clientW + 4, `fit-to-screen after zoom must show the whole diagram again (got ${Math.round(s.w)}×${Math.round(s.h)})`)

// And the header Fit-to-width leaves zoom mode (back to the responsive default, box unbounded).
await click('.dg-actions [data-dg-fit="width"]')
await page.waitForTimeout(300)
const zoomed = await page.evaluate((s) => document.querySelector(s).classList.contains('dg-zoomed'), boxSel)
ok(!zoomed, 'header Fit-to-width should leave zoom mode (the responsive fit-to-width default)')

if (errors.length) fail('page errors:\n' + errors.join('\n'))
await browser.close()
console.log('OK: diagram zoom — a too-tall diagram fits the screen whole; zoom in magnifies within a bounded, pannable viewport; Fit restores the whole; header Fit-to-width exits zoom')
