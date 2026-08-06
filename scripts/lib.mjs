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
  // A story that cannot be tied to a diff file is a story the pass invented.
  for (const s of rm.userStories?.stories || []) {
    if (!s.story?.trim()) errors.push('userStories: story with empty text')
    if (!['delivered', 'partial', 'broken', 'regressed'].includes(s.status)) {
      errors.push(`userStories: bad status ${JSON.stringify(s.status)} for "${(s.story || '').slice(0, 40)}"`)
    }
    for (const p of s.files || []) if (!filePaths.has(p)) errors.push(`userStories: unknown file ${p}`)
  }
  return errors
}

function git(repo, args) {
  return execFileSync('git', ['-C', repo, ...args], {
    encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, stdio: ['pipe', 'pipe', 'pipe'],
  })
}

/**
 * The pipeline's own working directory. A run creates diff.patch, the agent
 * outputs and review-map.json inside it; when the repo does not .gitignore it,
 * git reports those as changes and the map ends up reviewing its own scratch.
 * Excluded on BOTH sides (manifest and cross-check), so the two always agree.
 */
export const WORKDIR = '.whydiff'
const isOwnArtifact = (path) => path === WORKDIR || path.startsWith(WORKDIR + '/')

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
  const kept = rows.filter(r => !isOwnArtifact(r[0]))
  rows.length = 0
  rows.push(...kept)
  rows.sort((a, b) => a[0].localeCompare(b[0]))
  const totals = {
    filesChanged: rows.filter(r => !r[3]).length,
    filesNew: rows.filter(r => r[3]).length,
    added: rows.reduce((s, r) => s + r[1], 0),
    deleted: rows.reduce((s, r) => s + r[2], 0),
  }
  return { rows, totals }
}

const FRAG_LINES = 12       // upper bound on a fragment
const FRAG_MIN_KEEP = 2     // a hunk with fewer changed lines is a weak candidate
const LINE_CHARS = 200      // a minified line must not blow up the map
const HUNK_SCAN_ANCHORED = 500  // how far into a hunk to look for a fragAnchor
const NEW_FILE_BYTES = 64 * 1024

