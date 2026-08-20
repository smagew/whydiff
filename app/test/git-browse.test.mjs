// Browsing a repo's history from the app: which branches are offered, paging further back,
// comparing two refs, and not leaving PR scratch refs behind. Everything runs against a real
// throwaway repository — these are thin wrappers over git, so a mock would only test itself.
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { gitState, moreCommits, listBranches, compareRange, refExists, prunePrRefs, PR_REF_PREFIX } from '../src/main/git.mjs'

const run = (dir, ...args) => execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] })
const repo = mkdtempSync(join(tmpdir(), 'whydiff-git-'))
let failures = 0
const check = (name, fn) => fn().then(
  () => console.log(`  ✓ ${name}`),
  (e) => { failures++; console.error(`  ✗ ${name}\n    ${e.message}`) })

run(repo, 'init', '-q', '-b', 'main', '.')
run(repo, 'config', 'user.email', 't@example.com')
run(repo, 'config', 'user.name', 'Test')
for (let i = 1; i <= 8; i++) {
  writeFileSync(join(repo, `f${i}.txt`), `content ${i}\n`)
  run(repo, 'add', '-A')
  run(repo, 'commit', '-qm', `commit ${i}`)
}
run(repo, 'branch', 'feature/x')
run(repo, 'checkout', '-q', 'feature/x')
writeFileSync(join(repo, 'only-on-feature.txt'), 'x\n')
run(repo, 'add', '-A')
run(repo, 'commit', '-qm', 'feature work')
run(repo, 'checkout', '-q', 'main')

console.log('git-browse')

await check('gitState pages the log and says whether more exist', async () => {
  const st = await gitState(repo, { limit: 3 })
  assert.equal(st.ok, true)
  assert.equal(st.commits.length, 3, 'the limit is respected')
  assert.equal(st.more, true, 'more commits exist behind the limit')
  assert.equal(st.commits[0].subject, 'commit 8', 'newest first')
  const all = await gitState(repo, { limit: 50 })
  assert.equal(all.more, false, 'no more once the whole log fits')
})

await check('a second page continues where the first stopped, without repeats', async () => {
  const first = await gitState(repo, { limit: 3 })
  const next = await moreCommits(repo, { limit: 3, skip: 3 })
  const overlap = next.commits.filter((c) => first.commits.some((f) => f.hash === c.hash))
  assert.deepEqual(overlap, [], 'the pages do not overlap')
  assert.equal(next.commits[0].subject, 'commit 5')
})

await check('a branch other than the checked-out one can be walked', async () => {
  const onMain = await gitState(repo, { limit: 5 })
  assert.equal(onMain.commits[0].subject, 'commit 8')
  const onFeature = await gitState(repo, { limit: 5, ref: 'feature/x' })
  assert.equal(onFeature.commits[0].subject, 'feature work', 'the branch we asked for, not HEAD')
  assert.equal(onFeature.branch, 'main', 'the checked-out branch is still reported as such')
})

await check('branches are listed with the current one named', async () => {
  const b = await listBranches(repo)
  assert.equal(b.current, 'main')
  assert.ok(b.local.includes('feature/x'), 'other local branches are offered')
  assert.ok(b.local.includes('main'))
})

await check('a comparison range is base...head, and unknown refs are named', async () => {
  assert.equal(await compareRange(repo, 'main', 'feature/x'), 'main...feature/x')
  await assert.rejects(() => compareRange(repo, 'main', 'no-such-branch'), /unknown ref: no-such-branch/)
  await assert.rejects(() => compareRange(repo, '', 'main'), /pick both/)
  assert.equal(await refExists(repo, 'feature/x'), true)
  assert.equal(await refExists(repo, 'nope'), false)
})

// The regression this file exists for: every analysed PR used to leave its scratch ref in
// the clone forever, pinning objects against gc.
await check('PR scratch refs are pruned to the most recent few', async () => {
  for (const n of [1, 2, 3, 4, 5, 6, 7]) run(repo, 'branch', `${PR_REF_PREFIX}${n}`, 'main')
  const before = run(repo, 'for-each-ref', '--format=%(refname:short)', `refs/heads/${PR_REF_PREFIX}*`).split('\n').filter(Boolean)
  assert.equal(before.length, 7, 'seven scratch refs to start with')
  await prunePrRefs(repo, { keep: 5, exclude: [`${PR_REF_PREFIX}7`] })
  const after = run(repo, 'for-each-ref', '--format=%(refname:short)', `refs/heads/${PR_REF_PREFIX}*`).split('\n').filter(Boolean)
  assert.equal(after.length, 5, 'pruned down to the keep count')
  assert.ok(after.includes(`${PR_REF_PREFIX}7`), 'the ref in use is never dropped')
  const branches = await listBranches(repo)
  assert.deepEqual(branches.local.filter((n) => n.startsWith(PR_REF_PREFIX)), [], 'scratch refs are not offered as branches')
})

rmSync(repo, { recursive: true, force: true })
if (failures) { console.error(`\n${failures} failing`); process.exit(1) }
console.log('git-browse: ok')
