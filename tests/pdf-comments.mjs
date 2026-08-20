#!/usr/bin/env node
// END-TO-END PDF comments on the REAL engine — placed EXACTLY where the note was left.
//
// Requirements (the reviewer's, made explicit): a note's comment lands AT its anchor — a
// diagram region at the framed area, a diagram node at the node, a text/code selection at the
// highlight — never dumped at the caption; the framed region's OUTLINE is drawn into the PDF;
// and a text/code highlight prints as it shows in the report. Placement is asserted by the
// GOAL, not a pixel proxy: two regions at different heights in one diagram must yield comments
// at different, order-preserving positions (a caption-dump would put them at the same spot).
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
// Diagram 0 is a tall flowchart (known viewBox), so we can place regions at known, far-apart
// heights; diagram 1 is a second diagram, to prove a comment lands on its own page too.
rm.diagrams = [
  { kind: 'flow-diff', title: 'Pipeline', caption: 'watch the offline backoff decision here', mermaid: 'flowchart TD\n' + Array.from({ length: 16 }, (_, i) => `  N${i}["stage ${i} of the pipeline"] --> N${i + 1}["stage ${i + 1} of the pipeline"]`).join('\n') },
  { kind: 'flow-diff', title: 'Second diagram', caption: 'another flow', mermaid: 'flowchart TD\n  A["alpha"] --> B["beta"]' },
]
writeFileSync(join(work, 'review-map.json'), JSON.stringify(rm))
const ev = (o) => JSON.stringify({ at: '2026-08-15T00:00:00Z', by: 'ag', ...o })
const region = (dg, x, y, w, h) => ({ kind: 'diagram-region', key: `diagram:${dg}:region:${Math.round(x)}-${Math.round(y)}-${Math.round(w)}-${Math.round(h)}`, rect: { x, y, w, h }, nodes: [] })
writeFileSync(join(work, 'review.log.jsonl'), [
  ev({ type: 'note.added', noteId: 'r1', kind: 'note', anchor: region(0, 30, 40, 200, 70), text: 'TOP-REGION note' }),
  ev({ type: 'note.added', noteId: 'r2', kind: 'note', anchor: region(0, 30, 760, 200, 70), text: 'BOTTOM-REGION note' }),
  ev({ type: 'note.added', noteId: 'r3', kind: 'note', anchor: region(1, 10, 10, 120, 50), text: 'SECOND-DIAGRAM note' }),
  ev({ type: 'note.added', noteId: 's1', kind: 'note', anchor: { kind: 'selection', key: 'sel:cap', quote: 'offline backoff decision' }, text: 'TEXT-SELECTION note' }),
  ev({ type: 'note.added', noteId: 'q1', kind: 'question', anchor: region(0, 30, 400, 180, 60), text: 'a question, stays a link' }),
  ev({ type: 'note.added', noteId: 'a1', kind: 'answer', replyTo: 'q1', anchor: region(0, 30, 400, 180, 60), text: 'answered' }),
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

const manifest = await page.evaluate(() => window.__whydiffPreparePrint({ tab: 'diagrams', forComments: true }))
await page.waitForTimeout(500)
ok(Array.isArray(manifest) && manifest.length === 4, `expected 4 note places (3 region + 1 selection), got ${manifest?.length}`)

// EXACT placement is engaged, not a caption dump: each diagram region got an SVG outline + an
// SVG locator injected INTO the diagram; the text selection got an HTML glyph IN its highlight.
const marks = await page.evaluate(() => ({
  regionRects: document.querySelectorAll('#pane-diagrams svg .wdx-region').length,
  svgLocs: document.querySelectorAll('#pane-diagrams svg .wdx-loc-svg').length,
  glyphInQuote: document.querySelectorAll('.askquote .wdx-loc').length,
  askquotes: document.querySelectorAll('.askquote').length,
}))
ok(marks.regionRects === 3, `3 region outlines must be drawn into the diagrams (got ${marks.regionRects})`)
ok(marks.svgLocs === 3, `3 region locators must be SVG-native, not caption glyphs (got ${marks.svgLocs})`)
ok(marks.glyphInQuote === 1, `the text-selection locator must sit in its highlight (got ${marks.glyphInQuote})`)
ok(marks.askquotes >= 1, 'the selected text must be highlighted (and so prints in the PDF)')

const pdf = await page.pdf({ format: 'A4', printBackground: true, margin: { top: '0.4in', bottom: '0.4in', left: '0.4in', right: '0.4in' }, preferCSSPageSize: false })
await browser.close()
if (errors.length) fail('page errors:\n' + errors.join('\n'))

const warnings = []
const { bytes, added, located, total } = await annotatePdf(pdf, manifest, { warn: (m) => warnings.push(m) })
ok(total === 4 && located === 4, `all 4 locators must survive a real print and be found (located ${located}/${total}; warnings: ${warnings.join('; ')})`)
ok(added === 4, `4 comments injected, got ${added}`)

const cs = await readComments(bytes)
const by = (frag) => cs.find((c) => c.contents.includes(frag))
const top = by('TOP-REGION'), bottom = by('BOTTOM-REGION'), second = by('SECOND-DIAGRAM'), text = by('TEXT-SELECTION')
ok(top && bottom && second && text, `all four notes became comments (${cs.map((c) => c.contents.slice(0, 12))})`)
// GOAL: placement tracks the anchor. The two regions sit far apart in ONE diagram, so their
// comments must be on the same page but at clearly different heights, top ABOVE bottom (PDF y
// grows upward). A caption dump would put them at the same y.
ok(top.pageIndex === bottom.pageIndex, 'both diagram-0 region comments are on diagram 0’s page')
ok(top.y - bottom.y > 80, `the top-region comment must sit well above the bottom-region one — placement tracks the anchor, not the caption (top y=${Math.round(top.y)}, bottom y=${Math.round(bottom.y)})`)
ok(second.pageIndex !== top.pageIndex, 'the second diagram’s comment lands on its own page')
// The question stays a link, never a comment.
ok(!cs.some((c) => /stays a link/.test(c.contents)), 'a question must not become a comment')

writeFileSync(join(work, 'out.pdf'), Buffer.from(bytes))
console.log(`OK: PDF comments e2e — ${added} comments land AT their anchors (regions with drawn outlines, a text highlight), placement tracks the anchor not the caption, on their own pages, through real Chromium print`)
