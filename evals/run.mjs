#!/usr/bin/env node
// Quality eval for the analysis passes: run the real pipeline on fixtures with a
// known meaning, and score whether the map got that meaning right.
//
//   node evals/run.mjs [case …] [--runs N] [--min 0..1] [--no-judge]
//   make eval [CASES="quick synthetic"] [RUNS=1]
//
// Per case (evals/<case>/expect.json, the case name = the fixture name):
//   1. prepare the fixture (tests/fixtures/prepare.mjs) and drop any old .whydiff/;
//   2. produce a core map headlessly with THIS working tree (scripts/run.mjs);
//   3. grade it deterministically (evals/_lib/grade.mjs) — the score that counts;
//   4. if the case has `judge` questions, ask a small model (haiku) yes/no about the
//      map's prose against the real diff, and whether the prose claims anything the
//      diff contradicts. Reported next to the score, never mixed into it.
//
// COSTS MONEY: every run is a full /whydiff pipeline on your Claude credential
// (~3 min each). This is on-demand only — never wire it into `make check` or CI.
// Results: evals/results/<timestamp>/<case>-<run>/ (git-ignored).
// Exit 0 when every run's deterministic score is >= --min (default 0.8).

import { spawn, execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync, existsSync, mkdirSync, rmSync, copyFileSync, readdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { grade, prose } from './_lib/grade.mjs'
import { fixturesDir } from '../tests/fixtures/dir.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..')
const args = process.argv.slice(2)
const opt = (n, d) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : d }
const runs = Number(opt('--runs', 1))
const min = Number(opt('--min', 0.8))
const judgeOn = !args.includes('--no-judge')
const all = readdirSync(here).filter((d) => existsSync(join(here, d, 'expect.json')))
const cases = args.filter((a, i) => !a.startsWith('--') && !['--runs', '--min'].includes(args[i - 1]))
const picked = cases.length ? cases : all
const unknown = picked.filter((c) => !all.includes(c))
if (unknown.length) { console.error(`unknown case(s): ${unknown.join(', ')} (known: ${all.join(', ')})`); process.exit(2) }

