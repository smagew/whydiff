// github.mjs pure helpers + git.mjs clone (against a local repo, no network).
import { execFileSync } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parseRepo, mapPRs } from '../src/main/github.mjs'
import { clone, gitState } from '../src/main/git.mjs'

const fail = (m) => { console.error(`FAIL: ${m}`); process.exit(1) }
const ok = (c, m) => { if (!c) fail(m) }

// parseRepo
for (const [url, exp] of [
  ['https://github.com/owner/repo', 'owner/repo'],
  ['https://github.com/owner/repo.git', 'owner/repo'],
  ['git@github.com:owner/repo.git', 'owner/repo'],
  ['https://github.com/o/r/pulls', 'o/r'],
]) {
  const r = parseRepo(url)
  ok(r && `${r.owner}/${r.repo}` === exp, `parseRepo(${url}) → ${JSON.stringify(r)}`)
}
ok(parseRepo('https://gitlab.com/o/r') === null, 'parseRepo rejects non-GitHub')

// mapPRs
const mapped = mapPRs([{ number: 7, title: 'Add thing', user: { login: 'ann' }, base: { ref: 'main' }, head: { ref: 'feat' }, updated_at: '2026-08-12T09:00:00Z', draft: true }])
ok(mapped.length === 1, 'mapPRs length')
ok(mapped[0].number === 7 && mapped[0].author === 'ann' && mapped[0].baseRef === 'main' && mapped[0].headRef === 'feat' && mapped[0].draft === true && mapped[0].updated === '2026-08-12', `mapPRs shape: ${JSON.stringify(mapped[0])}`)
ok(mapPRs(null).length === 0, 'mapPRs tolerates non-arrays')

// clone: make a local source repo, clone it, read its state
const src = mkdtempSync(join(tmpdir(), 'wd-src-'))
const g = (...a) => execFileSync('git', ['-C', src, ...a], { encoding: 'utf8' })
g('init', '-q'); g('config', 'user.email', 't@e'); g('config', 'user.name', 'T')
writeFileSync(join(src, 'f.txt'), 'a\n'); g('add', '-A'); g('commit', '-qm', 'first')
const dest = join(mkdtempSync(join(tmpdir(), 'wd-clonedest-')), 'clone')
await clone(src, dest)
const st = await gitState(dest)
ok(st.ok && st.commits.length === 1 && st.commits[0].subject === 'first', `cloned repo state: ${JSON.stringify(st).slice(0, 120)}`)

console.log('OK: github (parseRepo owner/repo from every URL form + rejects non-GitHub; mapPRs shape; clone a repo and read its state)')
