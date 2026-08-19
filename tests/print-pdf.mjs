#!/usr/bin/env node
// The print / PDF stylesheet. A map assembled with a journal is loaded, print media is
// emulated, and we assert: interactive chrome is dropped, only the active pane prints by
// default (all panes with body.print-all), and the "Notes & questions" appendix — built
// from the review threads — is shown so the discussion travels into the PDF. No real
// printing happens (that is Electron's printToPDF in the app); this checks the CSS + the
// appendix, which is the surface a PDF actually renders.

import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const fail = (m) => { console.error(`FAIL: ${m}`); process.exit(1) }
const ok = (c, m) => { if (!c) fail(m) }

const work = mkdtempSync(join(tmpdir(), 'whydiff-print-'))
const rm = JSON.parse(readFileSync(join(root, 'examples', 'rate-limit', 'review-map.json'), 'utf8'))
for (const f of Object.values(rm.files)) delete f.embedFull
writeFileSync(join(work, 'review-map.json'), JSON.stringify(rm))
const ev = (o) => JSON.stringify({ at: '2026-08-15T00:00:00Z', by: 'ag', ...o })
writeFileSync(join(work, 'review.log.jsonl'), [
  ev({ type: 'note.added', noteId: 'n1', kind: 'note', anchor: { kind: 'diagram-node', key: 'diagram:0:auth', label: 'Request path → Auth' }, text: 'PRINT-ME: the auth gate before the limiter.' }),
].join('\n') + '\n')

const html = join(work, 'review-map.html')
execFileSync('node', [join(root, 'scripts', 'assemble.mjs'), join(work, 'review-map.json'), '--journal', work, '--out', html], { stdio: 'inherit' })

const browser = await chromium.launch()
const page = await browser.newPage({ viewport: { width: 1400, height: 1000 } })
const errors = []
page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`))
await page.goto('file://' + html)
await page.locator('#tabs .tab[data-pane="diagrams"]').click()
await page.waitForSelector('#pane-diagrams svg', { timeout: 15000 })

const disp = (sel) => page.evaluate((s) => { const e = document.querySelector(s); return e ? getComputedStyle(e).display : 'MISSING' }, sel)

// The content PDF button is shown on a tab with content, and hidden on an un-generated one.
ok(await page.locator('.content-pdf').count() === 1, 'the report content should show a PDF button')
ok(await disp('.content-tools') !== 'none', 'the PDF button should be visible on a content tab (diagrams)')
await page.locator('#tabs .tab[data-pane="stories"]').click(); await page.waitForTimeout(120)  // User stories is the un-generated (lazy) pane in the example
ok(await disp('.content-tools') === 'none', 'the PDF button should be hidden on an un-generated tab (User stories placeholder)')
await page.locator('#tabs .tab[data-pane="diagrams"]').click(); await page.waitForTimeout(120)

// Clicking it preps the tab (async) and opens the print dialog.
const printed = await page.evaluate(async () => {
  let called = false; window.print = () => { called = true }
  document.querySelector('.content-pdf').click()
  for (let i = 0; i < 80 && !called; i++) await new Promise((r) => setTimeout(r, 50))
  return called
})
ok(printed, 'clicking the PDF button did not open the print dialog (window.print)')

// The notes are built at print time (beforeprint), not on load: on screen they are absent.
ok(await disp('.printnotes') === 'none', 'the print notes must be hidden on screen')
await page.evaluate(() => window.dispatchEvent(new Event('beforeprint')))
await page.waitForTimeout(200)

// Print media: chrome drops, the endnotes show, linked to/from their place.
await page.emulateMedia({ media: 'print' })
for (const sel of ['#tabs', '.rightcol', '.footstrip', '.askpanel', '#title', '.kicker']) {
  const d = await disp(sel)
  ok(d === 'none' || d === 'MISSING', `[print] ${sel} should be hidden (got ${d})`)
}
ok(await disp('.printnotes') === 'block', 'the notes endnotes must print')
const pn = (await page.locator('.printnotes').textContent()) || ''
ok(/Notes & questions/.test(pn) && pn.includes('PRINT-ME'), `the endnotes should carry the title and the note text (got: "${pn.slice(0, 80)}")`)
// Every [N] marker links to an endnote that exists (internal PDF links resolve).
const linkOk = await page.evaluate(() => {
  const refs = [...document.querySelectorAll('.pnref a, .pn-diagram-notes a')]
  if (!refs.length) return 'no [N] markers were placed at the annotated places'
  for (const a of refs) { const id = a.getAttribute('href').slice(1); if (!document.getElementById(id)) return `marker → #${id} has no target` }
  // and each endnote links back to a place that exists
  for (const back of document.querySelectorAll('.printnotes .pn-back')) { const id = back.getAttribute('href').slice(1); if (!document.getElementById(id)) return `back-link → #${id} has no target` }
  return 'ok'
})
ok(linkOk === 'ok', `notes links broken: ${linkOk}`)

// Default print shows only the active pane; print-all reveals the inactive ones.
const hiddenPane = '#pane-story'
ok(await disp(hiddenPane) === 'none', `[print] an inactive pane (${hiddenPane}) should not print by default`)
await page.evaluate(() => document.body.classList.add('print-all'))
ok(await disp(hiddenPane) === 'block', `[print] body.print-all should reveal the inactive pane (${hiddenPane})`)

// A wide diagram must FIT the page: mermaid can lay a node out past its own SVG viewBox,
// which the SVG clips — and printToPDF/page.pdf fires `beforeprint`, so the fix (re-fit the
// viewBox on beforeprint, without re-rendering, which would reset it) has to survive that
// event. Prepare the diagrams tab, fire beforeprint like the PDF path does, and assert no
// node hangs past its SVG's right edge.
await page.emulateMedia({ media: 'screen' })
await page.locator('#tabs .tab[data-pane="diagrams"]').click()
await page.evaluate(() => window.__whydiffPreparePrint({ tab: 'diagrams' }))
await page.waitForTimeout(500)
await page.evaluate(() => window.dispatchEvent(new Event('beforeprint')))
await page.waitForTimeout(200)
const clipped = await page.evaluate(() => {
  let n = 0
  for (const svg of document.querySelectorAll('#pane-diagrams .mermaid-box svg')) {
    const sr = svg.getBoundingClientRect()
    n += [...svg.querySelectorAll('.node')].filter((el) => el.getBoundingClientRect().right > sr.right + 2).length
  }
  return n
})
ok(clipped === 0, `${clipped} diagram node(s) hang past the SVG edge after beforeprint — the PDF would clip them`)

if (errors.length) fail('page errors:\n' + errors.join('\n'))
await browser.close()
console.log('OK: print/PDF — chrome dropped, active pane only (print-all reveals the rest), the notes appendix prints, and no diagram node clips past its SVG (survives beforeprint)')
