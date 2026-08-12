// git.mjs — read-only git state over a temp repo.
import { execFileSync } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { gitState, rangeForCommit, recentCommits, EMPTY_TREE } from '../src/main/git.mjs'

const fail = (m) => { console.error(`FAIL: ${m}`); process.exit(1) }
const ok = (c, m) => { if (!c) fail(m) }

const repo = mkdtempSync(join(tmpdir(), 'wd-git-'))
const git = (...a) => execFileSync('git', ['-C', repo, ...a], { encoding: 'utf8' })
git('init', '-q'); git('config', 'user.email', 't@e'); git('config', 'user.name', 'T')
writeFileSync(join(repo, 'f.txt'), 'a\n'); git('add', '-A'); git('commit', '-qm', 'one')
writeFileSync(join(repo, 'f.txt'), 'b\n'); git('add', '-A'); git('commit', '-qm', 'two')
writeFileSync(join(repo, 'f.txt'), 'c\n') // uncommitted

const st = await gitState(repo)
ok(st.ok, `gitState should be ok: ${st.reason}`)
ok(st.uncommitted.dirty && st.uncommitted.count >= 1, 'uncommitted change not detected')
ok(st.commits.length === 2, `expected 2 commits, got ${st.commits.length}`)
ok(st.commits[0].subject === 'two', `newest commit should be first: ${st.commits[0].subject}`)
ok(st.commits[0].hash && st.commits[0].short && st.commits[0].date, 'commit record is incomplete')

const commits = await recentCommits(repo, 30)
ok((await rangeForCommit(repo, commits[0].hash)) === `${commits[0].hash}^..${commits[0].hash}`, 'range for a normal commit is parent..commit')
const root = commits[1].hash
ok((await rangeForCommit(repo, root)) === `${EMPTY_TREE}..${root}`, 'range for the root commit falls back to the empty tree')

const notRepo = mkdtempSync(join(tmpdir(), 'wd-notgit-'))
ok((await gitState(notRepo)).ok === false, 'a non-repo should report ok:false')

console.log('OK: git (uncommitted detection, commits newest-first, range parent..commit and empty-tree..root, non-repo handled)')
