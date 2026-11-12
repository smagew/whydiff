#!/usr/bin/env node
// Merges the analysis passes' output files into review-map.json.
//
//   node scripts/merge.mjs --repo <path> [--ref <rev-or-range>] [--out <file.json>]
//
// Every agent writes its own JSON into <repo>/.whydiff/ (see agents/*.md), so the
// orchestrator never retypes an agent's answer — that retyping used to cost more
// than the whole merge. This script reads those files, re-collects the manifest
// from git (authoritative: files can appear while the run is in flight), reconciles
// the two, and writes the map.
//
// Inputs in <repo>/.whydiff/ — all optional except narrative.json and one classifier:
//   narrative.json         orchestrator-authored: meta, intent, story, ops?, embedFull?
//   classifier*.json       one file per classifier pass (sharded runs: several)
//   diagrammer.json        { diagrams }
//   illustrator.json       { storyboard }
//   standards.json         { standards, blastRadius }
//   tests.json             { tests }
//   stories.json           { userStories }
//
// Exits non-zero when the result would not validate, listing what is wrong.

import { readFileSync, writeFileSync, existsSync, readdirSync } from 'node:fs'
import { join, resolve, basename } from 'node:path'
import { collectManifest, validateStructure, crossCheckManifest, extractFragments, logTiming, WORKDIR } from './lib.mjs'

const args = process.argv.slice(2)
const opt = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : null }
const repo = resolve(opt('--repo') || '.')
const ref = opt('--ref') || undefined
const dir = join(repo, WORKDIR)
const out = opt('--out') || join(dir, 'review-map.json')

const die = (msg) => { console.error(msg); process.exit(1) }
const read = (name) => {
  const p = join(dir, name)
  if (!existsSync(p)) return null
  try { return JSON.parse(readFileSync(p, 'utf8')) } catch (e) { die(`- ${name}: JSON parse error: ${e.message}`) }
}

// ── inputs ────────────────────────────────────────────────────────────────────
const narrative = read('narrative.json')
if (!narrative) die(`- missing ${WORKDIR}/narrative.json (meta, intent, story — written by the orchestrator)`)

const shardNames = existsSync(dir)
  ? readdirSync(dir).filter(f => /^classifier.*\.json$/.test(f)).sort()
  : []
if (!shardNames.length) die(`- no ${WORKDIR}/classifier*.json found (the classifier pass writes its own output)`)
const shards = shardNames.map(n => ({ name: n, data: read(n) }))

const parts = {
  diagrams: read('diagrammer.json')?.diagrams || [],
  standards: read('standards.json')?.standards || [],
  blastRadius: read('standards.json')?.blastRadius || [],
  tests: read('tests.json')?.tests || null,
  userStories: read('stories.json')?.userStories || null,
  storyboard: read('illustrator.json')?.storyboard || null,
}
// Which optional passes actually ran — by whether their file exists, so a pass that
// ran and found nothing still counts as generated (and shows its empty result, not
// a Generate button). Lets the viewer offer to generate the rest on demand.
const SECTION_FILE = { standards: 'standards.json', tests: 'tests.json', stories: 'stories.json' }
const generated = Object.entries(SECTION_FILE).filter(([, f]) => read(f) != null).map(([s]) => s)

const S = {
  unclassifiedGroup: 'Not described by any pass',
  unclassified: 'No analysis pass described this file.',
  ...(narrative.strings || {}),
}

// ── the manifest is the authority ─────────────────────────────────────────────
const { rows, totals } = collectManifest(repo, ref)
const real = new Map(rows.map(r => [r[0], r]))

// ── files: union of the shards, deterministic fields from git ────────────────
const files = {}
const dupes = []
for (const { name, data } of shards) {
  for (const [path, f] of Object.entries(data.files || {})) {
    if (files[path]) dupes.push(`${path} (also in ${files[path].__from})`)
    files[path] = { ...f, __from: name }
  }
}
if (dupes.length) console.warn(`warning: ${dupes.length} file(s) described by more than one shard, last wins:\n  - ${dupes.join('\n  - ')}`)

// Drop what git no longer reports; take add/del/isNew from git, never from the model.
const dropped = []
for (const path of Object.keys(files)) {
  const row = real.get(path)
  if (!row) { dropped.push(path); delete files[path]; continue }
  files[path].add = row[1]
  files[path].del = row[2]
  if (row[3]) files[path].isNew = true; else delete files[path].isNew
  // What git says happened to the file — the viewer's A/M/D/R mark. Never the model's.
  files[path].status = row[4] || (row[3] ? 'added' : 'modified')
  if (row[5]) files[path].from = row[5]; else delete files[path].from
}
if (dropped.length) console.warn(`warning: ${dropped.length} described file(s) are not in the diff, dropped:\n  - ${dropped.join('\n  - ')}`)

