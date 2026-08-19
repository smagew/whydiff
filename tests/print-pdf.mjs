#!/usr/bin/env node
// The print / PDF layout. A map assembled with a journal is loaded, print media is emulated,
// and we assert the two kinds of review annotation travel into the PDF DIFFERENTLY:
//  • QUESTIONS become an in-document link at their place → a "Questions" appendix (Chromium
//    keeps # links as real PDF links), linked both ways.
//  • NOTES are comments on a place. In the browser print fallback each note prints as a
//    footnote AT its place (not dumped in an appendix). The desktop Export-PDF path instead
//    returns a locator manifest (window.__whydiffPreparePrint forComments) and suppresses the
//    inline footnote, so the app can inject real PDF comment annotations (tested in the app).
// There must be NO combined "Notes & questions" heading. No real printing happens here.

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
  // A NOTE on one diagram node…
  ev({ type: 'note.added', noteId: 'n1', kind: 'note', anchor: { kind: 'diagram-node', key: 'diagram:0:auth', label: 'Request path → Auth' }, text: 'PRINT-ME: the auth gate before the limiter.' }),
  // …and a QUESTION (with its answer) on another node of the same diagram.
  ev({ type: 'note.added', noteId: 'q1', kind: 'question', anchor: { kind: 'diagram-node', key: 'diagram:0:limiter', label: 'Rate limiter' }, text: 'ASK-ME: where does the bucket state live?' }),
  ev({ type: 'note.added', noteId: 'a1', kind: 'answer', replyTo: 'q1', anchor: { kind: 'diagram-node', key: 'diagram:0:limiter', label: 'Rate limiter' }, text: 'ANSWER-ME: in Redis, keyed by user.' }),
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
const text = (sel) => page.evaluate((s) => document.querySelector(s)?.textContent || '', sel)

// The content PDF button is shown on a tab with content, and hidden on an un-generated one.
ok(await page.locator('.content-pdf').count() === 1, 'the report content should show a PDF button')
ok(await disp('.content-tools') !== 'none', 'the PDF button should be visible on a content tab (diagrams)')
await page.locator('#tabs .tab[data-pane="stories"]').click(); await page.waitForTimeout(120)  // User stories is the un-generated (lazy) pane
ok(await disp('.content-tools') === 'none', 'the PDF button should be hidden on an un-generated tab (User stories placeholder)')
await page.locator('#tabs .tab[data-pane="diagrams"]').click(); await page.waitForTimeout(120)

// The notes/questions are built at print time (beforeprint), not on load.
ok(['none', 'MISSING'].includes(await disp('.printnotes')), 'the questions appendix must not be visible on screen')
await page.evaluate(() => window.dispatchEvent(new Event('beforeprint')))
await page.waitForTimeout(200)

// ── QUESTIONS → a "Questions" appendix, linked to/from the place ──────────────
await page.emulateMedia({ media: 'print' })
ok(await disp('.printnotes') === 'block', 'the questions appendix must print')
const appendix = await text('.printnotes')
ok(/Questions/.test(appendix), 'the appendix is titled "Questions"')
ok(!/Notes\s*&\s*questions/i.test(appendix), 'there must be NO combined "Notes & questions" heading')
ok(appendix.includes('ASK-ME') && appendix.includes('ANSWER-ME'), 'the question and its answer travel into the appendix')
ok(!appendix.includes('PRINT-ME'), 'a NOTE must NOT be dumped into the questions appendix')

// ── NOTE → a footnote AT its place (browser fallback), not in the appendix ────
ok(await page.locator('.pn-inline-note').count() >= 1, 'a note should print as a footnote at its place')
ok((await text('.pn-inline-note')).includes('PRINT-ME'), 'the note footnote carries the note text')

// Every question marker links to an appendix entry that exists, and back again.
const linkOk = await page.evaluate(() => {
  const refs = [...document.querySelectorAll('.pnref a, .pn-diagram-notes a')]
  if (!refs.length) return 'no question link was placed at the annotated place'
  for (const a of refs) { const id = a.getAttribute('href').slice(1); if (!document.getElementById(id)) return `question link → #${id} has no target` }
  for (const back of document.querySelectorAll('.printnotes .pn-back')) { const id = back.getAttribute('href').slice(1); if (!document.getElementById(id)) return `back-link → #${id} has no target` }
  return 'ok'
})
ok(linkOk === 'ok', `question links broken: ${linkOk}`)

// Interactive chrome drops in print.
for (const sel of ['#tabs', '.rightcol', '.footstrip', '.askpanel', '#title', '.kicker']) {
  const d = await disp(sel)
  ok(d === 'none' || d === 'MISSING', `[print] ${sel} should be hidden (got ${d})`)
}

// ── Desktop comment path: preparePrint(forComments) returns a locator manifest and
//    suppresses the inline note footnote (the app turns notes into real PDF comments) ──
await page.emulateMedia({ media: 'screen' })
await page.locator('#tabs .tab[data-pane="diagrams"]').click()
const manifest = await page.evaluate(() => window.__whydiffPreparePrint({ tab: 'diagrams', forComments: true }))
await page.waitForTimeout(300)
ok(Array.isArray(manifest) && manifest.length === 1, `the manifest should carry one annotated place (got ${JSON.stringify(manifest)?.slice(0, 120)})`)
ok(manifest[0].anchorKey === 'diagram:0:auth', 'the manifest place is the note anchor')
ok(manifest[0].notes?.[0]?.contents.includes('PRINT-ME'), 'the manifest carries the note text')
ok(manifest[0].notes?.[0]?.author === 'ag', 'the manifest carries the note author')
ok(await page.locator('.wdx-loc').count() >= 1, 'a locator glyph should be placed for the note')
const glyphVisible = await page.evaluate(() => { const g = document.querySelector('.wdx-loc'); const s = getComputedStyle(g); return s.display !== 'none' && s.visibility !== 'hidden' && parseFloat(s.fontSize) > 0 })
ok(glyphVisible, 'the locator glyph must be painted (so it lands in the PDF text stream), not display:none/hidden/0px')
ok(await page.locator('.pn-inline-note').count() === 0, 'the inline note footnote must be suppressed in the comment path (the app makes a real PDF comment)')

// A wide diagram must FIT the page: mermaid can lay a node out past its SVG viewBox (clipped),
// and printToPDF fires beforeprint, so the re-fit must survive that event without re-render.
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
console.log('OK: print/PDF — questions link to a Questions appendix, notes print at their place (no combined heading), the desktop comment path returns a locator manifest + painted glyph and suppresses the footnote, chrome drops, no diagram clips')
