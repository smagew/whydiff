#!/usr/bin/env node
// END-TO-END PDF comments, on the REAL engine. This is the join the two cheaper suites cannot
// cover on their own: tests/print-pdf.mjs checks the viewer contract (split, manifest, painted
// glyph) but never prints; app/test/pdf-annotate.test.mjs checks the pdf-lib/pdfjs mechanics on
// a hand-crafted PDF but never runs the viewer or Chromium. Here we drive the actual pipeline —
// assemble → real Chromium page.pdf() (the same engine as Electron printToPDF) → annotatePdf —
// and assert the locator glyphs SURVIVE a real print and become real /Text comments on the
// pages their fragments landed on. If a future change breaks the glyph (hidden by print CSS,
// too small to render, caption restructured) or the printToPDF geometry, this fails.
//
// It imports the app's annotate module directly, so it spans both dep trees (playwright from
// the plugin, pdf-lib/pdfjs from app/). It is therefore NOT in `npm test`; run it with
// `make pdf-e2e` (its own CI job installs both trees). See docs/pdf-export.md.

import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'
import { annotatePdf, readComments } from '../app/src/main/pdf-annotate.mjs'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const fail = (m) => { console.error(`FAIL: ${m}`); process.exit(1) }
const ok = (c, m) => { if (!c) fail(m) }

const work = mkdtempSync(join(tmpdir(), 'whydiff-pdfc-'))
const rm = JSON.parse(readFileSync(join(root, 'examples', 'rate-limit', 'review-map.json'), 'utf8'))
for (const f of Object.values(rm.files)) delete f.embedFull
writeFileSync(join(work, 'review-map.json'), JSON.stringify(rm))
const ev = (o) => JSON.stringify({ at: '2026-08-15T00:00:00Z', by: 'ag', ...o })
// A note on each of the two diagrams (they print on their own pages), plus a question on the
// first — so we can assert one comment per diagram-page AND that the question stays a link.
writeFileSync(join(work, 'review.log.jsonl'), [
  ev({ type: 'note.added', noteId: 'n1', kind: 'note', anchor: { kind: 'diagram-node', key: 'diagram:0:auth', label: 'Auth' }, text: 'NOTE-ONE: the auth gate before the limiter.' }),
  ev({ type: 'note.added', noteId: 'n2', kind: 'note', anchor: { kind: 'diagram-node', key: 'diagram:1:store', label: 'Store' }, text: 'NOTE-TWO: does the store TTL match the window?' }),
  ev({ type: 'note.added', noteId: 'q1', kind: 'question', anchor: { kind: 'diagram-node', key: 'diagram:0:limiter', label: 'Rate limiter' }, text: 'Where does the bucket state live?' }),
  ev({ type: 'note.added', noteId: 'a1', kind: 'answer', replyTo: 'q1', anchor: { kind: 'diagram-node', key: 'diagram:0:limiter', label: 'Rate limiter' }, text: 'In Redis, keyed by user id.' }),
].join('\n') + '\n')

const html = join(work, 'review-map.html')
execFileSync('node', [join(root, 'scripts', 'assemble.mjs'), join(work, 'review-map.json'), '--journal', work, '--out', html], { stdio: 'inherit' })

const browser = await chromium.launch()
const page = await browser.newPage({ viewport: { width: 1400, height: 1000 } })
const errors = []
page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`))
await page.goto('file://' + html)
await page.locator('#tabs .tab[data-pane="diagrams"]').click()
await page.waitForSelector('#pane-diagrams .mermaid-box svg', { timeout: 15000 })

// The app's exact export path: prepare the diagrams tab for comments, get the manifest, print.
const manifest = await page.evaluate(() => window.__whydiffPreparePrint({ tab: 'diagrams', forComments: true }))
await page.waitForTimeout(400)
ok(Array.isArray(manifest) && manifest.length === 2, `expected 2 note places in the manifest, got ${JSON.stringify(manifest)?.slice(0, 160)}`)
const pdf = await page.pdf({ format: 'A4', printBackground: true, margin: { top: '0.4in', bottom: '0.4in', left: '0.4in', right: '0.4in' }, preferCSSPageSize: false })
await browser.close()
if (errors.length) fail('page errors:\n' + errors.join('\n'))

// Inject the comments and read them back out of the produced bytes.
const warnings = []
const { bytes, added, located, total } = await annotatePdf(pdf, manifest, { warn: (m) => warnings.push(m) })
ok(total === 2, `2 locator tokens, got ${total}`)
ok(located === 2, `BOTH glyphs must survive a real Chromium print and be found by readback — located ${located}/${total} (warnings: ${warnings.join('; ')})`)
ok(added === 2, `2 comments injected, got ${added}`)

const comments = await readComments(bytes)
ok(comments.length === 2, `the produced PDF must hold 2 /Text comments, got ${comments.length}`)
ok(comments.every((c) => c.hasPopup), 'each comment has a popup')
const one = comments.find((c) => c.contents.includes('NOTE-ONE'))
const two = comments.find((c) => c.contents.includes('NOTE-TWO'))
ok(one && two, 'both note texts became comment /Contents')
// The two diagrams print on their own pages (break-before: page), so their comments must land
// on different pages — a real check that the position was read from the paginated PDF.
ok(one.pageIndex !== two.pageIndex, `each diagram's comment must land on its own page (both on ${one.pageIndex})`)
ok(one.author === 'ag' && two.author === 'ag', 'the note author travels into /T')

// The question must NOT be a comment (it is a link); no comment carries the question text.
ok(!comments.some((c) => /bucket state/.test(c.contents)), 'a question must stay a link, never a comment')

// Save for eyeballing on failure triage.
writeFileSync(join(work, 'out.pdf'), Buffer.from(bytes))
console.log(`OK: PDF comments e2e — ${added} notes became real /Text comments on their own diagram pages (located ${located}/${total}), the question stayed a link, through real Chromium print`)
