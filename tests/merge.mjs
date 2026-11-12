#!/usr/bin/env node
// Contract test for scripts/merge.mjs: builds a throwaway git repo with a known
// diff, writes agent output files the way the agents now do, and checks that the
// merge reconciles them against git rather than trusting the model.
//
// Covers the failure modes seen in real runs: the pipeline's own .whydiff/ files
// leaking into the map, model-supplied line counts, a file no shard described,
// one file claimed by two groups, and edges pointing at dropped files.

import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { execFileSync, spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const repo = mkdtempSync(join(tmpdir(), 'whydiff-merge-'))
const wd = join(repo, '.whydiff')
const git = (...a) => execFileSync('git', ['-C', repo, ...a], { encoding: 'utf8' })

let failures = 0
const check = (ok, msg) => { if (!ok) { console.error(`FAIL: ${msg}`); failures++ } }

// ── a repo with one tracked change and one untracked file ────────────────────
git('init', '-q')
git('config', 'user.email', 'test@example.com')
git('config', 'user.name', 'test')
writeFileSync(join(repo, 'kept.txt'), 'one\ntwo\n')
writeFileSync(join(repo, 'code.php'), '<?php\nfunction old() { return 1; }\n')
git('add', '-A')
git('commit', '-qm', 'base')
writeFileSync(join(repo, 'kept.txt'), 'one\ntwo\nthree\n')
// Two hunks: the anchor lives in the second one, so a naive "first hunk" pick misses it.
writeFileSync(join(repo, 'code.php'), [
  '<?php',
  'const NOISE = 0;',
  'function old() { return 1; }',
  '',
  ...Array.from({ length: 12 }, (_, i) => `// filler ${i}`),
  '',
  'function interestingOne() { return DB::getOne("SELECT PrepareShutdownAfter FROM t"); }',
  '',
].join('\n'))
writeFileSync(join(repo, 'fresh.txt'), 'a\nb\n')
writeFileSync(join(repo, 'nobody-described.txt'), 'x\n')
writeFileSync(join(repo, 'generated.json'), JSON.stringify({ big: 'x'.repeat(500) }) + '\n')
writeFileSync(join(repo, 'orphan.txt'), 'no pass covered this\n')

mkdirSync(wd, { recursive: true })
const w = (name, obj) => writeFileSync(join(wd, name), JSON.stringify(obj))

w('narrative.json', {
  meta: { lang: 'en', ref: 'working tree', title: 'Merge test' },
  intent: 'A test change.',
  story: [{ label: 'Step', group: 'g1', text: 'happens', files: ['kept.txt'] }],
  groups: [
    { id: 'g1', name: 'One', role: 'read', why: 'authored once, by the orchestrator' },
    { id: 'unused', name: 'Nobody', role: 'context', why: 'no file assigned' },
  ],
  attentionFiles: 1,
  embedFull: ['kept.txt'],
  skip: ['generated.json'],
})

// Two shards: deliberately wrong line counts, an edge to a file that is not in
// the diff, and 'kept.txt' claimed by both groups.
w('classifier-a.json', {
  files: {
    'kept.txt': { service: 'core', role: 'edit', add: 999, del: 999, why: 'line added' },
    'gone.txt': { service: 'core', role: 'edit', why: 'not in the diff at all' },
    'code.php': { service: 'core', role: 'edit', why: 'new function', fragAnchor: 'interestingOne' },
    'generated.json': { service: 'other', role: 'plumbing', why: 'generated, skipped' },
    // A pass that still retypes code must not win over the patch.
    'nobody-described.txt': { service: 'core', role: 'edit', why: 'described after all', frag: [['add', 'INVENTED LINE']], preview: [['add', 'INVENTED LINE']] },
  },
  groups: [{ id: 'g1', files: ['kept.txt', 'gone.txt', 'code.php', 'generated.json', 'nobody-described.txt'] }],
  edges: [['kept.txt', 'gone.txt', 'points at a dropped file']],
  ops: { env: [], migrations: [], deploy: [], note: 'from a' },
})
w('classifier-b.json', {
  files: { 'fresh.txt': { service: 'core', role: 'new', isNew: false, why: 'brand new file' } },
  groups: [{ id: 'g2', name: 'Two', role: 'context', why: 'context', files: ['fresh.txt', 'kept.txt'] }],
  edges: [['fresh.txt', 'kept.txt', 'real edge']],
  ops: { env: [], migrations: [], deploy: [], note: 'from b' },
})
w('diagrammer.json', { diagrams: [] })
w('standards.json', { standards: [{ severity: 'ok', finding: 'fine' }], blastRadius: [] })
w('tests.json', { tests: { summary: 'none', fixed: [], gaps: [], files: [] } })

// The real patch, so fragment extraction has something to read. The run's own
// artifacts are untracked in this repo — exactly the leak to prevent.
writeFileSync(join(wd, 'diff.patch'), git('diff', 'HEAD'))

// ── run ───────────────────────────────────────────────────────────────────────
let stderr = ''
try {
  execFileSync('node', [join(root, 'scripts', 'merge.mjs'), '--repo', repo], { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] })
} catch (e) {
  console.error(`FAIL: merge.mjs exited non-zero\n${e.stdout || ''}${e.stderr || ''}`)
  rmSync(repo, { recursive: true, force: true })
  process.exit(1)
}
const rm = JSON.parse(readFileSync(join(wd, 'review-map.json'), 'utf8'))
const paths = Object.keys(rm.files).sort()

