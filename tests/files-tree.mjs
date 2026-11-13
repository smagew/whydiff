#!/usr/bin/env node
// Acceptance for the IDE-style Files navigator. Each check is the reader's goal:
//  1. The tree scrolls on its own: a long tree scrolls inside the navigator, the
//     navigator stays in the window while a long file is read, and wheeling over it
//     moves the tree, not the page (wide); in a narrow window it is a bounded box.
//  2. Every diff file is in the tree exactly once (per mode), under folders that spell
//     its path, with single-folder chains compacted, and its name never torn mid-word.
//  3. A folded folder stays folded across a tab switch, a mode switch and a reload.
//  4. Status is git's: colour + letter A/M/D/R, deleted struck through, a rename shows
//     its old name; an old map without `status` falls back to isNew.
//  5. The keyboard drives it (WAI-ARIA tree): ↑↓ move, ←→ fold/unfold or go to
//     parent/child, Enter opens a file, Home/End.
//  6. Opening a file from another tab scrolls its row into the navigator's view.

import { chromium } from 'playwright'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const base = JSON.parse(readFileSync(join(root, 'examples', 'rate-limit', 'review-map.json'), 'utf8'))
for (const f of Object.values(base.files)) delete f.embedFull

// A big diff: ~60 files in deep folders, every status, one long file to read.
const rm = JSON.parse(JSON.stringify(base))
const g = rm.groups[1]
const STATUSES = ['added', 'modified', 'deleted', 'renamed']
const extra = []
for (let i = 0; i < 56; i++) extra.push(`app/src/module-${String(i % 7).padStart(2, '0')}/feature-handler-${i}.service.ts`)
extra.push('deep/only/one/chain/leaf.ts', 'services/notifications/src/channels/push/mcp-permissions-service.ts')
extra.forEach((p, i) => {
  const status = STATUSES[i % 4]
  rm.files[p] = { service: 'api', role: 'edit', add: status === 'deleted' ? 0 : 10, del: 3, why: 'w', status, ...(status === 'added' ? { isNew: true } : {}), ...(status === 'renamed' ? { from: p.replace('handler', 'old-handler') } : {}) }
  g.files.push(p)
  rm.manifest.push([p, 10, 3, g.id, status === 'added'])
})
const LONG = 'src/middleware/rateLimit.ts'
rm.files[LONG].frag = Array.from({ length: 260 }, (_, i) => ['add', `const line${i} = compute(${i}) // a long file to read`])

const work = mkdtempSync(join(tmpdir(), 'whydiff-tree-'))
const build = (map, name) => {
  writeFileSync(join(work, `${name}.json`), JSON.stringify(map))
  execFileSync(process.execPath, [join(root, 'scripts', 'assemble.mjs'), join(work, `${name}.json`), '--out', join(work, `${name}.html`)], { stdio: 'ignore' })
  return pathToFileURL(join(work, `${name}.html`)).href
}
const bigUrl = build(rm, 'big')
const oldMap = JSON.parse(JSON.stringify(base))
for (const f of Object.values(oldMap.files)) delete f.status
const oldUrl = build(oldMap, 'old')

let failures = 0
const fail = (msg) => { console.error(`FAIL: ${msg}`); failures++ }
const check = (c, msg) => { if (!c) fail(msg) }
const mode = async (page, i) => { await page.locator('#filesModebar .files-mode-btn').nth(i).click(); await page.waitForTimeout(120) }
const openFiles = async (page) => { await page.locator('#tabs .tab[data-pane="files"]').click(); await page.waitForTimeout(120) }

const browser = await chromium.launch()

