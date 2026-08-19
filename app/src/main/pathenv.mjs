import { execFile, execSync } from 'node:child_process'
import { accessSync, constants, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

// A GUI app launched from Finder/Dock inherits a minimal PATH — it won't find
// `claude` (often in ~/.local/bin or a version manager) or `git`. Recover a usable
// PATH: ask the user's login shell for its PATH, then union in the common bin dirs.
// (On Windows a GUI process already gets the system PATH, so leave it alone.)
//
// Asking the login shell costs whatever the user's rc files cost — seconds on a heavy
// zshrc. So the shell is asked ASYNCHRONOUSLY (resolvedPathAsync) while the window is
// already on screen; until it answers, `quickPath()` — the inherited PATH unioned with
// the usual bin dirs — is what everything sees. Only code that must not guess (running
// the analysis, the preflight) awaits the real thing.
let cached
let pending

const COMMON = () => {
  const home = homedir()
  return [join(home, '.local/bin'), '/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin', '/usr/sbin', '/sbin']
}
const union = (...lists) => [...new Set(lists.flat().filter(Boolean))].join(':')

// The PATH we can produce without spawning anything: what we inherited plus the common
// bin dirs. Good enough for a Terminal-launched app, and the instant fallback everywhere.
export function quickPath() {
  if (process.platform === 'win32') return process.env.PATH || ''
  return union((process.env.PATH || '').split(':'), COMMON())
}

// The login shell's PATH, unioned with the above. Cached: the first caller pays, the rest
// get the answer. Never rejects — a shell that fails or hangs falls back to quickPath().
export function resolvedPathAsync() {
  if (cached) return Promise.resolve(cached)
  if (pending) return pending
  if (process.platform === 'win32') { cached = process.env.PATH || ''; return Promise.resolve(cached) }
  const shell = process.env.SHELL || '/bin/zsh'
  pending = new Promise((res) => {
    execFile(shell, ['-lic', 'printf %s "$PATH"'], { encoding: 'utf8', timeout: 8000 }, (err, stdout) => {
      const fromShell = err ? '' : String(stdout).trim()
      cached = union(fromShell ? fromShell.split(':') : [], (process.env.PATH || '').split(':'), COMMON())
      res(cached)
    })
  })
  return pending
}

// The synchronous form, kept for callers that cannot await (and for tests). Once the async
// resolution has landed this is free; before that it blocks on the shell exactly as it used to.
export function resolvedPath() {
  if (cached) return cached
  if (process.platform === 'win32') { cached = process.env.PATH || ''; return cached }
  let fromShell = ''
  try {
    const shell = process.env.SHELL || '/bin/zsh'
    fromShell = execSync(`${shell} -lic 'printf %s "$PATH"'`, { encoding: 'utf8', timeout: 4000, stdio: ['ignore', 'pipe', 'ignore'] }).trim()
  } catch { /* fall back to the common dirs below */ }
  cached = union(fromShell ? fromShell.split(':') : [], (process.env.PATH || '').split(':'), COMMON())
  return cached
}

// Find an executable by name on a PATH string (defaults to the recovered PATH), the way the
// shell would — so a preflight can tell the user "Claude Code not found" up front instead of
// letting the runner fail with a bare exit code. Returns its full path, or null. On Windows we
// also try the usual executable extensions. No spawning — a pure filesystem lookup, testable.
export function whichBin(name, pathStr = resolvedPath()) {
  const win = process.platform === 'win32'
  const sep = win ? ';' : ':'
  const exts = win ? (process.env.PATHEXT || '.EXE;.CMD;.BAT').split(';') : ['']
  for (const dir of (pathStr || '').split(sep)) {
    if (!dir) continue
    for (const ext of exts) {
      const full = join(dir, name + ext)
      try {
        if (!statSync(full).isFile()) continue
        if (!win) accessSync(full, constants.X_OK) // must be executable on POSIX
        return full
      } catch { /* not here */ }
    }
  }
  return null
}
