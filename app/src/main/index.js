import { app, BrowserWindow, ipcMain, dialog } from 'electron'
import { join, basename, dirname } from 'node:path'
import { existsSync, statSync, mkdirSync, copyFileSync, rmSync } from 'node:fs'
import { openStore, repoNameFromUrl } from './store.mjs'
import { gitState, rangeForCommit, clone, fetchPrRange } from './git.mjs'
import { fetchPRs, parseRepo } from './github.mjs'
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

  // Saved analyses live under userData/analyses/<id>/ (the map + its HTML), indexed
  // by the store. A saved copy means a past analysis re-opens without re-running,
  // even if the repo's own .whydiff was cleaned.
  const analysesDir = join(app.getPath('userData'), 'analyses')

  // Open a saved analysis in its own window. The saved `review-map.html` is fully
  // self-contained, so we load it directly — no re-assembly, no server, no port; it
  // renders even if the repo has moved. (Serving via serve.mjs would re-read the
  // repo's files for the live ask/instruct panel and fail when they aren't there;
  // it stays as a fallback only when the HTML is somehow missing.)
  const openAnalysisWindow = async (id) => {
    const a = store.getAnalysis(id)
    if (!a) throw new Error('that analysis is gone')
    const dir = join(analysesDir, String(id))
    const html = join(dir, 'review-map.html')
    const json = join(dir, 'review-map.json')
    const project = store.getProject(a.projectId)
    const win = new BrowserWindow({ width: 1400, height: 900, backgroundColor: '#14161a', title: a.title || project?.name || 'whydiff', autoHideMenuBar: true })
    if (existsSync(html)) {
      win.loadFile(html)
    } else if (existsSync(json)) {
      const { url, stop } = await serveMap(project?.path || dir, json)
      mapServers.add(stop)
      win.loadURL(url)
      win.on('closed', () => { mapServers.delete(stop); stop() })
    } else {
      win.destroy()
      throw new Error('the saved map file is missing')
    }
  }

  // ── Phase 3: a local project's git state ────────────────────────────────────
  ipcMain.handle('project:gitState', (_e, repo) => gitState(repo))
  ipcMain.handle('project:rangeForCommit', (_e, { repo, hash }) => rangeForCommit(repo, hash))

  // Run whydiff for a range (empty = the working tree), streaming progress to the
  // window that asked, then save the map into the analyses index and return the
  // stored record.
  ipcMain.handle('project:analyze', async (e, { repo, range, projectId, kind, ref, title, full }) => {
    const onProgress = (line) => { if (!e.sender.isDestroyed()) e.sender.send('analyze:progress', line) }
    const { mapPath } = await runAnalysis(repo, range || '', { onProgress, full: full !== false })
    const rec = store.addAnalysis({ projectId, kind, ref: ref || '', title: title || '' })
    const dir = join(analysesDir, String(rec.id))
    mkdirSync(dir, { recursive: true })
    copyFileSync(mapPath, join(dir, 'review-map.json'))
    const html = mapPath.replace(/\.json$/, '.html')
    if (existsSync(html)) copyFileSync(html, join(dir, 'review-map.html'))
    return { analysis: rec }
  })

  // ── Phase 4: the analyses index ─────────────────────────────────────────────
  ipcMain.handle('analyses:forProject', (_e, projectId) => store.listAnalyses({ projectId }))
  // Latest across everything, each tagged with its project's name for the home list.
  ipcMain.handle('analyses:latest', (_e, limit = 8) => {
    return store.listAnalyses({ limit }).map(a => ({ ...a, projectName: store.getProject(a.projectId)?.name || '?' }))
  })
  ipcMain.handle('analysis:open', async (_e, id) => { await openAnalysisWindow(id); return true })
  ipcMain.handle('analysis:remove', (_e, id) => {
    const ok = store.removeAnalysis(id)
    if (ok) rmSync(join(analysesDir, String(id)), { recursive: true, force: true })
    return ok
  })

  // ── Phase 5: GitHub — clone on demand, list PRs, analyze one ─────────────────
  const clonesDir = join(app.getPath('userData'), 'clones')
  const cloneSlug = (url) => { const r = parseRepo(url); return (r ? `${r.owner}__${r.repo}` : url).replace(/[^a-zA-Z0-9._-]/g, '_') }
  const clonePathFor = (project) => join(clonesDir, cloneSlug(project.url))

  // Where a project's git actually lives, and whether it is ready. A local project
  // is itself; a GitHub one is its clone, once cloned.
  ipcMain.handle('project:resolve', (_e, project) => {
    if (project.kind === 'local') return { repo: project.path, cloned: existsSync(join(project.path, '.git')) }
    const repo = clonePathFor(project)
    return { repo, cloned: existsSync(join(repo, '.git')) }
  })

  ipcMain.handle('project:clone', async (e, project) => {
    const dest = clonePathFor(project)
    if (!existsSync(join(dest, '.git'))) {
      mkdirSync(clonesDir, { recursive: true })
      const onProgress = (line) => { if (!e.sender.isDestroyed()) e.sender.send('clone:progress', line) }
      await clone(project.url, dest, { onProgress })
    }
    return { repo: dest, state: await gitState(dest) }
  })

  ipcMain.handle('github:prs', (_e, project) => fetchPRs(project.url))
  ipcMain.handle('project:rangeForPr', (_e, { repo, number, baseRef }) => fetchPrRange(repo, number, baseRef))

  createWindow()
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow() })
})

app.on('before-quit', () => { for (const stop of mapServers) stop() })

app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit() })
