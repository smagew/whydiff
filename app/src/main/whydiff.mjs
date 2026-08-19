import { spawn } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import { join, resolve, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

// The bridge to whydiff's own scripts — the runner (produces the map) and the server
// (renders it). The app drives them as child processes and reuses their output, so
// nothing about the pipeline or the viewer is reimplemented here.
const here = dirname(fileURLToPath(import.meta.url)) // app/src/main

// Where the plugin lives. In dev the app sits in the plugin repo (app/ → repo root);
// a packaged build sets WHYDIFF_PLUGIN_DIR to the bundled copy.
export const pluginDir = () => process.env.WHYDIFF_PLUGIN_DIR || resolve(here, '..', '..', '..')

/**
 * Run a whydiff analysis on `repo` for `range` via scripts/run.mjs. The runner
 * streams which pass is running to stderr; each line is handed to `onProgress`. On
 * success the map is at <repo>/.whydiff/review-map.json.
 */
export function runAnalysis(repo, range, { onProgress, onChild, logPath, runScript, node = 'node', env, timeout = 1_800_000, full = false, sections, progressJson = false } = {}) {
  return new Promise((resolveP, reject) => {
    const script = runScript || join(pluginDir(), 'scripts', 'run.mjs')
    // No range → the working tree (whydiff's default); pass only the repo then.
    const args = range ? [script, repo, range] : [script, repo]
    // Which optional passes to generate up front: full = all; a non-empty sections
    // list = just those; neither = core only (the rest stay one click away).
    if (full) args.push('--full')
    else if (sections && sections.length) args.push('--sections', sections.join(','))
    if (progressJson) args.push('--progress-json') // emit @stage markers for a host progress UI
    const child = spawn(node, args, { stdio: ['ignore', 'pipe', 'pipe'], env: env || process.env })
    onChild?.(child) // hand the child back so the caller can cancel the run (analyze:cancel)
    let timedOut = false
    const kill = setTimeout(() => { timedOut = true; child.kill('SIGKILL'); reject(new Error(`analysis timed out after ${Math.round(timeout / 1000)}s`)) }, timeout)
    let out = '', errTail = '', ebuf = '', fullErr = ''
    child.stderr.on('data', (d) => {
      fullErr += d
      errTail = (errTail + d).slice(-2000)
      ebuf += d
      const lines = ebuf.split('\n'); ebuf = lines.pop()
      for (const l of lines) { const t = l.trim(); if (t && onProgress) onProgress(t) }
    })
    child.stdout.on('data', (d) => { out += d })
    child.on('error', (e) => { clearTimeout(kill); reject(new Error(`could not start the runner: ${e.message}`)) })
    child.on('close', (code, signal) => {
      clearTimeout(kill)
      // Save the whole run for "Show log" — on success AND failure, so a failed run is never a
      // bare "exit 1" with no trace. Best-effort; a write error must not mask the run's result.
      if (logPath) { try { writeFileSync(logPath, `# whydiff run — repo=${repo} range=${range || '(working tree)'} full=${!!full} sections=${(sections || []).join(',')}\n# exit=${code} signal=${signal || ''}\n\n=== stderr (progress + errors) ===\n${fullErr}\n=== stdout ===\n${out}\n`) } catch { /* ignore */ } }
      if (timedOut) return // already rejected by the timeout
      // A signal-close that isn't the timeout means the caller killed it — a user cancel, not a
      // failure; surface it as such so the UI doesn't show a scary error.
      if (signal) { const e = new Error('analysis cancelled'); e.cancelled = true; return reject(e) }
      if (code !== 0) return reject(new Error(`analysis failed (exit ${code})${errTail ? `: ${errTail.trim().split('\n').pop()}` : ''}`))
      resolveP({ mapPath: join(repo, '.whydiff', 'review-map.json'), summary: out.trim() })
    })
  })
}

/**
 * Serve a produced map via scripts/serve.mjs and resolve with its localhost URL (the
 * app loads that in a window) plus a `stop()` to end the server. The server prints
 * a `http://127.0.0.1:<port>/` URL line on startup; we resolve on the first such URL. The
 * app passes --no-open so serve.mjs does not also open the system browser (the window
 * loads the URL itself).
 */
export function serveMap(repo, mapPath, { serveScript, node = 'node', env, port, work = false, startTimeout = 20000 } = {}) {
  return new Promise((resolveP, reject) => {
    const script = serveScript || join(pluginDir(), 'scripts', 'serve.mjs')
    // --no-open: the app loads the URL in its own window, so serve.mjs must NOT also pop
    // the system browser.
    const args = [script, mapPath, '--repo', repo, '--no-open']
    if (port) args.push('--port', String(port))
    // Opt-in: --work lets the map window work a task in a throwaway git worktree
    // (a real Claude run — tokens). The caller only asks for it when the user did.
    if (work) args.push('--work')
    const child = spawn(node, args, { stdio: ['ignore', 'pipe', 'pipe'], env: env || process.env })
    let out = '', err = '', done = false
    const stop = () => { try { child.kill('SIGKILL') } catch {} }
    const t = setTimeout(() => { if (!done) { stop(); reject(new Error('the map server did not start in time')) } }, startTimeout)
    child.stdout.on('data', (d) => {
      out += d
      const m = out.match(/https?:\/\/127\.0\.0\.1:\d+\//)
      if (m && !done) { done = true; clearTimeout(t); resolveP({ url: m[0], stop }) }
    })
    child.stderr.on('data', (d) => { err = (err + d).slice(-2000) })
    child.on('error', (e) => { if (!done) { clearTimeout(t); reject(new Error(`could not start the map server: ${e.message}`)) } })
    child.on('close', (code) => { if (!done) { clearTimeout(t); reject(new Error(`the map server exited (${code}) before it was ready${err ? `: ${err.trim().split('\n').pop()}` : ''}`)) } })
  })
}

/**
 * Export a saved analysis to a self-contained HTML file WITH its notes baked in — the
 * shareable, offline, read-only review. Runs scripts/assemble.mjs with --journal (the
 * analysis dir, where the review journal lives) and --repo (to embed full-file drill-downs
 * when the repo is on hand). Resolves the output path.
 */
export function exportHtml(mapPath, journalDir, outPath, { assembleScript, repo, node = 'node', env } = {}) {
  return new Promise((resolveP, reject) => {
    const script = assembleScript || join(pluginDir(), 'scripts', 'assemble.mjs')
    const args = [script, mapPath, '--out', outPath]
    if (journalDir) args.push('--journal', journalDir)
    if (repo) args.push('--repo', repo)
    const child = spawn(node, args, { stdio: ['ignore', 'pipe', 'pipe'], env: env || process.env })
    let err = ''
    child.stderr.on('data', (d) => { err = (err + d).slice(-2000) })
    child.on('error', (e) => reject(new Error(`could not start the exporter: ${e.message}`)))
    child.on('close', (code) => code === 0 ? resolveP(outPath)
      : reject(new Error(`export failed (exit ${code})${err ? `: ${err.trim().split('\n').pop()}` : ''}`)))
  })
}

// The plugin's review projection (scripts/review.mjs), imported lazily and once. It is
// import-safe — its CLI is guarded — and only uses node builtins, so it loads cleanly
// as an external ESM module in both dev and a packaged build.
let _reviewMod
async function reviewModule() {
  if (!_reviewMod) {
    const url = pathToFileURL(join(pluginDir(), 'scripts', 'review.mjs')).href
    _reviewMod = await import(/* @vite-ignore */ url)
  }
  return _reviewMod
}

/**
 * How much discussion a saved analysis carries, read from its review journal
 * (review.log.jsonl beside the map). Returns { notes, discussions, blocking } — pinned
 * remarks, distinct question/task threads, and how many of those still need attention
 * (unanswered questions + open or in-progress tasks). Null if the journal can't be read;
 * all-zero when there is none yet. Reuses the viewer's own projection so the numbers
 * match the map's Tasks tab exactly.
 */
export async function reviewCounts(dir) {
  try {
    const { readReview } = await reviewModule()
    const { state } = readReview(dir)
    const noteOf = new Map(state.notes.map((n) => [n.noteId, n]))
    const notes = state.notes.filter((n) => n.kind === 'note').length
    const discussions = Object.values(state.threads).filter((t) =>
      t.taskIds.length > 0 || t.noteIds.some((id) => noteOf.get(id)?.kind === 'question')).length
    return { notes, discussions, blocking: state.counts.blocking }
  } catch {
    return null
  }
}
