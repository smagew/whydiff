#!/usr/bin/env node
// Acceptance for the report polish pass (design review items 1A, 2A, 3A, 4A, 5A, 7, 8).
// Each check is the reader's goal, not a pixel:
//  1A the header says what to check: one chip per finding a pass made, each taking you to
//     it; nothing for a pass that did not run; no row at all when nothing was found;
//     reading progress next to it.
//  2A a storyboard card's status is an edge on its left (solid/double/dashed), drawn
//     inside the card, in every palette and after a palette re-render; the tag is a word,
//     not a box; an unchanged card has no edge.
//  3A a group shows its role as a word (read carefully stands out) and its WHY on two
//     lines, with "more" offered where it clips; a file with no deletions shows no "−0".
//  4A deploy is a numbered checklist whose ticks survive a reload; "no migrations" is
//     said once, never as a warning box.
//  5A standards: severity is its own column, warnings first, holds last and quiet.
//  7  an empty section in a static file says one thing (not in this export + how);
//     its tab is dimmed.
//  8  file chips show the whole file name with the folder after it; the Summary's
//     transitions are plain text; the diagrams hint is a legend of samples, above the
//     first engineering diagram.

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
const work = mkdtempSync(join(tmpdir(), 'whydiff-polish-'))
const build = (map, name) => {
  writeFileSync(join(work, `${name}.json`), JSON.stringify(map))
  execFileSync(process.execPath, [join(root, 'scripts', 'assemble.mjs'), join(work, `${name}.json`), '--out', join(work, `${name}.html`)], { stdio: 'ignore' })
  return pathToFileURL(join(work, `${name}.html`)).href
}
const clone = () => JSON.parse(JSON.stringify(base))

// The example as a reader would get it, plus a storyboard that has all three statuses.
const full = clone()
full.storyboard.cards.find(c => c.status === 'same' && c.id !== full.storyboard.cards[0].id).status = 'changed'
full.storyboard.cards.push({ id: 'gone', kind: 'queue', title: 'Old proxy limit', text: 'No longer relied on.', status: 'removed' })
full.storyboard.arrows.push({ from: full.storyboard.cards[0].id, to: 'gone', label: 'used to pass', status: 'removed' })
const url = build(full, 'full')

const browser = await chromium.launch()
const errors = []
const open = async (u, vp = { width: 1440, height: 1000 }) => {
  const p = await browser.newPage({ viewport: vp })
  p.on('pageerror', e => errors.push(e.message))
  await p.goto(u)
  await p.locator('#tabs .tab').first().waitFor()
  await p.waitForTimeout(400)
  return p
}
const tab = async (p, id) => { await p.locator(`#tabs .tab[data-pane="${id}"]`).click(); await p.waitForTimeout(300) }

