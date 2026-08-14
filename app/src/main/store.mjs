import { readFileSync, writeFileSync, existsSync, mkdirSync, renameSync } from 'node:fs'
import { dirname } from 'node:path'

// The projects store — a picked project is remembered and listed on the next launch.
// Backed by a plain JSON file: zero native dependencies, so it builds and runs the
// same on macOS/Linux/Windows with no compile step (native better-sqlite3 segfaulted
// under this Node/Electron ABI, and Electron's bundled Node has no built-in sqlite).
// It also indexes past analyses (Phase 4): which commit/range of which project was
// mapped, and when — enough to mark commits that have a map and to list the latest.
// Plain JSON handles this scale fine (a lookup is an array scan); SQLite would only
// earn its place if this ever grew large. Written as a factory over a file path so it
// runs — and is tested — under plain node, without Electron.
//
// A local project is unique by its path, a GitHub one by its URL; adding the same
// one again returns the existing row.
export function openStore(filePath) {
  mkdirSync(dirname(filePath), { recursive: true })
  let data = { seq: 0, projects: [], analyses: [] }
  if (existsSync(filePath)) {
    try {
      const parsed = JSON.parse(readFileSync(filePath, 'utf8'))
      if (parsed && Array.isArray(parsed.projects)) data = { analyses: [], ...parsed }
    } catch { /* a corrupt file starts empty rather than crashing the app */ }
  }
  const save = () => {
    const tmp = filePath + '.tmp'
    writeFileSync(tmp, JSON.stringify(data, null, 2))
    renameSync(tmp, filePath) // atomic-ish: never leave a half-written store
  }
  const nowISO = () => new Date().toISOString()
  // Newest first; id breaks ties so two added in the same millisecond stay ordered.
  const sorted = () => [...data.projects].sort((a, b) => b.added_at.localeCompare(a.added_at) || b.id - a.id)

  return {
    listProjects() { return sorted() },
    getProject(id) { return data.projects.find(p => p.id === id) || null },
    removeProject(id) {
      const before = data.projects.length
      data.projects = data.projects.filter(p => p.id !== id)
      if (data.projects.length === before) return false
      save(); return true
    },
    /**
     * Add (or return the existing) project. `kind` is 'local' (needs `path`) or
     * 'github' (needs `url`). Returns the stored row.
     */
    addProject({ kind, path = null, url = null, name }) {
      if (kind === 'local') {
        if (!path) throw new Error('a local project needs a path')
        const existing = data.projects.find(p => p.kind === 'local' && p.path === path)
        if (existing) return existing
        url = null
      } else if (kind === 'github') {
        if (!url) throw new Error('a github project needs a url')
        const existing = data.projects.find(p => p.kind === 'github' && p.url === url)
        if (existing) return existing
        path = null
      } else {
        throw new Error(`unknown project kind: ${kind}`)
      }
      const row = { id: ++data.seq, name: name || path || url, kind, path, url, added_at: nowISO() }
      data.projects.push(row)
      save()
      return row
    },

    // ── analyses index ──────────────────────────────────────────────────────
    // `ref` identifies what was mapped: a commit hash, a range like "main..feat",
    // "" for the working tree, or "pr:123". `kind` is 'working' | 'commit' | 'pr'.
    // The map itself is saved on disk by the caller under a dir derived from the id.
    addAnalysis({ projectId, kind, ref = '', title = '' }) {
      if (!data.projects.some(p => p.id === projectId)) throw new Error(`unknown project ${projectId}`)
      const row = { id: ++data.seq, projectId, kind, ref, title, created_at: nowISO() }
      data.analyses.push(row)
      save()
      return row
    },
    getAnalysis(id) { return data.analyses.find(a => a.id === id) || null },
    // Re-generating an analysis in place: keep its id/ref/title, just stamp it as
    // freshly produced (so it sorts to the top). The caller overwrites its files.
    touchAnalysis(id) {
      const a = data.analyses.find(x => x.id === id)
      if (!a) return null
      a.created_at = nowISO()
      save(); return a
    },
    removeAnalysis(id) {
      const before = data.analyses.length
      data.analyses = data.analyses.filter(a => a.id !== id)
      if (data.analyses.length === before) return false
      save(); return true
    },
    // Newest first; all analyses, or one project's, or the latest N across everything.
    listAnalyses({ projectId = null, limit = null } = {}) {
      let rows = data.analyses
      if (projectId != null) rows = rows.filter(a => a.projectId === projectId)
      rows = [...rows].sort((a, b) => b.created_at.localeCompare(a.created_at) || b.id - a.id)
      return limit ? rows.slice(0, limit) : rows
    },
    // The most recent analysis of a project for a given ref — for marking a commit
    // that already has a map. Returns the row or null.
    analysisForRef(projectId, ref) {
      return this.listAnalyses({ projectId }).find(a => a.ref === ref) || null
    },
  }
}

// Derive a friendly name from a GitHub URL: the "owner/repo" tail, .git stripped.
export function repoNameFromUrl(url) {
  const m = String(url).replace(/\.git$/, '').match(/([^/:]+\/[^/]+)$/)
  return m ? m[1] : url
}
