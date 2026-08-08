#!/usr/bin/env node
// PreToolUse hook: auto-approves the whydiff pipeline's own operations so a run
// does not need a permission prompt for every step. Anything it does not
// recognise produces no output, which defers to the normal permission flow.
//
// A /whydiff run drives the shell in chains (`a && b | c`), reads the diff with
// the usual text tools, and writes intermediate files into temp dirs. So the Bash
// check parses the command quote-aware, splits it into segments on `&&`, `||`,
// `;` and `|`, and approves only when EVERY segment is safe:
//
//   - the plugin's own scripts:      node <plugin-root>/scripts/<x>.mjs …
//   - read-only git:                 git [-C dir] diff|log|show|ls-files|status|rev-parse
//   - read-only PR fetch:            gh pr diff|view
//   - the working directory:         mkdir -p <…>/.whydiff
//   - opening the built map:         open <…>/.whydiff/<…>.html
//   - read-only text tools:          cat sed(no -i) awk head tail wc grep rg nl cut
//                                    sort uniq tr jq diff cd echo ls comm column printf
//
// A write redirect (`>`/`>>`) is allowed ONLY into a temp location: a `.whydiff/`
// directory, a `scratchpad/`, or `/tmp`, `/private/tmp`, `/var/folders`
// (resolved against any preceding `cd`). Never into source. Command substitution
// (`$(…)`, backticks) outside single quotes, a background `&`, `sed -i`, and any
// reference to a sensitive path (`~/.ssh`, `id_rsa`, `.pem`, …) all defer.
//
//   Write/Edit: files inside a .whydiff/ directory   (the pipeline's outputs)
//   Task: the plugin's own bundled agents (whydiff:*) — the analysis passes

import { resolve } from 'node:path'

const READ_CMDS = new Set([
  'cat', 'sed', 'awk', 'head', 'tail', 'wc', 'grep', 'egrep', 'fgrep', 'rg',
  'nl', 'cut', 'sort', 'uniq', 'tr', 'jq', 'diff', 'echo', 'ls', 'comm',
  'column', 'printf', 'basename', 'dirname', 'true',
])
const GIT_READ = new Set(['diff', 'log', 'show', 'ls-files', 'status', 'rev-parse'])
const SENSITIVE = /(\/\.ssh\/|\/\.aws\/|\/\.gnupg\/|\/\.config\/gcloud|id_rsa|id_ed25519|\.pem(\b|$))/

// Split a command into simple-command segments, quote-aware. Returns { defer }
// when the command has a construct we will not reason about (command
// substitution outside single quotes, a background `&`, unbalanced quotes).
function splitSegments(cmd) {
  let st = 'n' // n normal · s single-quote · d double-quote
  const segs = []
  let cur = ''
  for (let i = 0; i < cmd.length; i++) {
    const c = cmd[i], d = cmd[i + 1]
    if (st === 's') { if (c === "'") st = 'n'; cur += c; continue }
    if (st === 'd') {
      if (c === '`') return { defer: true }
      if (c === '$' && d === '(') return { defer: true }
      if (c === '"') st = 'n'
      cur += c; continue
    }
    if (c === "'") { st = 's'; cur += c; continue }
    if (c === '"') { st = 'd'; cur += c; continue }
    if (c === '`') return { defer: true }
    if (c === '$' && d === '(') return { defer: true }
    if (c === '&' && d === '&') { segs.push(cur); cur = ''; i++; continue }
    if (c === '|' && d === '|') { segs.push(cur); cur = ''; i++; continue }
    if (c === '&') return { defer: true } // background
    if (c === '|' || c === ';') { segs.push(cur); cur = ''; continue }
    cur += c
  }
  if (st !== 'n') return { defer: true } // unbalanced quotes
  segs.push(cur)
  return { defer: false, segments: segs.map((s) => s.trim()).filter(Boolean) }
}

// Split a segment into words, quote-aware, with the quotes removed.
function tokenize(s) {
  const toks = []
  let cur = '', has = false, st = 'n'
  for (let i = 0; i < s.length; i++) {
    const c = s[i]
    if (st === 's') { if (c === "'") st = 'n'; else cur += c; has = true; continue }
    if (st === 'd') { if (c === '"') st = 'n'; else cur += c; has = true; continue }
    if (c === "'") { st = 's'; has = true; continue }
    if (c === '"') { st = 'd'; has = true; continue }
    if (/\s/.test(c)) { if (has) { toks.push(cur); cur = ''; has = false } continue }
    cur += c; has = true
  }
  if (has) toks.push(cur)
  return toks
}

