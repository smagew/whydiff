import { app, BrowserWindow, Menu, ipcMain, dialog, nativeTheme, safeStorage, screen, shell } from 'electron'
import { join, basename, dirname } from 'node:path'
import { existsSync, statSync, mkdirSync, copyFileSync, rmSync, writeFileSync, readFileSync } from 'node:fs'
import { openStore, repoNameFromUrl } from './store.mjs'
import { openSettings } from './settings.mjs'
import { gitState, moreCommits, listBranches, compareRange, rangeForCommit, clone, fetchPrRange } from './git.mjs'
import { fetchPRs, parseRepo } from './github.mjs'
import { runAnalysis, serveMap, reviewCounts, exportHtml } from './whydiff.mjs'
import { checkForUpdate } from './updates.mjs'
import { annotatePdf } from './pdf-annotate.mjs'
import { quickPath, resolvedPathAsync, whichBin } from './pathenv.mjs'
import { openWindowState } from './window-state.mjs'

let store
let settings
let winState
// The login shell's PATH, resolved off the critical path — awaited only by the things that
// must not guess (running an analysis, cloning, the preflight). See pathenv.mjs.
let pathReady = Promise.resolve(quickPath())
// The window paint colour for the current appearance, so a new window doesn't flash white
// on a dark desktop (or the reverse) before its stylesheet lands.
const REPO_URL = 'https://github.com/smagew/whydiff/'
const PAPER = { dark: '#14161a', light: '#f6f7f9' }
const paper = () => (nativeTheme.shouldUseDarkColors ? PAPER.dark : PAPER.light)
// Map windows and their servers, so closing a map window stops its `serve.mjs`.
const mapServers = new Set()
// The currently-running analysis child, so `analyze:cancel` can stop it. One run at a time
// (the UI disables starting another while one is in flight).
let analyzeChild = null
// A fresh loopback port per live map window (serve.mjs binds a fixed port); closing
// the window frees it, and we never reuse within a session.
let servePortSeq = 7800
const nextServePort = () => ++servePortSeq

// How to run the plugin's node scripts. Packaged, there is no separate `node`, so run
// them with Electron's own node (ELECTRON_RUN_AS_NODE); in dev, plain `node`. The
// child inherits process.env, whose PATH we widen at startup so `claude`/`git`
// resolve even when the app was launched from Finder.
const nodeCmd = () => (app.isPackaged ? process.execPath : 'node')
const nodeEnv = () => (app.isPackaged ? { ...process.env, ELECTRON_RUN_AS_NODE: '1' } : process.env)

function createWindow() {
  // Reopen where the user left off — unless that spot is off-screen now (an external
  // display went away), in which case fall back to the default size, centred.
  const place = winState.place(screen.getAllDisplays())
  const win = new BrowserWindow({
    ...place,
    minWidth: 720,
    minHeight: 480,
    backgroundColor: paper(),
    show: false,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false, // the preload uses ipcRenderer via contextBridge; no node in the page
    },
  })
  if (place.maximized) win.maximize()
  win.once('ready-to-show', () => win.show())
  // Save on the settle of a move/resize rather than on every pixel of the drag.
  let saveTimer = null
  const remember = () => { clearTimeout(saveTimer); saveTimer = setTimeout(() => winState.remember(win), 400) }
  for (const ev of ['resize', 'move', 'maximize', 'unmaximize']) win.on(ev, remember)
  win.on('close', () => { clearTimeout(saveTimer); winState.remember(win) })
  // In dev, electron-vite serves the renderer; in a build it's a file on disk.
  if (process.env.ELECTRON_RENDERER_URL) win.loadURL(process.env.ELECTRON_RENDERER_URL)
  else win.loadFile(join(__dirname, '../renderer/index.html'))
  return win
}

/**
 * Check for a newer build from the menu. A menu item conventionally answers in a dialog
 * rather than by changing the page — it can be invoked from any screen, including one with
 * no banner to show — so this is the whole interaction: up to date, a newer version with a
 * Download button, or a plain "could not check".
 */
