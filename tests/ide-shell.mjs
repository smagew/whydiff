#!/usr/bin/env node
// Acceptance for the IDE shell: a title bar across the top and a side bar of sections.
// Each check is the reader's goal:
//  - the title bar stays at the top while reading and says where you are (project, ref,
//    change name, with the intent on hover) and what to check (each finding a short
//    labelled chip that opens it), with reading progress, PDF and the palette;
//  - no text block sits above the content in any section: content starts right under
//    the title bar; the change's numbers live in the status bar at the bottom;
//  - every section in the side bar shows its NAME next to its icon (an icon alone says
//    nothing), its count, red where it holds a problem; a click opens the section;
//  - the side bar widens and narrows from a labelled toggle; the content moves with it,
//    diagrams re-fit, and the choice survives a reload;
//  - a narrow window turns the side bar into a labelled row under the title bar;
//  - print carries none of this chrome.

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
const work = mkdtempSync(join(tmpdir(), 'whydiff-shell-'))
writeFileSync(join(work, 'm.json'), JSON.stringify(base))
execFileSync(process.execPath, [join(root, 'scripts', 'assemble.mjs'), join(work, 'm.json'), '--out', join(work, 'm.html')], { stdio: 'ignore' })
const url = pathToFileURL(join(work, 'm.html')).href
const PANES = ['diagrams', 'files', 'stories', 'story', 'ops', 'standards', 'tests']

const browser = await chromium.launch()
const errors = []
const open = async (vp = { width: 1920, height: 1080 }) => {
  const p = await browser.newPage({ viewport: vp })
  p.on('pageerror', e => errors.push(e.message))
  await p.goto(url)
  await p.locator('#tabs .tab').first().waitFor({ state: 'attached' })
  await p.waitForTimeout(600)
  return p
}
const pane = async (p, id) => { await p.locator(`#tabs .tab[data-pane="${id}"]`).click(); await p.waitForTimeout(350) }

// ── title bar ──────────────────────────────────────────────────────────────────
{
  const p = await open()
  const tb = p.locator('#titlebar')
  const text = await tb.textContent()
  check(text.includes(base.meta.project) && text.includes(base.meta.ref.split('..').pop()) && text.includes(base.meta.title), 'the title bar names the project, the branch and the change')
  check((await p.locator('#metaLine').getAttribute('title')).includes(base.meta.ref), 'the full ref is on hover')
  check((await p.locator('#title').getAttribute('title'))?.length > 20, 'hovering the change name gives its one-sentence intent')
  const chips = await p.locator('#titlebar .v-chip').evaluateAll(cs => cs.map(c => ({ shown: c.querySelector('.vt')?.textContent || '', vis: getComputedStyle(c.querySelector('.vt')).display !== 'none', full: c.title })))
  check(chips.length >= 3 && chips.every(c => /^\d+ \S/.test(c.shown) && c.vis && c.full.length > c.shown.length), `findings show as "number + word" with the full text on hover (${JSON.stringify(chips.map(c => c.shown))})`)
  await p.locator('#titlebar .v-chip', { hasText: 'standards' }).click(); await p.waitForTimeout(300)
  check(await p.locator('#tabs .tab[data-pane="standards"]').evaluate(t => t.classList.contains('active')), 'a finding chip opens its section')
  check(await p.locator('#titlebar .content-pdf').count() === 1 && await p.locator('#titlebar .themepick').count() === 1 && /of \d+ files read/.test(await p.locator('#titlebar').textContent()), 'PDF, palette and reading progress live in the title bar')
  // it stays put while reading
  await pane(p, 'files')
  await p.evaluate(() => scrollTo(0, 1200)); await p.waitForTimeout(200)
  const r = await tb.boundingBox()
  check(r.y === 0 && r.height <= 50, `the title bar stays at the top while reading, one line high (y ${r.y}, h ${r.height})`)
  const nav = await p.locator('#filesNavBody').boundingBox()
  check(nav.y >= r.y + r.height, `the file navigator sticks below the title bar, not under it (nav top ${Math.round(nav.y)}, bar bottom ${r.y + r.height})`)
  await p.close()
}

