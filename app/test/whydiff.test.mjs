// whydiff.mjs bridge — drive the runner and the server as child processes, with the
// real scripts stubbed so no model is called and no port work is needed.
import { mkdtempSync, writeFileSync, existsSync, readFileSync, chmodSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runAnalysis, serveMap } from '../src/main/whydiff.mjs'

const fail = (m) => { console.error(`FAIL: ${m}`); process.exit(1) }
const ok = (c, m) => { if (!c) fail(m) }

const dir = mkdtempSync(join(tmpdir(), 'wd-bridge-'))
const mkScript = (name, body) => { const p = join(dir, name); writeFileSync(p, `#!/usr/bin/env node\n${body}\n`); chmodSync(p, 0o755); return p }

// A stub runner: proves it got <repo> <range>, streams a progress line to stderr,
// writes the map, prints an OK summary, exits 0 — the shape scripts/run.mjs has.
const runOk = mkScript('run-ok.mjs', `
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
const [repo, range] = process.argv.slice(2)
if (!range) { console.error('no range'); process.exit(2) }
process.stderr.write('whydiff: ' + range + '\\n')
process.stderr.write('  · Agent whydiff:classifier\\n')
mkdirSync(join(repo, '.whydiff'), { recursive: true })
writeFileSync(join(repo, '.whydiff', 'review-map.json'), JSON.stringify({ ok: true, range }))
process.stdout.write('OK: 1 files\\n')
`)
const runFail = mkScript('run-fail.mjs', `process.stderr.write('boom\\n'); process.exit(1)`)

const repo = mkdtempSync(join(tmpdir(), 'wd-bridge-repo-'))
const steps = []
const res = await runAnalysis(repo, 'HEAD~1..HEAD', { runScript: runOk, onProgress: (s) => steps.push(s) })
ok(existsSync(res.mapPath), 'runAnalysis did not leave a map where it said')
ok(JSON.parse(readFileSync(res.mapPath, 'utf8')).range === 'HEAD~1..HEAD', 'the runner did not get the range')
ok(steps.some(s => /classifier/.test(s)), `progress was not streamed: ${JSON.stringify(steps)}`)

let failed = false
try { await runAnalysis(repo, 'HEAD~1..HEAD', { runScript: runFail }) } catch { failed = true }
ok(failed, 'a failing runner should reject')

// runAnalysis forwards the section selection + progress flag to run.mjs. A stub
// records its argv so both directions are checked.
const argvFile = join(dir, 'run-argv.json')
const runArgs = mkScript('run-argv.mjs', `
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
const [repo] = process.argv.slice(2)
writeFileSync(${JSON.stringify(argvFile)}, JSON.stringify(process.argv.slice(2)))
mkdirSync(join(repo, '.whydiff'), { recursive: true })
writeFileSync(join(repo, '.whydiff', 'review-map.json'), JSON.stringify({ ok: true }))
process.stdout.write('OK\\n')
`)
await runAnalysis(repo, '', { runScript: runArgs, sections: ['story', 'standards'], progressJson: true })
let av = JSON.parse(readFileSync(argvFile, 'utf8'))
ok(av.includes('--sections') && av[av.indexOf('--sections') + 1] === 'story,standards', `sections not forwarded: ${JSON.stringify(av)}`)
ok(av.includes('--progress-json'), 'progressJson not forwarded')
ok(!av.includes('--full'), 'a sections run must not pass --full')

await runAnalysis(repo, '', { runScript: runArgs, full: true })
av = JSON.parse(readFileSync(argvFile, 'utf8'))
ok(av.includes('--full') && !av.includes('--sections'), `full run should pass --full only: ${JSON.stringify(av)}`)

await runAnalysis(repo, '', { runScript: runArgs })
av = JSON.parse(readFileSync(argvFile, 'utf8'))
ok(!av.includes('--full') && !av.includes('--sections'), `a quick run passes neither: ${JSON.stringify(av)}`)

// A stub server: prints the startup URL line and stays alive until killed.
const serveOk = mkScript('serve-ok.mjs', `
process.stdout.write('whydiff serve: http://127.0.0.1:8123/\\n')
setInterval(() => {}, 1000)
`)
const s = await serveMap(repo, res.mapPath, { serveScript: serveOk })
ok(/^http:\/\/127\.0\.0\.1:8123\/$/.test(s.url), `serveMap did not surface the URL: ${s.url}`)
ok(typeof s.stop === 'function', 'serveMap did not return a stop()')
s.stop()

// serveMap forwards --work only when asked (the opt-in worktree "Do it"). A stub
// records its argv so we can assert both directions.
const argsFile = join(dir, 'serve-args.json')
const serveArgs = mkScript('serve-args.mjs', `
import { writeFileSync } from 'node:fs'
writeFileSync(${JSON.stringify(argsFile)}, JSON.stringify(process.argv.slice(2)))
process.stdout.write('http://127.0.0.1:8124/\\n')
setInterval(() => {}, 1000)
`)
const s2 = await serveMap(repo, res.mapPath, { serveScript: serveArgs, work: true })
ok(JSON.parse(readFileSync(argsFile, 'utf8')).includes('--work'), 'serveMap should pass --work when work:true')
s2.stop()
const s3 = await serveMap(repo, res.mapPath, { serveScript: serveArgs })
ok(!JSON.parse(readFileSync(argsFile, 'utf8')).includes('--work'), 'serveMap should NOT pass --work by default')
s3.stop()

console.log('OK: whydiff bridge (runAnalysis streams progress + returns the map path + rejects on failure; serveMap surfaces the localhost URL and a stop(); --work is opt-in)')