// ── assertions ────────────────────────────────────────────────────────────────
check(!paths.some(p => p.startsWith('.whydiff/')), `.whydiff/ artifacts leaked into files: ${paths.filter(p => p.startsWith('.whydiff/'))}`)
check(!rm.manifest.some(r => r[0].startsWith('.whydiff/')), '.whydiff/ artifacts leaked into the manifest')

check(rm.files['kept.txt']?.add === 1 && rm.files['kept.txt']?.del === 0,
  `line counts must come from git, got add=${rm.files['kept.txt']?.add} del=${rm.files['kept.txt']?.del}`)
check(rm.files['fresh.txt']?.isNew === true, 'untracked file must be marked isNew even when the shard said otherwise')
check(!rm.files['kept.txt']?.isNew, 'tracked file must not be marked isNew')

check(!rm.files['gone.txt'], 'a described file absent from the diff must be dropped')
check(rm.edges.length === 1 && rm.edges[0][0] === 'fresh.txt', `edges must be pruned to surviving files, got ${JSON.stringify(rm.edges)}`)

const owners = rm.groups.filter(g => g.files.includes('kept.txt'))
check(owners.length === 1, `kept.txt must belong to exactly one group, got ${owners.length}`)

// ── group metadata is authored once, by the orchestrator ─────────────────────
const g1 = rm.groups.find(g => g.id === 'g1')
check(g1?.why === 'authored once, by the orchestrator', `group metadata must come from narrative.json, got "${g1?.why}"`)
check(!rm.groups.some(g => g.id === 'unused'), 'a group with no files must be dropped')

// ── frag/preview come from the patch, never from the model ───────────────────
const kf = rm.files['kept.txt']
check(kf.frag?.length > 0, 'kept.txt got no fragment from the patch')
check(kf.frag.every(l => ['add', 'del', 'ctx'].includes(l[0])), `bad fragment classes: ${JSON.stringify(kf.frag)}`)
check(kf.frag.some(l => l[0] === 'add' && l[1] === 'three'), `fragment must contain the real added line, got ${JSON.stringify(kf.frag)}`)
check(kf.preview?.length >= 1 && kf.preview.length <= 2, `preview must be 1-2 lines, got ${kf.preview?.length}`)

const nd = rm.files['nobody-described.txt']
check(!nd.frag?.some(l => l[1] === 'INVENTED LINE'), 'a model-supplied fragment must be overwritten by the patch')
check(nd.frag?.some(l => l[1] === 'x'), `untracked file must get its opening lines, got ${JSON.stringify(nd.frag)}`)

