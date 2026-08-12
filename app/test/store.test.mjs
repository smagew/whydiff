// The projects store, tested under plain node (no Electron): add local/github,
// dedup, list newest-first, remove, and the input guards.
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openStore, repoNameFromUrl } from '../src/main/store.mjs'

const fail = (m) => { console.error(`FAIL: ${m}`); process.exit(1) }
const ok = (c, m) => { if (!c) fail(m) }

const db = join(mkdtempSync(join(tmpdir(), 'wd-store-')), 't.db')
const s = openStore(db)

ok(s.listProjects().length === 0, 'starts empty')

const a = s.addProject({ kind: 'local', path: '/tmp/foo', name: 'foo' })
ok(a.id && a.kind === 'local' && a.path === '/tmp/foo' && a.url === null, 'added a local project')
ok(s.addProject({ kind: 'local', path: '/tmp/foo', name: 'foo' }).id === a.id, 'a local project dedups by path')

ok(repoNameFromUrl('https://github.com/owner/repo.git') === 'owner/repo', 'repo name from a URL')
const g = s.addProject({ kind: 'github', url: 'https://github.com/owner/repo', name: repoNameFromUrl('https://github.com/owner/repo') })
ok(g.kind === 'github' && g.url === 'https://github.com/owner/repo' && g.path === null && g.name === 'owner/repo', 'added a github project')
ok(s.addProject({ kind: 'github', url: 'https://github.com/owner/repo', name: 'x' }).id === g.id, 'a github project dedups by url')

const listed = s.listProjects()
ok(listed.length === 2, 'two projects listed')
ok(listed[0].id === g.id, 'newest is first')

ok(s.getProject(a.id)?.path === '/tmp/foo', 'get by id')
ok(s.removeProject(a.id) === true, 'remove returns true')
ok(s.listProjects().length === 1, 'one project left after remove')
ok(s.removeProject(999999) === false, 'removing a missing id returns false')

let threw = false
try { s.addProject({ kind: 'local', name: 'x' }) } catch { threw = true }
ok(threw, 'a local project without a path is refused')
threw = false
try { s.addProject({ kind: 'bogus', path: '/x', name: 'x' }) } catch { threw = true }
ok(threw, 'an unknown kind is refused')

console.log('OK: store (add local/github, dedup by path/url, list newest-first, get, remove, guards)')