// ── groups: metadata from the orchestrator, membership from the shards ────────
// Seeding from narrative.json keeps name/role/why authored once instead of once
// per shard, and keeps shards from describing the same group three different ways.
const GROUP_META = ['name', 'role', 'tag', 'why', 'collapsed']
const groups = []
const byId = new Map()
for (const g of narrative.groups || []) {
  const copy = { ...g, files: [...(g.files || [])] }
  byId.set(g.id, copy)
  groups.push(copy)
}
for (const { data } of shards) {
  for (const g of data.groups || []) {
    const seen = byId.get(g.id)
    if (!seen) { const copy = { ...g, files: [...(g.files || [])] }; byId.set(g.id, copy); groups.push(copy); continue }
    for (const p of g.files || []) if (!seen.files.includes(p)) seen.files.push(p)
    // The orchestrator's metadata wins; a shard only fills what it left out.
    for (const k of GROUP_META) if (seen[k] == null && g[k] != null) seen[k] = g[k]
  }
}

// Files git reports that no pass described: keep the map complete rather than
// silently short. Loud, because it usually means a shard missed its scope.
const undescribed = rows.map(r => r[0]).filter(p => !files[p])
if (undescribed.length) {
  const gid = 'unclassified'
  let g = byId.get(gid)
  if (!g) { g = { id: gid, name: S.unclassifiedGroup, role: 'plumbing', why: S.unclassified, collapsed: true, files: [] }; byId.set(gid, g); groups.push(g) }
  for (const path of undescribed) {
    const row = real.get(path)
    files[path] = { service: 'other', role: 'plumbing', add: row[1], del: row[2], ...(row[3] ? { isNew: true } : {}), status: row[4] || (row[3] ? 'added' : 'modified'), ...(row[5] ? { from: row[5] } : {}), why: S.unclassified }
    if (!g.files.includes(path)) g.files.push(path)
  }
  console.warn(`warning: ${undescribed.length} file(s) in the diff were not described by any pass, filed under "${gid}":\n  - ${undescribed.join('\n  - ')}`)
}

// Prune members that no longer exist, and hold every file to exactly one group
// (principle 1) — first claim wins. Groups left empty by either pass are dropped.
const groupOf = new Map()
for (const g of groups) {
  const own = []
  for (const p of g.files) {
    if (!files[p] || groupOf.has(p)) continue
    groupOf.set(p, g.id)
    own.push(p)
  }
  g.files = own
}
const liveGroups = groups.filter(g => g.files.length)

// ── frag/preview come from the patch, not from the model ─────────────────────
// These are verbatim source lines. A pass that retypes them spends its slowest
// resource — generation — on bytes already sitting on disk.
const anchors = {}
for (const [path, f] of Object.entries(files)) if (f.fragAnchor) anchors[path] = f.fragAnchor
const frags = extractFragments(repo, opt('--patch') || join(dir, 'diff.patch'), Object.keys(files), {
  anchors, skip: narrative.skip || [],
})
let anchoredHits = 0
for (const [path, f] of Object.entries(files)) {
  delete f.fragAnchor
  const got = frags[path]
  if (!got) { delete f.frag; delete f.preview; continue }
  f.frag = got.frag
  f.preview = got.preview
  if (anchors[path] && got.frag.some(l => l[1].includes(anchors[path]))) anchoredHits++
}
const anchorMisses = Object.keys(anchors).length - anchoredHits
if (anchorMisses > 0) console.warn(`warning: ${anchorMisses} fragAnchor(s) matched no hunk; those files got their first changed hunk instead`)

// ── edges: dedupe, keep only those whose both ends survived ──────────────────
const edges = []
const edgeSeen = new Set()
for (const { data } of shards) {
  for (const e of data.edges || []) {
    if (!Array.isArray(e) || e.length !== 3) continue
    if (!files[e[0]] || !files[e[1]]) continue
    const k = `${e[0]}\u0000${e[1]}`
    if (edgeSeen.has(k)) continue
    edgeSeen.add(k)
    edges.push(e)
  }
}

// ── ops: the orchestrator's version wins; otherwise concatenate the shards ───
const shardOps = shards.map(s => s.data.ops).filter(Boolean)
const rawOps = narrative.ops || {
  env: shardOps.flatMap(o => o.env || []),
  migrations: shardOps.flatMap(o => o.migrations || []),
  deploy: shardOps.flatMap(o => o.deploy || []),
  note: shardOps.map(o => o.note).filter(Boolean).join(' '),
}
// migrations/deploy are lists of strings (the schema, and what the viewer renders).
// An agent sometimes emits { name, note } objects instead — the viewer then printed
// "[object Object]". Nothing is lost by joining an object's string fields, so do it
// here rather than fail the run.
const asLine = (e) => e && typeof e === 'object' && !Array.isArray(e)
  ? Object.values(e).filter(v => typeof v === 'string' && v.trim()).join(' — ')
  : e
const ops = { ...rawOps }
for (const k of ['migrations', 'deploy']) if (Array.isArray(ops[k])) ops[k] = ops[k].map(asLine)

