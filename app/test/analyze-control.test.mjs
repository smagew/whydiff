// Cancelling a run, and the preflight/last-run-log plumbing.
//  - whichBin: the preflight's executable lookup on a PATH string (no spawning).
//  - runAnalysis: a run killed via onChild rejects as { cancelled: true } (a user Cancel, not a
//    failure), and the full stdout+stderr is written to logPath on the way out (for "Show log").
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, chmodSync, existsSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { whichBin } from '../src/main/pathenv.mjs'
import { runAnalysis } from '../src/main/whydiff.mjs'

const dir = mkdtempSync(join(tmpdir(), 'wd-ctl-'))

// ── whichBin ──────────────────────────────────────────────────────────────────
if (process.platform !== 'win32') {
  const good = join(dir, 'mytool'); writeFileSync(good, '#!/bin/sh\necho hi\n'); chmodSync(good, 0o755)
  const nox = join(dir, 'notexec'); writeFileSync(nox, 'x\n'); chmodSync(nox, 0o644)
  assert.equal(whichBin('mytool', dir), good, 'whichBin finds an executable on the given PATH')
  assert.equal(whichBin('nope-xyz', dir), null, 'whichBin returns null for a missing binary')
  assert.equal(whichBin('notexec', dir), null, 'whichBin ignores a non-executable file (needs +x on POSIX)')
  assert.equal(whichBin('mytool', `/no/such:${dir}:/also/nope`), good, 'whichBin scans every PATH entry')
}

// ── runAnalysis: cancel ─────────────────────────────────────────────────────────
const sleeper = join(dir, 'sleep-run.mjs')
writeFileSync(sleeper, "process.stderr.write('starting the long run\\n'); setInterval(() => process.stderr.write('tick\\n'), 50)\n")
const logPath = join(dir, 'last-run.log')

let child
let outcome = 'resolved'
try {
  await runAnalysis(dir, '', {
    runScript: sleeper, logPath,
    onChild: (c) => { child = c; setTimeout(() => c.kill('SIGTERM'), 300) },
  })
} catch (e) {
  outcome = e.cancelled ? 'cancelled' : `error:${e.message}`
}
assert.equal(outcome, 'cancelled', 'a run killed via onChild rejects as cancelled, not a failure')
assert.ok(child && child.killed, 'the child was actually signalled')

// ── runAnalysis: the log is written (for "Show log"), even for the killed run ────
assert.ok(existsSync(logPath), 'runAnalysis writes the run log to logPath')
const log = readFileSync(logPath, 'utf8')
assert.match(log, /long run/, 'the log captures the run stderr')
assert.match(log, /signal=SIGTERM/, 'the log records how the run ended (the cancel signal)')

console.log('OK: analyze control (whichBin resolves/rejects executables on a PATH; a cancelled run rejects as cancelled not failure; the full run log is saved for Show-log)')
