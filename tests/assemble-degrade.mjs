#!/usr/bin/env node
// assemble.mjs degrades a missing embedFull file to a plain drill-down instead of
// crashing — so `serve` can re-assemble a saved map for the desktop app's live mode
// even when the repo has moved or a commit range renamed/deleted the file.
import { readFileSync, writeFileSync, mkdtempSync, existsSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const fail = (m) => { console.error(`FAIL: ${m}`); process.exit(1) }
const ok = (c, m) => { if (!c) fail(m) }

const dir = mkdtempSync(join(tmpdir(), 'wd-asm-'))
const map = JSON.parse(readFileSync(join(root, 'examples', 'rate-limit', 'review-map.json'), 'utf8'))
map.files[Object.keys(map.files)[0]].embedFull = true // force at least one embed
const mapPath = join(dir, 'm.json'); writeFileSync(mapPath, JSON.stringify(map))
const out = join(dir, 'm.html')
const emptyRepo = mkdtempSync(join(tmpdir(), 'wd-emptyrepo-')) // has none of the files

let code = 0
try { execFileSync('node', [join(root, 'scripts', 'assemble.mjs'), mapPath, '--repo', emptyRepo, '--out', out], { stdio: ['ignore', 'ignore', 'ignore'] }) } catch (e) { code = e.status ?? 1 }
ok(code === 0, `assemble should not crash when an embed file is unreadable (exit ${code})`)
ok(existsSync(out), 'assemble should still produce the HTML')

console.log('OK: assemble degrades a missing embedFull file to a plain drill-down (no crash, HTML produced)')