// ── no text header above content; numbers in the status bar ────────────────────
{
  const p = await open()
  for (const id of PANES) {
    await pane(p, id)
    await p.evaluate(() => scrollTo(0, 0))
    const g = await p.evaluate((id) => {
      const tb = document.getElementById('titlebar').getBoundingClientRect()
      const first = document.querySelector(`#pane-${id}`).getBoundingClientRect()
      return { gap: first.top - tb.bottom, intent: document.getElementById('intent').getClientRects().length }
    }, id)
    check(g.intent === 0, `${id}: no description block above the content`)
    check(g.gap >= 0 && g.gap <= 40, `${id}: content starts right under the title bar (gap ${Math.round(g.gap)}px)`)
  }
  const facts = await p.evaluate(() => { const f = document.querySelector('.footstrip .facts'); return { in: !!f, text: f?.textContent || '', shown: !!f && f.getClientRects().length > 0 } })
  check(facts.in && facts.shown && /\d+ files/.test(facts.text) && /lines/.test(facts.text), `the change's numbers are in the status bar (${facts.text.slice(0, 60)})`)
  await p.close()
}

// ── side bar: names, counts, hot counts, navigation ───────────────────────────
{
  const p = await open()
  const items = await p.locator('#sidebar .tab[data-pane]').evaluateAll(ts => ts.map(t => {
    const icon = t.querySelector('svg.ti')?.getBoundingClientRect(), label = t.querySelector('.tl'), lr = label?.getBoundingClientRect()
    return { id: t.dataset.pane, label: label?.textContent || '', labelShown: !!lr && lr.width > 10 && getComputedStyle(label).visibility === 'visible',
      fs: label ? parseFloat(getComputedStyle(label).fontSize) : 0, icon: !!icon && icon.width >= 18,
      cnt: t.querySelector('.cnt')?.textContent || '', hot: !!t.querySelector('.cnt.hot'), cntColor: t.querySelector('.cnt') && getComputedStyle(t.querySelector('.cnt')).color }
  }))
  check(JSON.stringify(items.map(i => i.id)) === JSON.stringify(PANES), `every section is in the side bar, in order (${items.map(i => i.id)})`)
  for (const i of items) check(i.icon && i.labelShown && i.label.length > 2 && i.fs >= 13, `side bar "${i.id}": an icon WITH its name shown (label "${i.label}", ${i.fs}px)`)
  check(items.find(i => i.id === 'standards').hot && items.find(i => i.id === 'tests').hot, 'standards and tests counts are marked as problems')
  check(!items.find(i => i.id === 'files').hot && items.find(i => i.id === 'files').cntColor !== items.find(i => i.id === 'standards').cntColor, 'a plain count is not red')
  for (const id of PANES) {
    await pane(p, id)
    check(!(await p.locator(`#pane-${id}`).evaluate(e => e.hidden)), `the "${id}" item opens its section`)
  }
  check(await p.locator('#sidebar .help-btn .tl').isVisible(), 'Help is labelled too')
  await p.locator('#sidebar .help-btn').click(); await p.waitForTimeout(200)
  check(await p.evaluate(() => !!document.querySelector('dialog[open]')), 'Help opens the help dialog')
  await p.close()
}

// ── the width toggle ──────────────────────────────────────────────────────────
{
  const p = await open()
  await p.evaluate(() => { try { localStorage.removeItem('whydiff:sidebarWide') } catch {} })
  await p.reload(); await p.waitForTimeout(600)
  const tog = p.locator('#sbToggle')
  const state = () => p.evaluate(() => {
    const sb = document.getElementById('sidebar').getBoundingClientRect(), wrap = document.querySelector('.wrap').getBoundingClientRect()
    const t = document.querySelector('#sidebar .tab[data-pane="files"]'), ic = t.querySelector('svg.ti').getBoundingClientRect(), lb = t.querySelector('.tl').getBoundingClientRect()
    const svg = document.querySelector('#pane-diagrams .diagram:not(.dg-off) pre.mermaid > svg')?.getBoundingClientRect()
    return { w: sb.width, wrapLeft: wrap.left, sbRight: sb.right, inline: Math.abs((lb.top + lb.height / 2) - (ic.top + ic.height / 2)) < 8 && lb.left > ic.right,
      under: lb.top >= ic.bottom - 2, label: document.querySelector('#sbToggle .stl')?.textContent || '', expanded: document.getElementById('sbToggle').getAttribute('aria-expanded'),
      svgInside: !!svg && svg.right <= innerWidth && svg.left >= sb.right }
  })
  const n = await state()
  check(n.w <= 100 && n.under && n.expanded === 'false' && n.label.length > 2, `narrow by default: name under the icon, the toggle labelled (${JSON.stringify(n)})`)
  check(n.wrapLeft >= n.sbRight - 1, 'the content starts beside the side bar, not under it')
  const overlap = await p.evaluate(() => document.getElementById('sidebar').getBoundingClientRect().bottom - document.querySelector('.footstrip').getBoundingClientRect().top)
  check(overlap <= 1, `the side bar ends where the status bar begins (overlap ${overlap}px)`)
  await tog.click(); await p.waitForTimeout(500)
  const w = await state()
  check(w.w >= 180 && w.inline && w.expanded === 'true' && w.label !== n.label, `wide: name beside the icon, toggle relabelled (${JSON.stringify(w)})`)
  check(w.wrapLeft >= w.sbRight - 1 && w.svgInside, 'the content moved with it and the diagram re-fit beside it')
  await p.reload(); await p.waitForTimeout(600)
  check((await state()).w >= 180, 'the wide side bar survives a reload')
  await tog.click(); await p.waitForTimeout(300)
  check((await state()).w <= 100, 'the toggle narrows it again')
  await p.close()
}