async function checkUpdateFromMenu() {
  if (!app.isPackaged) {
    // In dev app.getVersion() is the source package.json, so every release looks newer.
    await dialog.showMessageBox({ type: 'info', message: 'Update checks run in the installed app.', detail: 'This is a development build.' })
    return
  }
  const r = await checkForUpdate({ currentVersion: app.getVersion(), platform: process.platform, arch: process.arch })
  if (!r) {
    await dialog.showMessageBox({ type: 'warning', message: "Couldn't check for updates.", detail: 'Check your connection and try again.' })
    return
  }
  if (!r.available) {
    await dialog.showMessageBox({ type: 'info', message: "You're on the latest version.", detail: `whydiff ${r.current}` })
    return
  }
  const { response } = await dialog.showMessageBox({
    type: 'info',
    message: `whydiff ${r.latest} is available.`,
    detail: `You have ${r.current}.`,
    buttons: ['Download', 'Later'],
    defaultId: 0,
    cancelId: 1,
  })
  if (response === 0) shell.openExternal(r.assetUrl || r.url)
}

// The application menu. Built from roles so editing, window management and the platform's own
// conventions stay intact; we add only what is ours — the update check (in the app menu on
// macOS, under Help elsewhere, which is where each platform's users look) and the repository.
function buildMenu() {
  const mac = process.platform === 'darwin'
  const checkItem = { label: 'Check for Updates…', click: () => checkUpdateFromMenu() }
  const repoItem = { label: 'whydiff on GitHub', click: () => shell.openExternal(REPO_URL) }
  const template = [
    ...(mac ? [{
      label: app.name,
      submenu: [
        { role: 'about' },
        { type: 'separator' },
        checkItem,
        { type: 'separator' },
        { role: 'services' },
        { type: 'separator' },
        { role: 'hide' }, { role: 'hideOthers' }, { role: 'unhide' },
        { type: 'separator' },
        { role: 'quit' },
      ],
    }] : []),
    { role: 'fileMenu' },
    { role: 'editMenu' },
    { role: 'viewMenu' },
    { role: 'windowMenu' },
    {
      role: 'help',
      submenu: mac ? [repoItem] : [checkItem, { type: 'separator' }, repoItem, { type: 'separator' }, { role: 'about' }],
    },
  ]
  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
}

// A GitHub repo URL, roughly: https://github.com/owner/repo(.git) or the git@ form.
const isGithubUrl = (u) => /^(https?:\/\/github\.com\/|git@github\.com:)[^/:]+\/[^/]+/.test(String(u).trim())

