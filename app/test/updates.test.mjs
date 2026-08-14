// updates.mjs — the app-update notifier's pure logic, over an injected fetch.
import { checkForUpdate, cmpVersion, pickAsset } from '../src/main/updates.mjs'

const fail = (m) => { console.error(`FAIL: ${m}`); process.exit(1) }
const ok = (c, m) => { if (!c) fail(m) }

// pickAsset: the right installer per OS/arch, or null (→ release page) for what we don't build
const ASSETS = [
  { name: 'whydiff-0.4.0-arm64.dmg', browser_download_url: 'u/dmg' },
  { name: 'whydiff-0.4.0-arm64-mac.zip', browser_download_url: 'u/zip' },
  { name: 'whydiff.Setup.0.4.0.exe', browser_download_url: 'u/exe' },
  { name: 'whydiff-0.4.0.AppImage', browser_download_url: 'u/appimage' },
  { name: 'whydiff-desktop_0.4.0_amd64.deb', browser_download_url: 'u/deb' },
]
ok(pickAsset(ASSETS, 'darwin', 'arm64') === 'u/dmg', 'darwin/arm64 → .dmg')
ok(pickAsset(ASSETS, 'darwin', 'x64') === null, 'darwin/x64 → null (no Intel build)')
ok(pickAsset(ASSETS, 'win32', 'x64') === 'u/exe', 'win32 → .exe')
ok(pickAsset(ASSETS, 'linux', 'x64') === 'u/appimage', 'linux/x64 → AppImage (preferred over deb)')
ok(pickAsset(ASSETS, 'linux', 'arm64') === null, 'linux/arm64 → null (amd64 only)')
ok(pickAsset(ASSETS.filter((a) => a.name.endsWith('.deb')), 'linux', 'x64') === 'u/deb', 'linux falls back to .deb when no AppImage')
ok(pickAsset(ASSETS, 'freebsd', 'x64') === null, 'unknown platform → null')
ok(pickAsset(null, 'darwin', 'arm64') === null, 'no assets → null')

// version compare
ok(cmpVersion('0.2.0', '0.1.9') > 0, 'minor beats patch')
ok(cmpVersion('0.1.2', '0.1.2') === 0, 'equal is 0')
ok(cmpVersion('0.1.1', '0.1.2') < 0, 'older is negative')
ok(cmpVersion('1.0.0', '0.9.9') > 0, 'major beats all')

const mkFetch = (releases, { ok: httpOk = true, throws = false } = {}) => async () => {
  if (throws) throw new Error('offline')
  return { ok: httpOk, json: async () => releases }
}
const RELEASES = [
  { tag_name: 'v0.24.0', html_url: 'https://github.com/smagew/whydiff/releases/tag/v0.24.0' }, // plugin — must be ignored
  { tag_name: 'app-v0.1.1', html_url: 'https://github.com/smagew/whydiff/releases/tag/app-v0.1.1' },
  { tag_name: 'app-v0.2.0', html_url: 'https://github.com/smagew/whydiff/releases/tag/app-v0.2.0', assets: ASSETS },
  { tag_name: 'app-v0.1.2', html_url: 'https://github.com/smagew/whydiff/releases/tag/app-v0.1.2' },
  { tag_name: 'app-v0.3.0-rc', prerelease: true, html_url: 'x' }, // prerelease/non-semver — ignored
]

// a newer app release exists → available, picks the highest app-v, not the plugin tag
let r = await checkForUpdate({ currentVersion: '0.1.2', fetchImpl: mkFetch(RELEASES) })
ok(r && r.available === true, `expected an update, got ${JSON.stringify(r)}`)
ok(r.latest === '0.2.0', `latest should be 0.2.0, got ${r.latest}`)
ok(r.url.endsWith('app-v0.2.0'), `url should point at app-v0.2.0, got ${r.url}`)
ok(r.current === '0.1.2', 'current is echoed back')

// assetUrl: the direct installer for the given OS/arch; null when we build none for it
r = await checkForUpdate({ currentVersion: '0.1.2', fetchImpl: mkFetch(RELEASES), platform: 'win32', arch: 'x64' })
ok(r.assetUrl === 'u/exe', `win32 update should point straight at the .exe, got ${r.assetUrl}`)
r = await checkForUpdate({ currentVersion: '0.1.2', fetchImpl: mkFetch(RELEASES), platform: 'darwin', arch: 'x64' })
ok(r.assetUrl === null, 'Intel Mac gets no direct asset (falls back to the page)')
r = await checkForUpdate({ currentVersion: '0.1.2', fetchImpl: mkFetch(RELEASES) })
ok(r.assetUrl === null, 'no platform given → no direct asset')

// already on the latest → not available
r = await checkForUpdate({ currentVersion: '0.2.0', fetchImpl: mkFetch(RELEASES) })
ok(r && r.available === false && r.latest === '0.2.0', `should report no update: ${JSON.stringify(r)}`)

// only plugin releases → nothing to offer (null, not a crash)
r = await checkForUpdate({ currentVersion: '0.1.0', fetchImpl: mkFetch([{ tag_name: 'v0.24.0', html_url: 'x' }]) })
ok(r === null, `no app releases should be null, got ${JSON.stringify(r)}`)

// a notifier must never get in the way: HTTP error and a thrown fetch both → null
ok((await checkForUpdate({ currentVersion: '0.1.2', fetchImpl: mkFetch(RELEASES, { ok: false }) })) === null, 'non-ok response → null')
ok((await checkForUpdate({ currentVersion: '0.1.2', fetchImpl: mkFetch(RELEASES, { throws: true }) })) === null, 'thrown fetch → null')
ok((await checkForUpdate({ currentVersion: '', fetchImpl: mkFetch(RELEASES) })) === null, 'no current version → null')

console.log('OK: updates (version compare; picks the newest app-v* release, ignores plugin + prerelease tags; available true/false; null on error)')
