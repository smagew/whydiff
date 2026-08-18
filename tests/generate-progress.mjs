#!/usr/bin/env node
// The on-demand generation progress bar (viewer's startGenProgress). A generated
// section is one open-ended agent, so the bar shows an APPROXIMATE estimate, not an
// exact %: it must actually ADVANCE while the pass reads, jump up when the pass starts
// writing its answer (the server's `writing` phase), and complete on done. This checks
// the client model directly — no `claude`, no server — by driving startGenProgress and
// reading the bar width. The read→write wiring itself is exercised by serve.mjs.

import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const fail = (m) => { console.error(`FAIL: ${m}`); process.exit(1) }
const ok = (c, m) => { if (!c) fail(m) }

const rm = JSON.parse(readFileSync(join(root, 'examples', 'rate-limit', 'review-map.json'), 'utf8'))
for (const f of Object.values(rm.files)) delete f.embedFull
const work = mkdtempSync(join(tmpdir(), 'whydiff-genprog-'))
const jsonPath = join(work, 'review-map.json'), htmlPath = join(work, 'review-map.html')
writeFileSync(jsonPath, JSON.stringify(rm))
execFileSync('node', [join(root, 'scripts', 'assemble.mjs'), jsonPath, '--out', htmlPath], { stdio: 'inherit' })

const browser = await chromium.launch()
const page = await browser.newPage()
const errors = []
page.on('pageerror', (e) => errors.push(String(e.message)))
await page.goto('file://' + htmlPath)

const r = await page.evaluate(async () => {
  if (typeof startGenProgress !== 'function') return { err: 'startGenProgress is not global' }
  const el = document.createElement('div'); el.className = 'lazy-steps'; el.hidden = true; document.body.appendChild(el)
  const p = startGenProgress(el)
  const width = () => parseFloat(el.querySelector('.genbar > span').style.width) || 0
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
  p.step('read app/plugins/hlr/clx_new.php')
  const w0 = width()
  await sleep(1600); const wReading1 = width()        // the bar creeps while reading
  await sleep(1600); const wReading2 = width()        // and keeps creeping
  p.writing()
  await sleep(700); const wWriting = width()          // jumps up when the pass starts writing
  p.done(); const wDone = width()                     // completes on done
  return { w0, wReading1, wReading2, wWriting, wDone, step: el.querySelector('.genstep').textContent, time: el.querySelector('.gentime').textContent }
})

ok(!r.err, r.err)
ok(r.wReading1 > r.w0, `the bar did not advance while reading (${r.w0}% → ${r.wReading1}%)`)
ok(r.wReading2 > r.wReading1, `the bar stopped advancing while reading (${r.wReading1}% → ${r.wReading2}%)`)
ok(r.wReading2 < 75, `the reading estimate ran past its cap (${r.wReading2}%) — it must leave room for the writing phase`)
ok(r.wWriting >= 76 && r.wWriting > r.wReading2, `the bar did not jump up on the writing phase (${r.wReading2}% → ${r.wWriting}%)`)
ok(r.wWriting < 100, `the bar reached 100% before done (${r.wWriting}%) — it must never fake completion`)
ok(r.wDone === 100, `the bar did not complete to 100% on done (${r.wDone}%)`)
ok(r.step === 'read app/plugins/hlr/clx_new.php', `the current step is not shown (got "${r.step}")`)
ok(/^\d+s$/.test(r.time), `the elapsed timer is not shown (got "${r.time}")`)
if (errors.length) fail('page errors:\n' + errors.join('\n'))

await browser.close()
console.log(`OK: generate progress bar — approximate estimate advances while reading (${r.w0}→${r.wReading1}→${r.wReading2}%), jumps on writing (${r.wWriting}%), completes on done (100%), never fakes 100% early`)
