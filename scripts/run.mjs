#!/usr/bin/env node
// Standalone whydiff runner — produce a change map for a repo + range headlessly,
// with no interactive Claude Code session.
//
//   node scripts/run.mjs <repo> [<base..head>] [options]
//
// It drives `claude -p "/whydiff <range>"` in the repo (the plugin's approve hook
// lets the pipeline run non-interactively — see docs/desktop-app.md, Phase 0), then
// validates the produced map against the real diff and assembles the portable HTML.
// This is the headless core a desktop host or a CI job builds on; it touches no app
// code.
//
// Options:
//   --plugin-dir <path>   where the whydiff plugin lives (default: this repo)
//   --claude-cmd <cmd>    the claude binary (default: claude)
//   --timeout <ms>        kill the run after this long (default: 900000)
//   --no-assemble         skip producing the standalone review-map.html
//   --quiet               don't print per-step progress
//
// Exit 0 on a valid map; 1 on a run/validate failure; 2 on a usage error.

import { spawn, execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { join, dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const rootDir = join(dirname(fileURLToPath(import.meta.url)), '..')
const argv = process.argv.slice(2)
const VALUE = new Set(['--plugin-dir', '--claude-cmd', '--timeout'])
const BOOL = new Set(['--no-assemble', '--quiet', '--full'])
const opts = {}
const positional = []
for (let i = 0; i < argv.length; i++) {
  const a = argv[i]
  if (VALUE.has(a)) opts[a] = argv[++i]
  else if (BOOL.has(a)) opts[a] = true
  else if (a.startsWith('--')) die(2, `unknown option ${a}`)
  else positional.push(a)
}
function die(code, msg) {
  console.error(msg)
  if (code === 2) console.error('usage: run.mjs <repo> [<base..head>] [--full] [--plugin-dir <path>] [--claude-cmd <cmd>] [--timeout <ms>] [--no-assemble] [--quiet]')
  process.exit(code)
}

const repo = positional[0]
if (!repo) die(2, 'a repo path is required')
const repoAbs = resolve(repo)
if (!existsSync(join(repoAbs, '.git'))) die(2, `not a git repository: ${repoAbs}`)
// No range means the working tree vs HEAD (staged + unstaged + untracked) — the same
// default `/whydiff` uses. A range ("HEAD~3", "main..feat", a SHA) is passed through.
const range = positional[1] || ''
const pluginDir = resolve(opts['--plugin-dir'] || rootDir)
const claudeCmd = opts['--claude-cmd'] || 'claude'
const timeout = Number(opts['--timeout'] || 900000)
const quiet = !!opts['--quiet']
const log = (s) => { if (!quiet) process.stderr.write(s + '\n') }

// ── drive the pipeline through `claude -p` ───────────────────────────────────
// Stream-json so we can show which pass is running rather than a silent wait on
// something that spends money. The plugin's own hook is what makes the pipeline's
// tool calls run without a prompt; nothing here bypasses permissions.
const runPipeline = () => new Promise((ok, no) => {
  const child = spawn(claudeCmd, [
    // "full" tells the skill to generate the optional passes (Summary, user stories,
    // standards, tests) up front, not leave them behind a Generate button.
    '-p', `/whydiff${range ? ` ${range}` : ''}${opts['--full'] ? ' full' : ''}`,
    '--plugin-dir', pluginDir,
    '--output-format', 'stream-json', '--verbose',
  ], { cwd: repoAbs, stdio: ['ignore', 'pipe', 'pipe'] })
  const kill = setTimeout(() => { child.kill('SIGKILL'); no(new Error(`timed out after ${Math.round(timeout / 1000)}s`)) }, timeout)
  let buf = '', err = '', result = null, isError = false
  child.stderr.on('data', (d) => { err += d })
  child.stdout.on('data', (d) => {
    buf += d
    const lines = buf.split('\n'); buf = lines.pop()
    for (const line of lines) {
      if (!line.trim()) continue
      let j; try { j = JSON.parse(line) } catch { continue }
      if (j.type === 'assistant') {
        for (const c of j.message?.content || []) {
          if (c.type !== 'tool_use') continue
          const hint = c.input?.subagent_type || c.input?.description || c.input?.command || c.input?.file_path || ''
          log(`  · ${c.name}${hint ? ` ${String(hint).replace(/\s+/g, ' ').slice(0, 70)}` : ''}`)
        }
      } else if (j.type === 'result') {
        result = String(j.result ?? '')
        isError = j.is_error || j.subtype !== 'success'
      }
    }
  })
  child.on('error', (e) => { clearTimeout(kill); no(new Error(`${claudeCmd} failed to start: ${e.message} (is Claude Code installed?)`)) })
  child.on('close', (code) => {
    clearTimeout(kill)
    if (code !== 0 || isError) return no(new Error(`the run failed${result ? `: ${result.slice(0, 300)}` : ` (exit ${code})`}${err ? ` — ${err.slice(0, 200)}` : ''}`))
    ok()
  })
})

const node = (script, ...a) => execFileSync('node', [join(rootDir, 'scripts', script), ...a], { stdio: ['ignore', 'inherit', 'inherit'] })

try {
  log(`whydiff: ${range || 'working tree'} in ${repoAbs}`)
  await runPipeline()

  const mapPath = join(repoAbs, '.whydiff', 'review-map.json')
  if (!existsSync(mapPath)) die(1, 'the run finished but produced no .whydiff/review-map.json')

  // Prove the map matches the real diff, not just that it is well-formed. The
  // pipeline validates internally too; re-checking here is the runner's contract.
  node('validate.mjs', mapPath, '--repo', repoAbs, ...(range ? ['--ref', range] : []))

  // The portable, shareable artifact (mermaid inlined) — what a host would hand on.
  if (!opts['--no-assemble']) node('assemble.mjs', mapPath, '--repo', repoAbs)

  const m = JSON.parse(readFileSync(mapPath, 'utf8'))
  const html = mapPath.replace(/\.json$/, '.html')
  console.log(`OK: ${Object.keys(m.files || {}).length} files, ${(m.groups || []).length} groups, ${(m.diagrams || []).length} diagrams`)
  console.log(`  map  ${mapPath}`)
  if (!opts['--no-assemble']) console.log(`  html ${html}`)
} catch (e) {
  die(1, `whydiff run failed: ${e.message}`)
}