const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
const outRoot = join(here, 'results', stamp)
const sh = (cmd, a, o = {}) => execFileSync(cmd, a, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'], maxBuffer: 64 << 20, ...o })

// One `claude -p` call with no tools: the judge reads only what we hand it.
const ask = (prompt) => new Promise((ok, no) => {
  const child = spawn('claude', ['-p', prompt, '--model', 'haiku', '--output-format', 'json',
    '--disallowedTools', 'Bash,Edit,Write,NotebookEdit,Task,Agent,Read,Grep,Glob,WebFetch,WebSearch'],
  { stdio: ['ignore', 'pipe', 'pipe'] })
  let out = '', err = ''
  child.stdout.on('data', (d) => { out += d })
  child.stderr.on('data', (d) => { err += d })
  child.on('error', no)
  child.on('close', (code) => {
    if (code !== 0) return no(new Error(`judge exited ${code}: ${err.slice(0, 200)}`))
    try { ok(JSON.parse(out).result) } catch (e) { no(e) }
  })
})

async function judge(map, patch, questions) {
  const prompt = `You are auditing a code-review summary against the real diff it describes.
Answer strictly from the DIFF; the SUMMARY is the thing under test.

<diff>
${patch.slice(0, 60000)}
</diff>

<summary>
${prose(map).slice(0, 30000)}
</summary>

Questions (answer each yes or no — "yes" only if the SUMMARY clearly says it):
${questions.map((q, i) => `${i + 1}. ${q.q}`).join('\n')}

Also list every factual claim in the SUMMARY that the DIFF contradicts (not opinions or risks — claims of fact about what the code does). Empty if none.

Reply with ONLY this JSON, no prose, no code fence:
{"answers":[{"n":1,"verdict":"yes|no","evidence":"short quote from the summary or why not"}],"contradictions":["…"]}`
  const raw = await ask(prompt)
  const j = JSON.parse(String(raw).replace(/^```(json)?\s*|\s*```$/g, '').trim())
  const checks = questions.map((q, i) => {
    const a = (j.answers || []).find((x) => x.n === i + 1) || {}
    return { name: q.why, pass: a.verdict === 'yes', detail: a.evidence || '' }
  })
  const contra = j.contradictions || []
  checks.push({ name: 'no claim the diff contradicts', pass: !contra.length, detail: contra.join(' | ') })
  return checks
}

const rows = []
for (const name of picked) {
  const expect = JSON.parse(readFileSync(join(here, name, 'expect.json'), 'utf8'))
  console.log(`\n━━ ${name}`)
  sh(process.execPath, [join(root, 'tests', 'fixtures', 'prepare.mjs'), name], { stdio: ['ignore', 'ignore', 'inherit'] })
  const repo = join(fixturesDir(), name)
  const patch = sh('git', ['-C', repo, 'diff', 'HEAD~1..HEAD'])
  for (let r = 1; r <= runs; r++) {
    const out = join(outRoot, `${name}-${r}`)
    mkdirSync(out, { recursive: true })
    rmSync(join(repo, '.whydiff'), { recursive: true, force: true })
    const t0 = Date.now()
    let ok = true
    try {
      sh(process.execPath, [join(root, 'scripts', 'run.mjs'), repo, 'HEAD~1..HEAD', '--no-assemble', '--quiet'], { stdio: ['ignore', 'inherit', 'inherit'] })
    } catch { ok = false }
    const secs = Math.round((Date.now() - t0) / 1000)
    const mapPath = join(repo, '.whydiff', 'review-map.json')
    if (!ok || !existsSync(mapPath)) {
      console.log(`  run ${r}: PIPELINE FAILED after ${secs}s`)
      rows.push({ name, r, secs, score: 0, failed: true })
      continue
    }
    for (const f of ['review-map.json', 'timing-report.md', 'timing.jsonl']) {
      if (existsSync(join(repo, '.whydiff', f))) copyFileSync(join(repo, '.whydiff', f), join(out, f))
    }
    const map = JSON.parse(readFileSync(mapPath, 'utf8'))
    const det = grade(map, expect, { repo })
    let llm = null
    if (judgeOn && expect.judge?.length) {
      try { llm = await judge(map, patch, expect.judge) } catch (e) { llm = [{ name: 'judge ran', pass: false, detail: e.message }] }
    }
    const lines = [
      ...det.checks.map((c) => `${c.pass ? 'PASS' : 'FAIL'}  ${c.name}${!c.pass && c.detail ? `  (${c.detail})` : ''}`),
      `SCORE ${det.passed}/${det.total} = ${det.score.toFixed(2)}`,
      ...(llm ? ['', 'judge (haiku, advisory):', ...llm.map((c) => `${c.pass ? 'PASS' : 'FAIL'}  ${c.name}${c.detail ? `  — ${c.detail}` : ''}`)] : []),
    ]
    writeFileSync(join(out, 'grade.txt'), lines.join('\n') + '\n')
    for (const l of lines) if (!l.startsWith('PASS')) console.log(`  ${l}`)
    const jp = llm ? `${llm.filter((c) => c.pass).length}/${llm.length}` : '—'
    rows.push({ name, r, secs, score: det.score, det: `${det.passed}/${det.total}`, judge: jp })
  }
}

console.log(`\n${'case'.padEnd(12)} run  score       judge  time`)
for (const x of rows) {
  console.log(`${x.name.padEnd(12)} ${String(x.r).padEnd(4)} ${x.failed ? 'FAILED     ' : `${x.det.padEnd(6)}${x.score.toFixed(2)}`} ${String(x.judge ?? '—').padEnd(6)} ${x.secs}s`)
}
console.log(`\nresults: ${outRoot}`)
process.exit(rows.every((x) => !x.failed && x.score >= min) ? 0 : 1)
