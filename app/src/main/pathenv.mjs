import { execSync } from 'node:child_process'
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
