import { contextBridge, ipcRenderer } from 'electron'

// The only bridge between the page and the main process. The renderer has no node
// access; it calls these, which invoke the IPC handlers in main/index.js.
contextBridge.exposeInMainWorld('api', {
  listProjects: () => ipcRenderer.invoke('projects:list'),
  addLocal: () => ipcRenderer.invoke('projects:addLocal'),
  addGithub: (url) => ipcRenderer.invoke('projects:addGithub', url),
  removeProject: (id) => ipcRenderer.invoke('projects:remove', id),

  // Phase 3 — git state + analyze
  // opts: { limit, ref } — which branch to walk and how many commits to show.
  gitState: (repo, opts) => ipcRenderer.invoke('project:gitState', repo, opts),
  // Another page of commits: { limit, skip, ref } → { commits, more }.
  moreCommits: (repo, opts) => ipcRenderer.invoke('project:moreCommits', { repo, ...(opts || {}) }),
  // { current, local: [...], remote: [...] } — the branches offered in the picker.
  branches: (repo) => ipcRenderer.invoke('project:branches', repo),
  // The diff range comparing two refs (base...head); throws on an unknown ref.
  compareRange: (repo, base, head) => ipcRenderer.invoke('project:compareRange', { repo, base, head }),
  rangeForCommit: (repo, hash) => ipcRenderer.invoke('project:rangeForCommit', { repo, hash }),
  // args: { repo, range, projectId, kind: 'working'|'commit'|'pr', ref, title }
  // Resolves { analysis } on success, or { cancelled: true } if the user cancelled.
  analyze: (args) => ipcRenderer.invoke('project:analyze', args),
  // Stop the running analysis (SIGTERM → SIGKILL). Returns true if there was one to stop.
  cancelAnalyze: () => ipcRenderer.invoke('analyze:cancel'),
  // { claude, git, node } → each is the resolved path or null. For the startup preflight banner.
  preflight: () => ipcRenderer.invoke('preflight:check'),
  // The full stdout+stderr of the last run (or null) — for the "Show log" button.
  lastRunLog: () => ipcRenderer.invoke('analyze:lastLog'),
  // Open the Claude Code install page (fixed URL).
  openClaudeInstall: () => ipcRenderer.invoke('open:claudeInstall'),
  // Progress lines during an analyze; returns an unsubscribe fn.
  onAnalyzeProgress: (cb) => {
    const h = (_e, line) => cb(line)
    ipcRenderer.on('analyze:progress', h)
    return () => ipcRenderer.removeListener('analyze:progress', h)
  },

  // Phase 4 — the analyses index
  analysesForProject: (projectId) => ipcRenderer.invoke('analyses:forProject', projectId),
  latestAnalyses: (limit) => ipcRenderer.invoke('analyses:latest', limit),
  // opts: { work } — work:true opens the map able to run a fix in a worktree (opt-in)
  openAnalysis: (id, opts) => ipcRenderer.invoke('analysis:open', id, opts),
  // Export a saved analysis to a self-contained HTML file (notes baked in); returns the
  // chosen path, or null if the user cancelled the save dialog.
  exportAnalysis: (id) => ipcRenderer.invoke('analysis:export', id),
  exportAnalysisPdf: (id, opts) => ipcRenderer.invoke('analysis:exportPdf', id, opts),
  removeAnalysis: (id) => ipcRenderer.invoke('analysis:remove', id),

  // Settings — a GitHub token kept in the OS keychain. The renderer never sees the
  // value: it can set/clear it and read whether one is stored.
  tokenStatus: () => ipcRenderer.invoke('settings:tokenStatus'),
  setToken: (token) => ipcRenderer.invoke('settings:setToken', token),
  clearToken: () => ipcRenderer.invoke('settings:clearToken'),

  // Appearance: 'system' | 'light' | 'dark'. Returns { preference, dark } — the stored
  // choice and what it currently resolves to.
  getTheme: () => ipcRenderer.invoke('theme:get'),
  setTheme: (preference) => ipcRenderer.invoke('theme:set', preference),

  // About / updates — the running version, a manual update check, and opening a release.
  appVersion: () => ipcRenderer.invoke('app:version'),
  checkUpdate: () => ipcRenderer.invoke('updates:check'),
  openRelease: (url) => ipcRenderer.invoke('updates:open', url),

  // Phase 5 — GitHub
  resolveProject: (project) => ipcRenderer.invoke('project:resolve', project),
  cloneProject: (project) => ipcRenderer.invoke('project:clone', project),
  listPRs: (project) => ipcRenderer.invoke('github:prs', project),
  rangeForPr: (repo, number, baseRef) => ipcRenderer.invoke('project:rangeForPr', { repo, number, baseRef }),
  onCloneProgress: (cb) => {
    const h = (_e, line) => cb(line)
    ipcRenderer.on('clone:progress', h)
    return () => ipcRenderer.removeListener('clone:progress', h)
  },
})

// A map window is launched with --whydiff-analysis-id=<id>. Inside it runs the viewer, whose
// content PDF button calls window.whydiff.exportPdf() to export THIS analysis with its notes
// as real PDF comments (the app has Chromium via Electron; the browser does not). Only exposed
// when the id is present, so it never appears in the main app window.
const _aid = (process.argv.find((a) => a.startsWith('--whydiff-analysis-id=')) || '').split('=')[1]
if (_aid) {
  contextBridge.exposeInMainWorld('whydiff', {
    exportPdf: (opts) => ipcRenderer.invoke('analysis:exportPdf', Number(_aid), opts || {}),
  })
}
