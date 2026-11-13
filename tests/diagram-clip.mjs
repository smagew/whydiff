#!/usr/bin/env node
// Regression: on screen, every node of every diagram must be visible — inside the
// SVG's own box, not cut off by it. Mermaid sometimes lays a node out past its own
// viewBox (the reference flowchart's "Tokens left" decision and its 429 branch sit
// past the right edge), and an <svg> clips at its viewBox. The viewer re-fitted the
// viewBox to the content only for PDF, so on screen the reviewer simply never saw
// the 429 path. Checked in a wide and a narrow window, in both palettes (a palette
// switch re-renders the diagrams, which resets mermaid's viewBox), and after a resize.

import { chromium } from 'playwright'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const rm = JSON.parse(readFileSync(join(root, 'examples', 'rate-limit', 'review-map.json'), 'utf8'))
for (const f of Object.values(rm.files)) delete f.embedFull
const work = mkdtempSync(join(tmpdir(), 'whydiff-clip-'))
writeFileSync(join(work, 'review-map.json'), JSON.stringify(rm))
execFileSync(process.execPath, [join(root, 'scripts', 'assemble.mjs'), join(work, 'review-map.json'), '--out', join(work, 'map.html')], { stdio: 'ignore' })
const url = pathToFileURL(join(work, 'map.html')).href

let failures = 0
const fail = (msg) => { console.error(`FAIL: ${msg}`); failures++ }

// Nodes whose on-screen box pokes out of their SVG's box by more than 1px.
const clipped = (page) => page.evaluate(() => {
  const out = []
  for (const svg of document.querySelectorAll('#pane-diagrams .mermaid-box svg')) {
    const s = svg.getBoundingClientRect()
    for (const n of svg.querySelectorAll('g.node, g.cluster')) {
      const r = n.getBoundingClientRect()
      if (!r.width) continue
      if (r.left < s.left - 1 || r.right > s.right + 1 || r.top < s.top - 1 || r.bottom > s.bottom + 1) {
        out.push(`${(n.textContent || n.id).trim().slice(0, 30)} (node ${Math.round(r.left)}–${Math.round(r.right)}, svg ${Math.round(s.left)}–${Math.round(s.right)})`)
      }
    }
  }
  return out
})

const browser = await chromium.launch()
for (const viewport of [{ width: 1440, height: 900 }, { width: 900, height: 1000 }]) {
  const page = await browser.newPage({ viewport })
  await page.goto(url)
  await page.locator('#pane-diagrams .mermaid-box svg').first().waitFor()
  const label = `${viewport.width}px`
  const n0 = await page.locator('#pane-diagrams .mermaid-box svg g.node').count()
  if (n0 < 5) fail(`${label}: expected the reference diagrams to render nodes, got ${n0}`)
  let c = await clipped(page)
  if (c.length) fail(`${label} graphite: ${c.length} node(s) clipped: ${c.join('; ')}`)

  // Switch palette the way the UI does — it re-renders every diagram.
  await page.locator('.themepick button[data-v="slate"]').click()
  await page.waitForFunction(() => document.querySelector('#pane-diagrams .mermaid-box svg g.node'))
  await page.waitForTimeout(300)
  c = await clipped(page)
  if (c.length) fail(`${label} slate (after re-render): ${c.length} node(s) clipped: ${c.join('; ')}`)

  // Resize: fitDiagrams re-runs; the content must stay whole.
  await page.setViewportSize({ width: viewport.width === 1440 ? 1100 : 1300, height: viewport.height })
  await page.waitForTimeout(300)
  c = await clipped(page)
  if (c.length) fail(`${label} → resized: ${c.length} node(s) clipped: ${c.join('; ')}`)
  await page.close()
}
await browser.close()

if (failures) { console.error(`\ndiagram-clip: ${failures} failure(s)`); process.exit(1) }
console.log('OK: diagram clip — every node of every diagram is inside its SVG on screen (wide + narrow, both palettes, after re-render and resize)')
