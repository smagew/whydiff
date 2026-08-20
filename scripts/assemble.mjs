#!/usr/bin/env node
// Assembles a self-contained HTML change map from review-map.json and templates/viewer.html.
//
//   node scripts/assemble.mjs <review-map.json> [--repo <path>] [--out <file.html>]
//
// --repo is required when the JSON marks files with embedFull: true — their full
// text is read from the repository and embedded into fullFiles.
//
// When the map has diagrams, the mermaid UMD bundle (node_modules/mermaid) is
// inlined so diagrams render anywhere — local file://, artifact hosting, CI.

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs'
import { resolve, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { validateStructure, logTiming } from './lib.mjs'
import { readReview, turns, coverage } from './review.mjs'

const args = process.argv.slice(2)
const jsonPath = args.find(a => !a.startsWith('--'))
if (!jsonPath) {
  console.error('usage: assemble.mjs <review-map.json> [--repo <path>] [--out <file.html>]')
  process.exit(1)
}
const opt = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : null }
const repo = opt('--repo')
const out = opt('--out') || jsonPath.replace(/\.json$/, '.html')
// --journal <dir>: bake the review journal (notes, discussions, tasks) into the exported
// map so it reads offline, read-only — the shareable artifact. Without it the map ships
// note-less (a served map loads them live from /api/threads instead).
const journalDir = opt('--journal')

const rootDir = join(dirname(fileURLToPath(import.meta.url)), '..')
const template = readFileSync(join(rootDir, 'templates', 'viewer.html'), 'utf8')
const rm = JSON.parse(readFileSync(jsonPath, 'utf8'))

// ── integrity validation (principle 5: completeness is checked by script) ────
const errors = validateStructure(rm)
if (errors.length) {
  console.error('Integrity check failed:\n  - ' + errors.join('\n  - '))
  process.exit(1)
}

// ── embed full file texts ─────────────────────────────────────────────────────
rm.fullFiles = rm.fullFiles || {}
for (const [path, f] of Object.entries(rm.files)) {
  if (!f.embedFull) continue
  if (!repo) { console.error(`embedFull is set for ${path}, but --repo was not given`); process.exit(1) }
  try {
    rm.fullFiles[path] = readFileSync(resolve(repo, path), 'utf8')
  } catch {
    // The file the map wants to embed isn't readable at that path in this repo — a
    // commit range where it was renamed/deleted, or a relocated repo. Degrade to a
    // drill-down without the full text rather than failing the whole assemble (which
    // would also take down `serve` re-assembling a saved map for the desktop app).
    delete rm.fullFiles[path]
    f.embedFull = false
    console.warn(`warning: could not read ${path} to embed — its drill-down will omit the full file`)
  }
}

// ── static diagram HTML + inlined mermaid bundle ─────────────────────────────
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
// Same single escape path the viewer uses: escape everything, then restore the
// inline set the generator is allowed to emit. A caption written with <code>
// must not reach the page as a literal string.
const prose = (s) => esc(s == null ? '' : s).replace(/&lt;(\/?)(code|b|i|em|strong)&gt;/g, '<$1$2>')
// Colour is a role, not data. mermaid compiles a `classDef` into an inline
// style AND an injected `!important` rule, both of which outrank the page's own
// stylesheet — so a hex written by the generator would pin the diagram to one
// palette for good. Stripping the colour directives here (rather than only in
// the agent prompt) means maps generated before this rule also obey the palette:
// the viewer paints `.added` / `.removed` / `.changed` from tokens instead.
const stripDiagramColour = (src) => String(src).split('\n')
  .filter(l => !/^\s*classDef\s/.test(l) && !/^\s*style\s+\S+\s+.*(?:fill|stroke|color)\s*:/.test(l))
  .join('\n').replace(/\n{3,}/g, '\n\n').trimEnd()
const diagrams = rm.diagrams || []
// Feather-style icons (stroke = currentColor), so the diagram controls read as one clean set
// instead of OS-dependent glyphs. Kept here (not the viewer) because they live in the diagram
// card markup the assembler emits.
const ICON = {
  fit: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 12h18"/><path d="M7 8l-4 4 4 4"/><path d="M17 8l4 4-4 4"/></svg>',
  pop: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M15 3h6v6"/><path d="M21 3l-9 9"/><path d="M10 5H6a2 2 0 0 0-2 2v11a2 2 0 0 0 2 2h11a2 2 0 0 0 2-2v-4"/></svg>',
  zin: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="11" cy="11" r="7"/><path d="M11 8v6M8 11h6"/><path d="M20.5 20.5l-4-4"/></svg>',
  zout: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="11" cy="11" r="7"/><path d="M8 11h6"/><path d="M20.5 20.5l-4-4"/></svg>',
  reset: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M8 3H5a2 2 0 0 0-2 2v3"/><path d="M16 3h3a2 2 0 0 1 2 2v3"/><path d="M21 16v3a2 2 0 0 1-2 2h-3"/><path d="M3 16v3a2 2 0 0 0 2 2h3"/></svg>',
}
const diagramsHtml = diagrams.map(d => `
  <div class="diagram">
    <div class="dg-head">
      <h3>${esc(d.title)}</h3>
      <span class="dg-actions">
        <button class="dg-btn dg-fit" data-dg-fit="width" type="button" title="Fit to width">${ICON.fit}</button>
        <button class="dg-btn" data-pop type="button" title="Open in its own window">${ICON.pop}</button>
      </span>
    </div>
    ${d.caption ? `<p class="cap">${prose(d.caption)}</p>` : ''}
    <div class="mermaid-wrap"><div class="mermaid-box"><pre class="mermaid">${esc(stripDiagramColour(d.mermaid))}</pre></div><div class="dg-zoom"><button class="dg-btn" data-dg-zoom="in" type="button" title="Zoom in">${ICON.zin}</button><button class="dg-btn" data-dg-zoom="out" type="button" title="Zoom out">${ICON.zout}</button><button class="dg-btn" data-dg-fit="screen" type="button" title="Fit the whole diagram on screen">${ICON.reset}</button></div></div>
    ${(d.files || []).length ? `<div class="step-files">${d.files.map(p =>
      `<button class="fchip" data-goto="${esc(p)}">${esc(p.split('/').slice(-2).join('/'))}</button>`).join('')}</div>` : ''}
  </div>`).join('\n')

