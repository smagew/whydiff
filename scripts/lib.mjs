// Shared helpers for the whydiff scripts.

import { execFileSync } from 'node:child_process'
import { readFileSync, appendFileSync, existsSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'

/**
 * Appends a timing event to <dir>/timing.jsonl. By default it only logs when
 * the file already exists (i.e. an instrumented run is in progress), so ad-hoc
 * script invocations — tests, examples — stay silent. timing.mjs passes
 * {create: true} to start the log.
 */
export function logTiming(dir, event, meta = {}, { create = false } = {}) {
  const file = join(dir, 'timing.jsonl')
  if (!create && !existsSync(file)) return
  mkdirSync(dir, { recursive: true })
  appendFileSync(file, JSON.stringify({ t: Date.now(), event, meta }) + '\n')
}

/**
 * Structural integrity checks for a review-map object (principle 5:
 * completeness is enforced by script, not by the LLM).
 * Returns an array of error strings; empty means valid.
 */
export function validateStructure(rm) {
  const errors = []
  for (const key of ['meta', 'intent', 'story', 'groups', 'files', 'edges', 'manifest']) {
    if (!rm[key]) errors.push(`missing required section: ${key}`)
  }
  if (errors.length) return errors

  const filePaths = new Set(Object.keys(rm.files))
  for (const row of rm.manifest) {
    if (!filePaths.has(row[0])) errors.push(`manifest: ${row[0]} is not described in files`)
  }
  const grouped = new Set(rm.groups.flatMap(g => g.files))
  for (const p of filePaths) if (!grouped.has(p)) errors.push(`file has no group: ${p}`)
  for (const g of rm.groups) {
    for (const p of g.files) if (!filePaths.has(p)) errors.push(`group ${g.id}: unknown file ${p}`)
  }
  for (const e of rm.edges) {
    if (!Array.isArray(e) || e.length !== 3) { errors.push(`edge is not a [from, to, why] triple: ${JSON.stringify(e)}`); continue }
    if (!filePaths.has(e[0])) errors.push(`edge: unknown source ${e[0]}`)
    if (!filePaths.has(e[1])) errors.push(`edge: unknown target ${e[1]}`)
  }
  for (const item of rm.story) {
    if (item.link) continue
    for (const p of item.files || []) if (!filePaths.has(p)) errors.push(`story: unknown file ${p}`)
  }
  for (const d of rm.diagrams || []) {
    if (!d.mermaid?.trim()) errors.push(`diagram "${d.title}": empty mermaid source`)
    for (const p of d.files || []) if (!filePaths.has(p)) errors.push(`diagram "${d.title}": unknown file ${p}`)
    for (const [, p] of (d.mermaid || '').matchAll(/whydiffOpen\("([^"]*)"\)/g)) {
      if (!filePaths.has(p)) errors.push(`diagram "${d.title}": click target is not a diff file: ${p}`)
    }
  }
  for (const s of rm.standards || []) {
    if (s.file && !filePaths.has(s.file)) errors.push(`standards: unknown file ${s.file} (use blastRadius for files outside the diff)`)
  }
  for (const p of rm.tests?.files || []) if (!filePaths.has(p)) errors.push(`tests: unknown file ${p}`)
  return errors
}

function git(repo, args) {
  return execFileSync('git', ['-C', repo, ...args], {
    encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, stdio: ['pipe', 'pipe', 'pipe'],
  })
}

/**
 * Collects the real diff manifest from git.
 * ref semantics: undefined → working tree vs HEAD (staged + unstaged + untracked);
 * otherwise any revision/range accepted by `git diff <ref>`.
 * Returns { rows: [[path, add, del, isNew]], totals }.
 */
export function collectManifest(repo, ref) {
  const rows = []
  const numstat = git(repo, ['diff', '--numstat', ...(ref ? [ref] : ['HEAD'])])
  for (const line of numstat.split('\n')) {
    if (!line.trim()) continue
    const [add, del, ...pathParts] = line.split('\t')
    const path = pathParts.join('\t')
    rows.push([path, add === '-' ? 0 : Number(add), del === '-' ? 0 : Number(del), false])
  }
  if (!ref) {
    // Untracked files are part of the change but invisible to `git diff`.
    const untracked = git(repo, ['ls-files', '--others', '--exclude-standard'])
    for (const path of untracked.split('\n')) {
      if (!path.trim()) continue
      let lines = 0
      // Untracked files are not in the index — count lines from disk.
      try { lines = (readFileSync(join(repo, path), 'utf8').match(/\n/g) || []).length } catch {}
      rows.push([path, lines, 0, true])
    }
  } else {
    // In a range, added files come through numstat; mark them as new.
    const status = git(repo, ['diff', '--name-status', ref])
    const added = new Set(status.split('\n').filter(l => l.startsWith('A')).map(l => l.split('\t').pop()))
    for (const row of rows) if (added.has(row[0])) row[3] = true
  }
  rows.sort((a, b) => a[0].localeCompare(b[0]))
  const totals = {
    filesChanged: rows.filter(r => !r[3]).length,
    filesNew: rows.filter(r => r[3]).length,
    added: rows.reduce((s, r) => s + r[1], 0),
    deleted: rows.reduce((s, r) => s + r[2], 0),
  }
  return { rows, totals }
}

/**
 * Compares a review-map manifest against the real git diff.
 * Returns error strings for missing/extra files (line counts are advisory).
 */
export function crossCheckManifest(rm, repo, ref) {
  const errors = []
  const real = collectManifest(repo, ref)
  const inMap = new Set(rm.manifest.map(r => r[0]))
  const inGit = new Set(real.rows.map(r => r[0]))
  for (const p of inGit) if (!inMap.has(p)) errors.push(`diff file missing from the map: ${p}`)
  for (const p of inMap) if (!inGit.has(p)) errors.push(`map lists a file that is not in the diff: ${p}`)
  return errors
}
