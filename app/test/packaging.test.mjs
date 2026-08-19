// Packaging guard. The main process is bundled to CommonJS, so a static `import` of an
// ESM-ONLY dependency (pdfjs-dist v4 ships only .mjs) becomes a top-level `require()` of a
// .mjs file → ERR_REQUIRE_ESM, which crashes the PACKAGED app at launch (the plain Node and
// Playwright tests never see this — only a real bundle does). This shipped once; the guard
// builds the bundle and asserts ESM-only deps are loaded via a runtime dynamic import().
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const appDir = join(dirname(fileURLToPath(import.meta.url)), '..')
execFileSync('npx', ['electron-vite', 'build'], { cwd: appDir, stdio: 'ignore' })
const main = readFileSync(join(appDir, 'out', 'main', 'index.js'), 'utf8')

// No top-level require() of ANY .mjs (they are ESM; require() throws at launch).
assert.ok(!/require\(\s*["'][^"']*\.mjs["']\s*\)/.test(main),
  'the bundled main process require()s a .mjs module — ERR_REQUIRE_ESM at launch; load it via dynamic import() instead')
// pdfjs specifically must be a dynamic import (it is ESM-only and asarUnpack'd).
assert.ok(!/require\(\s*["']pdfjs-dist/.test(main),
  'pdfjs-dist must NOT be require()d')
assert.ok(/import\(\s*\n?\s*(?:\/\*[^*]*\*\/\s*)?["']pdfjs-dist/.test(main),
  'pdfjs-dist must be loaded via a runtime dynamic import()')

console.log('OK: packaging — the bundled main process loads ESM-only deps via dynamic import(), not require() (no ERR_REQUIRE_ESM at launch)')