// fragAnchor selects the hunk that matters, not merely the first one.
const cf = rm.files['code.php']
check(cf.frag?.some(l => l[1].includes('interestingOne')), `fragAnchor was ignored, got ${JSON.stringify(cf.frag)}`)
check(!('fragAnchor' in cf), 'fragAnchor must not survive into the map')

check(!rm.files['generated.json'].frag, 'a file listed in narrative.skip must get no fragment')

check(!!rm.files['orphan.txt'], 'a diff file no pass described must still reach the map')
check(rm.groups.some(g => g.id === 'unclassified' && g.files.includes('orphan.txt')),
  'an undescribed file must land in the unclassified group')

check(rm.files['kept.txt']?.embedFull === true, 'embedFull from narrative.json was not applied')
check(rm.meta.stats.filesChanged === 2 && rm.meta.stats.filesNew === 4,
  `stats must come from git, got ${JSON.stringify(rm.meta.stats)}`)
check(rm.meta.project === rm.meta.project && !!rm.meta.generatedAt, 'meta.generatedAt must be filled in')
check(rm.ops.note === 'from a from b', `shard ops must concatenate, got "${rm.ops.note}"`)

const manifestPaths = rm.manifest.map(r => r[0])
check(manifestPaths.length === Object.keys(rm.files).length, 'manifest and files must cover the same set')
check(rm.manifest.every(r => rm.groups.some(g => g.id === r[3])), 'every manifest row must name a real group')

// ── a map that cannot validate must not be written ───────────────────────────
rmSync(join(wd, 'review-map.json'))
w('narrative.json', { meta: { lang: 'en' }, story: [] })  // no intent
let refused = false
try { execFileSync('node', [join(root, 'scripts', 'merge.mjs'), '--repo', repo], { stdio: 'pipe' }) } catch { refused = true }
check(refused, 'merge.mjs must exit non-zero when the map would not validate')
let wrote = true
try { readFileSync(join(wd, 'review-map.json')) } catch { wrote = false }
check(!wrote, 'merge.mjs must not write a map that does not validate')

const runMerge = () => {
  // spawnSync: a successful merge still prints its repairs as warnings on stderr.
  const p = spawnSync('node', [join(root, 'scripts', 'merge.mjs'), '--repo', repo], { encoding: 'utf8' })
  return { ok: p.status === 0, err: `${p.stdout || ''}${p.stderr || ''}` }
}
const baseNarrative = { meta: { lang: 'en', ref: 'working tree', title: 'Merge test' }, intent: 'A test change.', story: [] }

// ── group metadata nobody supplied: refuse, and say where it belongs ─────────
// Seen in a real run: the orchestrator passed GROUPS: to the classifier (which then
// rightly emitted { id, files } only) but wrote narrative.json without `groups`. The
// map went out with nameless groups and the viewer printed "undefined" as headings.
w('narrative.json', baseNarrative)
w('classifier-b.json', { files: { 'fresh.txt': { service: 'core', role: 'new', why: 'brand new file' } }, groups: [{ id: 'g2', files: ['fresh.txt'] }], edges: [] })
let r = runMerge()
check(!r.ok, 'merge.mjs must refuse a map whose groups carry no name/role/why')
check(/g1/.test(r.err) && /narrative\.json/.test(r.err) && /\bname\b/.test(r.err),
  `the refusal must name the group, the missing field and narrative.json, got:\n${r.err}`)

