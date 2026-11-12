#!/usr/bin/env node
// Acceptance for the storyboard (the illustrator's plain-language picture, drawn first
// on the Diagrams tab). Each check is the reader's goal:
//  - it is the first diagram, counted in the tab, and every card is drawn with its title,
//    sentence, tag and warning;
//  - every card has a VISIBLE line icon (stroked, unfilled) in every palette, also after
//    a palette switch re-renders it (mermaid's node paint once filled/blanked them);
//  - a status shows as the diff classes; a warning stands out from the card text;
//  - each arrow is drawn; a card's text stays inside its card;
//  - a card opens its code; the pop-out (#dg=story) shows it alone;
//  - hostile model text renders literally and runs nothing;
//  - every diagram is keyed (data-dg story, 0, 1…); that notes keep their keys is
//    asserted where notes exist, in the served tests/diagram-notes.mjs;
//  - tags follow the report language; the icon vocabulary matches the schema.

import { chromium } from 'playwright'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { KINDS } from '../scripts/build-icons.mjs'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
let failures = 0
const fail = (m) => { console.error(`FAIL: ${m}`); failures++ }
const check = (c, m) => { if (!c) fail(m) }

// Vocabulary: schema enum == icon builder kinds == shipped icon subset.
const schema = JSON.parse(readFileSync(join(root, 'schema', 'review-map.schema.json'), 'utf8'))
const icons = JSON.parse(readFileSync(join(root, 'templates', 'storyboard-icons.json'), 'utf8'))
const schemaKinds = schema.properties.storyboard.properties.cards.items.properties.kind.enum
check(JSON.stringify([...schemaKinds].sort()) === JSON.stringify(Object.keys(KINDS).sort()), `schema kinds ≠ build-icons KINDS (re-run scripts/build-icons.mjs and update the schema)`)
check(JSON.stringify(Object.keys(icons.kinds).sort()) === JSON.stringify(Object.keys(KINDS).sort()), 'templates/storyboard-icons.json is stale: run node scripts/build-icons.mjs')
const agentPrompt = readFileSync(join(root, 'agents', 'illustrator.md'), 'utf8')
for (const k of Object.keys(KINDS)) if (!agentPrompt.includes(`\`${k}\``)) { fail(`agents/illustrator.md does not offer kind "${k}"`); break }

const base = JSON.parse(readFileSync(join(root, 'examples', 'rate-limit', 'review-map.json'), 'utf8'))
for (const f of Object.values(base.files)) delete f.embedFull
const work = mkdtempSync(join(tmpdir(), 'whydiff-sb-'))
const build = (map, name) => {
  writeFileSync(join(work, `${name}.json`), JSON.stringify(map))
  execFileSync(process.execPath, [join(root, 'scripts', 'assemble.mjs'), join(work, `${name}.json`), '--out', join(work, `${name}.html`)], { stdio: 'ignore' })
  return pathToFileURL(join(work, `${name}.html`)).href
}
const sb = base.storyboard
check(sb && sb.cards.length >= 3, 'the reference example carries a storyboard')
const url = build(base, 'ex')

const browser = await chromium.launch()
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } })
const errors = []
page.on('pageerror', e => errors.push(e.message))
await page.goto(url)
await page.locator('#pane-diagrams .storyboard pre.mermaid > svg').waitFor()
await page.waitForTimeout(300)

// first, keyed, counted
const keys = await page.locator('#pane-diagrams .diagram').evaluateAll(ds => ds.map(d => d.dataset.dg))
check(keys[0] === 'story' && keys.slice(1).join() === base.diagrams.map((_, i) => String(i)).join(), `diagram keys must be story, 0, 1… (got ${keys.join(', ')})`)
const tabCount = await page.locator('#tabs .tab[data-pane="diagrams"]').textContent()
check(tabCount.includes(String(base.diagrams.length + 1)), `the Diagrams tab counts the storyboard (${tabCount.trim()})`)
check((await page.locator('#pane-diagrams .storyboard h3').textContent()) === sb.title, 'the storyboard title shows')