// ── narrow window ─────────────────────────────────────────────────────────────
{
  const p = await open({ width: 800, height: 900 })
  const g = await p.evaluate(() => {
    const tb = document.getElementById('titlebar').getBoundingClientRect(), sb = document.getElementById('sidebar').getBoundingClientRect()
    const labels = [...document.querySelectorAll('#sidebar .tab .tl')].filter(l => l.getClientRects().length && l.getBoundingClientRect().width > 10).length
    const h1 = document.getElementById('title').getBoundingClientRect()
    return { row: sb.top >= tb.bottom - 1 && sb.width >= innerWidth - 2, labels, wrapLeft: document.querySelector('.wrap').getBoundingClientRect().left, titleOneLine: h1.height < 26 }
  })
  check(g.row && g.wrapLeft < 30, `a narrow window turns the side bar into a row under the title bar (${JSON.stringify(g)})`)
  check(g.labels >= 7, `the row keeps its names (${g.labels})`)
  check(g.titleOneLine, 'the change name stays on one line')
  await p.close()
}

// ── the title reads like a shell prompt ───────────────────────────────────────
{
  const p = await open()
  const t = await p.evaluate(() => {
    const k = document.getElementById('metaLine'), q = (sel) => k.querySelector(sel)?.textContent || ''
    return { badge: q('.tb-badge'), proj: q('.tb-proj'), branch: q('.tb-bn'), base: q('.tb-base'), prompt: q('.tb-prompt'), branchIcon: !!k.querySelector('.tb-branch svg'),
      title: document.getElementById('title').textContent }
  })
  check(t.badge === 'AC' && t.proj === 'acme-api' && t.branch === 'feature/rate-limit' && /main/.test(t.base) && t.prompt === '❯' && t.branchIcon,
    `the title reads as a prompt: badge, project, branch, base, ❯ (${JSON.stringify(t)})`)
  check(t.title === base.meta.title, `the change name stands alone, no "Change map:" prefix (${t.title})`)
  check(!(await p.locator('#tabs .tab[data-pane="diagrams"] svg.ti circle').count()), 'the Diagrams icon is not the git-branch glyph')
  await p.close()
  // an uncommitted working tree
  const m = JSON.parse(JSON.stringify(base)); m.meta.ref = 'working tree (feat/mcp-access)'
  writeFileSync(join(work, 'wt.json'), JSON.stringify(m))
  execFileSync(process.execPath, [join(root, 'scripts', 'assemble.mjs'), join(work, 'wt.json'), '--out', join(work, 'wt.html')], { stdio: 'ignore' })
  const q = await browser.newPage({ viewport: { width: 1920, height: 1080 } })
  await q.goto(pathToFileURL(join(work, 'wt.html')).href); await q.waitForTimeout(500)
  const w = await q.evaluate(() => ({ branch: document.querySelector('#metaLine .tb-bn')?.textContent, dirty: document.querySelector('#metaLine .tb-dirty')?.textContent || '' }))
  check(w.branch === 'feat/mcp-access' && /uncommitted/.test(w.dirty), `a working tree shows its branch and that it is uncommitted (${JSON.stringify(w)})`)
  await q.close()
}