// ── 1A verdict ────────────────────────────────────────────────────────────────
{
  const p = await open(url)
  const careful = new Set(full.groups.filter(g => g.role === 'read').flatMap(g => g.files)).size
  const want = [
    careful && `${careful} file`,
    full.storyboard.cards.some(c => c.warning) && 'storyboard',
    full.standards.some(s => s.severity === 'warn') && 'standards',
    (full.tests?.gaps || []).length && 'without test',
  ].filter(Boolean)
  const chips = await p.locator('#verdict .v-chip').allTextContents()
  check(await p.locator('#verdict').isVisible(), 'the verdict row shows when a pass found something')
  check(chips.length === want.length && want.every((w, i) => chips[i].includes(w)), `verdict chips ${JSON.stringify(chips)} want ${JSON.stringify(want)}`)
  const order = await p.evaluate(() => {
    const ids = ['title', 'intent', 'verdict', 'statbar'].map(id => document.getElementById(id))
    return ids.every((el, i) => !i || (ids[i - 1].compareDocumentPosition(el) & Node.DOCUMENT_POSITION_FOLLOWING))
  })
  check(order, 'the verdict sits under the intent, above the counts')
  check(!(await p.locator('#statbar .hot').count()), 'the counts line carries no red signal any more (the verdict does)')
  check(/0 of \d+ files read/.test(await p.locator('#vRead').textContent()), 'reading progress shows in the verdict row')
  // each chip goes where its finding lives
  for (const [needle, pane] of [['standards', 'standards'], ['without test', 'tests'], ['storyboard', 'diagrams']]) {
    await tab(p, 'ops')
    await p.locator('#verdict .v-chip', { hasText: needle }).click(); await p.waitForTimeout(200)
    check(await p.locator(`#tabs .tab[data-pane="${pane}"]`).evaluate(t => t.classList.contains('active')), `the "${needle}" chip opens ${pane}`)
  }
  await p.emulateMedia({ media: 'print' })
  check(!(await p.locator('#verdict').isVisible()), 'the verdict (buttons) is not printed')
  await p.emulateMedia({ media: 'screen' })
  await p.locator('#verdict .v-chip').first().click(); await p.waitForTimeout(300)
  check(await p.locator('#tabs .tab[data-pane="files"]').evaluate(t => t.classList.contains('active')), 'the careful-reading chip opens Files')
  // a file marked read updates the verdict's progress
  await p.keyboard.press('s'); await p.waitForTimeout(150)
  check(/^1 of/.test(await p.locator('#vRead').textContent()), `marking a file read updates the verdict progress (${await p.locator('#vRead').textContent()})`)
  await p.close()

  // a pass that did not run says nothing; a clean map shows no row
  const m = clone(); m.generated = ['story']; m.storyboard.cards.forEach(c => delete c.warning); m.groups.forEach(g => { if (g.role === 'read') g.role = 'context' })
  const q = await open(build(m, 'clean'))
  check(!(await q.locator('#verdict').isVisible()), 'nothing found (and passes not run) → no verdict row')
  await q.close()
}

// ── 2A storyboard edges ───────────────────────────────────────────────────────
{
  const p = await open(url)
  await p.locator('#pane-diagrams .storyboard pre.mermaid > svg').waitFor()
  for (const pal of ['graphite', 'bond', 'slate']) {
    await p.locator(`.themepick button[data-v="${pal}"]`).click(); await p.waitForTimeout(800)
    const cards = await p.evaluate(() => [...document.querySelectorAll('#pane-diagrams .storyboard g.node')].map(n => {
      const shape = n.querySelector(':scope > rect.label-container').getBoundingClientRect()
      const rails = [...n.querySelectorAll('.sb-rail')]
      const tag = n.querySelector('.sbtag')
      return {
        title: n.querySelector('.sbh')?.textContent,
        st: ['added', 'changed', 'removed'].find(c => n.classList.contains(c)) || 'same',
        rails: rails.length, railCls: [...new Set(rails.map(r => r.getAttribute('class')))],
        onLeft: rails.every(r => { const b = r.getBoundingClientRect(); return b.left >= shape.left - 1 && b.right <= shape.left + 10 && b.top >= shape.top - 1 && b.bottom <= shape.bottom + 1 }),
        railVisible: rails.every(r => { const cs = getComputedStyle(r); return cs.fill !== 'none' && !/rgba\(0, 0, 0, 0\)/.test(cs.fill) }),
        tagBorder: tag ? getComputedStyle(tag).borderTopWidth : '0px',
      }
    }))
    for (const c of cards) {
      const want = { same: 0, added: 1, changed: 2 }[c.st]
      if (c.st === 'removed') check(c.rails >= 3, `${pal}: removed "${c.title}" has a dashed edge (${c.rails} dashes)`)
      else check(c.rails === want, `${pal}: ${c.st} "${c.title}" has ${c.rails} edge bars, want ${want}`)
      if (c.rails) check(c.onLeft && c.railVisible && c.railCls.join() === `sb-rail ${c.st}`, `${pal}: "${c.title}" edge is visible, on the card's left, classed ${c.st}`)
      check(c.tagBorder === '0px', `${pal}: "${c.title}" tag is a word, not a box`)
    }
    check(cards.some(c => c.st === 'changed') && cards.some(c => c.st === 'removed'), `${pal}: fixture shows all statuses`)
  }
  const legend = await p.locator('#pane-diagrams .storyboard .dg-legend .sw').count()
  check(legend === 3, `the storyboard legend shows the three edges as samples (${legend})`)
  await p.close()
}

