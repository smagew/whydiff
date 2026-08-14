// Check GitHub Releases for a newer desktop-app build and report it — nothing more.
//
// We deliberately do NOT use electron-updater: the macOS builds are unsigned, and
// Squirrel.Mac refuses to apply an update to an unsigned/ad-hoc app, so auto-install
// can't work on the platform most of our users are on. A notifier works everywhere:
// the renderer shows a banner. Its Download button opens the installer that fits this
// OS/arch directly; only when we can't match one (e.g. an Intel Mac, where we publish
// no build) does it fall back to the release page so the user can choose.
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

// The installer for this platform/arch among a release's assets, or null if none fits.
// Match by the electron-builder filenames: whydiff-*-arm64.dmg / *-mac.zip (macOS,
// Apple-Silicon only), whydiff.Setup.*.exe (Windows), whydiff-*.AppImage / *_amd64.deb
// (Linux, amd64). Return null (→ release page) for combinations we don't build.
export function pickAsset(assets, platform, arch) {
  if (!Array.isArray(assets)) return null
  const list = assets
    .filter((a) => a && a.name && a.browser_download_url)
    .map((a) => ({ name: String(a.name).toLowerCase(), url: a.browser_download_url }))
  const find = (re) => (list.find((a) => re.test(a.name)) || {}).url || null
  if (platform === 'darwin') {
    // Only an arm64 build is published; an Intel Mac can't run it, so it gets no
    // direct download and falls back to the release page.
    return arch === 'arm64' ? (find(/\.dmg$/) || find(/mac\.zip$/)) : null
  }
  if (platform === 'win32') return find(/\.exe$/)
  if (platform === 'linux') {
    // AppImage is portable across distros — prefer it, then .deb. amd64 only.
    return arch === 'x64' ? (find(/\.appimage$/) || find(/amd64\.deb$/) || find(/\.deb$/)) : null
  }
  return null
}

/**
 * @returns {Promise<{available:boolean, latest:string, current:string, url:string, assetUrl:string|null}|null>}
 *   null on any failure (offline, rate limit, bad response) — a notifier must never
 *   get in the way. `available` is true only when a newer app-v* release exists.
 *   `assetUrl` is the installer for {platform, arch}, or null (open `url`, the page).
 */
export async function checkForUpdate({ currentVersion, repo = 'smagew/whydiff', fetchImpl = globalThis.fetch, timeoutMs = 6000, platform, arch } = {}) {
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
      .map((r) => ({ version: r.tag_name.replace(/^app-v/, ''), url: r.html_url, assets: r.assets || [] }))
    if (!apps.length) return null
    apps.sort((a, b) => cmpVersion(b.version, a.version))
    const latest = apps[0]
    const available = cmpVersion(latest.version, currentVersion) > 0
    const assetUrl = available ? pickAsset(latest.assets, platform, arch) : null
    return { available, latest: latest.version, current: currentVersion, url: latest.url, assetUrl }
  } catch {
    return null
  } finally {
    clearTimeout(timer)
  }
}
