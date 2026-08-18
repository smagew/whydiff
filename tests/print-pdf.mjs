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
// Let the annotation subsystem seed the threads (so the appendix populates).
await page.locator('#tabs .tab[data-pane="diagrams"]').click()
await page.waitForSelector('#pane-diagrams svg', { timeout: 15000 })
await page.waitForFunction(() => document.querySelector('.printnotes')?.textContent?.includes('PRINT-ME'), null, { timeout: 10000 })
  .catch(() => fail('the print appendix was not built from the threads'))

const disp = (sel) => page.evaluate((s) => { const e = document.querySelector(s); return e ? getComputedStyle(e).display : 'MISSING' }, sel)

// A visible PDF button in the report header opens the print dialog.
ok(await page.locator('#tabs .print-btn').count() === 1, 'the report header should show a PDF button')
const printed = await page.evaluate(() => { let called = false; window.print = () => { called = true }; document.querySelector('#tabs .print-btn').click(); return called })
ok(printed, 'clicking the PDF button did not open the print dialog (window.print)')

// On screen the appendix is hidden; the tab bar is shown.
ok(await disp('.printnotes') === 'none', 'the print appendix must be hidden on screen')
ok(await disp('#tabs') !== 'none', 'the tab bar should be visible on screen')

// Switch to print media: chrome drops, the appendix shows.
await page.emulateMedia({ media: 'print' })
for (const sel of ['#tabs', '.rightcol', '.footstrip', '.askpanel']) {
  const d = await disp(sel)
  ok(d === 'none' || d === 'MISSING', `[print] ${sel} should be hidden (got ${d})`)
}
ok(await disp('.printnotes') === 'block', 'the notes appendix must print')
const pn = (await page.locator('.printnotes').textContent()) || ''
ok(/Notes & questions/.test(pn) && pn.includes('PRINT-ME'), `the appendix should carry the title and the note text (got: "${pn.slice(0, 80)}")`)

// Default print shows only the active pane; print-all reveals the inactive ones.
const hiddenPane = '#pane-story'
ok(await disp(hiddenPane) === 'none', `[print] an inactive pane (${hiddenPane}) should not print by default`)
await page.evaluate(() => document.body.classList.add('print-all'))
ok(await disp(hiddenPane) === 'block', `[print] body.print-all should reveal the inactive pane (${hiddenPane})`)

if (errors.length) fail('page errors:\n' + errors.join('\n'))
await browser.close()
console.log('OK: print/PDF — chrome dropped, active pane only (print-all reveals the rest), and the Notes & questions appendix prints with the review threads')