// ── 3A Files overview groups ──────────────────────────────────────────────────
{
  const p = await open(url, { width: 1440, height: 900 })
  await tab(p, 'files')
  await p.waitForTimeout(300)
  const groups = await p.evaluate(() => [...document.querySelectorAll('.ovg')].map(s => {
    const note = s.querySelector('.ovg-note')
    const lh = note && parseFloat(getComputedStyle(note).lineHeight)
    return {
      name: s.querySelector('.ovg-name')?.textContent, role: s.querySelector('.ovg-role')?.textContent || '',
      hot: !!s.querySelector('.ovg-role.hot'), mono: s.querySelector('.ovg-role') && /Mono/.test(getComputedStyle(s.querySelector('.ovg-role')).fontFamily),
      lines: note ? Math.round(note.clientHeight / lh) : 0, clips: note ? note.scrollHeight - note.clientHeight > 1 : false,
      more: !!s.querySelector('.ovg-note-more.show'),
    }
  }))
  check(groups.length === full.groups.length, `one overview section per group (${groups.length})`)
  groups.forEach((g, i) => {
    const src = full.groups[i]
    check(g.role && !g.mono, `group "${g.name}" shows its role as a word, not a mono label`)
    check(g.hot === (src.role === 'read'), `group "${g.name}": only read-carefully stands out (hot ${g.hot})`)
    if (src.why) check(g.lines >= 1 && g.lines <= 2, `group "${g.name}" WHY shows up to two lines (${g.lines})`)
    if (src.why) check(g.clips === g.more, `group "${g.name}": "more" offered iff the WHY clips (clips ${g.clips}, more ${g.more})`)
  })
  check(groups.some(g => g.lines === 2), 'a long WHY uses two lines, not one')
  const zero = await p.locator('#pane-files .ft-stat', { hasText: /[−-]0\b/ }).count()
  check(zero === 0, `no "−0" on a file with no deletions (${zero})`)
  await p.close()
}

// ── 4A ops ─────────────────────────────────────────────────────────────────────
{
  const p = await open(url)
  await tab(p, 'ops')
  const steps = await p.locator('#ops .deploy-check li').allTextContents()
  check(steps.length === full.ops.deploy.length && steps.every((s, i) => s.trim().startsWith(String(i + 1))), `deploy is a numbered checklist (${steps.length})`)
  const first = await p.evaluate(() => document.querySelector('#ops > *')?.classList.contains('ops-deploy'))
  check(first, 'deploy comes first in Ops')
  await p.locator('#ops [data-deploy="1"]').check()
  await p.reload(); await p.waitForTimeout(400); await tab(p, 'ops')
  check(await p.locator('#ops [data-deploy="1"]').isChecked() && !(await p.locator('#ops [data-deploy="0"]').isChecked()), 'a ticked deploy step stays ticked after a reload')
  const migr = (await p.locator('#ops').textContent()).match(/no migrations/gi) || []
  check(migr.length === 1, `"no migrations" is said once (${migr.length})`)
  check(!(await p.locator('#ops .empty-good').count()), 'no "none" is drawn as a coloured box')
  await p.close()
  // without a note about migrations, the quiet line says it
  const m = clone(); delete m.ops.note
  const q = await open(build(m, 'nonote'))
  await tab(q, 'ops')
  check(await q.locator('#ops .ops-none', { hasText: /migration/i }).count() === 1, 'no note → one quiet "No migrations" line')
  await q.close()
}

