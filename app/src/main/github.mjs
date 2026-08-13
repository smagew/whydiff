// GitHub bits: parse a repo URL, and list a repo's open pull requests via the REST
// API. Uses the built-in fetch — no dependency. Unauthenticated by default (fine for
// public repos, rate-limited); a token (env GITHUB_TOKEN for now, a keychain later)
// lifts the limit and reaches private repos.

// owner/repo from https://github.com/owner/repo(.git) or git@github.com:owner/repo.
export function parseRepo(url) {
  const m = String(url).trim().replace(/\.git$/, '').match(/github\.com[/:]([^/]+)\/([^/]+)/)
  if (!m) return null
  return { owner: m[1], repo: m[2] }
}

// Map the API's PR objects to the small shape the UI needs.
export function mapPRs(arr) {
  return (Array.isArray(arr) ? arr : []).map(p => ({
    number: p.number,
    title: p.title,
    author: p.user?.login || '?',
    baseRef: p.base?.ref || 'main',
    headRef: p.head?.ref || '',
    updated: (p.updated_at || '').slice(0, 10),
    draft: !!p.draft,
  }))
}

export async function fetchPRs(url, { token = process.env.GITHUB_TOKEN, state = 'open', perPage = 50 } = {}) {
  const r = parseRepo(url)
  if (!r) throw new Error('not a GitHub repo URL')
  const api = `https://api.github.com/repos/${r.owner}/${r.repo}/pulls?state=${state}&per_page=${perPage}`
  const headers = { 'Accept': 'application/vnd.github+json', 'User-Agent': 'whydiff-desktop' }
  if (token) headers.Authorization = `Bearer ${token}`
  const res = await fetch(api, { headers })
  if (res.status === 404) throw new Error('repo not found (or private — set GITHUB_TOKEN)')
  if (res.status === 403) throw new Error('GitHub rate limit or access denied — set GITHUB_TOKEN')
  if (!res.ok) throw new Error(`GitHub API ${res.status}`)
  return mapPRs(await res.json())
}
