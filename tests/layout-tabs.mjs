#!/usr/bin/env node
// Acceptance for the full-window layout, the resizable file list and the diagram sub-tabs.
// Each check is the reader's goal:
//  - the report uses the window: the board spans it, with only a small gutter;
//  - the file list can be made wider or narrower by dragging the rule beside it (and from
//    the keyboard), never past sane limits, a double-click resets it, and the width
//    survives a reload; the tree still fits the window after a resize;
//  - one diagram at a time: a named tab per diagram; the shown one is drawn and fits the
//    window whole; the others are out of sight and out of the tab order; switching after a
//    palette change shows a correctly drawn diagram; arrows move between tabs;
//  - every path into a diagram opens its tab: the verdict chip, j/k, the #dg= pop-out;
//  - print still carries every diagram.

import { chromium } from 'playwright'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
let failures = 0
const fail = (m) => { console.error(`FAIL: ${m}`); failures++ }
const check = (c, m) => { if (!c) fail(m) }

const base = JSON.parse(readFileSync(join(root, 'examples', 'rate-limit', 'review-map.json'), 'utf8'))
for (const f of Object.values(base.files)) delete f.embedFull
const work = mkdtempSync(join(tmpdir(), 'whydiff-layout-'))
writeFileSync(join(work, 'm.json'), JSON.stringify(base))
execFileSync(process.execPath, [join(root, 'scripts', 'assemble.mjs'), join(work, 'm.json'), '--out', join(work, 'm.html')], { stdio: 'ignore' })
const url = pathToFileURL(join(work, 'm.html')).href
const keys = ['story', ...base.diagrams.map((_, i) => String(i))]

const browser = await chromium.launch()
const errors = []
const open = async (u = url, vp = { width: 1920, height: 1080 }) => {
  const p = await browser.newPage({ viewport: vp })
  p.on('pageerror', e => errors.push(e.message))
  await p.goto(u)
  await p.locator('#tabs .tab').first().waitFor({ state: 'attached' })
  await p.waitForTimeout(600)
  return p
}
const tab = async (p, id) => { await p.locator(`#tabs .tab[data-pane="${id}"]`).click(); await p.waitForTimeout(400) }

// ── full window ────────────────────────────────────────────────────────────────
{
  const p = await open()
  const b = await p.locator('.board').boundingBox(), sb = await p.locator('#sidebar').boundingBox()
  check(b.x - (sb.x + sb.width) <= 32 && b.x + b.width >= 1920 - 32, `the board spans the window beside the side bar with a small gutter (x ${Math.round(b.x)}, side bar ends ${Math.round(sb.x + sb.width)}, right ${Math.round(b.x + b.width)})`)
  await p.close()
}