// ── 1. own scroll, wide ───────────────────────────────────────────────────────
{
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } })
  await page.goto(bigUrl)
  await openFiles(page)
  await page.locator(`#filesOverview .ft-file[data-path="${LONG}"]`).click()
  await page.waitForTimeout(150)
  const nav = page.locator('#filesNavBody')
  const m0 = await nav.evaluate(n => ({ sh: n.scrollHeight, ch: n.clientHeight, top: n.getBoundingClientRect().top, bottom: n.getBoundingClientRect().bottom, vh: innerHeight }))
  check(m0.sh > m0.ch + 50, `wide: a long tree must scroll inside the navigator (scrollHeight ${m0.sh}, clientHeight ${m0.ch})`)
  check(m0.bottom <= m0.vh + 1, `wide: the navigator must fit in the window (bottom ${Math.round(m0.bottom)} > ${m0.vh})`)
  const pageH = await page.evaluate(() => document.documentElement.scrollHeight)
  check(pageH > 2500, `wide: the long file should make the page tall (${pageH})`)
  // Read down the long file: the navigator stays in the window, showing the same rows.
  const firstRow = () => page.evaluate(() => {
    const box = document.getElementById('filesNavBody').getBoundingClientRect()
    return [...document.querySelectorAll('#filesOverview .ft-item')].find(li => li.getBoundingClientRect().bottom > box.top + 4)?.dataset.path || null
  })
  const before = await firstRow()
  await page.evaluate(() => scrollTo(0, 1600))
  await page.waitForTimeout(150)
  const m1 = await nav.evaluate(n => ({ top: n.getBoundingClientRect().top, bottom: n.getBoundingClientRect().bottom, vh: innerHeight }))
  // it sticks just under the Files menu (itself pinned under the title bar), never under either
  const tbBottom = await page.evaluate(() => Math.max(document.getElementById('titlebar')?.getBoundingClientRect().bottom || 0, document.getElementById('filesModebar')?.getBoundingClientRect().bottom || 0))
  check(m1.top >= tbBottom && m1.top < tbBottom + 40 && m1.bottom <= m1.vh + 1, `wide: after scrolling the page 1600px the navigator must stay in the window (top ${Math.round(m1.top)}, bottom ${Math.round(m1.bottom)})`)
  check((await firstRow()) === before, `wide: reading the file moved the tree (${before} → ${await firstRow()})`)
  // Wheel over the tree: the tree scrolls, the page does not.
  const box = await nav.boundingBox()
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
  const y0 = await page.evaluate(() => scrollY), s0 = await nav.evaluate(n => n.scrollTop)
  // Wheel toward the side that has room: the revealed row can leave the tree scrolled
  // to its very end, where a wheel down has nowhere to go.
  const atEnd = await nav.evaluate(n => n.scrollTop >= n.scrollHeight - n.clientHeight - 1)
  await page.mouse.wheel(0, atEnd ? -300 : 300)
  await page.waitForTimeout(250)
  const y1 = await page.evaluate(() => scrollY), s1 = await nav.evaluate(n => n.scrollTop)
  check(atEnd ? s1 < s0 : s1 > s0, `wide: wheel over the tree must scroll the tree (scrollTop ${s0} → ${s1})`)
  check(y1 === y0, `wide: wheel over the tree must not scroll the page (scrollY ${y0} → ${y1})`)
  await page.close()
}
// ── 1b. own scroll, narrow (stacked layout) ──────────────────────────────────
{
  const page = await browser.newPage({ viewport: { width: 900, height: 1000 } })
  await page.goto(bigUrl)
  await openFiles(page)
  const m = await page.locator('#filesNavBody').evaluate(n => ({ sh: n.scrollHeight, ch: n.clientHeight, vh: innerHeight }))
  check(m.sh > m.ch + 50 && m.ch <= m.vh * 0.5, `narrow: the tree must be a bounded box with its own scroll (clientHeight ${m.ch} of ${m.vh}, scrollHeight ${m.sh})`)
  await page.close()
}

