#!/usr/bin/env node
// End-to-end smoke test: assemble the reference example into HTML, open it in
// headless chromium, and verify the viewer works — tabs render, mermaid
// diagrams produce clickable nodes, clicking a node opens the file in the
// inspector, and the page throws no errors.
//
// Requires the `playwright` dev dependency and a chromium browser
// (`npx playwright install chromium`).

import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const examplePath = join(root, 'examples', 'rate-limit', 'review-map.json')

// The example marks files with embedFull, which requires the original repo on
// disk — strip the flags so the test runs anywhere (fragments still render).
const rm = JSON.parse(readFileSync(examplePath, 'utf8'))
for (const f of Object.values(rm.files)) delete f.embedFull
const work = mkdtempSync(join(tmpdir(), 'whydiff-smoke-'))
const jsonPath = join(work, 'review-map.json')
const htmlPath = join(work, 'review-map.html')
writeFileSync(jsonPath, JSON.stringify(rm))

execFileSync('node', [join(root, 'scripts', 'assemble.mjs'), jsonPath, '--out', htmlPath], { stdio: 'inherit' })

const fail = (msg) => { console.error(`FAIL: ${msg}`); process.exit(1) }
const browser = await chromium.launch()
const page = await browser.newPage()
const errors = []
page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`))
page.on('console', (m) => { if (m.type() === 'error') errors.push(`console: ${m.text()}`) })

await page.goto('file://' + htmlPath)

const tabs = await page.locator('#tabs .tab').count()
if (tabs !== 6) fail(`expected 6 tabs, got ${tabs}`)

// Diagrams render lazily on first tab open.
await page.locator('#tabs .tab').nth(1).click()
await page.waitForSelector('#pane-diagrams svg', { timeout: 15000 })
await page.waitForTimeout(400)

const clickable = await page.locator('#pane-diagrams .clickable').count()
if (clickable < 1) fail('no clickable mermaid nodes rendered')

await page.locator('#pane-diagrams .clickable').first().click()
await page.waitForTimeout(300)
const insp = (await page.locator('#inspector h3').textContent()) || ''
if (!insp.includes('/')) fail(`inspector did not open a file after node click (got: "${insp}")`)

// Scope bar: service chips exist and filter the Files tab.
const scopeChips = await page.locator('#scopebar .scope-chip').count()
if (scopeChips < 2) fail(`expected >=2 scope chips, got ${scopeChips}`)
await page.locator('#scopebar .scope-chip').first().click()
await page.waitForTimeout(200)
const dimmed = await page.locator('.node.dim').count()
if (dimmed < 1) fail('scope filter did not dim non-matching file nodes')

// Diagram pop-out: opens a standalone window with the rendered SVG.
await page.locator('#tabs .tab').nth(1).click()
const [popup] = await Promise.all([
  page.waitForEvent('popup'),
  page.locator('.diagram [data-pop]').first().click(),
])
await popup.waitForLoadState()
if ((await popup.locator('svg').count()) !== 1) fail('diagram pop-out window has no svg')
await popup.close()

if (errors.length) fail('page errors:\n' + errors.join('\n'))

await browser.close()
console.log(`OK: 6 tabs, ${clickable} clickable diagram nodes, node click opened ${insp.trim()}, ${scopeChips} scope chips (filter dims ${dimmed}), diagram pop-out works, no page errors`)
