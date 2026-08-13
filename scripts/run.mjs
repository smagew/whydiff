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
//   --full                generate every optional section up front
//   --sections <list>     generate only these optional sections up front (comma-
//                         separated ids: story, standards, tests, stories). The core
//                         passes (Code map, Diagrams, Ops) always run. Mutually
//                         exclusive with --full; omit both for a core-only run.
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
const VALUE = new Set(['--plugin-dir', '--claude-cmd', '--timeout', '--sections'])
const BOOL = new Set(['--no-assemble', '--quiet', '--full', '--progress-json'])
// The optional passes a caller may ask for by id (core passes always run).
const OPTIONAL_SECTIONS = new Set(['story', 'standards', 'tests', 'stories'])
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
  if (code === 2) console.error('usage: run.mjs <repo> [<base..head>] [--full | --sections <ids>] [--plugin-dir <path>] [--claude-cmd <cmd>] [--timeout <ms>] [--no-assemble] [--quiet]')
  process.exit(code)
}

// The optional sections requested up front, as a clean list of known ids. --full is
// the shorthand for all of them; --sections names a subset. The skill reads this from
// the prompt and spawns exactly those optional passes (plus the always-on core).
let sections = []
if (opts['--sections']) {
  if (opts['--full']) die(2, '--sections and --full are mutually exclusive')
  sections = opts['--sections'].split(',').map(s => s.trim()).filter(Boolean)
  const bad = sections.filter(s => !OPTIONAL_SECTIONS.has(s))
  if (bad.length) die(2, `unknown section(s): ${bad.join(', ')} (valid: ${[...OPTIONAL_SECTIONS].join(', ')})`)
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

// Structured stage progress for a host UI (the desktop app renders a bar from these).
// Off by default so CLI output stays the human `· step` stream; the app opts in with
// --progress-json. One line per transition: `@stage {"stage":"…","status":"start|done"}`.
// Stage ids are the pass names (classifier, diagrammer, summariser, …) plus prepare,
// merge and assemble — so the host shows exactly the passes this run actually spawned.
const progressJson = !!opts['--progress-json']
const stage = (name, status) => { if (progressJson) process.stderr.write(`@stage ${JSON.stringify({ stage: name, status })}\n`) }

// ── drive the pipeline through `claude -p` ───────────────────────────────────
// Stream-json so we can show which pass is running rather than a silent wait on
// something that spends money. The plugin's own hook is what makes the pipeline's
// tool calls run without a prompt; nothing here bypasses permissions.
const runPipeline = () => new Promise((ok, no) => {
  // Tell the skill which optional passes to generate up front: "full" = all of them;
  // "sections:<ids>" = just those; neither = core only (the rest stay one click away).
  const want = opts['--full'] ? ' full' : sections.length ? ` sections:${sections.join(',')}` : ''
  const child = spawn(claudeCmd, [
    '-p', `/whydiff${range ? ` ${range}` : ''}${want}`,
    '--plugin-dir', pluginDir,
    '--output-format', 'stream-json', '--verbose',
  ], { cwd: repoAbs, stdio: ['ignore', 'pipe', 'pipe'] })
  const kill = setTimeout(() => { child.kill('SIGKILL'); no(new Error(`timed out after ${Math.round(timeout / 1000)}s`)) }, timeout)
  let buf = '', err = '', result = null, isError = false
  // Preparation (gather + reading the diff) runs before the first pass is spawned;
  // close it out when the first agent Task appears. `inflight` maps a tool_use id to
  // the stage it started, so its tool_result closes that stage.
  stage('prepare', 'start')
  let prepareDone = false
  const inflight = new Map()
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
          // A pass (a Task subagent) or the merge step — the stages a host UI shows.
          let name = null
          if (c.name === 'Task') name = String(c.input?.subagent_type || 'analyze').replace(/^whydiff:/, '')
          else if (c.name === 'Bash' && /\bmerge\.mjs\b/.test(String(c.input?.command || ''))) name = 'merge'
          if (name) {
            if (!prepareDone) { stage('prepare', 'done'); prepareDone = true }
            stage(name, 'start')
            if (c.id) inflight.set(c.id, name)
          }
        }
      } else if (j.type === 'user') {
        // Tool results close the stage that opened them (agents run in parallel, so
        // several can be in flight at once).
        for (const c of j.message?.content || []) {
          if (c.type === 'tool_result' && inflight.has(c.tool_use_id)) { stage(inflight.get(c.tool_use_id), 'done'); inflight.delete(c.tool_use_id) }
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

// Use the SAME runtime that is executing this script (process.execPath) for the
// sub-steps, not a literal `node` — a packaged host may run us with Electron's node
// (ELECTRON_RUN_AS_NODE, inherited via env), where no separate `node` is on PATH.
const node = (script, ...a) => execFileSync(process.execPath, [join(rootDir, 'scripts', script), ...a], { stdio: ['ignore', 'inherit', 'inherit'], env: process.env })

try {
  log(`whydiff: ${range || 'working tree'} in ${repoAbs}`)
  await runPipeline()

  const mapPath = join(repoAbs, '.whydiff', 'review-map.json')
  if (!existsSync(mapPath)) die(1, 'the run finished but produced no .whydiff/review-map.json')

  // Prove the map matches the real diff, not just that it is well-formed. The
  // pipeline validates internally too; re-checking here is the runner's contract.
  node('validate.mjs', mapPath, '--repo', repoAbs, ...(range ? ['--ref', range] : []))

  // The portable, shareable artifact (mermaid inlined) — what a host would hand on.
  if (!opts['--no-assemble']) {
    stage('assemble', 'start')
    node('assemble.mjs', mapPath, '--repo', repoAbs)
    stage('assemble', 'done')
  }

  const m = JSON.parse(readFileSync(mapPath, 'utf8'))
  const html = mapPath.replace(/\.json$/, '.html')
  console.log(`OK: ${Object.keys(m.files || {}).length} files, ${(m.groups || []).length} groups, ${(m.diagrams || []).length} diagrams`)
  console.log(`  map  ${mapPath}`)
  if (!opts['--no-assemble']) console.log(`  html ${html}`)
} catch (e) {
  die(1, `whydiff run failed: ${e.message}`)
}