// ── 2–6 on the big map ───────────────────────────────────────────────────────
{
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } })
  const errors = []
  page.on('pageerror', e => errors.push(e.message))
  await page.goto(bigUrl)
  await openFiles(page)

  // 2. completeness, folders spell the path, compaction, whole names
  for (const [i, sel, label] of [[0, '#filesOverview', 'Overview'], [1, '#filesList', 'Files list']]) {
    await mode(page, i)
    const r = await page.evaluate((sel) => {
      const out = { paths: [], spelled: [], uncompacted: [], torn: [] }
      for (const li of document.querySelectorAll(`${sel} .ft-file`)) {
        out.paths.push(li.dataset.path)
        const dirs = []
        for (let d = li.parentElement.closest('.ft-dir'); d; d = d.parentElement.closest('.ft-dir')) dirs.unshift(d.querySelector(':scope > .ft-row .ft-dname').textContent)
        const name = li.querySelector('.ft-name').childNodes[0]?.textContent ?? ''
        const nameText = [...li.querySelector('.ft-name').childNodes].filter(n => !(n.classList?.contains('ft-from'))).map(n => n.textContent).join('')
        const spelled = [...dirs, nameText].join('/')
        if (spelled !== li.dataset.path) out.spelled.push(`${spelled} ≠ ${li.dataset.path}`)
        // name torn mid-word? a line change between two characters that are not after - . _
        const tops = []
        const w = document.createTreeWalker(li.querySelector('.ft-name'), NodeFilter.SHOW_TEXT)
        for (let n; (n = w.nextNode());) {
          if (n.parentElement.closest('.ft-from')) continue
          for (let k = 0; k < n.length; k++) { const rg = document.createRange(); rg.setStart(n, k); rg.setEnd(n, k + 1); tops.push([n.data[k], Math.round(rg.getBoundingClientRect().top)]) }
        }
        for (let k = 1; k < tops.length; k++) if (tops[k][1] !== tops[k - 1][1] && !'-._'.includes(tops[k - 1][0])) { out.torn.push(li.dataset.path); break }
        void name
      }
      for (const d of document.querySelectorAll(`${sel} .ft-dir`)) {
        const kids = [...d.querySelector(':scope > ul').children]
        if (kids.length === 1 && kids[0].classList.contains('ft-dir')) out.uncompacted.push(d.dataset.dir)
      }
      return out
    }, sel)
    const want = Object.keys(rm.files).sort(), got = [...r.paths].sort()
    check(JSON.stringify(got) === JSON.stringify(want), `${label}: the tree must list every diff file exactly once (got ${got.length}, want ${want.length}; dupes ${got.filter((p, k) => got[k - 1] === p).join(', ') || 'none'})`)
    check(!r.spelled.length, `${label}: folders must spell each file's path: ${r.spelled.slice(0, 3).join('; ')}`)
    check(!r.uncompacted.length, `${label}: single-folder chains must be compacted: ${r.uncompacted.slice(0, 3).join(', ')}`)
    check(!r.torn.length, `${label}: file names torn mid-word: ${r.torn.slice(0, 3).join(', ')}`)
  }
  check(await page.locator('#filesList .ft-dir[data-dir="deep/only/one/chain/"]').count() === 1, 'a deep single-file chain must be ONE folder node "deep/only/one/chain"')

  // 4. status: letter, colour, strike, rename origin
  await mode(page, 1)
  const st = await page.evaluate(() => {
    const css = (v) => { const d = document.createElement('span'); d.style.color = `var(${v})`; document.body.appendChild(d); const c = getComputedStyle(d).color; d.remove(); return c }
    const col = { added: css('--st-new'), modified: css('--st-mod'), deleted: css('--st-del'), renamed: css('--st-mod') }
    const L = { added: 'A', modified: 'M', deleted: 'D', renamed: 'R' }
    const bad = []
    for (const li of document.querySelectorAll('#filesList .ft-file')) {
      const s = [...li.classList].find(c => c.startsWith('st-'))?.slice(3)
      const name = li.querySelector('.ft-name')
      if (li.querySelector('.ft-st-l').textContent !== L[s]) bad.push(`${li.dataset.path}: letter`)
      if (getComputedStyle(name).color !== col[s]) bad.push(`${li.dataset.path}: colour ${getComputedStyle(name).color} ≠ ${col[s]}`)
      if ((s === 'deleted') !== getComputedStyle(name).textDecorationLine.includes('line-through')) bad.push(`${li.dataset.path}: strike`)
      if (s === 'renamed' && !li.querySelector('.ft-from')?.textContent.includes('old-handler')) bad.push(`${li.dataset.path}: no old name`)
    }
    return { bad, distinct: new Set(Object.values(col)).size }
  })
  check(!st.bad.length, `status marks: ${st.bad.slice(0, 4).join('; ')}`)
  check(st.distinct === 3, `added / modified / deleted must be three distinct colours, got ${st.distinct}`)
  for (const [p, s] of Object.entries(rm.files)) {
    const want = s.status || (s.isNew ? 'added' : 'modified')
    const has = await page.locator(`#filesList .ft-file.st-${want}[data-path="${p}"]`).count()
    if (!has) { fail(`status: ${p} is not marked ${want}`); break }
  }

  // 3. folding persists across tab switch, mode switch and reload
  await mode(page, 0)
  const dirSel = '#filesOverview .ft-dir[data-dir="deep/only/one/chain/"]'
  await page.locator(`${dirSel} > .ft-row`).click()
  const folded = async () => page.locator(dirSel).getAttribute('aria-expanded')
  check(await folded() === 'false', 'clicking a folder folds it')
  check(!(await page.locator(`${dirSel} .ft-file`).first().isVisible()), 'a folded folder hides its files')
  await page.locator('#tabs .tab[data-pane="ops"]').click(); await openFiles(page)
  check(await folded() === 'false', 'a fold survives a tab switch')
  await mode(page, 1); await mode(page, 0)
  check(await folded() === 'false', 'a fold survives a mode switch')
  await page.reload(); await openFiles(page)
  check(await folded() === 'false', 'a fold survives a reload')
  await page.locator(`${dirSel} > .ft-row`).click()
  check(await folded() === 'true', 'clicking again unfolds it')

  // 5. keyboard
  await mode(page, 1)
  const first = page.locator('#filesList .ft-item').first()
  await first.focus()
  const focused = () => page.evaluate(() => document.activeElement?.dataset.path || document.activeElement?.dataset.dir || null)
  const f0 = await focused()
  await page.keyboard.press('ArrowDown')
  const f1 = await focused()
  check(f1 && f1 !== f0, `ArrowDown moves to the next item (${f0} → ${f1})`)
  await page.keyboard.press('ArrowUp')
  check(await focused() === f0, 'ArrowUp moves back')
  // ← on an open folder folds it; → unfolds; → again goes to its first child
  check(await first.getAttribute('aria-expanded') === 'true', 'the first item is an open folder')
  await page.keyboard.press('ArrowLeft')
  check(await first.getAttribute('aria-expanded') === 'false', 'ArrowLeft folds an open folder')
  await page.keyboard.press('ArrowRight')
  check(await first.getAttribute('aria-expanded') === 'true', 'ArrowRight unfolds a folded folder')
  await page.keyboard.press('ArrowRight')
  const child = await focused()
  check(child && child !== f0 && (await page.locator('#filesList .ft-item').first().locator('.ft-item').first().evaluate(e => e.dataset.path || e.dataset.dir)) === child, 'ArrowRight on an open folder goes to its first child')
  await page.keyboard.press('ArrowLeft')
  // On a child, ← goes to the parent (if the child is a file, or a folded folder).
  const afterLeft = await focused()
  check(afterLeft === f0 || afterLeft === child, 'ArrowLeft from a child goes to the parent (or folds it first)')
  await page.keyboard.press('End')
  const last = await focused()
  const lastVisible = await page.evaluate(() => { const v = [...document.querySelectorAll('#filesList .ft-item')].filter(li => !li.parentElement.closest('.ft-dir[aria-expanded="false"]')); const x = v[v.length - 1]; return x.dataset.path || x.dataset.dir })
  check(last === lastVisible, `End goes to the last visible item (${last} vs ${lastVisible})`)
  check(await page.evaluate(() => { const r = document.activeElement.getBoundingClientRect(), b = document.getElementById('filesNavBody').getBoundingClientRect(); return r.top >= b.top - 1 && r.top < b.bottom }), 'the focused item is scrolled into the navigator')
  // Enter on a file opens it in the file view
  await page.locator('#filesList .ft-file').nth(3).focus()
  const target = await focused()
  await page.keyboard.press('Enter')
  await page.waitForTimeout(120)
  check((await page.locator('#filesView h3').first().textContent()) === target, `Enter opens the focused file (${target})`)
  await page.keyboard.press('Home')
  check(await focused() === f0, 'Home goes to the first item')
  // one tab stop per tree
  const stops = await page.evaluate(() => [...document.querySelectorAll('.ftree')].map(t => t.querySelectorAll('.ft-item[tabindex="0"]').length))
  check(stops.every(n => n === 1), `each tree has exactly one tab stop, got ${JSON.stringify(stops)}`)

  // 6. a file opened from another tab is revealed in the navigator
  const deep = 'services/notifications/src/channels/push/mcp-permissions-service.ts'
  await page.evaluate(() => document.getElementById('filesNavBody').scrollTop = 0)
  await page.locator('#tabs .tab[data-pane="ops"]').click()
  await page.evaluate((p) => jumpToFile(p), deep)
  await page.waitForTimeout(150)
  check(await page.evaluate((p) => {
    const li = document.querySelector(`.files-mode:not([hidden]) .ft-file[data-path="${p}"]`)
    const r = li.querySelector('.ft-row').getBoundingClientRect(), b = document.getElementById('filesNavBody').getBoundingClientRect()
    return li.classList.contains('active') && r.top >= b.top - 1 && r.bottom <= b.bottom + 1
  }, deep), 'opening a file from another tab scrolls its row into the navigator and marks it')

  check(!errors.length, `page errors: ${errors.join('; ')}`)
  await page.close()
}

// ── 4b. an old map without `status` falls back to isNew ──────────────────────
{
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } })
  await page.goto(oldUrl)
  await openFiles(page); await mode(page, 1)
  for (const [p, f] of Object.entries(oldMap.files)) {
    const want = f.isNew ? 'A' : 'M'
    const got = await page.locator(`#filesList .ft-file[data-path="${p}"] .ft-st-l`).textContent()
    check(got === want, `old map: ${p} marked ${got}, want ${want} (from isNew)`)
  }
  await page.close()
}

await browser.close()
if (failures) { console.error(`\nfiles-tree: ${failures} failure(s)`); process.exit(1) }
console.log('OK: Files tree — own scroll (wide + narrow, wheel stays in the tree), every file once under folders that spell its path, compact folders, whole names, folds survive tab/mode/reload, git status as colour + A/M/D/R (old maps fall back to isNew), WAI-ARIA keyboard, autoscroll to the open file')
