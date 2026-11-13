#!/usr/bin/env node
// Translating a finished report (scripts/translate.mjs, /api/translate, the language menu).
// Goals, not proxies:
//   - a translation changes only reader-facing text: the translated map has the same
//     files, groups, edges and diagram syntax, and the map on disk is never rewritten;
//   - code, paths and ids survive: a reply that drops a <code> span or a {0} placeholder
//     is refused and that string stays in the original;
//   - after a section changes, an update sends only the new text;
//   - the reader switches language from the title bar and every diagram still draws; a
//     translated diagram that would not parse draws from its original source;
//   - a note pinned to a diagram node in one language finds that node in another;
//   - translating is on demand only: a standalone file lists what it carries and offers
//     no Translate button.
// `claude` is a stub that prefixes each string with "[<lang>] ", so no model runs.

import { readFileSync, writeFileSync, mkdtempSync, existsSync, chmodSync, mkdirSync } from 'node:fs'
import { spawn, execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'
import { mermaidSegments, translatableStrings, applyTranslation, untranslated, acceptTranslation, uiTable } from '../templates/viewer-logic.mjs'
import { viewerUiTemplates, plan, mergeReply, readCatalog } from '../scripts/translate.mjs'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const fail = (m) => { console.error(`FAIL: ${m}`); process.exit(1) }
const ok = (c, m) => { if (!c) fail(m) }

const rm = JSON.parse(readFileSync(join(root, 'examples', 'rate-limit', 'review-map.json'), 'utf8'))
for (const f of Object.values(rm.files)) delete f.embedFull
// A sequence and an ER diagram too: their labels are not all quoted.
rm.diagrams.push({
  kind: 'sequence', title: 'Refund call', caption: 'who calls whom',
  mermaid: 'sequenceDiagram\n  participant C as Client\n  participant API as OrdersController\n  C->>API: refund request\n  alt state is shipped\n    API-->>C: 201 refund_id\n  end\n  Note over API: checks the state first',
})
rm.diagrams.push({
  kind: 'er-diff', title: 'Refund rows', caption: 'the new table',
  mermaid: 'erDiagram\n  orders ||--o{ refunds : has\n  refunds {\n    bigint id "+ added"\n    text reason "+ added, free text"\n  }',
})
// The way a translator treats a diff marker: it stays first ("+ added" → "+ [de] added").
const tag = (text, lang) => text.replace(/^([+\-~] )?/, `$1[${lang}] `)
const prefixCat = (m, lang) => Object.fromEntries(translatableStrings(m).map(({ id, text }) => [id, { src: text, text: tag(text, lang) }]))

// ── unit: what is translated, and what never is ──────────────────────────────
{
  for (const d of rm.diagrams) ok(mermaidSegments(d.mermaid).map(s => s.t).join('') === d.mermaid, `segmenting "${d.title}" does not give its source back`)
  const ids = translatableStrings(rm).map(s => JSON.parse(s.id))
  const texts = translatableStrings(rm).map(s => s.text)
  for (const k of ['project', 'ref', 'lang', 'generatedAt']) ok(!ids.some(p => p[0] === 'meta' && p[1] === k), `meta.${k} was offered for translation`)
  ok(!ids.some(p => p[0] === 'groups' && p[2] === 'id') && !ids.some(p => p[0] === 'groups' && p[2] === 'files'), 'group ids or file lists were offered for translation')
  ok(!ids.some(p => p[0] === 'edges' && (p[2] === 0 || p[2] === 1)), 'edge endpoints (paths) were offered for translation')
  ok(!ids.some(p => p[0] === 'ops' && p[1] === 'env' && p[3] === 'name'), 'env var names were offered for translation')
  ok(!texts.some(t => /whydiffOpen|^src\//.test(t)), 'a click directive or a path was offered as a diagram label')
  for (const want of ['refund request', 'state is shipped', 'checks the state first', 'Client', 'has', '+ added, free text', 'Tokens left<br/>in the bucket?'])
    ok(texts.includes(want), `the diagram label "${want}" is not offered for translation`)

  const before = JSON.stringify(rm)
  const t = applyTranslation(rm, prefixCat(rm, 'de'))
  ok(JSON.stringify(rm) === before, 'applyTranslation changed the original map')
  ok(JSON.stringify(Object.keys(t.files)) === JSON.stringify(Object.keys(rm.files)), 'the translated map has different files')
  ok(JSON.stringify(t.groups.map(g => [g.id, g.files])) === JSON.stringify(rm.groups.map(g => [g.id, g.files])), 'the translated map has different groups')
  ok(JSON.stringify(t.edges.map(e => e.slice(0, 2))) === JSON.stringify(rm.edges.map(e => e.slice(0, 2))), 'the translated map has different edges')
  // Diagram syntax is identical once every label (and the quotes around one) is taken out.
  const bare = (src) => mermaidSegments(src).map(s => s.tr ? '' : s.t).join('').replace(/"/g, '')
  rm.diagrams.forEach((d, i) => ok(bare(t.diagrams[i].mermaid) === bare(d.mermaid), `diagram ${i}: the translation changed its syntax`))
  ok(translatableStrings(t).every(s => /^([+\-~] )?\[de\] /.test(s.text)), 'a reader-facing string was left untranslated')
  ok(/bigint id "\+ \[de\] added"/.test(t.diagrams.at(-1).mermaid), `the ER diff marker did not stay first: ${t.diagrams.at(-1).mermaid}`)

  // A section regenerated after the translation: only that string is untranslated again.
  const rm2 = JSON.parse(before); rm2.groups[0].why = 'A new reason, written after the translation.'
  const stale = untranslated(rm2, prefixCat(rm, 'de'))
  ok(stale.length === 1 && JSON.parse(stale[0].id).join('.') === 'groups.0.why', `after one change, untranslated() should list exactly that string, got ${stale.map(s => s.id)}`)
  ok(applyTranslation(rm2, prefixCat(rm, 'de')).groups[0].why === rm2.groups[0].why, 'a changed string showed its old translation')

  ok(acceptTranslation('uses <code>rateLimit()</code> now', 'nutzt jetzt rateLimit()') === null, 'a translation that lost a <code> span was accepted')
  ok(acceptTranslation('+ added', 'hinzugefügt') === '+ hinzugefügt', 'the diff marker was not restored')

  // The viewer's own labels: counted ones keep their count and their n = 1 form.
  const tpl = viewerUiTemplates()
  const de = Object.fromEntries(Object.entries(tpl).map(([k, v]) => [k, `Ü ${v}`]))
  const en = { vCareful: (n) => n === 1 ? '1 file to read carefully' : `${n} files to read carefully`, tabs: { files: 'Files' }, refVs: (b) => `vs ${b}` }
  const Lde = uiTable(en, de)
  ok(Lde.vCareful(1) === 'Ü 1 file to read carefully' && Lde.vCareful(3) === 'Ü 3 files to read carefully', `counted labels lost their forms: ${Lde.vCareful(1)} / ${Lde.vCareful(3)}`)
  ok(Lde.tabs.files === 'Ü Files' && Lde.refVs('main') === 'Ü vs main', 'plain or nested labels were not translated')
  ok(uiTable(en, { vCareful: 'Dateien' }).vCareful(3) === '3 files to read carefully', 'a label that lost its {0} replaced the English one')
  // mergeReply refuses the same two failures at the source.
  const cat = { lang: 'de', strings: {}, ui: null }
  const p = plan(rm, cat)
  const code = p.items.find(i => /<code>/.test(i.text))
  const ui = p.items.find(i => p.ui[i.k] && /\{0\}/.test(i.text))
  ok(code && ui, 'the plan has no string with a code span or no counted label to test with')
  const r = mergeReply(cat, p, { [code.k]: 'ohne Code', [ui.k]: 'ohne Zahl' })
  ok(r.taken === 0 && r.refused === 2, `mergeReply should refuse a lost code span and a lost placeholder, got ${JSON.stringify(r)}`)
}

// ── serve: /api/translate with a stub model ──────────────────────────────────
const work = mkdtempSync(join(tmpdir(), 'whydiff-translate-'))
const mapPath = join(work, 'review-map.json')
writeFileSync(mapPath, JSON.stringify(rm, null, 2))
const stubs = mkdtempSync(join(tmpdir(), 'whydiff-trstub-'))
const calls = join(stubs, 'calls.log')
const stub = join(stubs, 'claude.mjs')
// Prefixes every value with "[<lang>] "; drops the <code> span of a string that mentions
// "Lua" (so one refusal is exercised end to end); logs how many strings each call got.
writeFileSync(stub, `#!/usr/bin/env node
import { appendFileSync } from 'node:fs'
const a = process.argv.slice(2), prompt = a[a.indexOf('-p') + 1] || ''
const lang = (prompt.match(/TARGET_LANGUAGE: (\\S+)/) || [])[1]
const m = prompt.match(/STRINGS:\\n\`\`\`json\\n([\\s\\S]*?)\\n\`\`\`/)
const src = m ? JSON.parse(m[1]) : {}
appendFileSync(${JSON.stringify(calls)}, Object.keys(src).length + '\\n')
const out = {}
const tag = (v) => v.replace(/^([+\\-~] )?/, '$1[' + lang + '] ')
for (const [k, v] of Object.entries(src)) out[k] = /Lua/.test(v) ? tag(v.replace(/<\\/?code>/g, '')) : tag(v)
process.stdout.write(JSON.stringify({ type: 'result', subtype: 'success', result: '\`\`\`json\\n' + JSON.stringify(out) + '\\n\`\`\`' }) + '\\n')
`)
chmodSync(stub, 0o755)

const port = 7870 + (process.pid % 40)
const proc = spawn('node', [join(root, 'scripts', 'serve.mjs'), '--no-open', mapPath, '--repo', root, '--port', String(port), '--claude-cmd', stub], { stdio: ['ignore', 'pipe', 'pipe'] })
let out = ''; proc.stdout.on('data', d => { out += d }); proc.stderr.on('data', d => { out += d })
process.on('exit', () => { try { proc.kill('SIGKILL') } catch {} })
const base = `http://127.0.0.1:${port}`
for (let i = 0; i < 100; i++) { try { if ((await fetch(base + '/')).ok) break } catch {} await new Promise(r => setTimeout(r, 100)) }
const token = (await (await fetch(base + '/')).text()).match(/"token":"([a-f0-9]+)"/)?.[1]
ok(token, 'no server token in the page')
const post = async (lang, tok = token) => {
  const r = await fetch(base + '/api/translate', { method: 'POST', headers: { 'content-type': 'application/json', 'x-whydiff-token': tok }, body: JSON.stringify({ lang }) })
  if (r.headers.get('content-type')?.includes('application/json')) return { status: r.status, events: [await r.json()] }
  return { status: r.status, events: (await r.text()).trim().split('\n').map(l => JSON.parse(l)) }
}
const callCounts = () => existsSync(calls) ? readFileSync(calls, 'utf8').trim().split('\n').map(Number) : []
{
  const mapBytes = readFileSync(mapPath, 'utf8')
  ok((await post('de', 'nope')).status === 403, '/api/translate answered without the token')
  ok((await post('de; rm -rf')).status === 400, 'a malformed language code was not refused')
  ok((await post('en')).status === 400, 'translating into the report\'s own language was not refused')
  const r = await post('de')
  const done = r.events.find(e => e.kind === 'done')
  ok(done, `the translation did not finish: ${JSON.stringify(r.events)} ${out}`)
  ok(r.events.filter(e => e.kind === 'progress').length >= 2, 'no progress was streamed')
  const lostCode = new Set(translatableStrings(rm).filter(s => /Lua/.test(s.text) && /<code>/.test(s.text)).map(s => s.text)).size
  ok(lostCode >= 1 && done.refused === lostCode, `every reply that lost a <code> span (${lostCode}) should be refused, got ${done.refused}`)
  ok(readFileSync(mapPath, 'utf8') === mapBytes, 'translating rewrote the map')
  const cat = readCatalog(work, 'de')
  ok(Object.keys(cat.strings).length >= translatableStrings(rm).length - 3, 'the catalog misses strings')
  ok(cat.ui && Object.keys(cat.ui).length > 200, 'German has no label table in the viewer, yet its labels were not translated')
  ok(callCounts().every(n => n <= 80), `a batch was larger than 80 strings: ${callCounts()}`)

  // Nothing new → no model call. One changed string → one string sent.
  const n0 = callCounts().length
  ok((await post('de')).events.some(e => e.kind === 'done') && callCounts().length === n0, 'an up-to-date translation called the model again')
  const m2 = JSON.parse(mapBytes); m2.groups[0].why = 'A reason written after the translation.'
  writeFileSync(mapPath, JSON.stringify(m2, null, 2))
  await post('de')
  ok(callCounts().length === n0 + 1 && callCounts().at(-1) === 1, `an update should send only the changed string, sent ${callCounts().slice(n0)}`)
}

// ── the reader: switch, translate from the menu, every diagram draws, notes follow ──
const browser = await chromium.launch()
const errors = []
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } })
page.on('pageerror', e => errors.push(`pageerror: ${e.message}`))
page.on('console', m => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) errors.push(`console: ${m.text()}`) })
const drawn = async () => {
  await page.waitForFunction(() => document.querySelectorAll('#pane-diagrams pre.mermaid > svg').length === document.querySelectorAll('#pane-diagrams pre.mermaid').length, null, { timeout: 20000 })
    .catch(() => fail('not every diagram was drawn'))
  ok(await page.locator('#pane-diagrams .mermaid-box.broken').count() === 0, 'a diagram fell back to "could not be drawn"')
}
{
  await page.goto(base + '/')
  await drawn()
  const nDiagrams = await page.locator('#pane-diagrams pre.mermaid').count()
  // A note pinned to a node in the original language.
  const tab = page.locator('#dgTabs .dg-tab[data-dgkey="0"]')
  await tab.click(); await page.waitForTimeout(400)
  const key = await page.evaluate(() => {
    const n = [...document.querySelectorAll('#pane-diagrams .diagram[data-dg="0"] svg .node')].find(n => /Tokens left/.test(n.textContent))
    return n && `diagram:0:${nslug(n.textContent.replace(/\s+/g, ' ').trim()).slice(0, 40)}`
  })
  ok(key, 'the decision node was not found in the original diagram')
  const nr = await fetch(base + '/api/note', { method: 'POST', headers: { 'content-type': 'application/json', 'x-whydiff-token': token }, body: JSON.stringify({ kind: 'note', anchor: { kind: 'diagram-node', key, label: 'Tokens left' }, text: 'check the refill' }) })
  ok(nr.ok, 'the note was not saved')

  // The menu: the original and the German translation; French on offer with an estimate.
  await page.reload(); await drawn()
  await page.click('.lang-btn')
  const opts = await page.$$eval('.lang-pop .lp-opt', os => os.map(o => [o.dataset.lang, o.getAttribute('aria-checked')]))
  ok(JSON.stringify(opts) === JSON.stringify([['en', 'true'], ['de', 'false']]), `the menu should list the original and the German translation: ${JSON.stringify(opts)}`)
  await page.selectOption('.lp-sel', 'fr')
  ok(/\d+/.test(await page.locator('.lp-est').textContent()), 'no estimate before translating')
  await Promise.all([page.waitForNavigation({ timeout: 30000 }), page.click('.lp-go')])
  await drawn()
  ok(await page.evaluate(() => document.documentElement.lang) === 'fr', 'after Translate the report did not open in French')
  ok((await page.locator('#title').textContent()).startsWith('[fr] '), 'the title is not translated')
  ok((await page.locator('#dgTabs .dg-tab').first().textContent()).includes('[fr]'), 'the diagram tabs are not translated')
  ok((await page.locator('#tabs .tab[data-pane="files"] .tl').textContent()).startsWith('[fr]'), 'the side bar labels are not translated')
  ok(await page.locator('#pane-diagrams pre.mermaid').count() === nDiagrams, 'the translated report has a different number of diagrams')
  for (const k of ['0', String(rm.diagrams.length - 2), String(rm.diagrams.length - 1)]) {
    await page.click(`#dgTabs .dg-tab[data-dgkey="${k}"]`); await page.waitForTimeout(300)
    ok(/\[fr\]/.test(await page.locator(`#pane-diagrams .diagram[data-dg="${k}"] pre.mermaid > svg`).textContent()), `diagram ${k} is drawn without translated labels`)
  }
  ok(await page.locator('#pane-diagrams .diagram[data-dg="0"] .dg-badge').count() >= 1, 'the note pinned in English has no badge on the French diagram')

  // Back to the original, and the choice survives a reload.
  await page.click('.lang-btn')
  await Promise.all([page.waitForNavigation(), page.click('.lang-pop .lp-opt[data-lang="en"]')])
  await drawn()
  ok(await page.evaluate(() => document.documentElement.lang) === 'en' && !(await page.locator('#title').textContent()).includes('['), 'switching back did not restore the original')
  await page.reload(); await drawn()
  ok(await page.evaluate(() => document.documentElement.lang) === 'en', 'the language choice did not survive a reload')
}

