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

// The reference example predates the user-stories pass. The tab now STAYS in the
// menu even when the pass has not run — opening it shows an explanation and (in
// served mode) a Generate button, rather than vanishing. So the tab is present but
// its pane is the lazy placeholder, not story cards.
const tabs = await page.locator('#tabs .tab').count()
if (tabs !== 7) fail(`expected 7 tabs (stories stays as a placeholder), got ${tabs}`)
await page.locator('#tabs .tab[data-pane="stories"]').click()
await page.waitForTimeout(150)
if ((await page.locator('#pane-stories .lazy').count()) !== 1) fail('ungenerated user-stories tab did not show the lazy placeholder')

// Diagrams render lazily on first tab open. Address by data-pane, not index: the
// always-present stories tab now sits at index 1.
await page.locator('#tabs .tab[data-pane="diagrams"]').click()
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
await page.locator('#tabs .tab[data-pane="diagrams"]').click()
const [popup] = await Promise.all([
  page.waitForEvent('popup'),
  page.locator('.diagram [data-pop]').first().click(),
])
await popup.waitForLoadState()
if ((await popup.locator('svg').count()) !== 1) fail('diagram pop-out window has no svg')
await popup.close()

// ── second pass: the user-stories tab ────────────────────────────────────────
// Tabs are addressed by data-pane, not by index, so adding a tab cannot silently
// repoint these assertions at a neighbour.
const paths = Object.keys(rm.files)
const withStories = {
  ...rm,
  userStories: {
    summary: 'Smoke summary: outside behavior changed.',
    stories: [
      { actor: 'caller', story: 'I get a clear error when I exceed the limit.', status: 'delivered', why: 'guard added', files: [paths[0]], covered: true },
      { actor: 'operator', story: 'I can no longer see the old counter.', status: 'regressed', why: 'field dropped', files: [paths[1] || paths[0]], covered: false },
      { actor: 'caller', story: 'I am throttled per key rather than globally.', status: 'partial', why: 'key derivation incomplete', files: [paths[0]] },
    ],
  },
}
const storiesHtml = join(work, 'review-map-stories.html')
const storiesJson = join(work, 'review-map-stories.json')
writeFileSync(storiesJson, JSON.stringify(withStories))
execFileSync('node', [join(root, 'scripts', 'assemble.mjs'), storiesJson, '--out', storiesHtml], { stdio: 'inherit' })

const page2 = await browser.newPage()
const errors2 = []
page2.on('pageerror', (e) => errors2.push(`pageerror: ${e.message}`))
page2.on('console', (m) => { if (m.type() === 'error') errors2.push(`console: ${m.text()}`) })
await page2.goto('file://' + storiesHtml)

const tabs2 = await page2.locator('#tabs .tab').count()
if (tabs2 !== 7) fail(`expected 7 tabs on a map with userStories, got ${tabs2}`)

// The tab badge counts problems (regressed+broken+partial), not total stories.
const badge = (await page2.locator('#tabs .tab[data-pane="stories"] .cnt').textContent() || '').trim()
if (badge !== '2') fail(`expected the stories tab to badge 2 problems, got "${badge}"`)

await page2.locator('#tabs .tab[data-pane="stories"]').click()
await page2.waitForTimeout(200)

const cards = await page2.locator('#stories .ustory').count()
if (cards !== 3) fail(`expected 3 story cards, got ${cards}`)

// Bad news first, regardless of the order the model emitted.
const STATUSES = ['regressed', 'broken', 'partial', 'delivered']
const order = await page2.locator('#stories .ustory').evaluateAll(
  (els, statuses) => els.map((e) => [...e.classList].find((c) => statuses.includes(c))), STATUSES)
if (order.join(',') !== 'regressed,partial,delivered') fail(`stories not sorted problems-first: ${order.join(',')}`)

const uncovered = await page2.locator('#stories .ucov.no').count()
if (uncovered !== 1) fail(`expected 1 "no test" marker, got ${uncovered}`)

// The Overview | Call graph aside belongs to the Code map, so a prose tab like
// stories has none by default — the reading column runs full width. A story's file
// chip still reveals the aside on demand for that file's drill-down.
if (!(await page2.locator('.layout.solo').count())) fail('the aside should be collapsed on the stories tab, not shown by default')
await page2.locator('#stories .ustory .fchip').first().click()
await page2.waitForTimeout(250)
if (await page2.locator('.layout.solo').count()) fail('a story chip did not reveal the aside for the file drill-down')
const insp2 = (await page2.locator('#inspector h3').textContent()) || ''
if (!insp2.includes('/')) fail(`story chip did not open a file (got: "${insp2}")`)

if (errors2.length) fail('page errors (stories pass):\n' + errors2.join('\n'))

if (errors.length) fail('page errors:\n' + errors.join('\n'))

await browser.close()
console.log(`OK: 7 tabs (stories placeholder), ${clickable} clickable diagram nodes, node click opened ${insp.trim()}, ${scopeChips} scope chips (filter dims ${dimmed}), diagram pop-out works, no page errors`)
console.log(`OK: user stories — 7 tabs, badge ${badge}, ${cards} cards sorted ${order.join('/')}, aside is Code-map-only, chip revealed ${insp2.trim()}`)
