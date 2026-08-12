import { app, BrowserWindow, ipcMain, dialog } from 'electron'
import { join, basename } from 'node:path'
import { existsSync, statSync } from 'node:fs'
import { openStore, repoNameFromUrl } from './store.mjs'
import { gitState, rangeForCommit } from './git.mjs'
import { runAnalysis, serveMap } from './whydiff.mjs'

let store
// Map windows and their servers, so closing a map window stops its `serve.mjs`.
const mapServers = new Set()

function createWindow() {
  const win = new BrowserWindow({
    width: 1100,
    height: 760,
    minWidth: 720,
    minHeight: 480,
    backgroundColor: '#14161a',
    show: false,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false, // the preload uses ipcRenderer via contextBridge; no node in the page
    },
  })
  win.once('ready-to-show', () => win.show())
  // In dev, electron-vite serves the renderer; in a build it's a file on disk.
  if (process.env.ELECTRON_RENDERER_URL) win.loadURL(process.env.ELECTRON_RENDERER_URL)
  else win.loadFile(join(__dirname, '../renderer/index.html'))
  return win
}

// A GitHub repo URL, roughly: https://github.com/owner/repo(.git) or the git@ form.
const isGithubUrl = (u) => /^(https?:\/\/github\.com\/|git@github\.com:)[^/:]+\/[^/]+/.test(String(u).trim())

app.whenReady().then(() => {
  store = openStore(join(app.getPath('userData'), 'projects.json'))

  ipcMain.handle('projects:list', () => store.listProjects())
  ipcMain.handle('projects:remove', (_e, id) => store.removeProject(id))

  // Add a local project by picking a folder. Phase 2 stores it; Phase 3 checks its
  // git state on select.
  ipcMain.handle('projects:addLocal', async () => {
    const r = await dialog.showOpenDialog({ properties: ['openDirectory'], title: 'Pick a project folder' })
    const path = r.canceled ? null : r.filePaths[0]
    if (!path) return null
    if (!existsSync(path) || !statSync(path).isDirectory()) throw new Error('not a folder')
    return store.addProject({ kind: 'local', path, name: basename(path) })
  })

  // Add a project by GitHub URL. Phase 5 clones it; here we just remember it.
  ipcMain.handle('projects:addGithub', (_e, url) => {
    const u = String(url || '').trim()
    if (!isGithubUrl(u)) throw new Error('that does not look like a GitHub repo URL')
    return store.addProject({ kind: 'github', url: u, name: repoNameFromUrl(u) })
  })

  // ── Phase 3: a local project's git state, run an analysis, view the map ──────
  ipcMain.handle('project:gitState', (_e, repo) => gitState(repo))
  ipcMain.handle('project:rangeForCommit', (_e, { repo, hash }) => rangeForCommit(repo, hash))

  // Run whydiff for a range (empty = the working tree), streaming progress to the
  // window that asked. Resolves with the produced map's path.
  ipcMain.handle('project:analyze', async (e, { repo, range }) => {
    const onProgress = (line) => { if (!e.sender.isDestroyed()) e.sender.send('analyze:progress', line) }
    return runAnalysis(repo, range || '', { onProgress })
  })

  // Serve a produced map and open it in its own window; stop the server when the
  // window closes.
  ipcMain.handle('map:open', async (_e, { repo, mapPath, title }) => {
    const { url, stop } = await serveMap(repo, mapPath)
    mapServers.add(stop)
    const win = new BrowserWindow({ width: 1400, height: 900, backgroundColor: '#14161a', title: title || 'whydiff', autoHideMenuBar: true })
    win.loadURL(url)
    win.on('closed', () => { mapServers.delete(stop); stop() })
    return true
  })

  createWindow()
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow() })
})

app.on('before-quit', () => { for (const stop of mapServers) stop() })

app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit() })
