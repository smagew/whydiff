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

// ── analyses index ───────────────────────────────────────────────────────────
const proj = s.addProject({ kind: 'local', path: '/tmp/bar', name: 'bar' })
const an1 = s.addAnalysis({ projectId: proj.id, kind: 'commit', ref: 'abc123', title: 't1' })
ok(an1.id && an1.projectId === proj.id && an1.ref === 'abc123', 'added a commit analysis')
const an2 = s.addAnalysis({ projectId: proj.id, kind: 'working', ref: '', title: 'wt' })
ok(s.listAnalyses({ projectId: proj.id }).length === 2, 'two analyses for the project')
ok(s.listAnalyses({ projectId: proj.id })[0].id === an2.id, 'analyses are newest-first')
ok(s.analysisForRef(proj.id, 'abc123')?.id === an1.id, 'analysisForRef finds a commit map')
ok(s.analysisForRef(proj.id, 'nope') === null, 'analysisForRef is null when none match')
ok(s.getAnalysis(an1.id)?.title === 't1', 'getAnalysis by id')
// touchAnalysis: keeps id/ref/title, restamps created_at so it sorts to the top
const t0 = s.getAnalysis(an1.id).created_at
const touched = s.touchAnalysis(an1.id)
ok(touched?.id === an1.id && touched.ref === 'abc123' && touched.title === 't1', 'touchAnalysis keeps id/ref/title')
ok(touched.created_at >= t0, 'touchAnalysis restamps created_at')
ok(s.touchAnalysis(999999) === null, 'touchAnalysis on a missing id is null')
ok(s.listAnalyses({ limit: 1 }).length === 1, 'listAnalyses honours limit')
let threwA = false
try { s.addAnalysis({ projectId: 999999, kind: 'commit', ref: 'x' }) } catch { threwA = true }
ok(threwA, 'an analysis for an unknown project is refused')
ok(s.removeAnalysis(an1.id) === true, 'removeAnalysis')
ok(s.listAnalyses({ projectId: proj.id }).length === 1, 'one analysis left after remove')
// a reopened store keeps analyses (persistence)
ok(openStore(db).listAnalyses({ projectId: proj.id }).length === 1, 'analyses persist across reopen')

console.log('OK: store (projects: add/dedup/list/remove; analyses: add/list newest-first/forRef/limit/remove/persist; guards)')