const classify = (line) => (line[0] === '+' ? 'add' : line[0] === '-' ? 'del' : 'ctx')
const clip = (s) => (s.length > LINE_CHARS ? s.slice(0, LINE_CHARS - 1) + '…' : s)
const isComment = (s) => /^\s*(\/\/|\/\*|\*|#|--|<!--)/.test(s)

/**
 * How informative a hunk is. Changed code outweighs changed comments, and a hunk
 * that both removes and adds (a modification) beats a pure append of the same
 * size — the "first hunk" rule used to land on file-top boilerplate.
 */
function hunkScore(hunk) {
  let score = 0, adds = 0, dels = 0
  for (const [cls, text] of hunk) {
    if (cls === 'ctx') continue
    if (cls === 'add') adds++; else dels++
    score += isComment(text) ? 1 : 3
  }
  if (adds && dels) score += 6
  return score
}

/** A FRAG_LINES window over a hunk, starting a little before the line that matters. */
const window = (hunk, idx) => {
  const from = Math.max(0, Math.min(idx - 3, hunk.length - FRAG_LINES))
  return hunk.slice(from, from + FRAG_LINES)
}

/**
 * The 1–2 most substantive lines of a fragment, in their original order.
 * Real code first: a docblock is usually the longest thing in a hunk and the
 * least useful line to put on a file card.
 */
function pickPreview(frag) {
  for (const wantCode of [true, false]) {
    for (const cls of ['add', 'del', 'ctx']) {
      const idx = frag.map((_, i) => i).filter(i => frag[i][0] === cls && isComment(frag[i][1]) !== wantCode)
      if (!idx.length) continue
      const best = idx.sort((a, b) => frag[b][1].trim().length - frag[a][1].trim().length).slice(0, 2)
      return best.sort((a, b) => a - b).map(i => frag[i])
    }
  }
  return []
}

/**
 * Derives each file's `frag` and `preview` from the patch — the same lines a model
 * would otherwise retype into the map. `anchors` maps a path to a substring
 * (an identifier) whose hunk should win; `skip` lists generated/vendored paths
 * that get no fragment at all.
 *
 * Scans the patch once with an index walk rather than split('\n'): a truncated
 * dump or a vendored blob can make a single patch tens of megabytes.
 */
export function extractFragments(repo, patchPath, paths, { anchors = {}, skip = [] } = {}) {
  const want = new Set(paths)
  const skipped = new Set(skip)
  const out = {}
  const state = new Map()  // path -> { frag, anchored }

  if (patchPath && existsSync(patchPath)) {
    const buf = readFileSync(patchPath, 'utf8')
    let path = null, inHunk = false, hunk = []

    const flushHunk = () => {
      if (!path || !hunk.length) { hunk = []; return }
      const st = state.get(path)
      if (st && !st.anchored) {
        const anchor = anchors[path]
        const hit = anchor ? hunk.findIndex(l => l[1].includes(anchor)) : -1
        if (hit >= 0) {
          // A big hunk often buries the interesting line far below its first twelve.
          st.frag = window(hunk, hit)
          st.anchored = true
        } else if (hunk.filter(l => l[0] !== 'ctx').length >= FRAG_MIN_KEEP) {
          const score = hunkScore(hunk)
          if (score > st.score) {
            st.score = score
            // Start at the first changed line that is actual code — otherwise a
            // docblock above a new method fills the whole fragment.
            let head = hunk.findIndex(l => l[0] !== 'ctx' && !isComment(l[1]))
            if (head < 0) head = hunk.findIndex(l => l[0] !== 'ctx')
            st.frag = window(hunk, Math.max(head, 0))
          }
        }
      }
      hunk = []
    }

    for (let i = 0; i < buf.length;) {
      let nl = buf.indexOf('\n', i)
      if (nl === -1) nl = buf.length
      const line = buf.slice(i, nl)
      i = nl + 1

      if (line.startsWith('diff --git ')) {
        flushHunk()
        inHunk = false
        const m = / b\/(.*)$/.exec(line)
        path = m ? m[1] : null
        if (path && want.has(path) && !skipped.has(path)) state.set(path, { frag: [], anchored: false, score: 0 })
        else path = null
        continue
      }
      if (!path) continue
      if (line.startsWith('@@')) { flushHunk(); inHunk = true; continue }
      if (!inHunk) continue
      if (line.startsWith('+++') || line.startsWith('---') || line.startsWith('\\')) continue
      const c = line[0]
      if (c !== '+' && c !== '-' && c !== ' ') { flushHunk(); inHunk = false; continue }
      const text = line.slice(1)
      if (!text.trim()) continue
      // Scan further into the hunk when an anchor has to be found in it.
      const cap = anchors[path] ? HUNK_SCAN_ANCHORED : FRAG_LINES * 3
      if (hunk.length < cap) hunk.push([classify(line), clip(text)])
    }
    flushHunk()
  }

  for (const [path, st] of state) if (st.frag.length) out[path] = { frag: st.frag, preview: pickPreview(st.frag) }

  // Untracked files are absent from the patch — take their opening lines instead.
  for (const path of want) {
    if (out[path] || skipped.has(path)) continue
    let text
    try {
      const full = readFileSync(join(repo, path))
      if (full.includes(0)) continue                        // binary
      text = full.subarray(0, NEW_FILE_BYTES).toString('utf8')
    } catch { continue }
    const frag = []
    for (let i = 0; i < text.length && frag.length < FRAG_LINES;) {
      let nl = text.indexOf('\n', i)
      if (nl === -1) nl = text.length
      const line = text.slice(i, nl)
      i = nl + 1
      if (line.trim()) frag.push(['add', clip(line)])
    }
    if (frag.length) out[path] = { frag, preview: pickPreview(frag) }
  }
  return out
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
