// Check GitHub Releases for a newer desktop-app build and report it — nothing more.
//
// We deliberately do NOT use electron-updater: the macOS builds are unsigned, and
// Squirrel.Mac refuses to apply an update to an unsigned/ad-hoc app, so auto-install
// can't work on the platform most of our users are on. A notifier works everywhere:
// the renderer shows a banner with a link to the release, the user downloads it.
//
// checkForUpdate is pure over an injected fetch, so it is unit-testable without a
// network or Electron.

// Compare two X.Y.Z versions; > 0 if a is newer than b.
export function cmpVersion(a, b) {
  const pa = String(a).split('.').map((n) => parseInt(n, 10) || 0)
  const pb = String(b).split('.').map((n) => parseInt(n, 10) || 0)
  for (let i = 0; i < 3; i++) { const d = (pa[i] || 0) - (pb[i] || 0); if (d) return d }
  return 0
}

/**
 * @returns {Promise<{available:boolean, latest:string, current:string, url:string}|null>}
 *   null on any failure (offline, rate limit, bad response) — a notifier must never
 *   get in the way. `available` is true only when a newer app-v* release exists.
 */
export async function checkForUpdate({ currentVersion, repo = 'smagew/whydiff', fetchImpl = globalThis.fetch, timeoutMs = 6000 } = {}) {
  if (!currentVersion || typeof fetchImpl !== 'function') return null
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), timeoutMs)
  try {
    const res = await fetchImpl(`https://api.github.com/repos/${repo}/releases?per_page=30`, {
      headers: { accept: 'application/vnd.github+json', 'user-agent': 'whydiff-desktop' },
      signal: ctrl.signal,
    })
    if (!res || !res.ok) return null
    const rels = await res.json()
    if (!Array.isArray(rels)) return null
    // Only the desktop app's releases (tag `app-vX.Y.Z`), never the plugin's `vX.Y.Z`.
    const apps = rels
      .filter((r) => r && !r.draft && !r.prerelease && /^app-v\d+\.\d+\.\d+$/.test(r.tag_name || ''))
      .map((r) => ({ version: r.tag_name.replace(/^app-v/, ''), url: r.html_url }))
    if (!apps.length) return null
    apps.sort((a, b) => cmpVersion(b.version, a.version))
    const latest = apps[0]
    const available = cmpVersion(latest.version, currentVersion) > 0
    return { available, latest: latest.version, current: currentVersion, url: latest.url }
  } catch {
    return null
  } finally {
    clearTimeout(timer)
  }
}