// Inline highlight.js (the prebuilt browser bundle) so the viewer can syntax-highlight
// code — the full-file drill-down, the diff fragments, the card previews — with no
// network. Colours come from palette tokens in the template, not from hljs, so the
// highlight follows the palette and stays within the design system.
let hljsBundle = ''
{
  const hljsPath = join(rootDir, 'node_modules', '@highlightjs', 'cdn-assets', 'highlight.min.js')
  if (existsSync(hljsPath)) {
    const src = readFileSync(hljsPath, 'utf8').replace(/<\/script/g, '<\\/script')
    hljsBundle = '<script>\n' + src + '\n</script>'
  } else {
    console.warn('warning: highlight.js bundle not found (npm install @highlightjs/cdn-assets) — code will render unhighlighted')
  }
}

let mermaidBundle = ''
if (diagrams.length) {
  const mermaidPath = join(rootDir, 'node_modules', 'mermaid', 'dist', 'mermaid.min.js')
  if (existsSync(mermaidPath)) {
    // The minified bundle contains literal "</script>" inside strings, which would
    // terminate the inline tag early — escape the slash (a no-op for JS semantics).
    const src = readFileSync(mermaidPath, 'utf8').replace(/<\/script/g, '<\\/script')
    mermaidBundle = '<script>\n' + src + '\n</script>'
  } else {
    console.warn('warning: mermaid bundle not found (npm install mermaid) — diagrams will show as source text')
  }
}

// ── assembly ─────────────────────────────────────────────────────────────────
// A literal </script> inside JSON strings would close the tag — escape the slash.
// Replacements go through functions: string replacements interpret $-patterns
// ($&, $', …), and both the JSON and the mermaid bundle contain them.
const json = JSON.stringify(rm).replace(/<\//g, '<\\/')
// The viewer's pure logic module, inlined into its single classic <script> — the `export`
// keywords stripped so the declarations run as plain script, any literal </script>
// neutralised. Authored/tested as an ES module (templates/viewer-logic.mjs); shipped
// inline so the map stays self-contained.
const viewerLogic = readFileSync(join(rootDir, 'templates', 'viewer-logic.mjs'), 'utf8')
  .replace(/^export\s+/gm, '')
  .replace(/<\/script/g, '<\\/script')
// The review journal, folded into the page for an offline read-only export. `null` when
// no --journal is given (a served or plain export). The shapes match what serve.mjs sends
// live (turns() for the annotations, the projection + coverage for the Review tab).
let threadsJson = 'null', reviewJson = 'null'
if (journalDir) {
  try {
    const { state } = readReview(journalDir)
    threadsJson = JSON.stringify(turns(state)).replace(/<\//g, '<\\/')
    reviewJson = JSON.stringify({ ...state, coverage: coverage(rm, state) }).replace(/<\//g, '<\\/')
  } catch (e) { console.warn(`warning: could not read the review journal at ${journalDir} — exporting without notes (${e.message})`) }
}
// The plugin version, stamped into the footer so a served or exported map says
// which whydiff produced it. Read from the plugin manifest; empty if unavailable.
let version = ''
try { version = JSON.parse(readFileSync(join(rootDir, '.claude-plugin', 'plugin.json'), 'utf8')).version || '' } catch {}
const html = template
  .replace('__TITLE__', () => esc(`${rm.meta.project}: ${rm.meta.title || rm.meta.ref} — change map`))
  .replace('__WHYDIFF_VERSION__', () => esc(version))
  .replace('__DIAGRAMS_HTML__', () => diagramsHtml)
  .replace('__MERMAID_BUNDLE__', () => mermaidBundle)
  .replace('__HLJS_BUNDLE__', () => hljsBundle)
  .replace('__VIEWER_LOGIC__', () => viewerLogic)
  .replace('__THREADS__', () => threadsJson)
  .replace('__REVIEW__', () => reviewJson)
  .replace('__REVIEW_MAP_JSON__', () => json)

mkdirSync(dirname(resolve(out)), { recursive: true })
writeFileSync(out, html)
// Timing instrumentation: appends to an existing timing.jsonl only (see lib.mjs).
logTiming(dirname(resolve(jsonPath)), 'assembled', { html_kb: Math.round(html.length / 1024), files: Object.keys(rm.files).length, diagrams: diagrams.length })
console.log(`OK: ${out} (${(html.length / 1024).toFixed(0)} KB, files: ${Object.keys(rm.files).length}, diagrams: ${diagrams.length}, mermaid: ${mermaidBundle ? 'inlined' : 'no'})`)
