#!/usr/bin/env node
// Enforces the parts of the design system a script can decide, in every palette:
// token discipline, no serif, contrast floors, type floors, radii, shadows,
// nesting depth, prose measure, and the inline-code escape guard.

import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const fail = (m) => { console.error(`FAIL: ${m}`); process.exit(1) }
const tpl = readFileSync(join(root, 'templates', 'viewer.html'), 'utf8')

// ── static ───────────────────────────────────────────────────────────────────
const styleEnd = tpl.indexOf('</style>')
const tokenEnd = tpl.indexOf('* { box-sizing: border-box; }')
const stray = [...(tpl.slice(tokenEnd, styleEnd) + tpl.slice(styleEnd)).matchAll(/#[0-9a-fA-F]{3,8}\b/g)].map(m => m[0])
if (stray.length) fail(`hardcoded hex outside the token block: ${[...new Set(stray)].join(', ')}`)

// Comments describe the rules, so they are stripped before the ban list runs.
const code = tpl.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
if (/serif/.test(code.replace(/sans-serif/g, ''))) fail('a serif family is referenced somewhere in the viewer')
if (/\bInter\b/.test(code)) fail('Inter is in use')
if (/gradient\(/.test(code)) fail('a gradient is present')
if (/backdrop-filter|filter:\s*blur/.test(tpl)) fail('blur / glassmorphism is present')

const weights = [...tpl.matchAll(/font-weight: (\d+)/g)].map(m => +m[1]).filter(w => w !== 400 && w !== 500)
if (weights.length) fail(`weights outside 400/500: ${[...new Set(weights)].join(', ')}`)
const radii = [...tpl.matchAll(/border-radius: ([0-9.]+)px/g)].map(m => +m[1]).filter(r => r > 5 && r !== 0)
if (radii.length) fail(`border-radius above 5px: ${[...new Set(radii)].join(', ')}`)
const small = [...tpl.matchAll(/font-size: ([0-9.]+)px/g)].map(m => +m[1]).filter(v => v < 13)
if (small.length) fail(`type below 13px: ${[...new Set(small)].join(', ')}`)
if (/0\.5px solid/.test(tpl)) fail('sub-pixel hairline border present')
if (/text-transform: uppercase/.test(tpl)) fail('ALL CAPS label still present')
for (const w of ['successfully', 'simply', 'seamless', 'leverage', 'unlock']) {
  if (new RegExp(`\\b${w}\\b`, 'i').test(tpl)) fail(`banned copy word: ${w}`)
}
if (!/prefers-reduced-motion/.test(tpl)) fail('no prefers-reduced-motion block')

// ── rendered ─────────────────────────────────────────────────────────────────
const work = mkdtempSync(join(tmpdir(), 'whydiff-design-'))
const rm = JSON.parse(readFileSync(join(root, 'examples', 'rate-limit', 'review-map.json'), 'utf8'))
for (const f of Object.values(rm.files)) delete f.embedFull
const paths = Object.keys(rm.files)
// Every prose field carries inline markup, because the guard below only bites if
// the fixture actually exercises it — the bug it exists to catch shipped once
// precisely because the sample data had no <code> in these fields.
const C = 'uses <code>settleRefunds()</code> here'
rm.userStories = { summary: C, stories: [
  { actor: 'caller', story: `I call <code>POST /refund</code>.`, status: 'delivered', why: C, files: [paths[0]], covered: true },
  { actor: 'caller', story: 'I lost a field.', status: 'regressed', why: C, files: [paths[0]], covered: false },
] }
rm.intent = `Intent with ${C}.`
rm.tests = { summary: C, fixed: [C], gaps: [C], files: [] }
rm.blastRadius = [{ path: 'other/file.ts', why: C }]
rm.ops = { ...(rm.ops || {}), note: C, migrations: [C], deploy: [C] }
rm.standards = [{ severity: 'warn', finding: C, file: paths[0] }]
for (const f of Object.values(rm.files)) f.why = C
for (const g of rm.groups) g.why = C
for (const item of rm.story) if (item.link) { item.link = C } else {
  item.text = C
  item.branches = [['data loss', C]]
}
for (const d of rm.diagrams || []) d.caption = C
const jsonPath = join(work, 'm.json'); const htmlPath = join(work, 'm.html')
writeFileSync(jsonPath, JSON.stringify(rm))
execFileSync('node', [join(root, 'scripts', 'assemble.mjs'), jsonPath, '--out', htmlPath], { stdio: 'inherit' })

// A diagram's colour must arrive from the tokens, not from the map: mermaid
// compiles a classDef into an inline !important style that no stylesheet can
// reach, so one hex in the generator's output would outlive every palette.
const built = readFileSync(htmlPath, 'utf8')
const mermaidBlocks = [...built.matchAll(/<pre class="mermaid">([\s\S]*?)<\/pre>/g)].map(m => m[1])
if (!mermaidBlocks.length) fail('the fixture rendered no mermaid blocks, so the diagram checks below prove nothing')
for (const b of mermaidBlocks) {
  if (/\bclassDef\b/.test(b)) fail('a classDef survived into the built diagram source')
  const hex = b.match(/#[0-9a-fA-F]{3,8}\b/)
  if (hex) fail(`a hex reached the built diagram source: ${hex[0]}`)
}
if (!mermaidBlocks.some(b => /:::(added|removed|changed)/.test(b))) {
  fail('no diff-marked node in the fixture — the token painting below is untested')
}

// A map written before the rule keeps its classDef lines on disk; the pipeline,
// not the generator, is what has to make them harmless.
{
  const legacy = JSON.parse(JSON.stringify(rm))
  legacy.diagrams[0].mermaid += '\n    classDef added fill:#e2f2e6,stroke:#1a7f37,color:#14521f'
    + '\n    style A fill:#ff0000,stroke:#00ff00'
  const lp = join(work, 'legacy.json'); const lh = join(work, 'legacy.html')
  writeFileSync(lp, JSON.stringify(legacy))
  execFileSync('node', [join(root, 'scripts', 'assemble.mjs'), lp, '--out', lh], { stdio: 'pipe' })
  const lb = [...readFileSync(lh, 'utf8').matchAll(/<pre class="mermaid">([\s\S]*?)<\/pre>/g)].map(m => m[1])
  for (const b of lb) {
    if (/\bclassDef\b|#[0-9a-fA-F]{3,8}\b/.test(b)) fail('assemble.mjs let a legacy diagram colour through')
  }
  if (!lb.some(b => /:::added/.test(b))) fail('assemble.mjs stripped the class markers along with the colour')
}

const lum = (rgb) => {
  const [r, g, b] = rgb.map(v => { const c = v / 255; return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4 })
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}
const parse = (s) => (s.match(/[\d.]+/g) || []).slice(0, 3).map(Number)
const ratio = (a, b) => { const [x, y] = [lum(parse(a)), lum(parse(b))].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05) }

const browser = await chromium.launch()
const seenRatios = []
for (const palette of ['slate', 'graphite', 'bond']) {
  const page = await browser.newPage({ viewportSize: { width: 3840, height: 1200 } })
  const errs = []
  page.on('pageerror', e => errs.push(String(e.message)))
  await page.goto('file://' + htmlPath)
  // Switch palette the way the UI does — click the swatch — so diagrams re-render
  // under it. (Setting data-p directly skips applyPalette's re-render, which broke
  // once Diagrams became the default tab and renders eagerly at load.)
  await page.evaluate(() => localStorage.clear())
  await page.locator(`.themepick button[data-v="${palette}"]`).click()
  await page.waitForTimeout(250)

  const probe = await page.evaluate(() => {
    const cs = (sel, prop) => { const e = document.querySelector(sel); return e ? getComputedStyle(e)[prop] : null }
    const bg = (el) => {
      for (let e = el; e; e = e.parentElement) {
        const c = getComputedStyle(e).backgroundColor
        if (c && c !== 'rgba(0, 0, 0, 0)' && c !== 'transparent') return c
      }
      return getComputedStyle(document.body).backgroundColor
    }
    // shadows off overlays
    const shadows = [...document.querySelectorAll('body *')].filter((e) => {
      const s = getComputedStyle(e).boxShadow
      return s && s !== 'none' && !(e.tagName === 'DIALOG' || e.closest('dialog') || e.classList.contains('node'))
    }).map(e => e.className || e.tagName).slice(0, 5)
    // one level of nesting inside the reading column
    // A box is a four-sided border or a fill. A single-sided rule is explicitly
    // the system's alternative to a box (callouts, active tab), so it does not
    // count as a level of nesting.
    const boxed = (e) => {
      const c = getComputedStyle(e)
      if (c.display === 'none' || c.visibility === 'hidden') return false
      const sides = ['Top', 'Right', 'Bottom', 'Left'].filter(s => parseFloat(c[`border${s}Width`]) > 0)
      const filled = c.backgroundColor !== 'rgba(0, 0, 0, 0)' && c.backgroundColor !== 'transparent'
      return sides.length >= 3 || filled
    }
    const EXEMPT = (e) => e.closest('pre, .codebox, .cl, table, dialog, svg') || e.tagName === 'PRE' || e.tagName === 'CODE'
    // §4: only the chrome surfaces carry a distinct background. Everything in the
    // reading column sits on the canvas, whether or not it is nested.
    const canvas = getComputedStyle(document.documentElement).getPropertyValue('--canvas').trim()
    const toRgb = (h) => `rgb(${[1, 3, 5].map(i => parseInt(h.slice(i, i + 2), 16)).join(', ')})`
    const filledInColumn = [...document.querySelectorAll('.main-panel *')].filter((e) => {
      if (EXEMPT(e)) return false
      const c = getComputedStyle(e)
      if (c.display === 'none' || c.visibility === 'hidden') return false
      const bgc = c.backgroundColor
      return bgc !== 'rgba(0, 0, 0, 0)' && bgc !== 'transparent' && bgc !== toRgb(canvas)
    }).map(e => e.className || e.tagName).slice(0, 5)
    const nested = []
    for (const e of document.querySelectorAll('.main-panel *')) {
      if (!boxed(e) || EXEMPT(e)) continue
      for (let a = e.parentElement; a && a.closest('.main-panel'); a = a.parentElement) {
        if (boxed(a) && !EXEMPT(a)) { nested.push(`${a.className || a.tagName} > ${e.className || e.tagName}`); break }
      }
    }
    // inline code must be unstyled
    const ic = document.querySelector('.sub code, .step-text code')
    const icStyle = ic ? (() => { const c = getComputedStyle(ic)
      return { bg: c.backgroundColor, border: parseFloat(c.borderTopWidth), pad: parseFloat(c.paddingLeft) } })() : null
    // the escape guard: a literal <code> string must never reach the DOM
    const literalCode = document.body.innerText.includes('<code>')
    // …and the same markup must actually have become elements, in every place
    // that renders generated prose. Absence of the literal alone would also be
    // satisfied by silently dropping the tag.
    const rendered = ['.step-text', '.branch', '.uwhy', '.finding .fbody', '.sub', '.link-row', '.bwhy', '.section-note']
      .filter(sel => !document.querySelector(`${sel} code`))
    return {
      bodyColor: cs('body', 'color'), bodyBg: bg(document.body),
      subColor: cs('.sub', 'color'), subBg: bg(document.querySelector('.sub')),
      metaColor: cs('.kicker', 'color'), metaBg: bg(document.querySelector('.kicker')),
      subWidth: (() => { const e = document.querySelector('.sub'); if (!e) return null
        const pr = document.createElement('span'); pr.style.cssText = 'position:absolute;visibility:hidden;width:1ch'
        e.appendChild(pr); const ch = pr.getBoundingClientRect().width; pr.remove()
        return ch ? parseFloat(getComputedStyle(e).maxWidth) / ch : null })(),
      fonts: [cs('body', 'fontFamily'), cs('.sub', 'fontFamily')],
      cards: document.querySelectorAll('.stat').length,
      shadows, nested: [...new Set(nested)].slice(0, 5), icStyle, literalCode, rendered, filledInColumn,
    }
  })
  if (errs.length) fail(`[${palette}] page errors: ${errs.join(' | ')}`)
  if (probe.literalCode) fail(`[${palette}] a literal "<code>" string reached the DOM`)
  if (probe.rendered.length) fail(`[${palette}] generated markup was dropped instead of rendered in: ${probe.rendered.join(", ")}`)
  if (probe.filledInColumn.length) fail(`[${palette}] filled surface in the reading column: ${probe.filledInColumn.join(", ")}`)
  if (probe.cards) fail(`[${palette}] ${probe.cards} metric card(s) still rendered`)
  if (probe.shadows.length) fail(`[${palette}] shadow off an overlay: ${probe.shadows.join(', ')}`)
  if (probe.nested.length) fail(`[${palette}] bordered/filled element nested in another: ${probe.nested.join(' | ')}`)
  for (const f of probe.fonts) if (/serif/.test(f) && !/sans-serif/.test(f)) fail(`[${palette}] serif family rendered: ${f}`)
  if (probe.icStyle && (probe.icStyle.bg !== 'rgba(0, 0, 0, 0)' || probe.icStyle.border > 0 || probe.icStyle.pad > 0)) {
    fail(`[${palette}] inline code is boxed: ${JSON.stringify(probe.icStyle)}`)
  }
  if (!(probe.subWidth > 62 && probe.subWidth < 66)) fail(`[${palette}] prose measure ${probe.subWidth?.toFixed(1)}ch at 3840px, not ~64ch`)

  const body = ratio(probe.bodyColor, probe.bodyBg)
  if (body < 10 || body > 14) fail(`[${palette}] body contrast ${body.toFixed(1)}:1 outside 10–14:1`)
  const sub = ratio(probe.subColor, probe.subBg)
  if (sub < 6) fail(`[${palette}] secondary text ${sub.toFixed(1)}:1 below the 6:1 floor`)
  const meta = ratio(probe.metaColor, probe.metaBg)
  if (meta < 4.5) fail(`[${palette}] metadata ${meta.toFixed(1)}:1 below the 4.5:1 floor`)
  seenRatios.push(`${palette} ${body.toFixed(1)}/${sub.toFixed(1)}/${meta.toFixed(1)}`)

  // ── diagrams live inside the design system, not beside it ──────────────────
  await page.locator('#tabs .tab[data-pane="diagrams"]').click()
  await page.locator('#pane-diagrams svg g.node').first().waitFor({ timeout: 5000 })
  const dg = await page.evaluate(() => {
    const t = (n) => getComputedStyle(document.documentElement).getPropertyValue(n).trim()
    const toRgb = (v) => v.startsWith('#')
      ? `rgb(${[1, 3, 5].map(i => parseInt(v.slice(i, i + 2), 16)).join(', ')})`
      : (v === 'transparent' ? 'rgba(0, 0, 0, 0)' : v)
    const shape = (cls) => {
      const g = document.querySelector(`#pane-diagrams svg g.node.${cls}`)
      if (!g) return null
      const s = g.querySelector('rect, path, polygon, circle')
      const c = getComputedStyle(s)
      return { fill: c.fill, stroke: c.stroke, dash: c.strokeDasharray }
    }
    const plain = document.querySelector('#pane-diagrams svg g.node:not(.added):not(.removed):not(.changed) rect')
    return {
      added: shape('added'), removed: shape('removed'),
      want: { addBg: toRgb(t('--add-bg')), addEdge: toRgb(t('--add-edge')),
              delBg: toRgb(t('--del-bg')), delEdge: toRgb(t('--del-edge')),
              sunken: toRgb(t('--sunken')) },
      plainFill: plain ? getComputedStyle(plain).fill : null,
      svgFont: getComputedStyle(document.querySelector('#pane-diagrams svg')).fontFamily,
      labelFont: (() => { const l = document.querySelector('#pane-diagrams .nodeLabel')
        return l ? getComputedStyle(l).fontFamily : null })(),
      inlineStyled: [...document.querySelectorAll('#pane-diagrams svg [style*="fill:#"]')].length,
      // mermaid backs each label with its own rect; left filled it shows through
      // a removed node's transparent outline as a plate
      labelPlates: [...document.querySelectorAll('#pane-diagrams svg g.node rect:not(.label-container)')]
        .filter(r => { const f = getComputedStyle(r).fill; return f !== 'none' && f !== 'rgba(0, 0, 0, 0)' }).length,
    }
  })
  if (!dg.added || !dg.removed) fail(`[${palette}] the fixture's diff-marked nodes did not render`)
  if (dg.inlineStyled) fail(`[${palette}] ${dg.inlineStyled} diagram shape(s) still carry an inline hex fill`)
  if (dg.labelPlates) fail(`[${palette}] ${dg.labelPlates} filled label plate(s) behind diagram nodes`)
  if (dg.added.fill !== dg.want.addBg || dg.added.stroke !== dg.want.addEdge) {
    fail(`[${palette}] added node off token: ${JSON.stringify(dg.added)} want ${dg.want.addBg}/${dg.want.addEdge}`)
  }
  if (dg.removed.fill !== dg.want.delBg || dg.removed.stroke !== dg.want.delEdge) {
    fail(`[${palette}] removed node off token: ${JSON.stringify(dg.removed)} want ${dg.want.delBg}/${dg.want.delEdge}`)
  }
  if (!/5/.test(dg.removed.dash)) fail(`[${palette}] removed node lost its dashed outline: ${dg.removed.dash}`)
  // an unmarked node proves the base theme comes from the tokens too, not from
  // mermaid's own palette (#eee boxes) and its own font stack (Trebuchet)
  if (dg.plainFill !== dg.want.sunken) fail(`[${palette}] unmarked node fill ${dg.plainFill}, want --sunken ${dg.want.sunken}`)
  for (const [what, f] of [['svg', dg.svgFont], ['label', dg.labelFont]]) {
    if (f && !/Archivo/.test(f)) fail(`[${palette}] diagram ${what} font is "${f}", not the page's --ui`)
  }
  await page.close()
}
await browser.close()
console.log(`OK: design system — no stray hex, no serif, no metric cards, one nesting level, inline code bare, 64ch at 3840px, contrast body/secondary/meta ${seenRatios.join('  ')}`)
