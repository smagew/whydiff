import { contextBridge, ipcRenderer } from 'electron'

// The only bridge between the page and the main process. The renderer has no node
// access; it calls these, which invoke the IPC handlers in main/index.js.
contextBridge.exposeInMainWorld('api', {
  listProjects: () => ipcRenderer.invoke('projects:list'),
  addLocal: () => ipcRenderer.invoke('projects:addLocal'),
  addGithub: (url) => ipcRenderer.invoke('projects:addGithub', url),
  removeProject: (id) => ipcRenderer.invoke('projects:remove', id),

  // Phase 3
  gitState: (repo) => ipcRenderer.invoke('project:gitState', repo),
  rangeForCommit: (repo, hash) => ipcRenderer.invoke('project:rangeForCommit', { repo, hash }),
  analyze: (repo, range) => ipcRenderer.invoke('project:analyze', { repo, range }),
  openMap: (repo, mapPath, title) => ipcRenderer.invoke('map:open', { repo, mapPath, title }),
  // Progress lines during an analyze; returns an unsubscribe fn.
  onAnalyzeProgress: (cb) => {
    const h = (_e, line) => cb(line)
    ipcRenderer.on('analyze:progress', h)
    return () => ipcRenderer.removeListener('analyze:progress', h)
  },
})
