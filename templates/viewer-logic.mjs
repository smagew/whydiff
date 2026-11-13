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

// ── translating a finished map ───────────────────────────────────────────────
// A translation never rewrites the map: it is a catalog of strings, keyed by WHERE each
// string sits, laid over the original at load. Only reader-facing prose is listed —
// paths, ids, code, refs, scopes and the mermaid syntax around a label never are — so a
// translated map has, by construction, the same files, groups, edges and diagrams.
// An id is the JSON array of the string's path (["files","src/a.ts","why"]); a mermaid
// label adds its segment index (["diagrams",0,"mermaid",3]).

// The lines of a mermaid source whose text is syntax, never a label.
const MM_SKIP = /^\s*(click|classDef|class|style|linkStyle|%%|direction)\b/
// Split a mermaid source into pieces; a piece with `tr: true` is a label a reader sees.
// Quoted labels anywhere ("…"); in a sequence diagram also the text after a message's
// colon, a participant's alias, a note and a block's title; in an ER diagram also an
// unquoted relation label. Joining every piece's text gives back the source exactly.
export function mermaidSegments(src) {
  const out = []
  // `q`: a bare label (an ER relation's) that must be quoted once it holds more than one word.
  const push = (t, tr = false, q = false) => { if (t) out.push(tr && t.trim() ? { t, tr: true, ...(q ? { q: true } : {}) } : { t }) }
  const lines = String(src).split('\n')
  const kind = (lines.find(l => l.trim()) || '').trim().split(/\s+/)[0]
  lines.forEach((line, li) => {
    const nl = li < lines.length - 1 ? '\n' : ''
    if (MM_SKIP.test(line)) return push(line + nl)
    let m
    if (kind === 'sequenceDiagram') {
      if ((m = line.match(/^(\s*(?:participant|actor)\s+\S+\s+as\s+)(.+?)(\s*)$/))) { push(m[1]); push(m[2], true); return push(m[3] + nl) }
      if ((m = line.match(/^(\s*(?:alt|else|opt|loop|par|and|critical|break)\s+)(.+?)(\s*)$/))) { push(m[1]); push(m[2], true); return push(m[3] + nl) }
      if ((m = line.match(/^(\s*(?:Note\s+(?:over|left of|right of)\s+[^:]+|[^:"]+?(?:-{1,2}>>|-{1,2}x|-{1,2}\)|-{1,2}>)[+-]?[^:]+):\s*)(.+?)(\s*)$/))) { push(m[1]); push(m[2], true); return push(m[3] + nl) }
      return push(line + nl)
    }
    if (kind === 'erDiagram' && (m = line.match(/^(\s*\S+\s+[|}o{.\-]+\s+\S+\s*:\s*)([^"\s].*?)(\s*)$/))) { push(m[1]); push(m[2], true, true); return push(m[3] + nl) }
    // Quoted labels: "…" (mermaid has no escaped quote inside one).
    let last = 0
    for (const q of line.matchAll(/"([^"\n]*)"/g)) {
      push(line.slice(last, q.index + 1))
      push(q[1], true)
      last = q.index + q[0].length - 1
    }
    push(line.slice(last) + nl)
  })
  return out
}

// A translated label must not break the syntax around it: no quote (it would close
// the label), no line break, no `;` (a statement separator in sequence text, and with it
// gone no `#name;` entity can form). <br/> stays — it is how a label breaks a line.
export const mmSafe = (s) => String(s).replace(/"/g, "'").replace(/\r?\n/g, ' ').replace(/;/g, ',')

const TEXT_PATHS = [
  ['meta', 'title'], ['intent'],
  ['story', '*', 'label'], ['story', '*', 'text'], ['story', '*', 'link'],
  ['groups', '*', 'name'], ['groups', '*', 'tag'], ['groups', '*', 'why'],
  ['files', '*', 'role'], ['files', '*', 'why'],
  ['edges', '*', 2], ['edges', '*', 3],
  ['diagrams', '*', 'title'], ['diagrams', '*', 'caption'],
  ['storyboard', 'title'], ['storyboard', 'caption'],
  ['storyboard', 'cards', '*', 'title'], ['storyboard', 'cards', '*', 'text'], ['storyboard', 'cards', '*', 'warning'],
  ['storyboard', 'arrows', '*', 'label'],
  ['standards', '*', 'finding'], ['standards', '*', 'pattern'],
  ['tests', 'summary'], ['tests', 'fixed', '*'], ['tests', 'gaps', '*'],
  ['userStories', 'summary'], ['userStories', 'stories', '*', 'actor'], ['userStories', 'stories', '*', 'story'], ['userStories', 'stories', '*', 'why'],
  ['ops', 'env', '*', 'note'], ['ops', 'migrations', '*'], ['ops', 'deploy', '*'], ['ops', 'note'],
  ['blastRadius', '*', 'why'],
]
function* walkPath(node, pattern, at = []) {
  if (!pattern.length) { yield [at, node]; return }
  if (node == null || typeof node !== 'object') return
  const [head, ...rest] = pattern
  const keys = head === '*' ? (Array.isArray(node) ? node.map((_, i) => i) : Object.keys(node)) : [head]
  for (const k of keys) if (k in node) yield* walkPath(node[k], rest, [...at, k])
}

// Every reader-facing string of a map, in a stable order: [{ id, text }].
export function translatableStrings(rm) {
  const out = []
  for (const p of TEXT_PATHS) {
    for (const [at, v] of walkPath(rm, p)) if (typeof v === 'string' && v.trim()) out.push({ id: JSON.stringify(at), text: v })
  }
  ;(Array.isArray(rm?.diagrams) ? rm.diagrams : []).forEach((d, i) => {
    if (typeof d?.mermaid !== 'string') return
    mermaidSegments(d.mermaid).forEach((s, k) => { if (s.tr) out.push({ id: JSON.stringify(['diagrams', i, 'mermaid', k]), text: s.t.trim() }) })
  })
  return out
}

// The text of <code>…</code> spans, which a translation must carry over verbatim.
const codeSpans = (s) => [...String(s).matchAll(/<code>([\s\S]*?)<\/code>/g)].map(m => m[1]).sort()
// A translation of `src` the map can take, or null. It keeps every code span, the
// diff marker an ER comment starts with ("+ added"), and is not empty.
export function acceptTranslation(src, text) {
  if (typeof text !== 'string' || !text.trim()) return null
  if (JSON.stringify(codeSpans(src)) !== JSON.stringify(codeSpans(text))) return null
  const mark = String(src).match(/^([+\-~]\s)/)
  if (mark && !text.startsWith(mark[1])) text = mark[1] + text.replace(/^[+\-~]\s*/, '')
  return text
}

// The map with a catalog laid over it — a deep copy; the original is untouched. A string
// the catalog lacks, or whose source changed since it was translated (a section
// regenerated), stays in the original language. `strings`: { id: { src, text } }.
export function applyTranslation(rm, strings) {
  const out = JSON.parse(JSON.stringify(rm))
  if (!strings || typeof strings !== 'object') return out
  const pick = (id, src) => {
    const e = strings[id]
    return e && e.src === src ? acceptTranslation(src, e.text) : null
  }
  for (const p of TEXT_PATHS) {
    for (const [at, v] of walkPath(out, p)) {
      if (typeof v !== 'string' || !v.trim()) continue
      const t = pick(JSON.stringify(at), v)
      if (t == null) continue
      let o = out
      for (const k of at.slice(0, -1)) o = o[k]
      o[at[at.length - 1]] = t
    }
  }
  ;(Array.isArray(out.diagrams) ? out.diagrams : []).forEach((d, i) => {
    if (typeof d?.mermaid !== 'string') return
    const segs = mermaidSegments(d.mermaid)
    let changed = false
    segs.forEach((s, k) => {
      if (!s.tr) return
      const t = pick(JSON.stringify(['diagrams', i, 'mermaid', k]), s.t.trim())
      if (t == null) return
      const lead = s.t.match(/^\s*/)[0], trail = s.t.match(/\s*$/)[0]
      s.t = lead + (s.q ? `"${mmSafe(t)}"` : mmSafe(t)) + trail
      changed = true
    })
    if (changed) { d.mermaidSource = d.mermaid; d.mermaid = segs.map(s => s.t).join('') }
  })
  return out
}

// The strings of `rm` a catalog does not cover yet (new, or changed since): what a
// translation run sends — so updating after a Generate pays only for the new text.
export function untranslated(rm, strings = {}) {
  return translatableStrings(rm).filter(({ id, text }) => !(strings[id] && strings[id].src === text && acceptTranslation(text, strings[id].text) != null))
}

// The viewer's own labels for a language it has no table for. Function-valued labels
// ("3 to read") become templates: called with placeholder tokens, translated with the
// tokens kept, and rebuilt as functions. A count label also keeps its n = 1 form.
const UI_TOK = (i) => `{${i}}`
export function uiTemplates(table) {
  const out = {}
  const walk = (o, at) => {
    for (const [k, v] of Object.entries(o)) {
      const id = at ? `${at}.${k}` : k
      if (typeof v === 'string') out[id] = v
      else if (typeof v === 'function') {
        const toks = Array.from({ length: Math.max(v.length, 1) }, (_, i) => UI_TOK(i))
        let many
        try { many = v(...toks) } catch { continue }
        if (typeof many !== 'string') continue
        out[id] = many
        try {
          const one = v(1, ...toks.slice(1))
          if (typeof one === 'string' && one !== many.replace('{0}', '1')) out[id + '#one'] = one.replace(/\b1\b/, '{0}')
        } catch {}
      } else if (v && typeof v === 'object' && !Array.isArray(v)) walk(v, id)
    }
  }
  walk(table, '')
  return out
}
// A label table for `lang`: English with every translated template laid over it.
export function uiTable(en, tpl = {}) {
  const fill = (s, args) => String(s).replace(/\{(\d+)\}/g, (_, i) => args[i] ?? '')
  const keepsTokens = (src, t) => JSON.stringify((String(src).match(/\{\d+\}/g) || []).sort()) === JSON.stringify((String(t).match(/\{\d+\}/g) || []).sort())
  const build = (o, at) => {
    const r = {}
    for (const [k, v] of Object.entries(o)) {
      const id = at ? `${at}.${k}` : k
      if (typeof v === 'string') r[k] = typeof tpl[id] === 'string' && tpl[id].trim() ? tpl[id] : v
      else if (typeof v === 'function') {
        const many = tpl[id], one = tpl[id + '#one']
        const src = uiTemplates({ x: v }).x
        if (typeof many !== 'string' || !keepsTokens(src, many)) { r[k] = v; continue }
        r[k] = (...args) => fill(args[0] === 1 && typeof one === 'string' ? one : many, args)
      } else if (v && typeof v === 'object' && !Array.isArray(v)) r[k] = build(v, id)
      else r[k] = v
    }
    return r
  }
  return build(en, '')
}

// Languages a report can be translated into, by their own names (the desktop app's
// Report language list). Any other BCP-47 tag still works through the API; it is shown
// by its code.
export const LANGUAGE_NAMES = {
  en: 'English', ru: 'Русский', uk: 'Українська', de: 'Deutsch', es: 'Español', fr: 'Français',
  pt: 'Português', it: 'Italiano', pl: 'Polski', tr: 'Türkçe', zh: '中文', ja: '日本語',
}
