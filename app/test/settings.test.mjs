// settings.mjs — the GitHub token store. A fake safeStorage (base64, not real crypto)
// stands in for the OS keychain so this runs under plain node, and an "unavailable"
// fake proves the store refuses to write plaintext.
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openSettings } from '../src/main/settings.mjs'

const fail = (m) => { console.error(`FAIL: ${m}`); process.exit(1) }
const ok = (c, m) => { if (!c) fail(m) }

// A safeStorage-like fake: "encryption" is just a reversible tag so we can assert the
// stored value is NOT the plaintext token.
const fakeStore = {
  isEncryptionAvailable: () => true,
  encryptString: (s) => Buffer.from('enc:' + s, 'utf8'),
  decryptString: (buf) => buf.toString('utf8').replace(/^enc:/, ''),
}
const unavailable = { isEncryptionAvailable: () => false, encryptString: () => { throw new Error('no') }, decryptString: () => { throw new Error('no') } }

const file = join(mkdtempSync(join(tmpdir(), 'wd-settings-')), 'settings.json')
const s = openSettings(file, fakeStore)

ok(s.tokenStatus().stored === false && s.tokenStatus().available === true, 'starts with no token, keychain available')
ok(s.getToken() === null, 'no token → getToken null')

s.setToken('ghp_secret123')
ok(s.hasToken() && s.tokenStatus().stored, 'token now stored')
ok(s.getToken() === 'ghp_secret123', 'getToken round-trips the value')
// the value on disk must be ciphertext, never the raw token
const onDisk = JSON.parse(readFileSync(file, 'utf8')).githubToken
ok(typeof onDisk === 'string' && !onDisk.includes('ghp_secret123'), `token must be encrypted on disk, got: ${onDisk}`)

s.setToken('   ') // whitespace clears
ok(!s.hasToken(), 'setting a blank token clears it')

s.setToken('ghp_again'); s.clearToken()
ok(!s.hasToken() && s.getToken() === null, 'clearToken removes it')

// with no keychain, setting a token must fail loudly rather than store plaintext
const s2 = openSettings(join(mkdtempSync(join(tmpdir(), 'wd-settings2-')), 'settings.json'), unavailable)
let threw = false
try { s2.setToken('ghp_x') } catch { threw = true }
ok(threw, 'setToken must refuse when the keychain is unavailable')
ok(s2.tokenStatus().available === false && s2.tokenStatus().stored === false, 'status reflects unavailable keychain')

console.log('OK: settings (token encrypted on disk, round-trips, clears, refuses plaintext without a keychain)')

// ── appearance ───────────────────────────────────────────────────────────────
// The theme preference lives in the same file but is plain text — there is nothing secret
// about a colour scheme, and it must survive a keychain that refuses to work.
ok(s.getTheme() === 'system', 'appearance defaults to following the OS')
ok(s.setTheme('light') === 'light', 'setTheme returns what it stored')
ok(s.getTheme() === 'light', 'the choice persists')
ok(openSettings(file, fakeStore).getTheme() === 'light', 'and survives a reopen')
ok(s.setTheme('nonsense') === 'system', 'an unknown value falls back to system rather than sticking')
ok(openSettings(file, unavailable).getTheme() === 'system', 'the theme is readable with no keychain at all')