// ── ops lists are strings; an agent's { name, note } objects are flattened ───
// The classifier emitted migrations as objects; the viewer rendered "[object Object]".
w('narrative.json', { ...baseNarrative, groups: [{ id: 'g1', name: 'One', role: 'read', why: 'w' }, { id: 'g2', name: 'Two', role: 'context', why: 'w' }] })
w('classifier-b.json', {
  files: { 'fresh.txt': { service: 'core', role: 'new', why: 'brand new file' } }, groups: [{ id: 'g2', files: ['fresh.txt'] }], edges: [],
  ops: { env: [], migrations: [{ name: '0806_add_flag', note: 'adds a nullable column' }, 'plain string'], deploy: [{ step: 'run migrate' }] },
})
r = runMerge()
check(r.ok, `merge.mjs must accept object-form ops entries by flattening them, got:\n${r.err}`)
if (r.ok) {
  const m2 = JSON.parse(readFileSync(join(wd, 'review-map.json'), 'utf8'))
  check(JSON.stringify(m2.ops.migrations) === JSON.stringify(['0806_add_flag — adds a nullable column', 'plain string']),
    `ops.migrations must be strings, got ${JSON.stringify(m2.ops.migrations)}`)
  check(JSON.stringify(m2.ops.deploy) === JSON.stringify(['run migrate']), `ops.deploy must be strings, got ${JSON.stringify(m2.ops.deploy)}`)
}

// ── storyboard: illustrator.json → map.storyboard, repaired where it can be ──
w('narrative.json', { ...baseNarrative, groups: [{ id: 'g1', name: 'One', role: 'read', why: 'w' }, { id: 'g2', name: 'Two', role: 'context', why: 'w' }] })
w('illustrator.json', { storyboard: {
  title: 'Story', cards: [
    { id: 'u', kind: 'person', title: 'User', text: 'does a thing', status: 'same' },
    { id: 1, kind: 'service', title: 'Svc', text: 'new path', status: 'added', files: ['kept.txt', 'not-in-diff.txt'] },
  ],
  arrows: [{ from: 'u', to: 1, label: 'asks' }, { from: 'u', to: 'ghost', label: 'to nowhere' }],
} })
r = runMerge()
check(r.ok, `merge.mjs must accept a repairable storyboard, got:\n${r.err}`)
if (r.ok) {
  const m3 = JSON.parse(readFileSync(join(wd, 'review-map.json'), 'utf8'))
  check(m3.storyboard?.cards?.length === 2, 'the storyboard reaches the map')
  check(JSON.stringify(m3.storyboard.cards[1].files) === '["kept.txt"]', `a card's file not in the diff is dropped, got ${JSON.stringify(m3.storyboard.cards[1].files)}`)
  check(m3.storyboard.cards[1].id === '1' && m3.storyboard.arrows.length === 1 && m3.storyboard.arrows[0].to === '1', `ids become strings and an arrow to no card is dropped, got ${JSON.stringify(m3.storyboard.arrows)}`)
}
check(/not-in-diff\.txt/.test(r.err) && /to nowhere/.test(r.err), `the repairs are reported as warnings, got:\n${r.err}`)
// A picture where nothing changed cannot be repaired: refuse it.
w('illustrator.json', { storyboard: { cards: [
  { id: 'a', kind: 'person', title: 'A', text: 't', status: 'same' }, { id: 'b', kind: 'service', title: 'B', text: 't', status: 'same' },
], arrows: [] } })
r = runMerge()
check(!r.ok && /no card is added, changed or removed/.test(r.err), `a storyboard that shows no change must be refused, got:\n${r.err}`)
w('illustrator.json', { storyboard: { cards: [{ id: 'a', kind: 'robot', title: 'A', text: 't', status: 'added' }, { id: 'b', kind: 'service', title: 'B', text: 't', status: 'same' }], arrows: [] } })
r = runMerge()
check(!r.ok && /kind: "robot" is not one of/.test(r.err), `an unknown card kind must be refused by the schema, got:\n${r.err}`)
rmSync(join(wd, 'illustrator.json'))

rmSync(repo, { recursive: true, force: true })
if (failures) { console.error(`\n${failures} check(s) failed`); process.exit(1) }
console.log(`OK: merge.mjs contract (${paths.length} files, ${rm.groups.length} groups, ${rm.edges.length} edges)`)
