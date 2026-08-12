import { contextBridge, ipcRenderer } from 'electron'

// The only bridge between the page and the main process. The renderer has no node
// access; it calls these, which invoke the IPC handlers in main/index.js.
contextBridge.exposeInMainWorld('api', {
  listProjects: () => ipcRenderer.invoke('projects:list'),
  addLocal: () => ipcRenderer.invoke('projects:addLocal'),
  addGithub: (url) => ipcRenderer.invoke('projects:addGithub', url),
  removeProject: (id) => ipcRenderer.invoke('projects:remove', id),
})