// ── a standalone file: carries its translations, offers no Translate, falls back per diagram ──
{
  const htmlPath = join(work, 'standalone.html')
  execFileSync('node', [join(root, 'scripts', 'assemble.mjs'), mapPath, '--repo', root, '--out', htmlPath], { stdio: 'ignore' })
  let html = readFileSync(htmlPath, 'utf8')
  // Break diagram 1's German source: it must draw from the original instead.
  const tplAt = html.indexOf('<template data-dg-lang="de">')
  const preAt = html.indexOf('<pre class="mermaid" data-src-orig=', html.indexOf('data-dg="1"', tplAt))
  const body = html.indexOf('>', preAt) + 1
  html = html.slice(0, body) + 'flowchart TD\n  A[[[ broken' + html.slice(html.indexOf('</pre>', body))
  writeFileSync(htmlPath, html)
  const p2 = await browser.newPage({ viewport: { width: 1440, height: 900 } })
  p2.on('pageerror', e => errors.push(`pageerror: ${e.message}`))
  await p2.addInitScript(([k]) => { try { localStorage.setItem(k, JSON.stringify({ viewLang: 'de' })) } catch {} }, [`whydiff:${rm.meta.project}:${rm.meta.ref}`])
  await p2.goto('file://' + htmlPath)
  await p2.click('#dgTabs .dg-tab[data-dgkey="1"]')
  await p2.waitForSelector('#pane-diagrams .diagram[data-dg="1"] pre.mermaid > svg', { timeout: 15000 }).catch(() => fail('the broken translated diagram was not drawn from its original'))
  ok(await p2.locator('#pane-diagrams .diagram[data-dg="1"] .mermaid-box.broken').count() === 0, 'a translated diagram that does not parse showed the broken-diagram fallback')
  ok(await p2.locator('#pane-diagrams .diagram[data-dg="1"] pre.mermaid[data-untranslated]').count() === 1, 'the original-source fallback is not marked')
  await p2.click('.lang-btn')
  ok(await p2.locator('.lang-pop .lp-go, .lang-pop .lp-sel').count() === 0, 'a standalone file offers Translate')
  ok(await p2.locator('.lang-pop .lp-live').count() >= 1, 'a standalone file does not say where translations are made')
  ok(await p2.locator('.lang-pop .lp-opt').count() === 3, 'the standalone file does not list the translations it carries')
  await p2.close()
}
ok(!errors.length, `page errors: ${errors.join(' | ')}`)
await browser.close()
proc.kill('SIGKILL')
console.log('OK: translate — only reader-facing text is translated (files, groups, edges, diagram syntax unchanged; the map is never rewritten), code spans and placeholders are enforced, an update sends only new text, the title-bar menu translates and switches with every diagram drawn, a broken translated diagram draws from its original, notes follow nodes across languages, a standalone file offers no Translate')
process.exit(0)
