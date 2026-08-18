#!/usr/bin/env node
// A shared/exported map (assemble --journal) must show its notes READ-ONLY, offline,
// with no server: the annotations render and read back, but nothing can be asked, decided
// or run. This assembles a map with a journal, opens the static file (file://, no server),
// and checks both halves — notes visible + interactive affordances gone.

import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const fail = (m) => { console.error(`FAIL: ${m}`); process.exit(1) }
const ok = (c, m) => { if (!c) fail(m) }

const work = mkdtempSync(join(tmpdir(), 'whydiff-export-'))
const rm = JSON.parse(readFileSync(join(root, 'examples', 'rate-limit', 'review-map.json'), 'utf8'))
for (const f of Object.values(rm.files)) delete f.embedFull
writeFileSync(join(work, 'review-map.json'), JSON.stringify(rm))
// A journal with a note pinned to a diagram node ("Auth" in flow diagram 0) and a bare
// note on a file — the kinds a shared review carries.
const ev = (o) => JSON.stringify({ at: '2026-08-15T00:00:00Z', by: 'ag', ...o })
writeFileSync(join(work, 'review.log.jsonl'), [
  ev({ type: 'note.added', noteId: 'n1', kind: 'note', anchor: { kind: 'diagram-node', key: 'diagram:0:auth', label: 'Request path → Auth' }, text: 'This gate is the auth check before the limiter.' }),
].join('\n') + '\n')

const html = join(work, 'review-map.html')
execFileSync('node', [join(root, 'scripts', 'assemble.mjs'), join(work, 'review-map.json'), '--journal', work, '--out', html], { stdio: 'inherit' })

const browser = await chromium.launch()
const page = await browser.newPage({ viewport: { width: 1400, height: 1000 } })
const errors = []
page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`))
page.on('console', (m) => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) errors.push(`console: ${m.text()}`) })
await page.goto('file://' + html)

// No server: the page is in read-only export mode (view-only), yet annotations are enabled.
ok(await page.evaluate(() => !window.__WHYDIFF_SERVE__), 'an exported file must not carry a live SERVE handle')
ok(await page.evaluate(() => document.body.classList.contains('view-only')), 'the exported map should be in view-only mode')
ok(await page.evaluate(() => document.body.classList.contains('can-ask')), 'annotations should still be enabled (can-ask) so the notes show')

// The diagram note draws a badge on its node; the tab is default but click to be sure.
await page.locator('#tabs .tab[data-pane="diagrams"]').click()
await page.waitForSelector('#pane-diagrams svg', { timeout: 15000 })
await page.waitForFunction(() => document.querySelectorAll('#pane-diagrams .dg-badge').length >= 1, null, { timeout: 10000 })
  .catch(() => fail('the baked diagram note did not draw a badge in the exported map'))

// Clicking the badge opens the note read-only: the text reads back, but the compose form
// (ask/note input + send) is gone.
await page.locator('#pane-diagrams .dg-badge').first().click()
await page.waitForTimeout(300)
ok(await page.locator('.askpanel.on').count(), 'clicking the badge did not open the note panel')
const threadText = (await page.locator('.askpanel .dk-threads').textContent()) || ''
ok(threadText.includes('This gate is the auth check'), `the note text did not read back (got: "${threadText.slice(0, 80)}")`)
const composeShown = await page.evaluate(() => { const f = document.querySelector('.askpanel .dk-form'); return f ? getComputedStyle(f).display !== 'none' : false })
ok(!composeShown, 'the compose form must be hidden in a read-only export')

// No write affordances anywhere: no ask entry buttons, no thread/task action buttons.
const writeControls = await page.evaluate(() => [...document.querySelectorAll('.dg-ask, .askbtn, .asksel, .dk-agree, .dk-make, .dk-notnow, .dk-pick, .tk-run, .tk-apply, .tk-reopen, .tk-decline')]
  .filter((e) => getComputedStyle(e).display !== 'none').length)
ok(writeControls === 0, `a read-only export still shows ${writeControls} write control(s)`)

if (errors.length) fail('page errors:\n' + errors.join('\n'))
await browser.close()
console.log('OK: exported map with a journal — notes render read-only (badge shows, text reads back), and every ask/decide/work affordance is gone; no server, no page errors')
