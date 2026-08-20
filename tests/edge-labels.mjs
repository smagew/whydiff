#!/usr/bin/env node
// Code-map link labels: readable WITHOUT being moved.
//
// The labels ride the connectors and, with "show all links" on (the default), they land on
// top of the file cards. That overlap is deliberate — the map is compact, and a label that
// refuses to overlap either walks away from its line or gets hidden, and both cost more than
// the overlap does. What must never happen is that the overlap makes something unreadable.
//
// So the contract is not "labels never overlap cards". It is:
//   1. hovering a card gets it out from under the labels — you can always read a card in full;
//   2. hovering a label quiets the other labels — you never read one through another;
//   3. the label carries a ring in the page colour, so it reads as a layer above the card
//      rather than as part of it, and that ring follows the palette;
//   4. "show all links" stays on by default — the overview is the point of the feature.
import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const fail = (m) => { console.error(`FAIL: ${m}`); process.exit(1) }
const ok = (c, m) => { if (!c) fail(m) }

const work = mkdtempSync(join(tmpdir(), 'whydiff-elabels-'))
const rm = JSON.parse(readFileSync(join(root, 'examples', 'rate-limit', 'review-map.json'), 'utf8'))
for (const f of Object.values(rm.files)) delete f.embedFull
const jsonPath = join(work, 'm.json'); const htmlPath = join(work, 'm.html')
writeFileSync(jsonPath, JSON.stringify(rm))
execFileSync('node', [join(root, 'scripts', 'assemble.mjs'), jsonPath, '--out', htmlPath], { stdio: 'pipe' })