// ── resizable file list ───────────────────────────────────────────────────────
{
  const p = await open()
  await p.evaluate(() => { try { localStorage.removeItem('whydiff:navWidth') } catch {} })
  await p.reload(); await p.waitForTimeout(500)
  await tab(p, 'files')
  const nav = p.locator('#filesNav'), split = p.locator('#filesSplit'), view = p.locator('#filesMain')
  const w0 = (await nav.boundingBox()).width, v0 = (await view.boundingBox()).width
  check(Math.abs(w0 - 340) <= 1, `the list starts at its default width (${w0})`)
  check(await split.getAttribute('role') === 'separator' && await split.getAttribute('aria-label'), 'the rule is a labelled separator')
  const s = await split.boundingBox()
  await p.mouse.move(s.x + s.width / 2, s.y + 200); await p.mouse.down()
  await p.mouse.move(s.x + s.width / 2 + 200, s.y + 200, { steps: 10 }); await p.mouse.up()
  await p.waitForTimeout(200)
  const w1 = (await nav.boundingBox()).width, v1 = (await view.boundingBox()).width
  check(Math.abs(w1 - (w0 + 200)) <= 2 && Math.abs((v0 - v1) - 200) <= 2, `dragging the rule 200px right widens the list by 200 and narrows the file (${w0}→${w1}, ${v0}→${v1})`)
  check(+(await split.getAttribute('aria-valuenow')) === Math.round(w1), 'the separator reports its value')
  // too far left stops at the minimum; too far right leaves the file room
  const s2 = await split.boundingBox()
  await p.mouse.move(s2.x + 7, s2.y + 200); await p.mouse.down(); await p.mouse.move(0, s2.y + 200, { steps: 6 }); await p.mouse.up()
  check(Math.abs((await nav.boundingBox()).width - 200) <= 1, 'the list never goes below 200px')
  const s3 = await split.boundingBox()
  await p.mouse.move(s3.x + 7, s3.y + 200); await p.mouse.down(); await p.mouse.move(1919, s3.y + 200, { steps: 6 }); await p.mouse.up()
  check((await view.boundingBox()).width >= 340, `the file keeps room when the list is dragged to the far right (${(await view.boundingBox()).width})`)
  // keyboard
  await split.dblclick(); await p.waitForTimeout(100)
  check(Math.abs((await nav.boundingBox()).width - 340) <= 1, 'a double-click resets the width')
  await split.focus(); await p.keyboard.press('ArrowRight'); await p.keyboard.press('Shift+ArrowRight')
  check(Math.abs((await nav.boundingBox()).width - (340 + 16 + 80)) <= 1, `arrow keys resize (${(await nav.boundingBox()).width})`)
  // persists
  await p.reload(); await p.waitForTimeout(500); await tab(p, 'files')
  check(Math.abs((await nav.boundingBox()).width - 436) <= 1, `the width survives a reload (${(await nav.boundingBox()).width})`)
  // a narrower window clamps it so the file keeps room
  await p.setViewportSize({ width: 1000, height: 900 }); await p.waitForTimeout(300)
  check((await view.boundingBox()).width >= 300, `after the window narrows the file still has room (${(await view.boundingBox()).width})`)
  await p.close()
}

// ── diagram sub-tabs ───────────────────────────────────────────────────────────
{
  const p = await open()
  const tabs = await p.locator('#dgTabs .dg-tab').evaluateAll(ts => ts.map(t => ({ key: t.dataset.dgkey, name: t.textContent, sel: t.getAttribute('aria-selected') })))
  check(JSON.stringify(tabs.map(t => t.key)) === JSON.stringify(keys), `one tab per diagram, storyboard first (${tabs.map(t => t.key)})`)
  check(tabs[0].name === base.storyboard.title && tabs[1].name === base.diagrams[0].title, 'tabs are named by the diagrams\' titles')
  const state = () => p.evaluate(() => [...document.querySelectorAll('#pane-diagrams .diagram')].map(d => {
    const svg = d.querySelector('pre.mermaid > svg'), r = svg?.getBoundingClientRect()
    return { key: d.dataset.dg, visible: getComputedStyle(d).visibility === 'visible' && d.getBoundingClientRect().height > 50,
      nodes: svg ? svg.querySelectorAll('g.node').length : 0, nan: !!svg && /NaN/.test(svg.innerHTML),
      fits: !!r && r.top >= 0 && r.bottom <= innerHeight && r.left >= 0 && r.right <= innerWidth,
      focusable: [...d.querySelectorAll('button, a[href]')].some(b => getComputedStyle(b).visibility === 'visible') }
  }))
  for (const k of keys) {
    await p.locator(`#dgTabs .dg-tab[data-dgkey="${k}"]`).click(); await p.waitForTimeout(500)
    const st = await state()
    const on = st.filter(d => d.visible)
    check(on.length === 1 && on[0].key === k, `tab ${k}: only its diagram is on screen (${on.map(d => d.key)})`)
    const me = st.find(d => d.key === k)
    check(me.nodes > 0 && !me.nan, `tab ${k}: the diagram is drawn (${me.nodes} nodes)`)
    check(me.fits, `tab ${k}: the whole diagram fits the window`)
    check(st.filter(d => d.key !== k).every(d => !d.focusable), `tab ${k}: hidden diagrams are out of the tab order`)
  }
  // a palette switch re-renders; then switching tabs shows a correctly drawn diagram
  await p.locator('#dgTabs .dg-tab[data-dgkey="story"]').click()
  await p.locator('.themepick button[data-v="slate"]').click(); await p.waitForTimeout(1200)
  await p.locator('#dgTabs .dg-tab[data-dgkey="1"]').click(); await p.waitForTimeout(500)
  const after = (await state()).find(d => d.key === '1')
  check(after.visible && after.nodes > 0 && !after.nan && after.fits, 'after a palette switch another tab shows its diagram drawn and whole')
  // keyboard
  await p.locator('#dgTabs .dg-tab[data-dgkey="1"]').focus()
  await p.keyboard.press('ArrowLeft')
  check(await p.evaluate(() => document.activeElement?.dataset.dgkey) === '0' && (await state()).find(d => d.key === '0').visible, 'ArrowLeft moves to and shows the previous diagram')
  await p.keyboard.press('End')
  check(await p.evaluate(() => document.activeElement?.dataset.dgkey) === keys.at(-1), 'End goes to the last diagram')
  // print carries every diagram
  await p.emulateMedia({ media: 'print' })
  const printed = await p.evaluate(() => [...document.querySelectorAll('#pane-diagrams .diagram')].filter(d => getComputedStyle(d).visibility === 'visible' && d.getBoundingClientRect().height > 50).length)
  check(printed === keys.length, `print shows every diagram (${printed}/${keys.length})`)
  check(!(await p.locator('#dgTabs').isVisible()), 'the tab row is not printed')
  await p.emulateMedia({ media: 'screen' })
  // the verdict's storyboard chip opens the storyboard tab
  await tab(p, 'ops')
  await p.locator('#dgTabs .dg-tab[data-dgkey="1"]').evaluate(b => b.click())
  await p.locator('#verdict .v-chip', { hasText: 'storyboard' }).click(); await p.waitForTimeout(300)
  check(await p.locator('#dgTabs .dg-tab[data-dgkey="story"]').getAttribute('aria-selected') === 'true', 'the storyboard chip opens the storyboard tab')
  // j moves to the next diagram's tab
  await p.locator('body').click({ position: { x: 5, y: 5 } })
  await p.keyboard.press('j'); await p.keyboard.press('j'); await p.waitForTimeout(300)
  check(await p.locator('#dgTabs .dg-tab[data-dgkey="0"]').getAttribute('aria-selected') === 'true', 'j moves to the next diagram tab')
  await p.close()
}

