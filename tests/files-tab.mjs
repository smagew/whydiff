#!/usr/bin/env node
// The "Files" tab (restructure of "Code map") — IDE layout: a navigator on the LEFT
// (Overview | Files list | Call graph), the selected file's view in the MAIN content area.
// See docs/files-tab.md for the agreed spec + acceptance checklist. These assert the GOALS
// (default first-file view; each mode lists/opens files; a click opens the CONTENT file view,
// not the aside; and the PDF carries the file view), not pixel proxies.
import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const fail = (m) => { console.error(`FAIL: ${m}`); process.exit(1) }
const ok = (c, m) => { if (!c) fail(m) }

const work = mkdtempSync(join(tmpdir(), 'whydiff-files-'))
const rm = JSON.parse(readFileSync(join(root, 'examples', 'rate-limit', 'review-map.json'), 'utf8'))
for (const f of Object.values(rm.files)) delete f.embedFull
writeFileSync(join(work, 'review-map.json'), JSON.stringify(rm))
const nFiles = rm.manifest.length
const firstPath = rm.manifest[0][0]

const html = join(work, 'review-map.html')
execFileSync('node', [join(root, 'scripts', 'assemble.mjs'), join(work, 'review-map.json'), '--out', html], { stdio: 'inherit' })

const browser = await chromium.launch()
const page = await browser.newPage({ viewport: { width: 1400, height: 1000 } })
const errors = []
page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`))
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()) })
await page.goto('file://' + html)
await page.waitForTimeout(400)

// The tab is labelled "Files" (default locale English) and its pane id is unchanged.
const tabLabel = (await page.locator('#tabs .tab[data-pane="files"]').textContent())?.trim() || ''
ok(/^Files\b/.test(tabLabel) && !/Code/.test(tabLabel), `the tab must read "Files" (got "${tabLabel}")`)

// #2/#7: the switcher is on the LEFT (inside the navigator column), with three modes,
// Overview first/default; on entering Files the FIRST file is shown in the main view.
await page.locator('#tabs .tab[data-pane="files"]').click()
await page.waitForTimeout(300)
const modes = await page.locator('#filesModebar .files-mode-btn').allTextContents()
ok(modes.length === 3, `three navigator modes expected (got ${modes.length}: ${modes.join(', ')})`)
ok(await page.locator('#filesModebar .files-mode-btn.on').first().getAttribute('data-filesmode') === 'overview', 'Overview is the default mode on entering Files')
// The switcher sits left of the file view (navigator column comes first in the flex row).
const laidOut = await page.evaluate(() => {
  const nav = document.querySelector('.files-nav'), view = document.querySelector('.files-view')
  if (!nav || !view) return false
  const nr = nav.getBoundingClientRect(), vr = view.getBoundingClientRect()
  return nr.width > 0 && vr.width > 0 && nr.left < vr.left // navigator is to the LEFT of the view
})
ok(laidOut, 'the navigator must sit to the LEFT of the file view')
const firstView = (await page.locator('#filesView h3').textContent()) || ''
ok(firstView.includes(firstPath) || firstView.includes('/'), `the first file's view must show by default (got "${firstView}", want ${firstPath})`)
// The file view is in the MAIN content area, NOT the right-column aside.
ok(await page.evaluate(() => document.querySelector('.layout')?.classList.contains('solo')), 'the Files tab must not open the right-column aside — the file view is the main content')

// #3 Overview: grouped file list, no card-map; clicking a file opens it in the view.
ok(await page.locator('#filesOverview .ovg-file').count() >= 1, 'Overview lists grouped files')
ok(await page.evaluate(() => !!document.getElementById('filesCall')?.hidden), 'Overview must NOT show the card-map (Call graph is hidden)')
const ovTarget = await page.locator('#filesOverview [data-gofile]').nth(1).getAttribute('data-gofile')
await page.locator('#filesOverview [data-gofile]').nth(1).click()
await page.waitForTimeout(200)
ok(((await page.locator('#filesView h3').textContent()) || '').includes(ovTarget), `clicking a file in Overview opens it in the content view (want ${ovTarget})`)

