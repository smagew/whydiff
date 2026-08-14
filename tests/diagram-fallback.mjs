#!/usr/bin/env node
// A diagram whose generated mermaid source is invalid must NOT show mermaid's
// built-in "Syntax error" graphic — the viewer validates each diagram and shows a
// readable fallback (source + Copy) instead, while the valid diagrams still render.
//
// Requires the `playwright` dev dependency and a chromium browser.

import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const rm = JSON.parse(readFileSync(join(root, 'examples', 'rate-limit', 'review-map.json'), 'utf8'))
for (const f of Object.values(rm.files)) delete f.embedFull // run anywhere (see smoke.mjs)
const validCount = (rm.diagrams || []).length
if (validCount < 1) { console.error('FAIL: the fixture has no diagrams to keep valid'); process.exit(1) }
// Prepend one deliberately broken diagram; the fixture's own diagrams stay valid.
rm.diagrams.unshift({ title: 'Deliberately broken', caption: 'x', mermaid: 'graph TD\n  A[Start] --> (((\n  B -->', files: [] })

const work = mkdtempSync(join(tmpdir(), 'whydiff-dgfallback-'))
const jsonPath = join(work, 'review-map.json'); writeFileSync(jsonPath, JSON.stringify(rm))
const htmlPath = join(work, 'review-map.html')
execFileSync('node', [join(root, 'scripts', 'assemble.mjs'), jsonPath, '--out', htmlPath], { stdio: 'inherit' })

const fail = (m) => { console.error(`FAIL: ${m}`); process.exit(1) }
const browser = await chromium.launch()
const page = await browser.newPage()
const errors = []
page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`))
page.on('console', (m) => { if (m.type() === 'error') errors.push(`console: ${m.text()}`) })

await page.goto('file://' + htmlPath)
await page.locator('#tabs .tab[data-pane="diagrams"]').click()
// Wait until the valid diagrams have rendered and the broken one has its fallback.
await page.waitForSelector('#pane-diagrams .mermaid-box.broken .dg-broken', { timeout: 15000 })
await page.waitForSelector('#pane-diagrams .mermaid-box svg', { timeout: 15000 })
await page.waitForTimeout(300)

const broken = await page.locator('#pane-diagrams .mermaid-box.broken').count()
if (broken !== 1) fail(`expected exactly one broken diagram, got ${broken}`)

// The fallback carries the source and a Copy button; a standalone file has no
// Regenerate button (it needs the live server), exactly like the rest of the ask UI.
if ((await page.locator('.dg-broken-copy').count()) !== 1) fail('the fallback has no Copy button')
if ((await page.locator('.dg-broken-src pre').count()) !== 1) fail('the fallback did not carry the diagram source')
if ((await page.locator('.dg-broken-regen').count()) !== 0) fail('a standalone file must not offer Regenerate (served-only)')

// mermaid's error graphic (bomb) must be gone — neither its "Syntax error" heading
// nor its "mermaid version" line (which the post-run check keys on) may reach the page.
const bodyText = await page.locator('body').innerText()
if (/Syntax error|mermaid version/i.test(bodyText)) fail('mermaid\'s "Syntax error" graphic reached the page')
const svgs = await page.locator('#pane-diagrams .mermaid-box:not(.broken) svg').count()
if (svgs < validCount) fail(`valid diagrams did not render alongside the broken one (${svgs} < ${validCount})`)

if (errors.length) fail(`page errors: ${errors.join(' | ')}`)
await browser.close()
console.log(`OK: diagram fallback (invalid diagram shows Copy + source, no "Syntax error"/"mermaid version" bomb, ${svgs} valid diagram(s) still rendered, Regenerate absent in a standalone file)`)
