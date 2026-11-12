#!/usr/bin/env node
// Regression: a map that drifted from the schema must not print JavaScript's
// "undefined" or "[object Object]" anywhere in the viewer. Seen in a real run: groups
// with only { id, files } rendered "undefined" as every group heading in the Files
// overview, and ops.migrations as { name, note } objects rendered "[object Object]".
// merge.mjs now refuses / normalises those, but a map saved by an older run still
// opens in the viewer (assemble only warns), so the viewer must degrade on its own.
// Walks every tab and every Files mode, and opens a group's drill-down.

import { chromium } from 'playwright'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const rm = JSON.parse(readFileSync(join(root, 'examples', 'rate-limit', 'review-map.json'), 'utf8'))
for (const f of Object.values(rm.files)) delete f.embedFull
for (const g of rm.groups) { delete g.name; delete g.role; delete g.tag; delete g.why }
rm.ops = { ...(rm.ops || {}), migrations: [{ name: '0806_add_flag', note: 'adds a nullable column' }], deploy: [{ step: 'run migrate' }] }
const work = mkdtempSync(join(tmpdir(), 'whydiff-degrade-'))
writeFileSync(join(work, 'review-map.json'), JSON.stringify(rm))
execFileSync(process.execPath, [join(root, 'scripts', 'assemble.mjs'), join(work, 'review-map.json'), '--out', join(work, 'map.html')], { stdio: 'ignore' })

let failures = 0
const fail = (msg) => { console.error(`FAIL: ${msg}`); failures++ }
const BAD = /\bundefined\b|\[object Object\]/

const browser = await chromium.launch()
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } })
const errors = []
page.on('pageerror', (e) => errors.push(e.message))
await page.goto(pathToFileURL(join(work, 'map.html')).href)
await page.locator('#tabs .tab').first().waitFor()

const scan = async (where) => {
  const hit = await page.evaluate((re) => {
    const rx = new RegExp(re)
    const out = []
    const walk = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT)
    for (let n; (n = walk.nextNode());) {
      const el = n.parentElement
      if (!el || el.closest('script, style') || !el.getClientRects().length) continue
      if (rx.test(n.textContent)) out.push(`${el.className || el.tagName}: "${n.textContent.trim().slice(0, 50)}"`)
    }
    for (const el of document.querySelectorAll('[title], [aria-label]')) {
      for (const a of ['title', 'aria-label']) if (rx.test(el.getAttribute(a) || '')) out.push(`${a} of ${el.className || el.tagName}`)
    }
    return out
  }, BAD.source)
  if (hit.length) fail(`${where}: ${hit.length} placeholder(s): ${hit.slice(0, 5).join('; ')}`)
}

const panes = await page.locator('#tabs .tab').evaluateAll((ts) => ts.map((t) => t.dataset.pane))
for (const pane of panes) {
  await page.locator(`#tabs .tab[data-pane="${pane}"]`).click()
  await page.waitForTimeout(150)
  await scan(`tab ${pane}`)
  if (pane !== 'files') continue
  const modes = await page.locator('#filesModebar .files-mode-btn').count()
  for (let i = 0; i < modes; i++) {
    await page.locator('#filesModebar .files-mode-btn').nth(i).click()
    await page.waitForTimeout(150)
    await scan(`files mode ${i}`)
  }
  await page.locator('#filesModebar .files-mode-btn').first().click()
  const g = page.locator('[data-gogroup]').first()
  if (await g.count()) { await g.click(); await page.waitForTimeout(150); await scan('group drill-down') }
}
// The help dialog carries the group legend.
const help = page.locator('#helpBtn, button[aria-label="Help"], .help-btn').first()
if (await help.count()) { await help.click().catch(() => {}); await page.waitForTimeout(150); await scan('help dialog') }

if (errors.length) fail(`page errors: ${errors.join('; ')}`)
await browser.close()

if (failures) { console.error(`\nviewer-degrade: ${failures} failure(s)`); process.exit(1) }
console.log('OK: viewer degrade — no "undefined" / "[object Object]" on any tab or Files mode for a map with nameless groups and object-form ops')
