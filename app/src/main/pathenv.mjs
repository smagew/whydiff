import { execSync } from 'node:child_process'
import { accessSync, constants, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

// A GUI app launched from Finder/Dock inherits a minimal PATH — it won't find
// `claude` (often in ~/.local/bin or a version manager) or `git`. Recover a usable
// PATH: ask the user's login shell for its PATH, then union in the common bin dirs.
// (On Windows a GUI process already gets the system PATH, so leave it alone.)
let cached
export function resolvedPath() {
  if (cached) return cached
  if (process.platform === 'win32') { cached = process.env.PATH || ''; return cached }
  let fromShell = ''
  try {
    const shell = process.env.SHELL || '/bin/zsh'
    fromShell = execSync(`${shell} -lic 'printf %s "$PATH"'`, { encoding: 'utf8', timeout: 4000, stdio: ['ignore', 'pipe', 'ignore'] }).trim()
  } catch { /* fall back to the common dirs below */ }
  const home = homedir()
  const common = [
    join(home, '.local/bin'), '/opt/homebrew/bin', '/usr/local/bin',
    '/usr/bin', '/bin', '/usr/sbin', '/sbin',
  ]
  const parts = [
    ...(fromShell ? fromShell.split(':') : []),
    ...((process.env.PATH || '').split(':')),
    ...common,
  ]
  cached = [...new Set(parts.filter(Boolean))].join(':')
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