// ── folders, the file context menu (standalone file), scroll bars ─────────────
{
  const p = await open()
  await pane(p, 'files')
  const fold = () => p.evaluate(() => { const d = document.querySelector('#filesOverview .ft-dir'), v = (sel) => getComputedStyle(d.querySelector(`:scope > .ft-row .ft-fold ${sel}`)).display !== 'none'; return { closed: v('.c'), open: v('.o') } })
  let f = await fold()
  check(f.open && !f.closed, `an open folder shows an open-folder icon (${JSON.stringify(f)})`)
  await p.locator('#filesOverview .ft-dir > .ft-row').first().click(); await p.waitForTimeout(150)
  f = await fold()
  check(f.closed && !f.open, `a collapsed folder shows a closed-folder icon (${JSON.stringify(f)})`)
  await p.locator('#filesOverview .ft-dir > .ft-row').first().click(); await p.waitForTimeout(150)
  // right-click a file
  const row = p.locator('#filesOverview .ft-file').first()
  const path = await row.getAttribute('data-path')
  await p.context().grantPermissions(['clipboard-read', 'clipboard-write'])
  await row.click({ button: 'right' }); await p.waitForTimeout(150)
  const menu = p.locator('#ctxMenu')
  check(await menu.isVisible(), 'right-clicking a file opens its menu')
  check((await menu.locator('.ctx-head').textContent()) === path, 'the menu names the file')
  check(await p.evaluate(() => document.activeElement?.getAttribute('role') === 'menuitem'), 'the menu takes focus on its first item')
  check(await menu.locator('[data-act="open"]').isDisabled() && /app|serve/.test(await menu.locator('.ctx-note').textContent()), 'a standalone file cannot open files and says where it can')
  await menu.locator('[data-act="copy"]').click(); await p.waitForTimeout(150)
  check((await p.evaluate(() => navigator.clipboard.readText())) === path, 'a standalone file copies the path inside the repo (it does not know where the repo is)')
  check(!(await menu.isVisible()) && /Copied/.test(await p.locator('.ctx-toast').textContent()), 'copying closes the menu and says so')
  // keyboard: Shift+F10 on a focused row, arrows, Escape returns focus
  await row.focus(); await p.keyboard.press('Shift+F10'); await p.waitForTimeout(100)
  check(await menu.isVisible(), 'Shift+F10 on a focused file opens its menu')
  await p.keyboard.press('Escape'); await p.waitForTimeout(100)
  check(!(await menu.isVisible()) && await p.evaluate((pp) => document.activeElement?.dataset.path === pp, path), 'Escape closes the menu and returns focus to the file')
  // the open file's title and a file chip have the same menu
  await p.locator('#filesView h3[data-ctxfile]').click({ button: 'right' }); await p.waitForTimeout(100)
  check(await menu.isVisible(), 'the open file\'s title has the menu too')
  await p.keyboard.press('Escape')
  // scroll bars: thin, in the palette's colours, and never over the counts
  const sb = await p.evaluate(() => {
    const n = document.getElementById('filesNavBody'), cs = getComputedStyle(n)
    const right = Math.max(...[...n.querySelectorAll('.ft-stat')].map(e => e.getBoundingClientRect().right))
    return { width: cs.scrollbarWidth, color: cs.scrollbarColor, scheme: getComputedStyle(document.documentElement).colorScheme,
      inside: right <= n.getBoundingClientRect().left + n.clientWidth + 0.5 }
  })
  check(sb.width === 'thin' && sb.color !== 'auto' && sb.scheme === 'dark', `scroll bars are thin and themed; a dark palette is a dark color-scheme (${JSON.stringify(sb)})`)
  check(sb.inside, 'the file counts stay clear of the scroll bar')
  await p.locator('.themepick button[data-v="bond"]').click(); await p.waitForTimeout(300)
  check(await p.evaluate(() => getComputedStyle(document.documentElement).colorScheme) === 'light', 'a light palette is a light color-scheme')
  await p.close()
}

// ── print ─────────────────────────────────────────────────────────────────────
{
  const p = await open()
  await p.emulateMedia({ media: 'print' })
  const pr = await p.evaluate(() => ({ tb: getComputedStyle(document.getElementById('titlebar')).display, sb: getComputedStyle(document.getElementById('sidebar')).display, left: parseFloat(getComputedStyle(document.querySelector('.wrap')).marginLeft) }))
  check(pr.tb === 'none' && pr.sb === 'none' && pr.left === 0, `print drops the title bar and side bar (${JSON.stringify(pr)})`)
  await p.close()
}

await browser.close()
check(!errors.length, `page errors: ${errors.join('; ')}`)
if (failures) { console.error(`\nide-shell: ${failures} failure(s)`); process.exit(1) }
console.log('OK: IDE shell — sticky one-line title bar (where you are, findings as number+word chips that open them, progress, PDF, palette, intent on hover); no text block above any section; numbers in the status bar; side bar names every section beside its icon with counts (problems red) and opens it; labelled width toggle moves the content, re-fits diagrams, persists; narrow window → labelled row; print drops the chrome')
