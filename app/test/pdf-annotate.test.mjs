// pdf-annotate: real PDF comment annotations placed by locator-glyph readback.
// We craft a 2-page PDF that draws known locator tokens at known points, then:
//  1) assert locateTokens reads each token back at the point it was drawn — this is the
//     coordinate invariant the whole approach rests on (pdfjs transform == PDF bottom-left
//     point, no flip). If it ever regresses, this fails loudly instead of misplacing comments.
//  2) assert annotatePdf injects one real /Text (+/Popup) comment per note, on the right page,
//     at that point, with the note text as /Contents — and stacks multiple notes on one anchor.
//  3) assert a token that was never drawn is skipped (warned), never fabricated.
import assert from 'node:assert/strict'
import { PDFDocument, PDFName, PDFString } from 'pdf-lib'
import { annotatePdf, locateTokens } from '../src/main/pdf-annotate.mjs'

const TOK0 = 'WDX000WDX', TOK1 = 'WDX001WDX', MISSING = 'WDX009WDX'
const P0 = { x: 120, y: 650 }, P1 = { x: 90, y: 400 }

// A 2-page PDF with a locator token painted at a known baseline on each page.
async function craft() {
  const doc = await PDFDocument.create()
  const a = doc.addPage([595, 842]) // A4 points
  a.drawText(TOK0, { x: P0.x, y: P0.y, size: 6 })
  const b = doc.addPage([595, 842])
  b.drawText(TOK1, { x: P1.x, y: P1.y, size: 6 })
  return await doc.save()
}

// Every /Subtype /Text annotation across the doc, with the fields we care about.
async function readComments(bytes) {
  const doc = await PDFDocument.load(bytes)
  const out = []
  doc.getPages().forEach((page, pageIndex) => {
    const annots = page.node.Annots()
    if (!annots) return
    for (let i = 0; i < annots.size(); i++) {
      const d = annots.lookup(i)
      const sub = d?.get?.(PDFName.of('Subtype'))
      if (!sub || sub.toString() !== '/Text') continue
      const rect = d.get(PDFName.of('Rect')).asArray().map((n) => n.asNumber())
      out.push({
        pageIndex,
        contents: d.get(PDFName.of('Contents')).decodeText(),
        author: d.get(PDFName.of('T')).decodeText(),
        hasPopup: !!d.get(PDFName.of('Popup')),
        x: rect[0], y: rect[1],
      })
    }
  })
  return out
}

async function main() {
  const pdf = await craft()

  // 1) coordinate invariant: readback lands on the drawn point (bottom-left, no flip).
  const pos = await locateTokens(pdf, [TOK0, TOK1])
  assert.ok(pos.has(TOK0) && pos.has(TOK1), 'both tokens should be located')
  assert.equal(pos.get(TOK0).pageIndex, 0, 'TOK0 is on page 0')
  assert.equal(pos.get(TOK1).pageIndex, 1, 'TOK1 is on page 1')
  assert.ok(Math.abs(pos.get(TOK0).x - P0.x) < 2 && Math.abs(pos.get(TOK0).y - P0.y) < 2,
    `readback of TOK0 (${pos.get(TOK0).x},${pos.get(TOK0).y}) should match drawn (${P0.x},${P0.y}) — coordinate assumption`)
  assert.ok(Math.abs(pos.get(TOK1).x - P1.x) < 2 && Math.abs(pos.get(TOK1).y - P1.y) < 2,
    `readback of TOK1 (${pos.get(TOK1).x},${pos.get(TOK1).y}) should match drawn (${P1.x},${P1.y})`)

  // 2) inject: one anchor with one note, one anchor with two notes (stacked), one missing.
  const warnings = []
  const manifest = [
    { token: TOK0, anchorKey: 'diagram:0', notes: [{ contents: 'the auth gate', author: 'ag', nm: 'd0::n1' }] },
    { token: TOK1, anchorKey: 'sel:x', notes: [
      { contents: 'first on this spot', author: 'ag', nm: 's::n1' },
      { contents: 'second on this spot', author: 'ag', nm: 's::n2' },
    ] },
    { token: MISSING, anchorKey: 'gone', notes: [{ contents: 'never printed', author: 'ag', nm: 'g::n1' }] },
  ]
  const now = new Date('2026-08-19T00:00:00Z')
  const { bytes, added, located, total } = await annotatePdf(pdf, manifest, { now, warn: (m) => warnings.push(m) })
  assert.equal(added, 3, 'three comments injected (1 + 2), the missing token contributes none')
  assert.equal(total, 3, 'three tokens in the manifest')
  assert.equal(located, 2, 'two tokens located; the missing one is not')
  assert.equal(warnings.length, 1, 'the missing token is warned exactly once')
  assert.match(warnings[0], /WDX009WDX/, 'the warning names the missing locator')

  const comments = await readComments(bytes)
  assert.equal(comments.length, 3, 'the produced PDF holds three /Text comments')
  assert.ok(comments.every((c) => c.hasPopup), 'each comment has a /Popup')
  const byText = Object.fromEntries(comments.map((c) => [c.contents, c]))
  assert.ok(byText['the auth gate'], 'the note text becomes /Contents')
  assert.ok(byText['first on this spot'] && byText['second on this spot'], 'both notes on one anchor become comments')
  assert.ok(!byText['never printed'], 'a note whose place did not print produces no comment')

  // right page + point
  assert.equal(byText['the auth gate'].pageIndex, 0, 'the diagram:0 note lands on page 0')
  assert.ok(Math.abs(byText['the auth gate'].x - P0.x) < 3 && Math.abs(byText['the auth gate'].y - P0.y) < 3,
    'the comment sits at the anchor point')
  assert.equal(byText['first on this spot'].pageIndex, 1, 'the sel note lands on page 1')
  assert.equal(byText['second on this spot'].pageIndex, 1, 'the second note stays on the same page')
  assert.ok(byText['second on this spot'].y < byText['first on this spot'].y, 'stacked notes step down the page, not overlap')

  console.log('OK: pdf-annotate — locator readback matches drawn point; notes become real /Text comments on the right page; missing tokens are skipped not faked')
}

main().catch((e) => { console.error(e); process.exit(1) })
