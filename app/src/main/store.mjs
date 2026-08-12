import { readFileSync, writeFileSync, existsSync, mkdirSync, renameSync } from 'node:fs'
import { dirname } from 'node:path'

// The projects store — a picked project is remembered and listed on the next launch.
// Backed by a plain JSON file: zero native dependencies, so it builds and runs the
// same on macOS/Linux/Windows with no compile step (native better-sqlite3 segfaulted
// under this Node/Electron ABI, and Electron's bundled Node has no built-in sqlite).
// A real SQLite index earns its place in Phase 4 (querying analyses across projects),
// behind this same interface. Written as a factory over a file path so it runs — and
// is tested — under plain node, without Electron.
//
// A local project is unique by its path, a GitHub one by its URL; adding the same
// one again returns the existing row.
export function openStore(filePath) {
  mkdirSync(dirname(filePath), { recursive: true })
  let data = { seq: 0, projects: [] }
  if (existsSync(filePath)) {
    try {
      const parsed = JSON.parse(readFileSync(filePath, 'utf8'))
      if (parsed && Array.isArray(parsed.projects)) data = parsed
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
  }
}

// Derive a friendly name from a GitHub URL: the "owner/repo" tail, .git stripped.
export function repoNameFromUrl(url) {
  const m = String(url).replace(/\.git$/, '').match(/([^/:]+\/[^/]+)$/)
  return m ? m[1] : url
}
