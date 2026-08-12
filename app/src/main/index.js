import { app, BrowserWindow, ipcMain, dialog } from 'electron'
import { join, basename } from 'node:path'
import { existsSync, statSync } from 'node:fs'
import { openStore, repoNameFromUrl } from './store.mjs'

let store

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

  createWindow()
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow() })
})

app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit() })