// #4 Files list: a flat list of EVERY file; clicking opens the view.
await page.locator('#filesModebar .files-mode-btn[data-filesmode="list"]').click()
await page.waitForTimeout(150)
const rows = await page.locator('#filesList .files-flat-row').count()
ok(rows === nFiles, `Files list must list every file (got ${rows}/${nFiles})`)
const listTarget = await page.locator('#filesList .files-flat-row').last().getAttribute('data-path')
await page.locator('#filesList .files-flat-row').last().click()
await page.waitForTimeout(200)
ok(((await page.locator('#filesView h3').textContent()) || '').includes(listTarget), `clicking a Files-list row opens it in the content view (want ${listTarget})`)

// #5 Call graph: card-map (nodes + edges) AND the dependency tree; clicking a card opens the view.
// The map takes the FULL width of the main column (the narrow navigator is hidden), so a 2D map
// has room — not squeezed into the ~340px nav.
await page.locator('#filesModebar .files-mode-btn[data-filesmode="callgraph"]').click()
await page.waitForTimeout(400)
const cg = await page.evaluate(() => ({
  nodes: [...document.querySelectorAll('#map .node')].filter((n) => n.getBoundingClientRect().width > 0).length,
  edges: document.querySelectorAll('#edges line, #edges path').length,
  tree: document.querySelectorAll('#callTree [data-gofile], #callTree .ct-file').length,
  navHidden: !!document.getElementById('filesNav')?.hidden,
  mapWidth: document.getElementById('map')?.getBoundingClientRect().width || 0,
}))
ok(cg.nodes >= 1, 'Call graph shows the card-map nodes')
ok(cg.edges >= 1, 'Call graph draws connector edges (drawEdges ran on entering the mode)')
ok(cg.tree >= 1, 'Call graph also shows the dependency tree')
ok(cg.navHidden, 'the narrow navigator is hidden in Call graph mode (the map goes full-width)')
ok(cg.mapWidth > 340, `the card-map must span the full main column, not the ~340px nav (got ${Math.round(cg.mapWidth)}px)`)
const nodeTarget = await page.locator('#map .node').first().getAttribute('data-path')
await page.locator('#map .node').first().click()
await page.waitForTimeout(200)
ok(((await page.locator('#filesView h3').textContent()) || '').includes(nodeTarget), `clicking a card in Call graph opens it in the content view (want ${nodeTarget})`)
// Still the main content area, never the aside.
ok(await page.evaluate(() => document.querySelector('.layout')?.classList.contains('solo')), 'a Call-graph card click must open the MAIN file view, not the aside')

// #9 PDF: with a file open, the PDF shows the file view; the navigator chrome is hidden in print.
await page.emulateMedia({ media: 'print' })
await page.waitForTimeout(100)
const printState = await page.evaluate(() => {
  const vis = (s) => { const e = document.querySelector(s); return e ? getComputedStyle(e).display !== 'none' : false }
  return {
    view: vis('#filesView') && !!document.querySelector('#filesView h3'),
    nav: vis('.files-nav'),
    modebar: vis('.files-modebar'),
  }
})
ok(printState.view, 'the file view must print (the PDF shows the open file, #6)')
ok(!printState.nav && !printState.modebar, 'the navigator chrome (nav + switcher) must be hidden in print')
await page.emulateMedia({ media: 'screen' })

if (errors.length) fail('page errors:\n' + errors.join('\n'))
await browser.close()
console.log(`OK: Files tab — "Files" label, left navigator (Overview default) + main-area file view, ${nFiles} files listed, each mode opens files into the content view (not the aside), Call graph carries map+tree, and the PDF prints the open file with nav chrome hidden`)
