// updates.mjs — the app-update notifier's pure logic, over an injected fetch.
import { checkForUpdate, cmpVersion } from '../src/main/updates.mjs'

const fail = (m) => { console.error(`FAIL: ${m}`); process.exit(1) }
const ok = (c, m) => { if (!c) fail(m) }

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
  { tag_name: 'app-v0.2.0', html_url: 'https://github.com/smagew/whydiff/releases/tag/app-v0.2.0' },
  { tag_name: 'app-v0.1.2', html_url: 'https://github.com/smagew/whydiff/releases/tag/app-v0.1.2' },
  { tag_name: 'app-v0.3.0-rc', prerelease: true, html_url: 'x' }, // prerelease/non-semver — ignored
]

// a newer app release exists → available, picks the highest app-v, not the plugin tag
let r = await checkForUpdate({ currentVersion: '0.1.2', fetchImpl: mkFetch(RELEASES) })
ok(r && r.available === true, `expected an update, got ${JSON.stringify(r)}`)
ok(r.latest === '0.2.0', `latest should be 0.2.0, got ${r.latest}`)
ok(r.url.endsWith('app-v0.2.0'), `url should point at app-v0.2.0, got ${r.url}`)
ok(r.current === '0.1.2', 'current is echoed back')

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
