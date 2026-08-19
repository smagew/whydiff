import { PDFDocument, PDFName, PDFString, PDFArray } from 'pdf-lib'

// pdfjs-dist v4 is ESM-only (no CJS build). The app's main process is bundled to CommonJS,
// so a static import becomes a require() of pdf.mjs → ERR_REQUIRE_ESM, which crashes the
// packaged app at launch. Load it lazily with a runtime dynamic import() instead (the same
// ESM-in-Electron pattern whydiff.mjs uses for the plugin's review.mjs); the /* @vite-ignore */
// keeps electron-vite from rewriting it back to a require. pdfjs is asarUnpack'd (see
// electron-builder.yml) so it resolves from a real path, not inside the asar archive.
let _pdfjs
async function loadPdfjs() {
  if (!_pdfjs) _pdfjs = await import(/* @vite-ignore */ 'pdfjs-dist/legacy/build/pdf.mjs')
  return _pdfjs
}

/**
 * Read every /Text comment annotation back out of a PDF: page index, note text, author,
 * whether it has a popup, and its lower-left point. Used by the tests to assert against the
 * produced bytes (never viewer internals), and handy for round-trip verification.
 */
export async function readComments(pdfBytes) {
  const doc = await PDFDocument.load(pdfBytes)
  const out = []
  doc.getPages().forEach((page, pageIndex) => {
    const annots = page.node.Annots()
    if (!annots) return
    for (let i = 0; i < annots.size(); i++) {
      const d = annots.lookup(i)
      if (d?.get?.(PDFName.of('Subtype'))?.toString() !== '/Text') continue
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

// Turn the review notes into REAL PDF comment annotations, placed where each note's anchor
// actually rendered. The desktop Export-PDF path drops an invisible locator glyph at each
// note's place (viewer: placeLocators) and prints the page; here we read each glyph's real
// position back out of the produced PDF and inject a /Text (+/Popup) annotation there. The
// position comes from the finished PDF, so it survives forced page breaks and diagram
// fit-scaling — there is no fragile px→point/page math to get wrong.

const pad = (n) => String(n).padStart(2, '0')
// PDF date string: D:YYYYMMDDHHmmSSZ (readers sort the Comments panel by /M).
const pdfDate = (d) => `D:${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}Z`

/**
 * Read each locator token's rendered position back out of a produced PDF: its page index and
 * baseline point in PDF user space (origin bottom-left, points), taken straight from pdfjs'
 * text-item transform. Returns Map<token, {pageIndex, x, y}>. A token can be split across
 * text items, so the items are concatenated and each character mapped back to its item.
 */
export async function locateTokens(pdfBytes, tokens) {
  // Minimal options on purpose: passing isEvalSupported/useSystemFonts pushes pdfjs onto a
  // worker-transfer path that throws a DataCloneError under Node's fake worker. Plain { data }
  // runs on the main thread and is all we need (text-item transforms, no font rendering).
  const pdfjs = await loadPdfjs()
  const data = Uint8Array.from(pdfBytes instanceof Uint8Array ? pdfBytes : new Uint8Array(pdfBytes))
  const pdf = await pdfjs.getDocument({ data, verbosity: 0 }).promise
  const want = new Set(tokens)
  const found = new Map()
  try {
    for (let p = 1; p <= pdf.numPages && found.size < want.size; p++) {
      const page = await pdf.getPage(p)
      const { items } = await page.getTextContent({ disableNormalization: true })
      let concat = ''
      const owner = []
      for (let i = 0; i < items.length; i++) {
        const s = items[i].str || ''
        for (let k = 0; k < s.length; k++) owner.push(i)
        concat += s
      }
      for (const tok of want) {
        if (found.has(tok)) continue
        const at = concat.indexOf(tok)
        if (at < 0) continue
        const it = items[owner[at]]
        found.set(tok, { pageIndex: p - 1, x: it.transform[4], y: it.transform[5] })
      }
    }
  } finally {
    await pdf.destroy()
  }
  return found
}

/**
 * Inject a real /Text comment annotation for every note in the manifest, at the position its
 * locator token rendered. `manifest` is [{ token, anchorKey, notes:[{contents, author, nm}] }]
 * (viewer: placeLocators). Notes sharing an anchor are stacked so they do not overlap. A token
 * that did not render (its place was on a non-printed tab, or was empty) is skipped and warned
 * — never fabricated. Returns { bytes, added, located, total }.
 */
export async function annotatePdf(pdfBytes, manifest, { now = new Date(), warn = () => {} } = {}) {
  const tokens = manifest.map((m) => m.token)
  const pos = await locateTokens(pdfBytes, tokens)
  const doc = await PDFDocument.load(pdfBytes)
  const pages = doc.getPages()
  const ctx = doc.context
  const ICON = 18
  let added = 0
  for (const m of manifest) {
    const at = pos.get(m.token)
    if (!at) { warn(`whydiff: locator ${m.token} (${m.anchorKey}) did not render — skipping ${m.notes.length} comment(s)`); continue }
    const page = pages[at.pageIndex]
    if (!page) { warn(`whydiff: locator ${m.token} points at missing page ${at.pageIndex}`); continue }
    const { height } = page.getSize()
    const y0 = Math.max(2, Math.min(at.y, height - ICON - 2))
    m.notes.forEach((note, i) => {
      const oy = Math.max(2, y0 - i * (ICON + 4)) // stack notes on one anchor down the page
      const popup = ctx.obj({ Type: 'Annot', Subtype: 'Popup', Rect: [at.x + ICON, Math.max(2, oy - 90), at.x + ICON + 200, oy + ICON], Open: false })
      const popupRef = ctx.register(popup)
      const annot = ctx.obj({
        Type: 'Annot', Subtype: 'Text', Rect: [at.x, oy, at.x + ICON, oy + ICON],
        Contents: PDFString.of(note.contents || ''),
        T: PDFString.of(note.author || 'whydiff'),
        Subj: PDFString.of('Note'),
        Name: PDFName.of('Comment'),
        NM: PDFString.of(note.nm || `${m.token}-${i}`),
        M: PDFString.of(pdfDate(now)),
        F: 4, CA: 1, Open: false, // F=4: Print flag, so the marker is kept when the PDF is printed
      })
      annot.set(PDFName.of('Popup'), popupRef)
      annot.set(PDFName.of('P'), page.ref)
      const annotRef = ctx.register(annot)
      popup.set(PDFName.of('Parent'), annotRef)
      let annots = page.node.lookupMaybe(PDFName.of('Annots'), PDFArray)
      if (!annots) { annots = ctx.obj([]); page.node.set(PDFName.of('Annots'), annots) }
      annots.push(annotRef)
      annots.push(popupRef)
      added++
    })
  }
  const bytes = await doc.save()
  return { bytes, added, located: pos.size, total: tokens.length }
}