// Separate a segment's redirect targets from its command words.
function parseRedirects(tokens) {
  const words = [], writes = []
  for (let i = 0; i < tokens.length; i++) {
    const m = tokens[i].match(/^([0-9]*|&)?(>>?|<)(.*)$/)
    if (!m) { words.push(tokens[i]); continue }
    let target = m[3]
    if (target === '') { target = tokens[++i] }
    if (target === undefined) return { danger: true }
    if (m[2] === '<') continue          // input redirect: a read, low risk
    if (target === '&1' || target === '&2') continue // fd dup
    writes.push(target)
  }
  return { words, writes }
}

function safeWrite(target, cwd) {
  if (target === '/dev/null') return true
  if (SENSITIVE.test(target)) return false
  const abs = target.startsWith('/') ? target : resolve(cwd, target)
  if (/\/\.whydiff(\/|$)/.test(abs)) return true
  if (/\/scratchpad(\/|$)/.test(abs)) return true
  return abs.startsWith('/tmp/') || abs.startsWith('/private/tmp/') || abs.startsWith('/var/folders/')
}

function coreOk(words, root) {
  if (!words.length) return false
  if (words.some((w) => SENSITIVE.test(w))) return false
  const c = words[0]
  if (c === 'node') {
    const s = words[1] || ''
    return !!root && s.startsWith(root + '/scripts/') && s.endsWith('.mjs')
  }
  if (c === 'git') {
    let i = 1
    while (i < words.length) {
      const w = words[i]
      if (w === '-C' || w === '-c') { i += 2; continue }
      if (w.startsWith('-')) { i += 1; continue }
      break
    }
    return GIT_READ.has(words[i])
  }
  if (c === 'gh') return words[1] === 'pr' && ['diff', 'view'].includes(words[2])
  if (c === 'mkdir') return words.some((w) => /\.whydiff(\/|$)/.test(w))
  if (c === 'open') return words.some((w) => /\/\.whydiff\/.*\.html$/.test(w))
  if (c === 'cd') return true // cwd is tracked; redirect safety is enforced separately
  if (READ_CMDS.has(c)) {
    if (c === 'sed' && words.some((w) => w === '-i' || /^-i/.test(w))) return false // in-place edit writes
    return true
  }
  return false
}

// Returns an approval reason for a Bash command, or null to defer.
export function decideBash(cmd, cwd, root) {
  const trimmed = String(cmd || '').trim()
  if (!trimmed) return null
  const s = splitSegments(trimmed)
  if (s.defer || !s.segments.length) return null
  let curCwd = cwd || process.cwd()
  for (const seg of s.segments) {
    const { words, writes, danger } = parseRedirects(tokenize(seg))
    if (danger || !coreOk(words, root)) return null
    for (const t of writes) if (!safeWrite(t, curCwd)) return null
    if (words[0] === 'cd' && words[1]) {
      curCwd = words[1].startsWith('/') ? words[1] : resolve(curCwd, words[1])
    }
  }
  return 'whydiff: read-only pipeline / diff inspection'
}

// Returns an approval reason for a whole PreToolUse event, or null to defer.
export function decide(evt, root = process.env.CLAUDE_PLUGIN_ROOT) {
  const tool = evt.tool_name
  if (tool === 'Bash') return decideBash(evt.tool_input?.command, evt.cwd, root)
  if (tool === 'Write' || tool === 'Edit') {
    return /\/\.whydiff\//.test(String(evt.tool_input?.file_path || '')) ? 'whydiff: pipeline output file' : null
  }
  if (tool === 'Task') {
    return /^whydiff:/.test(String(evt.tool_input?.subagent_type || '')) ? 'whydiff: bundled analysis agent' : null
  }
  return null
}

// CLI entry: read the hook event from stdin, emit an allow decision or nothing.
if (import.meta.url === `file://${process.argv[1]}`) {
  let input = ''
  process.stdin.on('data', (d) => (input += d))
  process.stdin.on('end', () => {
    let reason = null
    try { reason = decide(JSON.parse(input)) } catch {}
    if (reason) {
      process.stdout.write(JSON.stringify({
        hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'allow', permissionDecisionReason: reason },
      }))
    }
    process.exit(0)
  })
}