const inspect = () => page.evaluate(() => {
  const svg = document.querySelector('#pane-diagrams .storyboard pre.mermaid > svg')
  const cards = [...svg.querySelectorAll('g.node')].map(n => {
    const c = n.querySelector('.sbc'), r = n.querySelector('.label-container')?.getBoundingClientRect() || n.getBoundingClientRect()
    const icon = c?.querySelector(':scope > .sbi svg'), shape = icon?.querySelector('path, rect, circle, line, polyline, polygon, ellipse')
    const cs = shape && getComputedStyle(shape)
    const w = c?.querySelector('.sbw')
    const cr = c?.getBoundingClientRect()
    return {
      cls: [...n.classList].filter(x => ['added', 'changed', 'removed'].includes(x)).join(''),
      title: c?.querySelector('.sbh')?.textContent, text: c?.querySelector('.sbx')?.textContent,
      tag: c?.querySelector('.sbtag')?.textContent || '',
      icon: !!icon, iconFill: cs?.fill, iconStroke: cs?.stroke, iconW: icon?.getBoundingClientRect().width || 0,
      warn: w?.textContent || '', warnColor: w && getComputedStyle(w).color, textColor: c && getComputedStyle(c.querySelector('.sbx')).color,
      inside: cr && cr.left >= r.left - 1 && cr.right <= r.right + 1 && cr.top >= r.top - 1 && cr.bottom <= r.bottom + 1,
    }
  })
  return { cards, edges: svg.querySelectorAll('.edgePaths path, path.flowchart-link').length }
})

const want = sb.cards
for (const pal of ['graphite', 'bond', 'slate']) {
  await page.locator(`.themepick button[data-v="${pal}"]`).click()
  await page.waitForTimeout(700)
  const r = await inspect()
  check(r.cards.length === want.length, `${pal}: ${r.cards.length} cards drawn, want ${want.length}`)
  r.cards.forEach((c, i) => {
    const w = want[i]
    if (!w) return
    check(c.title === w.title && c.text === w.text, `${pal}: card ${i} text "${c.title} / ${c.text}"`)
    check(c.icon && c.iconW >= 20, `${pal}: card "${w.title}" has no visible icon`)
    check(c.iconFill === 'none' && c.iconStroke && c.iconStroke !== 'none' && !/rgba\(0, 0, 0, 0\)/.test(c.iconStroke), `${pal}: card "${w.title}" icon must be a stroked line icon (fill ${c.iconFill}, stroke ${c.iconStroke})`)
    check(c.cls === (w.status === 'same' ? '' : w.status), `${pal}: card "${w.title}" class "${c.cls}" for status ${w.status}`)
    check(!!c.tag === (w.status !== 'same'), `${pal}: card "${w.title}" tag "${c.tag}" for status ${w.status}`)
    check(c.inside, `${pal}: card "${w.title}" text spills out of its card`)
    if (w.warning) check(c.warn.includes(w.warning) && c.warnColor !== c.textColor, `${pal}: warning on "${w.title}" must show and stand out (${c.warnColor} vs ${c.textColor})`)
  })
  check(r.edges === sb.arrows.length, `${pal}: ${r.edges} arrows drawn, want ${sb.arrows.length}`)
}

// Note keys (story first, diagram:0 unchanged) are asserted in tests/diagram-notes.mjs:
// anchors exist only in a served map.

// a card opens its code
const target = want.find(c => c.files?.length)
await page.locator('#pane-diagrams .storyboard g.node').nth(want.indexOf(target)).click()
await page.waitForTimeout(250)
const opened = await page.evaluate(() => [...document.querySelectorAll('#filesView h3, .inspector h3')].map(h => h.textContent))
check(opened.includes(target.files[0]), `clicking "${target.title}" opens ${target.files[0]} (opened: ${opened.join(', ') || 'nothing'})`)
check(!errors.length, `page errors: ${errors.join('; ')}`)
await page.close()

