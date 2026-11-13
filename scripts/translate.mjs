#!/usr/bin/env node
// Translating a finished change map into another language — the deterministic half.
// The model only ever sees a flat list of reader-facing strings (see translatableStrings
// in templates/viewer-logic.mjs) and returns the same list translated; this module plans
// that list, checks what comes back, and keeps the result as a catalog beside the map:
//
//   .whydiff/translations/<lang>.json  { lang, strings: { <id>: { src, text } }, ui }
//
// The map itself is never rewritten. assemble.mjs embeds every catalog, and the viewer
// lays the chosen one over the map at load. A string whose source changed since (a
// section regenerated) is simply untranslated again, so an update pays only for it.
//
// Used by serve.mjs (/api/translate) and, for the plugin's `/whydiff translate:<lang>`, as
// a CLI around the translator agent:
//   node scripts/translate.mjs extract <review-map.json> --lang <code>   → <lang>.todo.json
//   node scripts/translate.mjs apply   <review-map.json> --lang <code>   ← <lang>.out.json

import { readFileSync, writeFileSync, mkdirSync, existsSync, rmSync } from 'node:fs'
import { join, dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'
import { untranslated, acceptTranslation, uiTemplates } from '../templates/viewer-logic.mjs'

const rootDir = join(dirname(fileURLToPath(import.meta.url)), '..')

// A BCP-47 tag (the same rule run.mjs applies to --lang).
export const LANG_RE = /^[a-z]{2,3}(-[A-Za-z0-9]{2,8})*$/
// Languages the viewer has its own label table for; any other gets its labels translated.
export const BUILTIN_UI = new Set(['en', 'ru'])
// Strings per model call: small enough that one reply never runs long, large enough that
// a typical map (~100–300 strings) is a few calls.
export const CHUNK = 80

export const catalogPath = (reviewDir, lang) => join(reviewDir, 'translations', `${lang}.json`)
export function readCatalog(reviewDir, lang) {
  try {
    const c = JSON.parse(readFileSync(catalogPath(reviewDir, lang), 'utf8'))
    return { lang, strings: c.strings && typeof c.strings === 'object' ? c.strings : {}, ui: c.ui && typeof c.ui === 'object' ? c.ui : null }
  } catch { return { lang, strings: {}, ui: null } }
}
export function writeCatalog(reviewDir, cat) {
  mkdirSync(join(reviewDir, 'translations'), { recursive: true })
  writeFileSync(catalogPath(reviewDir, cat.lang), JSON.stringify(cat, null, 2))
}

// The viewer's English label table, read out of the template (it is code: some labels
// are functions of a count). Evaluated in an empty context; only `ruN` is referenced.
let enUi = null
export function viewerUiTemplates() {
  if (enUi) return enUi
  const html = readFileSync(join(rootDir, 'templates', 'viewer.html'), 'utf8')
  const start = html.indexOf('const I18N = {')
  const end = html.indexOf('\n}\n', start)
  if (start < 0 || end < 0) throw new Error('viewer.html: the I18N table was not found')
  const table = vm.runInNewContext(`(() => { function ruN(n, a, b, c) { return c } ${html.slice(start, end + 2)}; return I18N.en })()`)
  enUi = uiTemplates(table)
  return enUi
}

// What a run must translate: the map's strings the catalog lacks, deduplicated (the same
// text is sent once), plus the viewer's labels when the language has no table of its own
// and the catalog has not covered them yet. Short keys keep the prompt small.
export function plan(map, cat) {
  const byText = new Map()
  for (const { id, text } of untranslated(map, cat.strings)) {
    if (!byText.has(text)) byText.set(text, [])
    byText.get(text).push(id)
  }
  const items = [], ids = {}
  for (const [text, list] of byText) { const k = `s${items.length}`; items.push({ k, text }); ids[k] = list }
  const ui = {}
  if (!BUILTIN_UI.has(cat.lang)) {
    const tpl = viewerUiTemplates()
    let n = 0
    for (const [id, text] of Object.entries(tpl)) {
      if (cat.ui && typeof cat.ui[id] === 'string' && cat.ui[id].trim()) continue
      const k = `u${n++}`
      items.push({ k, text }); ui[k] = id
    }
  }
  return { lang: cat.lang, items, ids, ui }
}
export const chunks = (items, size = CHUNK) => Array.from({ length: Math.ceil(items.length / size) }, (_, i) => items.slice(i * size, (i + 1) * size))

// The instructions for one batch: the translator agent's own text, the target language,
// and the batch as a JSON object. The reply must be one JSON object with the same keys.
export function promptFor(lang, batch) {
  const md = readFileSync(join(rootDir, 'agents', 'translator.md'), 'utf8').replace(/^---[\s\S]*?\n---\n/, '').trim()
  const obj = Object.fromEntries(batch.map(({ k, text }) => [k, text]))
  return `${md}

TARGET_LANGUAGE: ${lang}

STRINGS:
\`\`\`json
${JSON.stringify(obj, null, 1)}
\`\`\`

Reply with NOTHING but one fenced json block holding the same keys, each value translated.`
}

// The JSON object in a reply: the last fenced json block, or the reply itself.
export function parseReply(reply) {
  const blocks = [...String(reply).matchAll(/```(?:json)?\s*\n([\s\S]*?)```/g)].map(m => m[1])
  for (const b of [...blocks.reverse(), String(reply)]) {
    try { const o = JSON.parse(b.trim()); if (o && typeof o === 'object' && !Array.isArray(o)) return o } catch {}
  }
  return null
}

// Fold a batch's reply into the catalog. A string comes in only if acceptTranslation
// takes it (non-empty, every <code> span carried over); a label only if it keeps its
// {0}-style placeholders. A refused one is recorded as kept in the original (`kept`), so
// an update does not pay to send it again. Returns how many were taken and refused.
export function mergeReply(cat, p, reply) {
  let taken = 0, refused = 0
  const tokens = (s) => JSON.stringify((String(s).match(/\{\d+\}/g) || []).sort())
  for (const [k, text] of Object.entries(reply || {})) {
    if (p.ids[k]) {
      const src = p.items.find(i => i.k === k)?.text
      const t = acceptTranslation(src, text)
      for (const id of p.ids[k]) cat.strings[id] = t == null ? { src, text: src, kept: true } : { src, text: t }
      if (t == null) refused++; else taken++
    } else if (p.ui[k]) {
      const src = p.items.find(i => i.k === k)?.text
      const good = typeof text === 'string' && text.trim() && tokens(src) === tokens(text)
      cat.ui = cat.ui || {}
      cat.ui[p.ui[k]] = good ? text : src
      if (good) taken++; else refused++
    }
  }
  return { taken, refused }
}

// ── CLI (the plugin path: extract → translator agent → apply) ─────────────────
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [cmd, mapArg, ...rest] = process.argv.slice(2)
  const opt = (n) => { const i = rest.indexOf(n); return i >= 0 ? rest[i + 1] : null }
  const lang = opt('--lang') || ''
  if (!['extract', 'apply'].includes(cmd) || !mapArg || !LANG_RE.test(lang)) {
    console.error('usage: translate.mjs extract|apply <review-map.json> --lang <code>')
    process.exit(2)
  }
  const mapPath = resolve(mapArg)
  const reviewDir = dirname(mapPath)
  const map = JSON.parse(readFileSync(mapPath, 'utf8'))
  const cat = readCatalog(reviewDir, lang)
  const todoPath = join(reviewDir, 'translations', `${lang}.todo.json`)
  const outPath = join(reviewDir, 'translations', `${lang}.out.json`)
  if (cmd === 'extract') {
    if ((map.meta?.lang || 'en') === lang) { console.error(`the report is already in ${lang}`); process.exit(3) }
    const p = plan(map, cat)
    mkdirSync(dirname(todoPath), { recursive: true })
    writeFileSync(todoPath, JSON.stringify(p, null, 2))
    const strings = Object.fromEntries(p.items.map(({ k, text }) => [k, text]))
    writeFileSync(join(reviewDir, 'translations', `${lang}.in.json`), JSON.stringify(strings, null, 1))
    console.log(p.items.length
      ? `translate ${lang}: ${p.items.length} strings (${Object.keys(p.ui).length} interface labels) → IN ${join(reviewDir, 'translations', `${lang}.in.json`)}  OUT ${outPath}`
      : `translate ${lang}: already complete — nothing to translate`)
  } else {
    if (!existsSync(todoPath)) { console.error(`run extract first: ${todoPath} is missing`); process.exit(1) }
    const p = JSON.parse(readFileSync(todoPath, 'utf8'))
    let reply = null
    try { reply = parseReply(readFileSync(outPath, 'utf8')) } catch {}
    if (!reply) { console.error(`no translated strings in ${outPath}`); process.exit(1) }
    const { taken, refused } = mergeReply(cat, p, reply)
    writeCatalog(reviewDir, cat)
    for (const f of [todoPath, outPath, join(reviewDir, 'translations', `${lang}.in.json`)]) rmSync(f, { force: true })
    console.log(`translate ${lang}: ${taken} taken, ${refused} kept in the original (missing code span or placeholder) → ${catalogPath(reviewDir, lang)}`)
  }
}
