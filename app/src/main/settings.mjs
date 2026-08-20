// App settings that must not sit in plaintext — chiefly a GitHub token for private
// repos and higher rate limits. The token is encrypted with the OS keychain
// (Electron safeStorage: macOS Keychain, Windows DPAPI, Linux libsecret/kwallet)
// and only the ciphertext is written to disk. The renderer never receives the
// token back — it can set it, clear it, and ask whether one is stored.
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs'
import { dirname } from 'node:path'

const read = (file) => { try { return JSON.parse(readFileSync(file, 'utf8')) } catch { return {} } }
const write = (file, data) => { mkdirSync(dirname(file), { recursive: true }); writeFileSync(file, JSON.stringify(data, null, 2) + '\n') }

/**
 * @param file  where the (encrypted) settings JSON lives
 * @param storage  a safeStorage-like { isEncryptionAvailable, encryptString, decryptString }.
 *   Injected in tests; defaults to Electron's safeStorage in the app.
 */
export function openSettings(file, storage) {
  const available = () => { try { return !!storage && storage.isEncryptionAvailable() } catch { return false } }

  const hasToken = () => !!read(file).githubToken
  // What the renderer is allowed to know: whether a token is stored, and whether the
  // keychain is usable at all (Linux headless may have no keyring) — never the value.
  const tokenStatus = () => ({ stored: hasToken(), available: available() })

  const setToken = (raw) => {
    const token = String(raw || '').trim()
    const data = read(file)
    if (!token) { delete data.githubToken; write(file, data); return { stored: false, available: available() } }
    if (!available()) throw new Error('the OS keychain is unavailable, so the token cannot be stored securely — use the GITHUB_TOKEN environment variable instead')
    data.githubToken = storage.encryptString(token).toString('base64')
    write(file, data)
    return { stored: true, available: true }
  }

  const clearToken = () => { const data = read(file); delete data.githubToken; write(file, data); return { stored: false, available: available() } }

  // The appearance preference: 'dark' out of the box, or 'light'/'system' once chosen. Dark is
  // the default because that is the appearance the map windows are designed in and the one the
  // app is read in beside a terminal; following the OS is offered, not assumed. Plain text —
  // there is nothing secret about a colour scheme — but it lives here so the app has one
  // settings file rather than two.
  const THEMES = ['system', 'light', 'dark']
  const DEFAULT_THEME = 'dark'
  const getTheme = () => { const t = read(file).theme; return THEMES.includes(t) ? t : DEFAULT_THEME }
  const setTheme = (raw) => {
    const theme = THEMES.includes(raw) ? raw : DEFAULT_THEME
    const data = read(file)
    data.theme = theme
    write(file, data)
    return theme
  }

  // Decrypt for use in the main process only (e.g. GitHub API calls). Returns null if
  // nothing is stored or the keychain can't decrypt it (e.g. a different machine/user).
  const getToken = () => {
    const enc = read(file).githubToken
    if (!enc || !available()) return null
    try { return storage.decryptString(Buffer.from(enc, 'base64')) } catch { return null }
  }

  return { hasToken, tokenStatus, setToken, clearToken, getToken, getTheme, setTheme }
}