app.whenReady().then(() => {
  // Widen PATH so `claude`/`git` are found when launched from Finder, and point the
  // runner at the plugin bundled inside the app (in dev it uses the repo root). Asking the
  // login shell can take seconds on a heavy rc file, so the window opens on the quick PATH
  // and the real one lands when it lands — every path that spawns a tool awaits `pathReady`.
  process.env.PATH = quickPath()
  pathReady = resolvedPathAsync().then((p) => { process.env.PATH = p; return p })
  if (app.isPackaged) process.env.WHYDIFF_PLUGIN_DIR = join(process.resourcesPath, 'whydiff-plugin')

  store = openStore(join(app.getPath('userData'), 'projects.json'))
  settings = openSettings(join(app.getPath('userData'), 'settings.json'), safeStorage)
  winState = openWindowState(join(app.getPath('userData'), 'window.json'))
  buildMenu()

  // Appearance: 'system' (default) follows the OS, light/dark pin it. Electron drives the
  // renderer's `prefers-color-scheme` from themeSource, so the stylesheet needs no extra
  // wiring — and every window repaints its backdrop when the resolved scheme flips.
  nativeTheme.themeSource = settings.getTheme()
  nativeTheme.on('updated', () => {
    for (const w of BrowserWindow.getAllWindows()) if (!w.isDestroyed()) w.setBackgroundColor(paper())
  })
  ipcMain.handle('theme:get', () => ({ preference: settings.getTheme(), dark: nativeTheme.shouldUseDarkColors }))
  ipcMain.handle('theme:set', (_e, pref) => {
    const saved = settings.setTheme(pref)
    nativeTheme.themeSource = saved
    return { preference: saved, dark: nativeTheme.shouldUseDarkColors }
  })

  // Update notifier: check GitHub Releases for a newer app-v* build and let the
  // renderer show a banner. Only in a packaged build — in dev app.getVersion() is the
  // source package.json and every release looks newer. No auto-install (see updates.mjs).
  ipcMain.handle('app:version', () => app.getVersion())
  ipcMain.handle('updates:check', () => (app.isPackaged ? checkForUpdate({ currentVersion: app.getVersion(), platform: process.platform, arch: process.arch }) : null))
  ipcMain.handle('updates:open', (_e, url) => {
    // Only ever open this repo's own release pages — never an arbitrary URL.
    if (/^https:\/\/github\.com\/smagew\/whydiff\/releases\//.test(String(url || ''))) shell.openExternal(String(url))
  })
  // Open the Claude Code install page — a fixed URL (no renderer-supplied input), for the
  // preflight banner when `claude` is missing.
  ipcMain.handle('open:claudeInstall', () => shell.openExternal('https://claude.com/claude-code'))
  // The project's repository — the same fixed URL the Help menu opens.
  ipcMain.handle('open:github', () => shell.openExternal(REPO_URL))

  // Where a project's git actually lives: a local folder is itself; a GitHub project
  // is its on-demand clone under userData/clones/. Used for both live-mode serving
  // and the worktree "Do it".
  const clonesDir = join(app.getPath('userData'), 'clones')
  const cloneSlug = (url) => { const r = parseRepo(url); return (r ? `${r.owner}__${r.repo}` : url).replace(/[^a-zA-Z0-9._-]/g, '_') }
  const clonePathFor = (project) => join(clonesDir, cloneSlug(project.url))
  const repoForProject = (project) => (project?.kind === 'local' ? project.path : project ? clonePathFor(project) : null)
  const isGitRepo = (dir) => !!dir && existsSync(join(dir, '.git'))

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

  // Open a saved analysis in its own window — LIVE: serve the map through serve.mjs
  // so the ask / instruct / options panel works against the repo. If serve can't
  // start (repo gone, port trouble, …) fall back to the saved self-contained HTML,
  // which always renders but has an inert ask UI. (assemble/serve now degrade a
  // missing embed-file to a plain drill-down instead of crashing.)
  const openAnalysisWindow = async (id, { work = false } = {}) => {
    const a = store.getAnalysis(id)
    if (!a) throw new Error('that analysis is gone')
    const dir = join(analysesDir, String(id))
    const html = join(dir, 'review-map.html')
    const json = join(dir, 'review-map.json')
    const project = store.getProject(a.projectId)
    // Serve against the project's real git repo (local folder or GitHub clone) when it
    // is available; the saved analysis dir is the fallback. The journal (review.log.jsonl)
    // lands next to the map — i.e. in this per-analysis dir — so notes persist per analysis.
    const resolved = repoForProject(project)
    const repo = resolved && existsSync(resolved) ? resolved : dir
    // --work needs a real git repo to spin up the throwaway worktree; only honour the
    // opt-in when we actually have one, otherwise serve read-only.
    const canWork = work && isGitRepo(repo)
    const win = new BrowserWindow({
      width: 1400, height: 900, backgroundColor: paper(), title: a.title || project?.name || 'whydiff', autoHideMenuBar: true,
      // The viewer's in-content PDF button exports THIS analysis (notes → real PDF comments)
      // through the app; give the window the preload bridge and tell it which analysis it is.
      webPreferences: { preload: join(__dirname, '../preload/index.js'), sandbox: false, additionalArguments: ['--whydiff-analysis-id=' + id] },
    })

    const loadStatic = () => {
      if (existsSync(html)) { win.loadFile(html); return true }
      return false
    }
    if (existsSync(json)) {
      try {
        const { url, stop } = await serveMap(repo, json, { node: nodeCmd(), env: nodeEnv(), port: nextServePort(), work: canWork })
        mapServers.add(stop)
        win.on('closed', () => { mapServers.delete(stop); stop() })
        win.loadURL(url)
        return
      } catch (e) {
        if (loadStatic()) return // live failed — show the static map rather than nothing
        win.destroy()
        throw e
      }
    }
    if (loadStatic()) return
    win.destroy()
    throw new Error('the saved map is missing')
  }

  // ── Phase 3: a local project's git state ────────────────────────────────────
  // `opts` picks the branch to walk and how many commits to show; the same handler
  // serves the initial load and every refresh.
  ipcMain.handle('project:gitState', async (_e, repo, opts) => { await pathReady; return gitState(repo, opts || {}) })
  ipcMain.handle('project:moreCommits', async (_e, { repo, ...opts }) => { await pathReady; return moreCommits(repo, opts) })
  ipcMain.handle('project:branches', async (_e, repo) => { await pathReady; return listBranches(repo) })
  // A comparison of two refs (base...head) — the pipeline has always accepted an arbitrary
  // range; this is the UI finally being able to name one.
  ipcMain.handle('project:compareRange', async (_e, { repo, base, head }) => { await pathReady; return compareRange(repo, base, head) })
  ipcMain.handle('project:rangeForCommit', (_e, { repo, hash }) => rangeForCommit(repo, hash))

  // Run whydiff for a range (empty = the working tree), streaming progress to the
  // window that asked, then save the map into the analyses index and return the
  // stored record.
  const lastRunLog = join(app.getPath('userData'), 'last-run.log')
  ipcMain.handle('project:analyze', async (e, { repo, range, projectId, kind, ref, title, full, sections, analysisId }) => {
    const onProgress = (line) => { if (!e.sender.isDestroyed()) e.sender.send('analyze:progress', line) }
    await pathReady // the shell PATH may still be resolving; a run must not look for `claude` on a guess
    // Preflight: the whole run shells out to `claude` (and `git`). If either is missing, say so
    // up front with a fixable message instead of letting the runner die with a bare exit code.
    if (!whichBin('claude')) throw new Error('Claude Code (the `claude` command) was not found on your PATH. Install it from https://claude.com/claude-code, then reopen this app.')
    if (!whichBin('git')) throw new Error('`git` was not found on your PATH. Install git, then reopen this app.')
    try {
      const { mapPath } = await runAnalysis(repo, range || '', {
        onProgress, full: !!full, sections: sections || [], progressJson: true, node: nodeCmd(), env: nodeEnv(),
        logPath: lastRunLog, onChild: (c) => { analyzeChild = c },
      })
      // analysisId → regenerate that analysis in place (same id + dir, files overwritten);
      // otherwise record a new one. Fall back to a new record if the id is gone.
      const rec = (analysisId != null && store.touchAnalysis(analysisId)) || store.addAnalysis({ projectId, kind, ref: ref || '', title: title || '' })
      const dir = join(analysesDir, String(rec.id))
      mkdirSync(dir, { recursive: true })
      copyFileSync(mapPath, join(dir, 'review-map.json'))
      const html = mapPath.replace(/\.json$/, '.html')
      if (existsSync(html)) copyFileSync(html, join(dir, 'review-map.html'))
      return { analysis: rec }
    } catch (err) {
      if (err && err.cancelled) return { cancelled: true } // a user Cancel, not a failure
      throw err
    } finally {
      analyzeChild = null
    }
  })
  // Stop the running analysis. SIGTERM first (let the runner clean up its worktree/temp), then
  // SIGKILL if it ignores it. runAnalysis sees the signal-close and rejects as cancelled.
  ipcMain.handle('analyze:cancel', () => {
    const c = analyzeChild
    if (!c || c.killed) return false
    try { c.kill('SIGTERM') } catch {}
    setTimeout(() => { try { if (c && !c.killed) c.kill('SIGKILL') } catch {} }, 3000)
    return true
  })
  // Preflight the external CLIs the app drives, so the UI can warn before the main button is used.
  ipcMain.handle('preflight:check', async () => {
    await pathReady // answering from the quick PATH would report a false "not found"
    return {
      claude: whichBin('claude'),
      git: whichBin('git'),
      node: whichBin('node') || (nodeCmd() === process.execPath ? process.execPath : null),
    }
  })
  // The full stdout+stderr of the last run — for a "Show log" button (esp. after a failure).
  ipcMain.handle('analyze:lastLog', () => { try { return readFileSync(lastRunLog, 'utf8') } catch { return null } })

  // ── Phase 4: the analyses index ─────────────────────────────────────────────
  // Each analysis carries its review counts (notes + discussions from the journal beside
  // its map) so the lists can show how much conversation a report holds without opening it.
  const withCounts = (a) => reviewCounts(join(analysesDir, String(a.id))).then((counts) => ({ ...a, counts }))
  ipcMain.handle('analyses:forProject', (_e, projectId) => Promise.all(store.listAnalyses({ projectId }).map(withCounts)))
  // Latest across everything, each tagged with its project's name for the home list.
  ipcMain.handle('analyses:latest', (_e, limit = 8) => {
    return Promise.all(store.listAnalyses({ limit }).map(a => withCounts(a).then(x => ({ ...x, projectName: store.getProject(a.projectId)?.name || '?' }))))
  })
  ipcMain.handle('analysis:open', async (_e, id, opts) => { await openAnalysisWindow(id, opts || {}); return true })
  // Export a saved analysis as a self-contained HTML file WITH its notes baked in — the
  // shareable, offline, read-only review. Asks the user where to save; nothing is uploaded.
  ipcMain.handle('analysis:export', async (_e, id) => {
    const a = store.getAnalysis(id)
    if (!a) throw new Error('that analysis is gone')
    const dir = join(analysesDir, String(id))
    const mapJson = join(dir, 'review-map.json')
    if (!existsSync(mapJson)) throw new Error('the saved map is missing')
    const project = store.getProject(a.projectId)
    const resolved = repoForProject(project)
    const repo = resolved && existsSync(resolved) ? resolved : null
    const base = (a.title || project?.name || 'review').replace(/[^\w.-]+/g, '-').replace(/^-+|-+$/g, '') || 'review'
    const r = await dialog.showSaveDialog({ title: 'Export review as HTML', defaultPath: `${base}.html`, filters: [{ name: 'HTML', extensions: ['html'] }] })
    if (r.canceled || !r.filePath) return null
    await exportHtml(mapJson, dir, r.filePath, { repo, node: nodeCmd(), env: nodeEnv() })
    shell.showItemInFolder(r.filePath)
    return r.filePath
  })
  // Export a saved analysis as a PDF with the review NOTES as real PDF comment annotations
  // (the kind a reader shows in its Comments panel) and QUESTIONS as in-document links. We
  // serve the map, print it to PDF off-screen (Chromium printToPDF == the viewer's clean print
  // layout), then place a /Text comment at each note's real rendered position — read back out
  // of the produced PDF via a locator glyph, so it survives page breaks and diagram scaling.
  ipcMain.handle('analysis:exportPdf', async (_e, id, opts = {}) => {
    const a = store.getAnalysis(id)
    if (!a) throw new Error('that analysis is gone')
    const dir = join(analysesDir, String(id))
    const json = join(dir, 'review-map.json')
    if (!existsSync(json)) throw new Error('the saved map is missing')
    const project = store.getProject(a.projectId)
    const resolved = repoForProject(project)
    const repo = resolved && existsSync(resolved) ? resolved : dir
    const base = (a.title || project?.name || 'review').replace(/[^\w.-]+/g, '-').replace(/^-+|-+$/g, '') || 'review'
    const r = await dialog.showSaveDialog({ title: 'Export review as PDF', defaultPath: `${base}.pdf`, filters: [{ name: 'PDF', extensions: ['pdf'] }] })
    if (r.canceled || !r.filePath) return null
    const pdf = {} // annotate outcome: { expected, added, located, total, warns, error }
    const { url, stop } = await serveMap(repo, json, { node: nodeCmd(), env: nodeEnv(), port: nextServePort(), work: false })
    const win = new BrowserWindow({ show: false, width: 1400, height: 1000, webPreferences: { offscreen: false } })
    try {
      await win.loadURL(url)
      // Wait for the viewer's print API, then prepare the chosen scope for a clean print and
      // get back the note manifest (one locator token per annotated place).
      await win.webContents.executeJavaScript('new Promise((res)=>{const t=setInterval(()=>{if(window.__whydiffPreparePrint){clearInterval(t);res(1)}},50);setTimeout(()=>{clearInterval(t);res(0)},15000)})')
      const scope = { tab: opts.tab || null, all: !!opts.all, forComments: true }
      const manifest = await win.webContents.executeJavaScript(`window.__whydiffPreparePrint(${JSON.stringify(scope)})`)
      const pdfBuf = await win.webContents.printToPDF({
        pageSize: 'A4', landscape: false, printBackground: true, scale: 1,
        margins: { top: 0.4, bottom: 0.4, left: 0.4, right: 0.4 }, preferCSSPageSize: false, displayHeaderFooter: false,
      })
      // Add the note comments. If that step fails (e.g. pdfjs could not load) still save a
      // valid PDF — the clean layout with questions-as-links — but do NOT hide the failure: a
      // note that can't become a comment is otherwise dropped silently (the comment path does
      // not print footnotes). Capture the outcome so the caller can surface it.
      const notes = Array.isArray(manifest) ? manifest : []
      pdf.expected = notes.reduce((n, m) => n + (m.notes?.length || 0), 0)
      let finalBytes = pdfBuf
      const warns = []
      try {
        const res = await annotatePdf(pdfBuf, notes, { warn: (m) => warns.push(m) })
        finalBytes = res.bytes
        pdf.added = res.added; pdf.located = res.located; pdf.total = res.total
      } catch (e) {
        pdf.error = e?.stack || e?.message || String(e)
      }
      pdf.warns = warns
      writeFileSync(r.filePath, Buffer.from(finalBytes))
    } finally {
      if (!win.isDestroyed()) win.destroy()
      stop()
    }
    // Tell the user when comments were expected but not all landed — with the real reason,
    // instead of quietly shipping a comment-less PDF.
    if (pdf.expected > 0 && (pdf.error || (pdf.added || 0) < pdf.expected)) {
      const detail = pdf.error
        ? `Could not add comments:\n${pdf.error}`
        : `Placed ${pdf.added || 0} of ${pdf.expected} note comment(s) (found ${pdf.located || 0}/${pdf.total || 0} anchors in the PDF).\n${(pdf.warns || []).join('\n')}`
      dialog.showMessageBox({ type: 'warning', title: 'PDF saved without all comments', message: 'The PDF was saved, but some notes did not become PDF comments.', detail }).catch(() => {})
    }
    shell.showItemInFolder(r.filePath)
    return r.filePath
  })
  ipcMain.handle('analysis:remove', (_e, id) => {
    const ok = store.removeAnalysis(id)
    if (ok) rmSync(join(analysesDir, String(id)), { recursive: true, force: true })
    return ok
  })

  // ── Settings: a GitHub token in the OS keychain ─────────────────────────────
  // The renderer only learns whether a token is stored and whether the keychain works
  // — never the value. github:prs prefers the stored token over the env fallback.
  const githubToken = () => settings.getToken() || process.env.GITHUB_TOKEN || undefined
  ipcMain.handle('settings:tokenStatus', () => settings.tokenStatus())
  ipcMain.handle('settings:setToken', (_e, token) => settings.setToken(token))
  ipcMain.handle('settings:clearToken', () => settings.clearToken())

  // ── Phase 5: GitHub — clone on demand, list PRs, analyze one ─────────────────
  // Where a project's git actually lives, and whether it is ready. A local project
  // is itself; a GitHub one is its clone, once cloned.
  ipcMain.handle('project:resolve', (_e, project) => {
    if (project.kind === 'local') return { repo: project.path, cloned: existsSync(join(project.path, '.git')) }
    const repo = clonePathFor(project)
    return { repo, cloned: existsSync(join(repo, '.git')) }
  })

  ipcMain.handle('project:clone', async (e, project) => {
    await pathReady
    const dest = clonePathFor(project)
    if (!existsSync(join(dest, '.git'))) {
      mkdirSync(clonesDir, { recursive: true })
      const onProgress = (line) => { if (!e.sender.isDestroyed()) e.sender.send('clone:progress', line) }
      await clone(project.url, dest, { onProgress })
    }
    return { repo: dest, state: await gitState(dest) }
  })

  ipcMain.handle('github:prs', (_e, project) => fetchPRs(project.url, { token: githubToken() }))
  ipcMain.handle('project:rangeForPr', (_e, { repo, number, baseRef }) => fetchPrRange(repo, number, baseRef))

  createWindow()
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow() })
})

app.on('before-quit', () => { for (const stop of mapServers) stop() })

app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit() })