// ── 5A standards ──────────────────────────────────────────────────────────────
{
  const p = await open(url)
  await tab(p, 'standards')
  const rows = await p.evaluate(() => [...document.querySelectorAll('#standards .finding')].map(f => {
    const sev = f.querySelector('.sev'), body = f.querySelector('.fbody')
    return { cls: [...f.classList].find(c => ['warn', 'info', 'ok'].includes(c)), sev: sev.textContent,
      column: sev.getBoundingClientRect().right <= body.getBoundingClientRect().left,
      bodyColor: getComputedStyle(body).color, anchor: f.dataset.anchor || '' }
  }))
  const rank = { warn: 0, info: 1, ok: 2 }
  check(rows.every((r, i) => !i || rank[rows[i - 1].cls] <= rank[r.cls]), `warnings first, holds last (${rows.map(r => r.cls).join(',')})`)
  check(rows.every(r => r.column), 'severity is a column beside the text, not a label above it')
  check(rows.find(r => r.cls === 'warn')?.sev.includes('⚠'), 'a warning reads as one (⚠ + word)')
  const ok = rows.find(r => r.cls === 'ok'), warn = rows.find(r => r.cls === 'warn')
  if (ok && warn) check(ok.bodyColor !== warn.bodyColor, 'what holds is quieter than a warning')
  const wi = full.standards.findIndex(s => s.severity === 'warn')
  check(rows.find(r => r.cls === 'warn').anchor === `finding:${wi}`, 'a re-ordered warning keeps its original anchor index')
  await p.close()
}

// ── 7 empty sections (static file) ───────────────────────────────────────────
{
  const m = clone(); m.generated = ['standards', 'tests']; delete m.userStories
  const p = await open(build(m, 'lazy'))
  await tab(p, 'stories')
  const pane = await p.locator('#pane-stories').textContent()
  check(/not in this export/i.test(pane) && !/Generate/.test(pane), `a static empty section says one thing, offers no button (${pane.trim().slice(0, 120)})`)
  check(!(await p.locator('#pane-stories .lazy-gen').count()), 'no Generate button in a static file')
  check(await p.locator('#tabs .tab[data-pane="story"]').evaluate(t => t.classList.contains('not-gen')), 'an ungenerated tab is dimmed')
  check(!(await p.locator('#tabs .tab[data-pane="tests"]').evaluate(t => t.classList.contains('not-gen'))), 'a generated tab is not dimmed')
  await p.close()
}

// ── 8 chips, transitions, legend ─────────────────────────────────────────────
{
  const p = await open(url)
  const hint = await p.evaluate(() => {
    const h = document.getElementById('diagramsHint'), d0 = document.querySelector('#pane-diagrams .diagram[data-dg="0"]')
    return { legend: h.classList.contains('dg-legend'), sw: h.querySelectorAll('.sw').length, before: h.nextElementSibling === d0 }
  })
  check(hint.legend && hint.sw === 3 && hint.before, `the diagrams hint is a 3-sample legend right above the first diagram (${JSON.stringify(hint)})`)
  await tab(p, 'story')
  const chips = await p.evaluate(() => [...document.querySelectorAll('#pane-story .fchip')].map(c => ({ text: c.textContent, path: c.dataset.goto })))
  check(chips.length > 0, 'the Summary has file chips')
  for (const c of chips) {
    const name = c.path.split('/').pop()
    check(c.text.startsWith(name) && !c.text.includes('…'), `chip for ${c.path} starts with the whole file name (${c.text})`)
  }
  const italic = await p.locator('#pane-story .link-row').evaluateAll(rs => rs.filter(r => getComputedStyle(r).fontStyle === 'italic').length)
  check(italic === 0, 'Summary transitions are plain text, not italic')
  await p.close()
}

await browser.close()
check(!errors.length, `page errors: ${errors.join('; ')}`)
if (failures) { console.error(`\nreport-polish: ${failures} failure(s)`); process.exit(1) }
console.log('OK: report polish — verdict row (chips per finding, each opens it, progress, hidden when clean), storyboard status edges in all palettes, group role + 2-line WHY + more, deploy checklist persists, migrations said once, standards severity column ordered, static empty section, dimmed tabs, whole-name chips, plain transitions, legend above diagrams')
