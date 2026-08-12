import { spawn } from 'node:child_process'
import { join, resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

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
export function runAnalysis(repo, range, { onProgress, runScript, node = 'node', timeout = 1_800_000 } = {}) {
  return new Promise((resolveP, reject) => {
    const script = runScript || join(pluginDir(), 'scripts', 'run.mjs')
    // No range → the working tree (whydiff's default); pass only the repo then.
    const child = spawn(node, range ? [script, repo, range] : [script, repo], { stdio: ['ignore', 'pipe', 'pipe'] })
    const kill = setTimeout(() => { child.kill('SIGKILL'); reject(new Error(`analysis timed out after ${Math.round(timeout / 1000)}s`)) }, timeout)
    let out = '', errTail = '', ebuf = ''
    child.stderr.on('data', (d) => {
      errTail = (errTail + d).slice(-2000)
      ebuf += d
      const lines = ebuf.split('\n'); ebuf = lines.pop()
      for (const l of lines) { const t = l.trim(); if (t && onProgress) onProgress(t) }
    })
    child.stdout.on('data', (d) => { out += d })
    child.on('error', (e) => { clearTimeout(kill); reject(new Error(`could not start the runner: ${e.message}`)) })
    child.on('close', (code) => {
      clearTimeout(kill)
      if (code !== 0) return reject(new Error(`analysis failed (exit ${code})${errTail ? `: ${errTail.trim().split('\n').pop()}` : ''}`))
      resolveP({ mapPath: join(repo, '.whydiff', 'review-map.json'), summary: out.trim() })
    })
  })
}

/**
 * Serve a produced map via scripts/serve.mjs and resolve with its localhost URL (the
 * app loads that in a window) plus a `stop()` to end the server. The server prints
 * `whydiff serve: http://127.0.0.1:<port>/` on startup; we resolve on that line.
 */
export function serveMap(repo, mapPath, { serveScript, node = 'node', port, startTimeout = 20000 } = {}) {
  return new Promise((resolveP, reject) => {
    const script = serveScript || join(pluginDir(), 'scripts', 'serve.mjs')
    const args = [script, mapPath, '--repo', repo]
    if (port) args.push('--port', String(port))
    const child = spawn(node, args, { stdio: ['ignore', 'pipe', 'pipe'] })
    let out = '', done = false
    const stop = () => { try { child.kill('SIGKILL') } catch {} }
    const t = setTimeout(() => { if (!done) { stop(); reject(new Error('the map server did not start in time')) } }, startTimeout)
    child.stdout.on('data', (d) => {
      out += d
      const m = out.match(/https?:\/\/127\.0\.0\.1:\d+\//)
      if (m && !done) { done = true; clearTimeout(t); resolveP({ url: m[0], stop }) }
    })
    child.on('error', (e) => { if (!done) { clearTimeout(t); reject(new Error(`could not start the map server: ${e.message}`)) } })
    child.on('close', (code) => { if (!done) { clearTimeout(t); reject(new Error(`the map server exited (${code}) before it was ready`)) } })
  })
}
