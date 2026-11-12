#!/usr/bin/env node
// Deterministic grader for a whydiff review map: does the map get the MEANING of
// a known diff right — not merely its shape (validate.mjs owns the shape).
//
//   node evals/_lib/grade.mjs <review-map.json> <expect.json> [--repo <dir>] [--min <0..1>]
//
// Prints one line per check, then `SCORE <passed>/<total> = <fraction>`.
// Exit 0 when the fraction is >= --min (default 1), else 1; exit 2 on bad input.
//
// expect.json (every key optional except `files`):
//   files        the exact paths of the real diff — the map must cover these, no more
//   sameGroup    [[path, …], …]       each list must sit together in one group
//   splitGroups  [[path, path], …]    each pair must sit in DIFFERENT groups
//   roleIn       { path: [role, …] }  the group holding `path` must have one of these roles
//   env          { includes: [NAME…], exact: [NAME…] }  ops.env names
//   migrations   { min, max, mentions: [regex…] }        ops.migrations entries
//   diagrams     { kinds: [kind…], max }                 diagrams[].kind
//   mentions     [{ re, why }]   regex (case-insensitive) that must match the map's prose
//   absent       [{ re, why }]   regex that must NOT match the map's prose

import { readFileSync, existsSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const strip = (s) => String(s ?? '').replace(/<[^>]+>/g, '').replace(/&[a-z]+;/g, ' ')
// An ops entry is a string by schema, but a pass has emitted {name, note} objects;
// grade what an entry SAYS in either form.
const entry = (e) => strip(e && typeof e === 'object' ? Object.values(e).filter((v) => typeof v === 'string').join(' — ') : e)

// All human-readable text the map carries, flattened — what a reviewer reads.
export function prose(map) {
  const parts = [map.intent, map.meta?.title]
  for (const s of map.story || []) parts.push(s.step, s.link, s.text)
  for (const g of map.groups || []) parts.push(g.name, g.why, g.tag)
  for (const f of Object.values(map.files || {})) parts.push(f.role, f.why)
  for (const e of map.edges || []) parts.push(...e.slice(2))
  for (const d of map.diagrams || []) parts.push(d.title, d.caption)
  for (const s of map.standards || []) parts.push(s.finding, s.pattern)
  const ops = map.ops || {}
  for (const e of ops.env || []) parts.push(typeof e === 'string' ? e : `${e.name} ${e.status || ''} ${e.note || ''}`)
  parts.push(...(ops.migrations || []).map(entry), ...(ops.deploy || []).map(entry), ops.note)
  return parts.filter(Boolean).map(strip).join('\n')
}

const groupOf = (map, path) => (map.groups || []).find((g) => (g.files || []).includes(path))
const envNames = (map) => (map.ops?.env || []).map((e) => (typeof e === 'string' ? e.split(/[\s=:]/)[0] : e.name))

export function grade(map, expect, { repo } = {}) {
  const checks = []
  const check = (name, pass, detail = '') => checks.push({ name, pass: !!pass, detail })
  const diff = new Set(expect.files || [])

  // ── always-on: the map is about THIS diff ─────────────────────────────────
  const onMap = new Set((map.manifest || []).map((r) => (Array.isArray(r) ? r[0] : r.path)))
  const missing = [...diff].filter((p) => !onMap.has(p))
  const extra = [...onMap].filter((p) => !diff.has(p))
  check('covers every diff file', !missing.length, missing.length ? `missing: ${missing.join(', ')}` : '')
  check('lists no file outside the diff', !extra.length, extra.length ? `extra: ${extra.join(', ')}` : '')

  // A path the map points at must be in the diff, or at least exist in the repo.
  const referenced = new Set()
  for (const g of map.groups || []) for (const p of g.files || []) referenced.add(p)
  for (const e of map.edges || []) { referenced.add(e[0]); referenced.add(e[1]) }
  for (const p of Object.keys(map.files || {})) referenced.add(p)
  const phantom = [...referenced].filter((p) => p && !diff.has(p) && !(repo && existsSync(join(repo, p))))
  check('references no invented path', !phantom.length, phantom.length ? `phantom: ${phantom.join(', ')}` : '')

  const unlabeled = (map.edges || []).filter((e) => !strip(e[2]).trim())
  check('every edge says why', !unlabeled.length, unlabeled.length ? `${unlabeled.length} unlabeled` : '')

  // ── expectations about meaning ────────────────────────────────────────────
  for (const set of expect.sameGroup || []) {
    const ids = [...new Set(set.map((p) => groupOf(map, p)?.id ?? '∅'))]
    check(`same group: ${set.join(' + ')}`, ids.length === 1 && ids[0] !== '∅', `groups: ${ids.join(', ')}`)
  }
  for (const [a, b] of expect.splitGroups || []) {
    const ga = groupOf(map, a)?.id, gb = groupOf(map, b)?.id
    check(`different groups: ${a} | ${b}`, ga && gb && ga !== gb, `groups: ${ga} / ${gb}`)
  }
  for (const [path, roles] of Object.entries(expect.roleIn || {})) {
    const role = groupOf(map, path)?.role
    check(`role of ${path} ∈ {${roles.join(', ')}}`, roles.includes(role), `got: ${role}`)
  }
  if (expect.env) {
    const names = envNames(map)
    for (const n of expect.env.includes || []) check(`ops.env lists ${n}`, names.includes(n), `got: ${names.join(', ') || '∅'}`)
    if (expect.env.exact) {
      const want = [...expect.env.exact].sort().join(','), got = [...names].sort().join(',')
      check(`ops.env is exactly [${expect.env.exact.join(', ')}]`, want === got, `got: [${names.join(', ')}]`)
    }
  }
  if (expect.migrations) {
    const m = (expect.migrations.min ?? 0), x = expect.migrations.max
    const list = (map.ops?.migrations || []).map(entry)
    check(`ops.migrations count in [${m}, ${x ?? '∞'}]`, list.length >= m && (x == null || list.length <= x), `got: ${list.length}`)
    for (const re of expect.migrations.mentions || []) {
      check(`ops.migrations mentions /${re}/`, list.some((s) => new RegExp(re, 'i').test(s)))
    }
  }
  if (expect.diagrams) {
    const kinds = (map.diagrams || []).map((d) => d.kind)
    for (const k of expect.diagrams.kinds || []) check(`has a ${k} diagram`, kinds.includes(k), `got: ${kinds.join(', ') || '∅'}`)
    if (expect.diagrams.max != null) check(`at most ${expect.diagrams.max} diagram(s)`, kinds.length <= expect.diagrams.max, `got: ${kinds.length}`)
  }
  const text = prose(map)
  for (const { re, why } of expect.mentions || []) check(`says: ${why}`, new RegExp(re, 'is').test(text), `/${re}/`)
  for (const { re, why } of expect.absent || []) check(`does not claim: ${why}`, !new RegExp(re, 'is').test(text), `/${re}/`)

  const passed = checks.filter((c) => c.pass).length
  return { checks, passed, total: checks.length, score: checks.length ? passed / checks.length : 0 }
}

// ── CLI ─────────────────────────────────────────────────────────────────────
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2)
  const opt = (n) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : null }
  const [mapPath, expectPath] = args.filter((a, i) => !a.startsWith('--') && !args[i - 1]?.startsWith('--'))
  if (!mapPath || !expectPath) {
    console.error('usage: grade.mjs <review-map.json> <expect.json> [--repo <dir>] [--min <0..1>]')
    process.exit(2)
  }
  let map, expect
  try {
    map = JSON.parse(readFileSync(mapPath, 'utf8'))
    expect = JSON.parse(readFileSync(expectPath, 'utf8'))
  } catch (e) { console.error(`cannot read input: ${e.message}`); process.exit(2) }
  const r = grade(map, expect, { repo: opt('--repo') })
  for (const c of r.checks) console.log(`${c.pass ? 'PASS' : 'FAIL'}  ${c.name}${!c.pass && c.detail ? `  (${c.detail})` : ''}`)
  console.log(`SCORE ${r.passed}/${r.total} = ${r.score.toFixed(2)}`)
  process.exit(r.score >= Number(opt('--min') ?? 1) ? 0 : 1)
}
