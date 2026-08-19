import { contextBridge, ipcRenderer } from 'electron'

// The only bridge between the page and the main process. The renderer has no node
// access; it calls these, which invoke the IPC handlers in main/index.js.
contextBridge.exposeInMainWorld('api', {
  listProjects: () => ipcRenderer.invoke('projects:list'),
  addLocal: () => ipcRenderer.invoke('projects:addLocal'),
  addGithub: (url) => ipcRenderer.invoke('projects:addGithub', url),
  removeProject: (id) => ipcRenderer.invoke('projects:remove', id),

  // Phase 3 — git state + analyze
  gitState: (repo) => ipcRenderer.invoke('project:gitState', repo),
  rangeForCommit: (repo, hash) => ipcRenderer.invoke('project:rangeForCommit', { repo, hash }),
  // args: { repo, range, projectId, kind: 'working'|'commit'|'pr', ref, title }
  analyze: (args) => ipcRenderer.invoke('project:analyze', args),
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
