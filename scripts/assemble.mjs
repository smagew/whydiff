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

const args = process.argv.slice(2)
const jsonPath = args.find(a => !a.startsWith('--'))
if (!jsonPath) {
  console.error('usage: assemble.mjs <review-map.json> [--repo <path>] [--out <file.html>]')
  process.exit(1)
}
const opt = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : null }
const repo = opt('--repo')
const out = opt('--out') || jsonPath.replace(/\.json$/, '.html')

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
  rm.fullFiles[path] = readFileSync(resolve(repo, path), 'utf8')
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
const diagramsHtml = diagrams.map(d => `
  <div class="diagram">
    <div class="dg-head">
      <h3>${esc(d.title)}</h3>
      <span class="dg-actions"><button class="dg-btn" data-pop>⧉</button></span>
    </div>
    ${d.caption ? `<p class="cap">${prose(d.caption)}</p>` : ''}
    <div class="mermaid-box"><pre class="mermaid">${esc(stripDiagramColour(d.mermaid))}</pre></div>
    ${(d.files || []).length ? `<div class="step-files">${d.files.map(p =>
      `<button class="fchip" data-goto="${esc(p)}">${esc(p.split('/').slice(-2).join('/'))}</button>`).join('')}</div>` : ''}
  </div>`).join('\n')

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
// The plugin version, stamped into the footer so a served or exported map says
// which whydiff produced it. Read from the plugin manifest; empty if unavailable.
let version = ''
try { version = JSON.parse(readFileSync(join(rootDir, '.claude-plugin', 'plugin.json'), 'utf8')).version || '' } catch {}
const html = template
  .replace('__TITLE__', () => esc(`${rm.meta.project}: ${rm.meta.title || rm.meta.ref} — change map`))
  .replace('__WHYDIFF_VERSION__', () => esc(version))
  .replace('__DIAGRAMS_HTML__', () => diagramsHtml)
  .replace('__MERMAID_BUNDLE__', () => mermaidBundle)
  .replace('__REVIEW_MAP_JSON__', () => json)

mkdirSync(dirname(resolve(out)), { recursive: true })
writeFileSync(out, html)
// Timing instrumentation: appends to an existing timing.jsonl only (see lib.mjs).
logTiming(dirname(resolve(jsonPath)), 'assembled', { html_kb: Math.round(html.length / 1024), files: Object.keys(rm.files).length, diagrams: diagrams.length })
console.log(`OK: ${out} (${(html.length / 1024).toFixed(0)} KB, files: ${Object.keys(rm.files).length}, diagrams: ${diagrams.length}, mermaid: ${mermaidBundle ? 'inlined' : 'no'})`)