// pop-out: #dg=story shows the storyboard alone
{
  const p = await browser.newPage({ viewport: { width: 1200, height: 900 } })
  await p.goto(url + '#dg=story')
  await p.waitForTimeout(800)
  const vis = await p.locator('#pane-diagrams .diagram').evaluateAll(ds => ds.map(d => getComputedStyle(d).display !== 'none'))
  check(vis[0] && vis.slice(1).every(v => !v), `#dg=story must show only the storyboard (visible: ${vis.join(',')})`)
  await p.close()
}

// hostile text + report language
{
  const m = JSON.parse(JSON.stringify(base))
  m.meta.lang = 'ru'
  m.storyboard = {
    cards: [
      { id: 'a', kind: 'person', title: 'Клиент "VIP" #1', text: '<img src=x onerror="window.__pwned=1">тест & <b>жирно</b>', status: 'same' },
      { id: 'b', kind: 'not-a-kind', title: "Сервис's", text: 'a|b|c; end"]] --> x', status: 'added', warning: 'нет "payout"' },
    ],
    arrows: [{ from: 'a', to: 'b', label: 'шлёт "сигнал" #2' }],
  }
  const p = await browser.newPage({ viewport: { width: 1200, height: 900 } })
  const errs = []
  p.on('pageerror', e => errs.push(e.message))
  await p.goto(build(m, 'hostile'))
  await p.locator('#pane-diagrams .storyboard pre.mermaid > svg').waitFor()
  await p.waitForTimeout(300)
  const r = await p.evaluate(() => ({
    pwned: window.__pwned, broken: !!document.querySelector('#pane-diagrams .storyboard.broken, #pane-diagrams .storyboard .mermaid-box.broken'),
    titles: [...document.querySelectorAll('.storyboard .sbh')].map(e => e.textContent),
    texts: [...document.querySelectorAll('.storyboard .sbx')].map(e => e.textContent),
    imgs: document.querySelectorAll('.storyboard img, .storyboard .sbx b').length,
    tag: document.querySelector('.storyboard .sbtag')?.textContent, warn: document.querySelector('.storyboard .sbw')?.textContent,
    label: document.querySelector('.storyboard .edgeLabel')?.textContent,
    otherIcon: !!document.querySelectorAll('.storyboard .sbc > .sbi svg')[1]?.querySelector('path, rect, polyline'),
  }))
  check(r.pwned === undefined && r.imgs === 0, 'model text must never become markup or run')
  check(!r.broken, 'hostile text must not break the diagram')
  check(r.titles.join('|') === 'Клиент "VIP" #1|Сервис\'s', `titles render literally (got ${r.titles.join('|')})`)
  check(r.texts[0] === '<img src=x onerror="window.__pwned=1">тест & <b>жирно</b>' && r.texts[1] === 'a|b|c; end"]] --> x', `texts render literally (got ${JSON.stringify(r.texts)})`)
  check(r.label === 'шлёт "сигнал" #2', `arrow label renders literally (got ${r.label})`)
  check(r.tag === 'новое' && r.warn?.includes('нет "payout"'), `tags follow the report language (tag ${r.tag}, warn ${r.warn})`)
  check(r.otherIcon, 'an unknown kind still gets an icon (other)')
  check(!errs.length, `hostile page errors: ${errs.join('; ')}`)
  await p.close()
}

await browser.close()
if (failures) { console.error(`\nstoryboard: ${failures} failure(s)`); process.exit(1) }
console.log('OK: storyboard — first and keyed, every card with a visible line icon in all palettes after re-render, status classes + tags, warning stands out, arrows drawn, text inside cards, opens code, pops out alone, hostile text literal, report-language tags, vocabulary in sync')