// ── zoom buttons never cover the drawing (long-standing overlap with the right-most card) ──
for (const vp of [{ width: 900, height: 1000 }, { width: 1920, height: 1080 }]) {
  const p = await open(url, vp)
  for (const k of keys) {
    await p.locator(`#dgTabs .dg-tab[data-dgkey="${k}"]`).click(); await p.waitForTimeout(400)
    const hit = await p.evaluate((key) => {
      const d = document.querySelector(`#pane-diagrams .diagram[data-dg="${key}"]`)
      const z = d.querySelector('.dg-zoom').getBoundingClientRect()
      return [...d.querySelectorAll('pre.mermaid > svg g.node')].filter(n => { const r = n.getBoundingClientRect(); return r.left < z.right && r.right > z.left && r.top < z.bottom && r.bottom > z.top }).length
    }, k)
    check(hit === 0, `${vp.width}px, tab ${k}: the zoom buttons cover ${hit} node(s)`)
  }
  await p.close()
}

// ── pop-out ────────────────────────────────────────────────────────────────────
{
  const p = await open(url + '#dg=1')
  await p.waitForTimeout(800)
  const st = await p.evaluate(() => [...document.querySelectorAll('#pane-diagrams .diagram')].map(d => ({ key: d.dataset.dg, shown: getComputedStyle(d).display !== 'none' && getComputedStyle(d).visibility === 'visible', nodes: d.querySelectorAll('pre.mermaid > svg g.node').length })))
  const on = st.filter(d => d.shown)
  check(on.length === 1 && on[0].key === '1' && on[0].nodes > 0, `#dg=1 pops out diagram 1 alone, drawn (${JSON.stringify(on)})`)
  check(await p.locator('.diagram[data-dg="1"] h3').isVisible(), 'the pop-out keeps the diagram\'s heading')
  await p.close()
}

await browser.close()
check(!errors.length, `page errors: ${errors.join('; ')}`)
if (failures) { console.error(`\nlayout-tabs: ${failures} failure(s)`); process.exit(1) }
console.log('OK: layout — full window; file list resizes by drag/keys within limits, resets, persists, clamps on resize; one diagram per named tab, drawn and whole, others out of sight and tab order, palette-safe, arrow keys; verdict/j/pop-out open the right tab; print keeps every diagram')
