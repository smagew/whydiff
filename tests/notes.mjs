#!/usr/bin/env node
// Notes on the map: a bare reviewer remark pinned to a place — no model. It is
// journaled, shows a marker on its anchor like a question does, reads back in the
// panel, and survives a reload. No `claude` is ever invoked (the note path does not
// call a model), so this test costs nothing.

import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs'
import { spawn } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const fail = (msg) => { console.error(`FAIL: ${msg}`); process.exit(1) }
const ok = (cond, msg) => { if (!cond) fail(msg) }

const work = mkdtempSync(join(tmpdir(), 'whydiff-notes-'))
const rm = JSON.parse(readFileSync(join(root, 'examples', 'rate-limit', 'review-map.json'), 'utf8'))
for (const f of Object.values(rm.files)) delete f.embedFull
const paths = Object.keys(rm.files)
rm.userStories = {
  summary: 'Notes-test summary.',
  stories: [{ actor: 'caller', story: 'I get a clear error when I exceed the limit.', status: 'partial', why: 'guard added', files: [paths[0]], covered: false }],
}
const mapPath = join(work, 'review-map.json')
writeFileSync(mapPath, JSON.stringify(rm))

const port = 7860 + (process.pid % 40)
const proc = spawn('node', [join(root, 'scripts', 'serve.mjs'), mapPath, '--repo', root, '--port', String(port)], { stdio: ['ignore', 'pipe', 'pipe'] })
let out = ''
proc.stdout.on('data', d => { out += d }); proc.stderr.on('data', d => { out += d })
process.on('exit', () => { try { proc.kill('SIGKILL') } catch {} })
const base = `http://127.0.0.1:${port}`
for (let i = 0; i < 100; i++) { try { if ((await fetch(base + '/')).ok) break } catch {} await new Promise(r => setTimeout(r, 100)) }

const NOTE = 'Refund rows are append-only — never mutate an earlier one.'
const browser = await chromium.launch()
const errors = []
const page = await browser.newPage({ viewport: { width: 1500, height: 1000 } })
page.on('pageerror', e => errors.push(`pageerror: ${e.message}`))
page.on('console', m => { if (m.type() === 'error') errors.push(`console: ${m.text()}`) })
await page.goto(base + '/')
await page.waitForTimeout(400)

// Open a fresh anchor (no thread yet) via its hover "ask" affordance.
await page.locator('#tabs .tab[data-pane="stories"]').click()
await page.waitForTimeout(200)
const anchor = page.locator('.ustory[data-anchor="story:0"]')
await anchor.hover()
await anchor.locator('.askbtn').click()
await page.waitForSelector('.askpanel.on', { timeout: 5000 }).catch(() => fail('the panel did not open for the anchor'))

// Switch to Note mode and pin a remark — no model call.
await page.locator('.askpanel .dk-mode button[data-mode="note"]').click()
ok(await page.locator('.askpanel .dk-mode button[data-mode="note"].on').count(), 'Note mode did not switch on')
const ta = page.locator('.askpanel textarea')
ok(!(await ta.isHidden()), 'Note mode hid the textarea (a note needs to be typed)')
await ta.fill(NOTE)
await page.locator('.askpanel .dk-send').click()

// The note reads back in the thread, and a marker now sits on its anchor.
await page.waitForFunction(t => (document.querySelector('.askpanel .dk-threads')?.textContent || '').includes(t), NOTE, { timeout: 10000 })
  .catch(() => fail('the note did not appear in the thread'))
ok((await page.locator('.askpanel .dk-threads .dk-a').count()) === 0, 'a bare note rendered an (empty) answer bubble')
await page.waitForSelector('.ustory[data-anchor="story:0"] .askmark', { timeout: 5000 })
  .catch(() => fail('pinning a note did not put a marker on its anchor'))

// It is journaled: a reload brings it back, openable from the marker.
await page.reload()
await page.waitForTimeout(400)
await page.locator('#tabs .tab[data-pane="stories"]').click()
await page.waitForTimeout(200)
await page.waitForSelector('.ustory[data-anchor="story:0"] .askmark', { timeout: 5000 })
  .catch(() => fail('the note marker did not survive a reload'))
await page.locator('.ustory[data-anchor="story:0"] .askmark').click()
await page.waitForFunction(t => (document.querySelector('.askpanel .dk-threads')?.textContent || '').includes(t), NOTE, { timeout: 5000 })
  .catch(() => fail('the reloaded note lost its text'))

if (errors.length) fail('page errors:\n' + errors.join('\n'))
await browser.close()
proc.kill('SIGKILL')
console.log('OK: notes on the map (Note mode pins a bare remark with no model, it marks its anchor, reads back in the panel, and survives a reload)')
