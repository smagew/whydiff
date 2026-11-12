// Pure, DOM-free helpers for the viewer. Authored as an ES module so it can be unit
// tested in node (tests/viewer-logic.mjs); assemble.mjs strips the `export` keywords and
// inlines the body into the viewer's single classic <script>, so the shipped map stays
// self-contained. Keep this file DOM-free and dependency-free — anything that touches the
// DOM or viewer state belongs in the template. This is the seam that lets viewer logic
// grow under unit coverage instead of only end-to-end.

// A URL/anchor-safe slug for a label (diagram node/region anchor keys, etc.).
export const nslug = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')

// The approximate progress (0..1) of an on-demand section generation. There is no exact
// percentage — one open-ended agent does the work — so it eases over two real signals:
// elapsed time while the pass reads, then the read→write transition (the server sends a
// `writing` phase on the pass's first output). Capped strictly below 1 until `ended`, so
// it never fabricates completion; the caller keeps it monotonic and renders the width.
export function genProgressEstimate({ elapsedS = 0, phase = 'reading', writeElapsedS = 0, ended = false } = {}) {
  if (ended) return 1
  if (phase === 'writing') return Math.min(0.97, 0.76 + 0.21 * (1 - Math.exp(-writeElapsedS / 9)))
  return Math.min(0.70, 0.04 + 0.66 * (1 - Math.exp(-elapsedS / 20)))
}

// Make a map that drifted from the schema safe to render, in place, once at load. The
// generator now refuses or normalises such maps (merge.mjs), but a map saved by an older
// run still opens here, and every template literal that interpolates a missing field
// prints "undefined", an object prints "[object Object]". Seen for real: groups with
// only { id, files } (every Files heading read "undefined") and ops.migrations as
// { name, note } objects. A nameless group falls back to its id; a missing role, tag or
// why to empty; an object list entry to its string fields joined.
export function normalizeMap(rm) {
  if (!rm || typeof rm !== 'object') return rm
  const str = (v) => typeof v === 'string' ? v : v == null ? '' : String(v)
  const line = (e) => e && typeof e === 'object' && !Array.isArray(e)
    ? Object.values(e).filter(v => typeof v === 'string' && v.trim()).join(' — ')
    : str(e)
  for (const g of Array.isArray(rm.groups) ? rm.groups : []) {
    if (!g || typeof g !== 'object') continue
    g.id = str(g.id)
    g.name = str(g.name).trim() || g.id
    g.role = str(g.role)
    g.why = str(g.why)
    if (g.tag != null) g.tag = str(g.tag)
    if (!Array.isArray(g.files)) g.files = []
  }
  if (rm.ops && typeof rm.ops === 'object') {
    for (const k of ['migrations', 'deploy']) if (Array.isArray(rm.ops[k])) rm.ops[k] = rm.ops[k].map(line)
  }
  return rm
}

// What git says happened to a file: added | modified | deleted | renamed. merge.mjs
// writes `status` from `git diff --name-status -M`; a map from before that falls
// back to the old isNew flag.
export function fileStatus(f) {
  const s = f && f.status
  if (s === 'added' || s === 'modified' || s === 'deleted' || s === 'renamed') return s
  return f && f.isNew ? 'added' : 'modified'
}

