#!/usr/bin/env node
// Contract: every diff file's status comes from git, renames included. Builds a repo
// with one file of each kind (modified, added, deleted, renamed with an edit, and an
// untracked one) and checks collectManifest for a working-tree run AND a commit range,
// then that merge.mjs carries status/from into the map. A rename used to reach the map
// as the literal path "src/{old => new}.ts" (git's --numstat display form).

import { mkdtempSync, writeFileSync, mkdirSync, rmSync, readFileSync, renameSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { collectManifest } from '../scripts/lib.mjs'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
let failures = 0
const check = (c, m) => { if (!c) { console.error(`FAIL: ${m}`); failures++ } }
const repo = mkdtempSync(join(tmpdir(), 'whydiff-status-'))
const git = (...a) => execFileSync('git', ['-C', repo, ...a], { encoding: 'utf8' })
git('init', '-q'); git('config', 'user.email', 't@example.com'); git('config', 'user.name', 't')
mkdirSync(join(repo, 'src', 'old'), { recursive: true })
const body = Array.from({ length: 30 }, (_, i) => `line ${i}`).join('\n') + '\n'
writeFileSync(join(repo, 'src', 'edit.ts'), 'a\nb\n')
writeFileSync(join(repo, 'src', 'gone.ts'), 'x\ny\nz\n')
writeFileSync(join(repo, 'src', 'old', 'name.ts'), body)
git('add', '-A'); git('commit', '-qm', 'base')

// The change: modify, add, delete, rename (+1 line), and an untracked file.
writeFileSync(join(repo, 'src', 'edit.ts'), 'a\nb\nc\n')
writeFileSync(join(repo, 'src', 'added.ts'), 'new\n')
rmSync(join(repo, 'src', 'gone.ts'))
mkdirSync(join(repo, 'src', 'new'), { recursive: true })
renameSync(join(repo, 'src', 'old', 'name.ts'), join(repo, 'src', 'new', 'name.ts'))
writeFileSync(join(repo, 'src', 'new', 'name.ts'), body + 'one more\n')
git('add', 'src/edit.ts', 'src/added.ts', 'src/gone.ts', 'src/old/name.ts', 'src/new/name.ts')
writeFileSync(join(repo, 'untracked.md'), 'u\n')

const expectRows = (label, rows, want) => {
  const by = Object.fromEntries(rows.map(r => [r[0], r]))
  check(!rows.some(r => /=>|[{}]/.test(r[0])), `${label}: a path is git's rename display form: ${rows.map(r => r[0]).join(', ')}`)
  for (const [path, status, from] of want) {
    const r = by[path]
    if (!r) { check(false, `${label}: ${path} missing (rows: ${rows.map(r => r[0]).join(', ')})`); continue }
    check(r[4] === status, `${label}: ${path} status ${r[4]}, want ${status}`)
    check(r[3] === (status === 'added'), `${label}: ${path} isNew ${r[3]} disagrees with status ${status}`)
    check((r[5] || null) === (from || null), `${label}: ${path} from ${r[5]}, want ${from}`)
  }
  check(rows.length === want.length, `${label}: ${rows.length} rows, want ${want.length}`)
}
const WT = [['src/edit.ts', 'modified'], ['src/added.ts', 'added'], ['src/gone.ts', 'deleted'], ['src/new/name.ts', 'renamed', 'src/old/name.ts'], ['untracked.md', 'added']]
expectRows('working tree', collectManifest(repo).rows, WT)
const rn = collectManifest(repo).rows.find(r => r[0] === 'src/new/name.ts')
check(rn && rn[1] === 1 && rn[2] === 0, `a rename counts only its edit (+1/-0), got +${rn?.[1]}/-${rn?.[2]}`)

git('add', '-A'); git('commit', '-qm', 'change')
expectRows('range HEAD~1..HEAD', collectManifest(repo, 'HEAD~1..HEAD').rows, WT)

// merge.mjs: the map's files carry git's status and the old path.
const wd = join(repo, '.whydiff'); mkdirSync(wd)
const files = Object.fromEntries(WT.map(([p]) => [p, { service: 'core', role: 'edit', why: 'w' }]))
writeFileSync(join(wd, 'narrative.json'), JSON.stringify({ meta: { lang: 'en' }, intent: 'i', story: [], groups: [{ id: 'g', name: 'G', role: 'read', why: 'w' }] }))
writeFileSync(join(wd, 'classifier.json'), JSON.stringify({ files, groups: [{ id: 'g', files: Object.keys(files) }], edges: [] }))
writeFileSync(join(wd, 'diff.patch'), git('diff', 'HEAD~1..HEAD'))
try {
  execFileSync(process.execPath, [join(root, 'scripts', 'merge.mjs'), '--repo', repo, '--ref', 'HEAD~1..HEAD'], { stdio: 'pipe' })
  const rm = JSON.parse(readFileSync(join(wd, 'review-map.json'), 'utf8'))
  for (const [p, status, from] of WT) {
    check(rm.files[p]?.status === status, `map: ${p} status ${rm.files[p]?.status}, want ${status}`)
    check((rm.files[p]?.from || null) === (from || null), `map: ${p} from ${rm.files[p]?.from}, want ${from}`)
  }
  check(rm.files['src/new/name.ts']?.frag?.length > 0, 'a renamed file still gets its code fragment from the patch')
} catch (e) { check(false, `merge.mjs failed: ${e.stderr || e.message}`) }

rmSync(repo, { recursive: true, force: true })
if (failures) { console.error(`\nmanifest-status: ${failures} failure(s)`); process.exit(1) }
console.log('OK: manifest status — modified/added/deleted/renamed/untracked from git (working tree + range), renames as real paths with their old path, carried into the map')
