#!/usr/bin/env node
// The post-Generate reload must not break the diagrams.
//
// After generating a lazy section (User stories / Summary), generate() sets a one-shot
// `flashTab` and reloads. On that reload the default-tab logic starts rendering Diagrams
// eagerly, but flashTab immediately switches to the generated tab — so the scheduled mermaid
// render used to run into a now-HIDDEN pane, producing "translate(undefined, NaN)" and a broken
// diagram that then stuck (the render was latched, so opening Diagrams never re-rendered it).
// This reproduces that exact race by injecting the flashTab the reload would carry, then asserts
// the GOAL: the diagrams render whole when Diagrams is opened, with no NaN geometry.
import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const fail = (m) => { console.error(`FAIL: ${m}`); process.exit(1) }
const ok = (c, m) => { if (!c) fail(m) }

const work = mkdtempSync(join(tmpdir(), 'whydiff-flash-'))
const rm = JSON.parse(readFileSync(join(root, 'examples', 'rate-limit', 'review-map.json'), 'utf8'))
for (const f of Object.values(rm.files)) delete f.embedFull
writeFileSync(join(work, 'review-map.json'), JSON.stringify(rm))
const nDiagrams = (rm.diagrams || []).length
const sessionKey = `whydiff:${rm.meta.project}:${rm.meta.ref}` // where the viewer keeps flashTab

const html = join(work, 'review-map.html')
execFileSync('node', [join(root, 'scripts', 'assemble.mjs'), join(work, 'review-map.json'), '--out', html], { stdio: 'inherit' })

const browser = await chromium.launch()
const page = await browser.newPage({ viewport: { width: 1300, height: 900 } })
const errors = []
page.on('pageerror', (e) => errors.push(e.message))
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()) })
// Carry the flashTab the reload after a Generate would carry: open on the User stories tab, not
// Diagrams — the exact condition that raced the eager diagram render into a hidden pane.
await page.addInitScript(([k]) => { try { localStorage.setItem(k, JSON.stringify({ flashTab: 'stories' })) } catch {} }, [sessionKey])
await page.goto('file://' + html)
await page.waitForTimeout(600)
ok(await page.evaluate(() => document.querySelector('#tabs .tab.active')?.dataset.pane) === 'stories', 'flashTab must open the generated tab (stories), reproducing the reload')

// Now open Diagrams, as the user does after the reload.
await page.locator('#tabs .tab[data-pane="diagrams"]').click()
await page.waitForTimeout(2000)
const state = await page.evaluate(() => ({
  svgs: document.querySelectorAll('#pane-diagrams .mermaid-box svg').length,
  broken: document.querySelectorAll('#pane-diagrams .mermaid-box.broken').length,
}))
ok(state.svgs === nDiagrams, `every diagram must render after the flashTab reload (got ${state.svgs}/${nDiagrams} svgs)`)
ok(state.broken === 0, `no diagram may be broken after the flashTab reload (got ${state.broken})`)
const nanErrs = errors.filter((e) => /NaN|translate\(undefined/.test(e))
ok(nanErrs.length === 0, `mermaid must not render into a hidden pane — no NaN geometry (got ${nanErrs.length}: ${nanErrs[0] || ''})`)

await browser.close()
console.log('OK: diagram flashTab — the post-Generate reload (open on another tab) renders the diagrams whole when opened, never broken into a hidden pane')
