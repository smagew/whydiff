#!/usr/bin/env node
// Regression: in the Files navigator (Overview and Files list) a file name is always
// whole and never torn mid-word. A character-level wrap
// (overflow-wrap: anywhere) split names like "aut / h.ts" and "mcp– / routes.ts" in a
// narrow column; the Files list cut the END of the path, i.e. hid the file name.
// The goal checked here is the reader's: they can read every file name in full, and
// where a name is longer than the column it breaks only after - . _ (like a hyphen),
// checked per character from its rendered position. The directory may give way
// (one line, ellipsis); the full path is on hover.

import { chromium } from 'playwright'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const rm = JSON.parse(readFileSync(join(root, 'examples', 'rate-limit', 'review-map.json'), 'utf8'))
for (const f of Object.values(rm.files)) delete f.embedFull
// Long, deep paths of the shape that broke — added to the first group, so they render
// in both modes next to the example's own short ones.
const LONG = ['app/src/api/middleware/authentication-scope.test.ts', 'services/notifications/src/channels/push/mcp-permissions-service.ts', 'README.md']
for (const p of LONG) {
  rm.files[p] = { service: 'api', role: 'edit', add: 10, del: 0, why: 'long path' }
  rm.groups[0].files.push(p)
  rm.manifest.push([p, 10, 0, rm.groups[0].id, false])
}
const work = mkdtempSync(join(tmpdir(), 'whydiff-paths-'))
writeFileSync(join(work, 'review-map.json'), JSON.stringify(rm))
execFileSync(process.execPath, [join(root, 'scripts', 'assemble.mjs'), join(work, 'review-map.json'), '--out', join(work, 'map.html')], { stdio: 'ignore' })

let failures = 0
const fail = (msg) => { console.error(`FAIL: ${msg}`); failures++ }

const inspect = (page, sel) => page.evaluate((sel) => [...document.querySelectorAll(sel)].filter(e => e.getClientRects().length).map((el) => {
  const base = el.querySelector('.pth-base'), dir = el.querySelector('.pth-dir')
  // Rendered top of every character of the name: a change of top = a line break there.
  const tops = []
  const walk = document.createTreeWalker(base, NodeFilter.SHOW_TEXT)
  for (let n; (n = walk.nextNode());) for (let i = 0; i < n.length; i++) {
    const r = document.createRange(); r.setStart(n, i); r.setEnd(n, i + 1)
    const g = r.getBoundingClientRect(); tops.push([n.data[i], Math.round(g.top), g.right])
  }
  const badBreaks = []
  for (let i = 1; i < tops.length; i++) if (tops[i][1] !== tops[i - 1][1] && !'-._'.includes(tops[i - 1][0])) badBreaks.push(tops.slice(Math.max(0, i - 4), i).map(t => t[0]).join('') + '|' + tops.slice(i, i + 4).map(t => t[0]).join(''))
  // The name's real right edge (its last glyph) against where it can actually be
  // seen: the nearest ancestor that clips. scrollWidth misses text clipped higher up.
  let clip = el.parentElement
  while (clip && getComputedStyle(clip).overflowX === 'visible') clip = clip.parentElement
  const clipRight = Math.min(...[el.parentElement, clip].filter(Boolean).map(e => e.getBoundingClientRect().right))
  const glyphRight = Math.max(...tops.map(t => t[2]))
  return {
    path: el.getAttribute('title'),
    text: (dir?.textContent || '') + base.textContent,
    badBreaks,
    dirOneLine: !dir || dir.getClientRects().length === 1 && dir.getBoundingClientRect().height < parseFloat(getComputedStyle(dir).lineHeight) * 1.6,
    baseInside: glyphRight <= clipRight + 1,
  }
}), sel)

const browser = await chromium.launch()
for (const viewport of [{ width: 1440, height: 900 }, { width: 900, height: 1000 }]) {
  const page = await browser.newPage({ viewport })
  await page.goto(pathToFileURL(join(work, 'map.html')).href)
  await page.locator('#tabs .tab[data-pane="files"]').click()
  for (const [mode, sel] of [[0, '#filesOverview .pth'], [1, '#filesList .pth']]) {
    await page.locator('#filesModebar .files-mode-btn').nth(mode).click()
    await page.waitForTimeout(150)
    const rows = await inspect(page, sel)
    const where = `${viewport.width}px ${mode ? 'Files list' : 'Overview'}`
    if (rows.length < Object.keys(rm.files).length) fail(`${where}: expected a .pth for every file, found ${rows.length}`)
    for (const r of rows) {
      if (r.text !== r.path) fail(`${where}: shown text "${r.text}" differs from the full path "${r.path}"`)
      if (r.badBreaks.length) fail(`${where}: the file name of ${r.path} breaks mid-word at ${r.badBreaks.join(', ')}`)
      if (!r.baseInside) fail(`${where}: the file name of ${r.path} is cut or overflows its row`)
      if (!r.dirOneLine) fail(`${where}: the directory of ${r.path} wraps instead of giving way`)
    }
    for (const p of LONG) if (!rows.some(r => r.path === p)) fail(`${where}: ${p} missing (full path must be its hover title)`)
  }
  await page.close()
}
await browser.close()

if (failures) { console.error(`\nfile-paths: ${failures} failure(s)`); process.exit(1) }
console.log('OK: file paths — file name whole, breaks only after - . _, directory one line, full path on hover (Overview + Files list, 1440 + 900px)')
