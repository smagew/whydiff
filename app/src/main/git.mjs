import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'

// Thin, read-only git over a local repo path — enough for Phase 3: is this a repo,
// does it have uncommitted work, and what are its recent commits. Everything shells
// out to `git` (already required by the rest of the toolchain) and never writes.
const git = (dir, args) => new Promise((resolve, reject) => {
  execFile('git', ['-C', dir, ...args], { maxBuffer: 16 * 1024 * 1024 }, (err, stdout, stderr) => {
    if (err) reject(new Error((stderr || err.message).toString().trim()))
    else resolve(stdout.toString())
  })
})

export function isRepo(dir) {
  return existsSync(join(dir, '.git'))
}

// Uncommitted work = anything `git status --porcelain` reports (staged, unstaged, or
// untracked). Returns a small summary the UI can show without re-parsing.
export async function uncommitted(dir) {
  const out = (await git(dir, ['status', '--porcelain'])).split('\n').filter(Boolean)
  return { dirty: out.length > 0, count: out.length, files: out.slice(0, 50).map(l => l.slice(3)) }
}

// Recent commits, newest first. A record-separator-delimited format so subjects with
// any punctuation survive parsing.
export async function recentCommits(dir, n = 30) {
  const SEP = '\x1f', REC = '\x1e'
  const fmt = ['%H', '%h', '%s', '%an', '%ad'].join(SEP) + REC
  const out = await git(dir, ['log', `-n${n}`, '--date=short', `--pretty=format:${fmt}`])
  return out.split(REC).map(s => s.trim()).filter(Boolean).map(rec => {
    const [hash, short, subject, author, date] = rec.split(SEP)
    return { hash, short, subject, author, date }
  })
}

export async function currentBranch(dir) {
  return (await git(dir, ['rev-parse', '--abbrev-ref', 'HEAD'])).trim()
}

// Everything the project view needs in one call. `ok:false` when the path is not a
// git repo, so the UI can say so instead of erroring.
export async function gitState(dir, commitLimit = 30) {
  if (!isRepo(dir)) return { ok: false, reason: 'not a git repository' }
  try {
    const [changes, commits, branch] = await Promise.all([
      uncommitted(dir), recentCommits(dir, commitLimit), currentBranch(dir).catch(() => null),
    ])
    return { ok: true, branch, uncommitted: changes, commits }
  } catch (e) {
    return { ok: false, reason: e.message }
  }
}

// The diff range for a single commit: its parent..itself. The root commit has no
// parent, so fall back to the empty-tree hash so its first files still show.
export const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904'
export async function rangeForCommit(dir, hash) {
  try {
    await git(dir, ['rev-parse', '--verify', `${hash}^`])
    return `${hash}^..${hash}`
  } catch {
    return `${EMPTY_TREE}..${hash}`
  }
}