// A folder tree of repo paths, the IDE way: folders first, then files, each sorted by
// name; a folder whose only child is a folder is merged into one node
// ("app/src/api/middleware"), as IDEs' "compact folders" do, so a deep path costs one
// row instead of four. Nodes: { kind: 'dir', name, key, children } | { kind: 'file',
// name, path }. `key` is the folder's full path with a trailing slash — stable across
// renders, so a collapsed folder can be remembered.
export function buildFileTree(paths) {
  const root = { kind: 'dir', name: '', key: '', children: [] }
  for (const path of paths) {
    const parts = String(path).split('/')
    let node = root
    for (let i = 0; i < parts.length - 1; i++) {
      const key = parts.slice(0, i + 1).join('/') + '/'
      let next = node.children.find(c => c.kind === 'dir' && c.key === key)
      if (!next) { next = { kind: 'dir', name: parts[i], key, children: [] }; node.children.push(next) }
      node = next
    }
    if (!node.children.some(c => c.kind === 'file' && c.path === path)) node.children.push({ kind: 'file', name: parts[parts.length - 1], path })
  }
  const by = (a, b) => (a.kind === b.kind ? 0 : a.kind === 'dir' ? -1 : 1) || a.name.localeCompare(b.name, 'en', { numeric: true })
  const compact = (node) => {
    for (const c of node.children) if (c.kind === 'dir') compact(c)
    while (node.key && node.children.length === 1 && node.children[0].kind === 'dir') {
      const only = node.children[0]
      node.name = `${node.name}/${only.name}`
      node.key = only.key
      node.children = only.children
    }
    node.children.sort(by)
  }
  compact(root)
  return root.children
}

// Mermaid source for the storyboard — the plain-language picture of the change: cards
// (an icon by `kind`, a title, one sentence, a new/changed/removed tag, an optional
// warning) joined by labelled arrows. Mermaid lays it out and gives it everything the
// other diagrams have (zoom, fit, print, palette, notes, pop-out); the card body is an
// HTML label whose icon slot (.sbi[data-k]) the viewer fills after render.
// Every model-written string is escaped twice over: HTML (& < >) so it can never become
// markup, and mermaid's own entities (#35; #quot; #39;) so a quote or a "#" can never end
// the label early. `labels` are the tag words in the report language.
export const STORY_STATUSES = ['added', 'changed', 'removed', 'same']
export function storyboardMermaid(sb, labels = {}) {
  const cards = Array.isArray(sb?.cards) ? sb.cards : []
  const arrows = Array.isArray(sb?.arrows) ? sb.arrows : []
  const t = (v) => String(v ?? '').replace(/\s+/g, ' ').trim()
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/#/g, '#35;').replace(/"/g, '#quot;').replace(/'/g, '#39;')
  const tag = { added: labels.added || 'new', changed: labels.changed || 'changed', removed: labels.removed || 'removed' }
  const ids = new Map(cards.map((c, i) => [String(c.id), `sb${i}`]))
  const lines = [`flowchart ${cards.length > 5 ? 'TB' : 'LR'}`]
  cards.forEach((c, i) => {
    const kind = /^[a-z-]+$/.test(c.kind || '') ? c.kind : 'other'
    const st = STORY_STATUSES.includes(c.status) ? c.status : 'same'
    lines.push(`  sb${i}["<div class='sbc'><span class='sbi' data-k='${kind}'></span><div class='sbt'>` +
      `<b class='sbh'>${t(c.title)}</b>${st !== 'same' ? `<span class='sbtag'>${t(tag[st])}</span>` : ''}` +
      `<span class='sbx'>${t(c.text)}</span>` +
      (c.warning ? `<span class='sbw'><span class='sbi sbi-w' data-m='warning'></span>${t(c.warning)}</span>` : '') +
      `</div></div>"]`)
  })
  for (const a of arrows) {
    const from = ids.get(String(a.from)), to = ids.get(String(a.to))
    if (!from || !to) continue
    const op = a.status === 'removed' ? '-.->' : a.status === 'added' ? '==>' : '-->'
    lines.push(`  ${from} ${op}${a.label ? `|"${t(a.label)}"|` : ''} ${to}`)
  }
  cards.forEach((c, i) => {
    if (c.status === 'added' || c.status === 'changed' || c.status === 'removed') lines.push(`  class sb${i} ${c.status}`)
    const file = (c.files || []).find(p => typeof p === 'string' && !/["\\\n]/.test(p))
    if (file) lines.push(`  click sb${i} call whydiffOpen("${file}")`)
  })
  return lines.join('\n')
}
