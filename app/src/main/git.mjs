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
// any punctuation survive parsing. `ref` picks the branch to walk (default: HEAD) and
// `skip` pages further back, so the UI can load another page instead of guessing a
// limit that is always wrong in one direction.
export async function recentCommits(dir, n = 30, { ref = '', skip = 0 } = {}) {
  const SEP = '\x1f', REC = '\x1e'
  const fmt = ['%H', '%h', '%s', '%an', '%ad'].join(SEP) + REC
  const args = ['log', `-n${n}`, '--date=short', `--pretty=format:${fmt}`]
  if (skip > 0) args.push(`--skip=${skip}`)
  args.push(ref || 'HEAD', '--')
  const out = await git(dir, args)
  return out.split(REC).map(s => s.trim()).filter(Boolean).map(rec => {
    const [hash, short, subject, author, date] = rec.split(SEP)
    return { hash, short, subject, author, date }
  })
}

// Every branch the user could review: local ones, plus remote-tracking branches that have
// no local counterpart (a fresh clone has exactly one local branch and a dozen remote
// ones — listing only local would leave most of the repo unreachable). `current` is the
// checked-out branch, or null on a detached HEAD.
export async function listBranches(dir) {
  const names = async (glob) => (await git(dir, ['for-each-ref', '--format=%(refname:short)', glob]))
    .split('\n').map(s => s.trim()).filter(Boolean)
  // Our own PR scratch refs (whydiff/pr-N) are not the user's branches.
  const local = (await names('refs/heads')).filter(n => !n.startsWith(PR_REF_PREFIX))
  const shortOf = (n) => n.split('/').slice(1).join('/') // "origin/main" → "main"
  // A remote branch that already has a local counterpart would just be a duplicate entry.
  const remote = (await names('refs/remotes')).filter(n => !n.endsWith('/HEAD') && !local.includes(shortOf(n)))
  const current = await currentBranch(dir).catch(() => null)
  return { current: current && current !== 'HEAD' ? current : null, local, remote }
}

// Does this ref resolve in this repo? Used before building a comparison range, so a typo
// says "unknown ref: foo" instead of failing deep inside the analysis runner.
export async function refExists(dir, ref) {
  try { await git(dir, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`]); return true } catch { return false }
}

// The range for comparing two refs: base...head — three-dot, i.e. what head introduces
// since the two diverged, which is what a reviewer means by "what's on this branch".
export async function compareRange(dir, base, head) {
  const b = String(base || '').trim(), h = String(head || '').trim()
  if (!b || !h) throw new Error('pick both a base and a branch to compare')
  if (!await refExists(dir, b)) throw new Error(`unknown ref: ${b}`)
  if (!await refExists(dir, h)) throw new Error(`unknown ref: ${h}`)
  return `${b}...${h}`
}

export async function currentBranch(dir) {
  return (await git(dir, ['rev-parse', '--abbrev-ref', 'HEAD'])).trim()
}

// Everything the project view needs in one call. `ok:false` when the path is not a
// git repo, so the UI can say so instead of erroring. `ref` walks a branch other than
// the checked-out one; `more` is true when another page of commits exists behind the
// limit, so the UI knows whether to offer "load more" instead of guessing.
export async function gitState(dir, { limit = 30, ref = '' } = {}) {
  if (!isRepo(dir)) return { ok: false, reason: 'not a git repository' }
  try {
    const [changes, page, branch, branches] = await Promise.all([
      uncommitted(dir),
      recentCommits(dir, limit + 1, { ref }),
      currentBranch(dir).catch(() => null),
      listBranches(dir).catch(() => ({ current: null, local: [], remote: [] })),
    ])
    const commits = page.slice(0, limit)
    return { ok: true, branch, ref: ref || branch || 'HEAD', uncommitted: changes, commits, more: page.length > limit, branches }
  } catch (e) {
    return { ok: false, reason: e.message }
  }
}

// Another page of commits for the branch already being shown.
export async function moreCommits(dir, { limit = 30, skip = 0, ref = '' } = {}) {
  const page = await recentCommits(dir, limit + 1, { ref, skip })
  return { commits: page.slice(0, limit), more: page.length > limit }
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

// Clone a repo (a GitHub URL, or any git remote — even a local path, which is how
// this is tested) into `dest`. Streams git's progress lines if asked.
export function clone(url, dest, { onProgress } = {}) {
  return new Promise((resolve, reject) => {
    const child = execFile('git', ['clone', '--progress', url, dest], { maxBuffer: 64 * 1024 * 1024 }, (err, _o, stderr) => {
      if (err) reject(new Error(`clone failed: ${(stderr || err.message).toString().trim().split('\n').pop()}`))
      else resolve(dest)
    })
    if (onProgress) child.stderr?.on('data', (d) => String(d).split(/\r|\n/).forEach(l => l.trim() && onProgress(l.trim())))
  })
}

// Where a fetched PR head is parked locally. Namespaced so these scratch refs are
// recognisable — and prunable — as ours.
export const PR_REF_PREFIX = 'whydiff/pr-'

// Fetch a PR's head into a local ref and return the diff range for its changes:
// base...head (three-dot = merge-base..head, i.e. what the PR introduces). Older PR refs
// are pruned as we go: without this every PR ever analysed stays in the clone forever,
// pinning its objects against gc.
export async function fetchPrRange(dir, number, baseRef, { keep = 5 } = {}) {
  const local = `${PR_REF_PREFIX}${number}`
  await git(dir, ['fetch', '--force', 'origin', `pull/${number}/head:${local}`])
  await prunePrRefs(dir, { keep, exclude: [local] }).catch(() => {})
  return `origin/${baseRef}...${local}`
}

/**
 * Drop our PR scratch refs, keeping the `keep` most recently committed-to (plus anything
 * named in `exclude`, i.e. the one in use). Returns the ref names removed.
 */
export async function prunePrRefs(dir, { keep = 5, exclude = [] } = {}) {
  const out = await git(dir, ['for-each-ref', '--sort=-committerdate', '--format=%(refname:short)', `refs/heads/${PR_REF_PREFIX}*`])
  const refs = out.split('\n').map(s => s.trim()).filter(Boolean)
  const doomed = refs.filter((r) => !exclude.includes(r)).slice(Math.max(0, keep - exclude.length))
  for (const r of doomed) await git(dir, ['branch', '-D', r]).catch(() => {})
  return doomed
}