// ── storyboard: keep what is real, drop what is not ───────────────────────────
// A card's files are a drill-down, so a path the diff does not have is dropped (with a
// warning) rather than failing the run; so is an arrow to a card that does not exist.
// What cannot be repaired — fewer than two cards, nothing marked as changed — is left
// for validateStructure to refuse.
let storyboard = null
if (parts.storyboard && Array.isArray(parts.storyboard.cards)) {
  const sb = { ...parts.storyboard, cards: parts.storyboard.cards.map(c => ({ ...c, id: String(c.id) })), arrows: (parts.storyboard.arrows || []).map(a => ({ ...a, from: String(a.from), to: String(a.to) })) }
  const ids = new Set(sb.cards.map(c => c.id))
  const droppedFiles = [], droppedArrows = []
  for (const c of sb.cards) {
    const keep = (c.files || []).filter(p => files[p])
    droppedFiles.push(...(c.files || []).filter(p => !files[p]))
    if (keep.length) c.files = keep; else delete c.files
  }
  sb.arrows = sb.arrows.filter(a => (ids.has(a.from) && ids.has(a.to)) || (droppedArrows.push(a.label || `${a.from}→${a.to}`), false))
  if (droppedFiles.length) console.warn(`warning: storyboard cards named ${droppedFiles.length} file(s) not in the diff, dropped:\n  - ${droppedFiles.join('\n  - ')}`)
  if (droppedArrows.length) console.warn(`warning: storyboard arrows to no card, dropped: ${droppedArrows.join(', ')}`)
  storyboard = sb
}

// ── assemble ──────────────────────────────────────────────────────────────────
const intent = narrative.intent || shards.map(s => s.data.intent).find(Boolean)
// Summary (story) is a lazy pass now: a default run writes none, so story defaults
// to []. It arrives from the summariser (story.json), or — for back-compat — from
// an orchestrator/classifier that still authored one.
const story = read('story.json')?.story || narrative.story || shards.map(s => s.data.story).find(Boolean) || []
// Present story ⇒ mark it generated, so the viewer shows it rather than a Generate
// button. Tying this to content (not just a file) keeps the two in step.
if (Array.isArray(story) && story.length && !generated.includes('story')) generated.push('story')
const attentionFiles = narrative.attentionFiles
  ?? shards.reduce((n, s) => n + (s.data.attentionFiles || 0), 0)

for (const path of narrative.embedFull || []) {
  if (files[path]) files[path].embedFull = true
  else console.warn(`warning: embedFull lists ${path}, which is not in the map`)
}
for (const f of Object.values(files)) delete f.__from

const rm = {
  meta: {
    project: narrative.meta?.project || basename(repo),
    lang: narrative.meta?.lang || 'en',
    ref: narrative.meta?.ref || (ref || 'working tree'),
    generatedAt: narrative.meta?.generatedAt || new Date().toLocaleDateString('sv-SE'),
    title: narrative.meta?.title || '',
    stats: { ...totals, attentionFiles },
  },
  intent,
  story,
  groups: liveGroups,
  files,
  edges,
  ...(storyboard ? { storyboard } : {}),
  ...(parts.diagrams.length ? { diagrams: parts.diagrams } : {}),
  ...(parts.standards.length ? { standards: parts.standards } : {}),
  ...(parts.blastRadius.length ? { blastRadius: parts.blastRadius } : {}),
  ...(parts.tests ? { tests: parts.tests } : {}),
  ...(parts.userStories ? { userStories: parts.userStories } : {}),
  generated,
  ops,
  manifest: rows.map(r => [r[0], r[1], r[2], groupOf.get(r[0]) || 'unclassified', r[3]]),
}

// The same two checks validate.mjs runs, so a map merge.mjs wrote needs no second
// validate pass unless someone edits it afterwards.
// A group's name/role/why come from narrative.json `groups` (or a shard that wrote a
// full group object). When neither did — the orchestrator passed GROUPS: to the
// classifier, which rightly emitted { id, files }, then left `groups` out of the
// narrative — say exactly where the metadata belongs; the viewer would otherwise
// show the group with no heading.
const nameless = liveGroups.flatMap(g => ['name', 'role', 'why'].filter(k => typeof g[k] !== 'string' || !g[k].trim()).map(k => `group ${g.id}: no "${k}" — add { "id": "${g.id}", "name", "role", "why" } to "groups" in ${WORKDIR}/narrative.json (the list you passed the classifier as GROUPS:)`))
const errors = [...nameless, ...validateStructure(rm).filter(e => !/^\$\.groups\[\d+\]: missing required "(name|role|why)"$/.test(e)), ...crossCheckManifest(rm, repo, ref)]
if (errors.length) {
  console.error(errors.map(e => '- ' + e).join('\n'))
  console.error(`\nFAILED: the merged map has ${errors.length} error(s); nothing written`)
  process.exit(1)
}

writeFileSync(out, JSON.stringify(rm, null, 1))
logTiming(dir, 'map_written', { shards: shards.length, files: Object.keys(files).length })
console.log(`OK: ${out} (${shards.length} classifier shard(s), ${Object.keys(files).length} files, ${liveGroups.length} groups, ${edges.length} edges, ${parts.diagrams.length} diagrams${storyboard ? `, storyboard ${storyboard.cards.length} cards` : ''})`)