const browser = await chromium.launch()
// Three widths: the labels are placed from live rects, so the overlaps differ per width and
// a fix proven at one size proves nothing about the others.
for (const width of [1400, 1100, 900]) {
  const page = await browser.newPage({ viewportSize: { width, height: 900 } })
  const errs = []
  page.on('pageerror', (e) => errs.push(String(e.message)))
  await page.goto('file://' + htmlPath)
  await page.waitForTimeout(1200)
  await page.locator('.tab', { hasText: 'Code map' }).click()
  await page.waitForTimeout(600)
  const at = (m) => `[${width}px] ${m}`

  ok(await page.isChecked('#allEdges'), at('"show all links" is no longer on by default — the crowded overview is the feature, not the bug'))

  // Which cards are actually covered? If none, this fixture stopped exercising the case and
  // every assertion below would pass vacuously.
  const covered = await page.evaluate(() => {
    const hit = (a, b) => !(a.right <= b.left || a.left >= b.right || a.bottom <= b.top || a.top >= b.bottom)
    const out = []
    for (const node of document.querySelectorAll('.node')) {
      const nr = node.getBoundingClientRect()
      if (!nr.width) continue
      const over = [...document.querySelectorAll('.elabel')].filter((l) => {
        const lr = l.getBoundingClientRect()
        return lr.width && +getComputedStyle(l).opacity > 0.5 && hit(lr, nr)
      }).length
      if (over) out.push({ id: node.dataset.path || node.querySelector('.fname')?.textContent?.trim() || '?', over })
    }
    return out
  })
  ok(covered.length > 0, at('no card is covered by a label — the fixture no longer exercises the overlap this test is about'))

  // A card can be read by hovering it. A GROUP HEADING cannot — there is no card there to
  // point at — so a label parked on a heading is permanently unreadable. Those get nudged off.
  const onHeadings = await page.evaluate(() => {
    const hit = (a, b) => !(a.right <= b.left || a.left >= b.right || a.bottom <= b.top || a.top >= b.bottom)
    const rows = [...document.querySelectorAll('.group-row')].map((r) => r.getBoundingClientRect())
    return [...document.querySelectorAll('.elabel')]
      .filter((l) => { const lr = l.getBoundingClientRect(); return lr.width && +getComputedStyle(l).opacity > 0.5 && rows.some((r) => hit(lr, r)) })
      .map((l) => l.textContent.trim().slice(0, 30))
  })
  ok(onHeadings.length === 0, at(`${onHeadings.length} label(s) sit on a group heading, which has no card to hover: ${onHeadings.join(' | ')}`))

  // 1. Hovering a card clears it. The reader's way to read what a label sits on.
  const first = await page.locator('.node').nth(
    await page.evaluate(() => {
      const hit = (a, b) => !(a.right <= b.left || a.left >= b.right || a.bottom <= b.top || a.top >= b.bottom)
      const nodes = [...document.querySelectorAll('.node')]
      return nodes.findIndex((n) => {
        const nr = n.getBoundingClientRect()
        return nr.width && [...document.querySelectorAll('.elabel')].some((l) => {
          const lr = l.getBoundingClientRect()
          return lr.width && +getComputedStyle(l).opacity > 0.5 && hit(lr, nr)
        })
      })
    }))
  await first.hover()
  await page.waitForTimeout(350)
  const stillOver = await page.evaluate(() => {
    const hit = (a, b) => !(a.right <= b.left || a.left >= b.right || a.bottom <= b.top || a.top >= b.bottom)
    const n = document.querySelector('.node:hover')
    if (!n) return ['(nothing is hovered)']
    const nr = n.getBoundingClientRect()
    return [...document.querySelectorAll('.elabel')]
      .filter((l) => { const lr = l.getBoundingClientRect(); return lr.width && +getComputedStyle(l).opacity > 0.5 && hit(lr, nr) })
      .map((l) => l.textContent.trim().slice(0, 30))
  })
  ok(stillOver.length === 0, at(`a hovered card is still covered by ${stillOver.length} label(s): ${stillOver.join(' | ')}`))

  // …and letting go puts the overview back. A fade that never comes back is a hidden feature.
  await page.mouse.move(2, 2)
  await page.waitForTimeout(350)
  const backAgain = await page.evaluate(() =>
    [...document.querySelectorAll('.elabel')].filter((l) => +getComputedStyle(l).opacity > 0.5).length)
  ok(backAgain > 0, at('the labels did not come back after the pointer left the card'))

  // 2. Hovering a label quiets the others.
  const visible = page.locator('.elabel').filter({ has: page.locator('.elabel-t') })
  await visible.first().hover()
  await page.waitForTimeout(350)
  const spot = await page.evaluate(() => {
    const els = [...document.querySelectorAll('.elabel')]
    const me = els.find((l) => l.matches(':hover'))
    if (!me) return null
    const others = els.filter((l) => l !== me && l.getBoundingClientRect().width)
    return { mine: +getComputedStyle(me).opacity, loud: others.filter((l) => +getComputedStyle(l).opacity > 0.3).length }
  })
  ok(spot, at('hovering a label did not register'))
  ok(spot.mine > 0.9, at(`the hovered label is not fully visible (opacity ${spot.mine})`))
  ok(spot.loud === 0, at(`${spot.loud} other label(s) stayed loud while one was hovered`))

  // 3. The ring that separates the label from the card is the page colour, from the palette.
  const ring = await page.evaluate(() => {
    const t = document.querySelector('.elabel-t')
    const cs = getComputedStyle(t)
    const canvas = getComputedStyle(document.documentElement).getPropertyValue('--canvas').trim()
    const toRgb = (h) => `rgb(${[1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16)).join(', ')})`
    return { width: parseFloat(cs.outlineWidth), color: cs.outlineColor, canvas: toRgb(canvas) }
  })
  ok(ring.width >= 2, at(`the label has no casing ring (outline-width ${ring.width})`))
  ok(ring.color === ring.canvas, at(`the casing is not the page colour: ${ring.color} vs ${ring.canvas}`))

  // …and it follows the palette. Switch it the way the UI does (see gotchas: setting data-p
  // directly skips applyPalette).
  await page.locator('.themepick button[data-v="bond"]').click()
  await page.waitForTimeout(400)
  const ring2 = await page.evaluate(() => {
    const cs = getComputedStyle(document.querySelector('.elabel-t'))
    const canvas = getComputedStyle(document.documentElement).getPropertyValue('--canvas').trim()
    const toRgb = (h) => `rgb(${[1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16)).join(', ')})`
    return { color: cs.outlineColor, canvas: toRgb(canvas) }
  })
  ok(ring2.color === ring2.canvas, at(`after a palette switch the casing is stale: ${ring2.color} vs ${ring2.canvas}`))

  ok(errs.length === 0, at(`page errors: ${errs.join(' | ')}`))
  await page.close()
}
await browser.close()
console.log('OK: edge labels — a hovered card comes out from under them, a hovered label quiets the rest, the casing tracks the palette, and "show all links" stays on')
