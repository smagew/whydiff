#!/usr/bin/env node
// Contract test for scripts/serve.mjs: token gating, the ask and instruct
// round-trips, journal persistence, the Tasks tab, and the browser side of all of
// it appearing only when served.
//
// `claude` is stubbed with a script that echoes a fixed answer, so this test
// never calls a model and never costs anything.

import { readFileSync, writeFileSync, mkdtempSync, chmodSync, existsSync } from 'node:fs'
import { spawn } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const fail = (msg) => { console.error(`FAIL: ${msg}`); process.exit(1) }

const work = mkdtempSync(join(tmpdir(), 'whydiff-serve-'))
const rm = JSON.parse(readFileSync(join(root, 'examples', 'rate-limit', 'review-map.json'), 'utf8'))
for (const f of Object.values(rm.files)) delete f.embedFull
const paths = Object.keys(rm.files)
rm.userStories = {
  summary: 'Serve-test summary.',
  stories: [{ actor: 'caller', story: 'I get a clear error when I exceed the limit.', status: 'partial', why: 'guard added', files: [paths[0]], covered: false }],
}
const mapPath = join(work, 'review-map.json')
writeFileSync(mapPath, JSON.stringify(rm))

// Stubbed CLI: emits the same stream-json event shapes the real one does, so the
// streaming path (tool steps, text deltas, final result) is exercised for free.
const stub = join(work, 'fake-claude')
writeFileSync(stub, `#!/usr/bin/env node
const args = process.argv.slice(2)
const prompt = args[args.indexOf('-p') + 1] || ''
// Prove the prompt carried the anchor through to the CLI.
const sawAnchor = /Anchor kind:/.test(prompt) ? 'anchored' : 'no-anchor'
const say = (o) => process.stdout.write(JSON.stringify(o) + '\\n')
// The instruct path asks for a plan; answer it the way the prompt demands, prose
// followed by one fenced json block, so the split and the Agree button are real.
if (/Produce a PLAN/.test(prompt)) {
  if (!/read-only tools/.test(prompt)) { console.error('plan prompt did not forbid editing'); process.exit(3) }
  if (args.indexOf('--allowedTools') < 0) { console.error('planning ran without a tool allowlist'); process.exit(3) }
  // An allowlist alone leaves the editing tools reachable; the deny list is what
  // makes "this server does not change the repo" true of the process.
  const deny = args[args.indexOf('--disallowedTools') + 1] || ''
  for (const t of ['Edit', 'Write', 'Bash', 'Task']) {
    if (!deny.includes(t)) { console.error('planning could still reach ' + t); process.exit(3) }
  }
  const prose = 'STUB PLAN (' + sawAnchor + '): guard the unshipped path in \`api/refunds.py\`.'
  const plan = { spec: 'Settle refunds for unshipped orders.', acceptance: { type: 'test', name: 'test_refund_unshipped_order_settles' }, files: ['src/middleware/rateLimit.ts'], risks: ['payout worker'], questions: [] }
  for (const t of [prose, '\\n\\n'])
    say({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: t } } })
  say({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: '\\\`\\\`\\\`json\\n' + JSON.stringify(plan) + '\\n\\\`\\\`\\\`' } } })
  say({ type: 'result', subtype: 'success', result: prose + '\\n\\n\\\`\\\`\\\`json\\n' + JSON.stringify(plan) + '\\n\\\`\\\`\\\`' })
  process.exit(0)
}
// Options: three kinds asked for, and deliberately sloppy output — an invented
// kind, a duplicate kind, a variant with no criterion — so normalisation is real.
if (/Give TWO or THREE options/.test(prompt)) {
  const prose = 'STUB OPTIONS (' + sawAnchor + '): the guard runs too late.'
  const body = { variants: [
    { kind: 'local', what: 'Guard the unshipped path at the call site.', cost: 'an hour', risk: 'none', blast: [], acceptance: { type: 'test', name: 'test_guard_at_call_site' } },
    { kind: 'cheap', what: 'invented kind, must be dropped', acceptance: { type: 'manual', what: 'x' } },
    { kind: 'root', what: 'Move settlement into the refund path.', cost: 'a day', risk: 'the payout worker', blast: ['worker/src/payouts.ts'] },
    { kind: 'local', what: 'duplicate kind, must be dropped', acceptance: { type: 'manual', what: 'x' } },
  ], noFixNeeded: null }
  say({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: prose } } })
  const F = String.fromCharCode(96).repeat(3)
  say({ type: 'result', subtype: 'success', result: prose + '\\n\\n' + F + 'json\\n' + JSON.stringify(body) + '\\n' + F })
  process.exit(0)
}
say({ type: 'system', subtype: 'init' })
say({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Read', input: { file_path: '/x/worker/src/refunds.ts' } }] } })
say({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Grep', input: { pattern: 'payout' } }] } })
for (const t of ['STUB ', 'ANSWER ', '(' + sawAnchor + ')'])
  say({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: t } } })
say({ type: 'result', subtype: 'success', result: 'STUB **ANSWER** (' + sawAnchor + ') with \\\`inline\\\` code\\n\\n- first\\n- second' })
`)
chmodSync(stub, 0o755)

const port = 7791 + (process.pid % 90)
const proc = spawn('node', [join(root, 'scripts', 'serve.mjs'), mapPath, '--repo', root, '--port', String(port), '--claude-cmd', stub],
  { stdio: ['ignore', 'pipe', 'pipe'] })
let out = ''
proc.stdout.on('data', (d) => { out += d })
proc.stderr.on('data', (d) => { out += d })
const stop = () => { try { proc.kill('SIGKILL') } catch {} }
process.on('exit', stop)

const base = `http://127.0.0.1:${port}`
const waitUp = async () => {
  for (let i = 0; i < 100; i++) {
    try { const r = await fetch(base + '/'); if (r.ok) return } catch {}
    await new Promise(r => setTimeout(r, 100))
  }
  fail(`server did not come up on ${port}:\n${out}`)
}
await waitUp()

// The token is injected into the served page only.
const page0 = await (await fetch(base + '/')).text()
const token = page0.match(/__WHYDIFF_SERVE__=\{"token":"([a-f0-9]+)"/)?.[1]
if (!token) fail('served page does not carry an injected token')

// Unauthenticated API calls are refused.
const noTok = await fetch(base + '/api/ping')
if (noTok.status !== 403) fail(`expected 403 without a token, got ${noTok.status}`)
const badTok = await fetch(base + '/api/ping', { headers: { 'x-whydiff-token': 'deadbeef' } })
if (badTok.status !== 403) fail(`expected 403 with a wrong token, got ${badTok.status}`)

const H = { 'x-whydiff-token': token, 'content-type': 'application/json' }
const ping = await (await fetch(base + '/api/ping', { headers: H })).json()
if (!ping.ok) fail('ping did not report ok')

// An empty question is rejected before the CLI is ever spawned.
const empty = await fetch(base + '/api/ask', { method: 'POST', headers: H, body: JSON.stringify({ question: '   ' }) })
if (empty.status !== 400) fail(`expected 400 for an empty question, got ${empty.status}`)

// Round-trip. The response is a stream of NDJSON events, not one JSON object:
// steps and deltas arrive while the CLI works, then a final `done`.
const askRes = await fetch(base + '/api/ask', {
  method: 'POST', headers: H,
  body: JSON.stringify({ anchorKey: 'story:0', anchor: { kind: 'story', key: 'story:0', label: 'caller: I get a clear error', context: 'partial' }, question: 'Why is this partial?' }),
})
if (!askRes.ok) fail(`ask failed: ${askRes.status} ${await askRes.text()}`)
if (!/ndjson/.test(askRes.headers.get('content-type') || '')) fail('ask did not answer as a stream')
const events = (await askRes.text()).split('\n').filter(Boolean).map(l => JSON.parse(l))
const kinds = events.map(e => e.kind)
if (!kinds.includes('step')) fail(`no tool steps streamed: ${kinds.join(',')}`)
if (!kinds.includes('delta')) fail(`no text deltas streamed: ${kinds.join(',')}`)
if (kinds[kinds.length - 1] !== 'done') fail(`stream did not end with done: ${kinds.join(',')}`)
const steps = events.filter(e => e.kind === 'step').map(e => e.text)
if (!steps.some(s => /^read .*refunds\.ts$/.test(s))) fail(`tool step not summarised readably: ${JSON.stringify(steps)}`)
const turn = events[events.length - 1].turn
if (turn.kind !== 'ask') fail(`ask produced the wrong turn kind: ${turn.kind}`)
if (!/STUB/.test(turn.response)) fail(`unexpected answer: ${turn.response}`)
if (!/anchored/.test(turn.response)) fail('the anchor did not reach the CLI prompt')
if (turn.anchorKey !== 'story:0') fail(`turn lost its anchor key: ${turn.anchorKey}`)
if (turn.steps?.length !== 2) fail(`steps not stored on the turn: ${JSON.stringify(turn.steps)}`)
if (turn.plan) fail('a plain question came back with a plan')

// Answers land in the review journal next to the map, so they survive the tab
// closing — and so a question asked here shares one history with the task work.
const logFile = join(work, 'review.log.jsonl')
if (!existsSync(logFile)) fail('review.log.jsonl was not written next to the map')
const logged = readFileSync(logFile, 'utf8').trim().split('\n').map(l => JSON.parse(l))
if (logged.length !== 2) fail(`expected a question and an answer in the journal, got ${logged.length} event(s)`)
if (logged[0].kind !== 'question' || logged[0].by !== 'reviewer') fail(`first event is not the reviewer's question: ${JSON.stringify(logged[0])}`)
if (logged[1].kind !== 'answer' || logged[1].by !== 'claude') fail(`second event is not Claude's answer: ${JSON.stringify(logged[1])}`)
if (logged[1].replyTo !== logged[0].noteId) fail('the answer was not linked to its question')
if (logged[0].anchor?.key !== 'story:0') fail(`the journal lost the anchor: ${JSON.stringify(logged[0].anchor)}`)
if (logged[1].steps?.length !== 2) fail(`the journal lost the tool steps: ${JSON.stringify(logged[1].steps)}`)
const listed = await (await fetch(base + '/api/threads', { headers: H })).json()
if (listed.threads.length !== 1) fail('GET /api/threads did not return the stored thread')
// The projection is what the Tasks tab will read; the counts have to be right now.
const projected = await (await fetch(base + '/api/review', { headers: H })).json()
if (projected.counts?.notes !== 2) fail(`/api/review did not project the journal: ${JSON.stringify(projected.counts)}`)
if (projected.counts.unanswered !== 0) fail('an answered question is still counted as unanswered')

// ── instruct: an instruction gets a plan, and only an approved plan opens a task ─
const instructRes = await fetch(base + '/api/instruct', {
  method: 'POST', headers: H,
  body: JSON.stringify({ anchorKey: 'story:0', anchor: { kind: 'story', key: 'story:0', label: 'caller' }, instruction: 'Make refunds settle for unshipped orders.' }),
})
if (!instructRes.ok) fail(`instruct failed: ${instructRes.status} ${await instructRes.text()}`)
const iev = (await instructRes.text()).split('\n').filter(Boolean).map(l => JSON.parse(l))
const iturn = iev[iev.length - 1].turn
if (!iturn) fail(`instruct did not end with a turn: ${JSON.stringify(iev[iev.length - 1])}`)
if (iturn.kind !== 'instruct') fail(`instruct turn has the wrong kind: ${iturn.kind}`)
if (/```json/.test(iturn.response)) fail('the machine-readable plan block leaked into the prose the reviewer reads')
if (!/STUB PLAN \(anchored\)/.test(iturn.response)) fail(`unexpected plan prose: ${iturn.response}`)
if (iev.some(e => e.kind === 'delta' && /```json/.test(e.text))) fail('the json fence was streamed to the page')
if (iturn.plan?.acceptance?.name !== 'test_refund_unshipped_order_settles') fail(`plan acceptance not parsed: ${JSON.stringify(iturn.plan)}`)
if (iturn.task) fail('an instruction opened a task before the reviewer agreed to the plan')
// Nothing is journalled as a task yet, and the plan itself does not block a merge.
const afterPlan = await (await fetch(base + '/api/review', { headers: H })).json()
if (afterPlan.counts.tasks !== 0) fail('a task was opened without approval')
if (afterPlan.notes.some(n => n.kind === 'report' && !n.plan)) fail('the plan payload was not stored on the report note')

// Agreeing opens exactly one task, with the plan's spec and acceptance.
const opened = await (await fetch(base + '/api/task', {
  method: 'POST', headers: H,
  body: JSON.stringify({ anchorKey: 'story:0', anchor: iturn.anchor, from: iturn.requestId, spec: iturn.plan.spec, acceptance: iturn.plan.acceptance }),
})).json()
if (opened.task?.state !== 'open') fail(`task did not open: ${JSON.stringify(opened)}`)
if (opened.review.counts.blocking !== 1) fail(`an open task must block a merge: ${JSON.stringify(opened.review.counts)}`)
if (!opened.threads.find(t => t.requestId === iturn.requestId)?.task) fail('the task was not attached to its turn')

// A task the journal would refuse is refused at the endpoint, not written.
const badTask = await fetch(base + '/api/task', {
  method: 'POST', headers: H,
  body: JSON.stringify({ anchorKey: 'story:0', anchor: iturn.anchor, spec: 'no acceptance here' }),
})
if (badTask.status !== 400) fail(`expected 400 for a task with no acceptance, got ${badTask.status}`)
const stateChanged = await (await fetch(base + '/api/task-state', {
  method: 'POST', headers: H, body: JSON.stringify({ taskId: opened.task.taskId, state: 'in_progress' }),
})).json()
if (stateChanged.review.counts.in_progress !== 1) fail('task state change did not land')
const badState = await fetch(base + '/api/task-state', {
  method: 'POST', headers: H, body: JSON.stringify({ taskId: opened.task.taskId, state: 'verified' }),
})
if (badState.status !== 400) fail('the endpoint allowed an illegal state jump')

// ── options: a finding answered with two or three kinds of answer ─────────────
const gapAnchor = { kind: 'gap', key: 'gap:0', label: 'nothing covers the unshipped path' }
const propRes = await fetch(base + '/api/propose', {
  method: 'POST', headers: H, body: JSON.stringify({ anchorKey: 'gap:0', anchor: gapAnchor, finding: gapAnchor.label }),
})
if (!propRes.ok) fail(`propose failed: ${propRes.status} ${await propRes.text()}`)
const pev = (await propRes.text()).split('\n').filter(Boolean).map(l => JSON.parse(l))
const pturn = pev[pev.length - 1].turn
if (pturn.kind !== 'proposal') fail(`propose produced the wrong turn kind: ${pturn.kind}`)
if (pturn.request !== null) fail('a proposal invented a request the reviewer never made')
if (pturn.proposal?.finding !== 'gap:0') fail(`the proposal does not cite its finding: ${JSON.stringify(pturn.proposal)}`)
// Normalisation: an invented kind and a duplicate kind are dropped, and a variant
// that came back without a criterion gets one rather than sinking the proposal.
const vkinds = pturn.proposal.variants.map(v => v.kind)
if (vkinds.join(',') !== 'local,root') fail(`variants were not normalised to distinct known kinds: ${vkinds.join(',')}`)
if (pturn.proposal.variants[1].acceptance?.type !== 'manual') fail('a variant with no criterion did not get a fallback one')
if (pturn.proposal.variants[0].acceptance?.name !== 'test_guard_at_call_site') fail('a real criterion was overwritten')
if (/```json/.test(pturn.response)) fail('the options json leaked into the prose')

// Choosing one opens a task that keeps the finding it descends from.
const picked = await (await fetch(base + '/api/task', {
  method: 'POST', headers: H,
  body: JSON.stringify({ anchorKey: 'gap:0', anchor: gapAnchor, from: pturn.requestId, origin: 'proposal', finding: 'gap:0', spec: pturn.proposal.variants[0].what, acceptance: pturn.proposal.variants[0].acceptance }),
})).json()
if (picked.task?.finding !== 'gap:0') fail(`the chosen option lost its finding: ${JSON.stringify(picked.task)}`)
if (picked.task.origin !== 'proposal') fail('a task from an option is not marked as proposal-born')
// The decision manifest counts it as decided from here on.
if (!picked.review.coverage.total) fail('the coverage manifest found no findings in the map')
if (picked.review.coverage.open.some(f => f.key === 'gap:0')) fail('a finding with a chosen option still counts as undecided')

// ── browser side ──────────────────────────────────────────────────────────────
const browser = await chromium.launch()
const errors = []
const page = await browser.newPage()
page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`))
page.on('console', (m) => { if (m.type() === 'error') errors.push(`console: ${m.text()}`) })
await page.goto(base + '/')
await page.waitForTimeout(500)

if (!(await page.locator('body.can-ask').count())) fail('served page did not enable the ask UI')

// A stored thread leaves a numbered marker on its anchor, Notion-comment style,
// without hovering anything. Two notes are on story:0 by now: the answered
// question and the planned instruction above.
await page.locator('#tabs .tab[data-pane="stories"]').click()
await page.waitForTimeout(300)
const mark = await page.locator('.ustory[data-anchor="story:0"] .askmark').textContent()
if (mark !== '1·2') fail(`expected marker "1·2" on the story with two notes, got "${mark}"`)
if (await page.locator('.ustory[data-anchor="story:0"] .askbtn').count()) {
  fail('the hover "ask" button is still there next to a marker — they would overlap')
}

// Asking from the UI: the trace shows the CLI's steps while it works …
await page.locator('.ustory[data-anchor="story:0"] .askmark').click()
if (!(await page.locator('.layout.chatting .askpanel.on').count())) fail('chat did not open as a right-column panel')
await page.locator('.askpanel textarea').fill('Second question from the UI?')
await page.locator('.askpanel .dk-send').click()
await page.waitForFunction(() => document.querySelectorAll('.askpanel .tr-step').length >= 2, null, { timeout: 30000 })
// … and folds itself away once the answer lands.
await page.waitForFunction(
  () => !document.querySelector('.askpanel .spin') && document.querySelectorAll('.askpanel .dk-t').length >= 2,
  null, { timeout: 30000 })
const lastRow = page.locator('.askpanel .dk-t').last()
if (await lastRow.locator('.trace[open]').count()) fail('the trace stayed expanded after the answer arrived')
if (!(await lastRow.locator('.trace').count())) fail('the trace was dropped instead of folded')

// Markdown in the answer is rendered, not shown as source.
const html = await lastRow.locator('.dk-a').innerHTML()
if (!/<strong>ANSWER<\/strong>/.test(html)) fail(`bold not rendered: ${html}`)
if (!/<code>inline<\/code>/.test(html)) fail(`inline code not rendered: ${html}`)
if (!/<li>first<\/li>/.test(html)) fail(`list not rendered: ${html}`)
if (/\*\*/.test(await lastRow.locator('.dk-a').textContent())) fail('markdown source leaked into the text')

// Several notes on one anchor: the marker counts them.
await page.waitForFunction(() => document.querySelector('.ustory[data-anchor="story:0"] .askmark')?.textContent === '1·3',
  null, { timeout: 5000 }).catch(() => fail('marker did not count the note just added'))

// ── instruct from the UI: a plan, then the reviewer's decision ────────────────
// The journalled instruction above already renders as a turn with its task chip.
if (!(await page.locator('.askpanel .dk-task .st').count())) fail('the approved task did not show its state in the thread')
if (!(await page.locator('.askpanel .dk-plan dt').count())) fail('the plan fields were not rendered in the thread')
await page.locator('.askpanel .dk-mode button[data-mode="instruct"]').click()
if (!(await page.locator('.askpanel .dk-mode button[data-mode="instruct"].on').count())) fail('instruct mode did not switch on')
const hint = await page.locator('.askpanel .dk-form .dk-hint').textContent()
if (!/nothing is edited/.test(hint || '')) fail(`instruct mode must say nothing is edited, hint said "${hint}"`)
await page.locator('.askpanel textarea').fill('Also reject refunds twice as loudly.')
await page.locator('.askpanel .dk-send').click()
await page.waitForFunction(() => document.querySelectorAll('.askpanel .dk-acts .dk-agree').length === 1,
  null, { timeout: 30000 }).catch(() => fail('a fresh plan did not offer the Agree action'))
const planText = await page.locator('.askpanel .dk-t').last().locator('.dk-a').textContent()
if (/```json/.test(planText || '')) fail('the json block leaked into the rendered plan')
// An answer is where work often gets decided, so it can become a task directly —
// with the reviewer confirming what the task will say, not the model guessing.
const askTurn = page.locator('.askpanel .dk-t').first()
await askTurn.locator('.dk-make').click()
if (!(await page.locator('.askpanel .dk-tf').count())) fail('"make this a task" did not ask what the task should say')
const prefill = await page.locator('.askpanel .dk-tf .tf-spec').inputValue()
if (!/STUB/.test(prefill)) fail(`the form did not prefill from the answer: "${prefill}"`)
// It refuses to open a task with no criterion — the same rule the journal has.
await page.locator('.askpanel .dk-tf .tf-create').click()
await page.waitForTimeout(200)
if (!(await page.locator('.askpanel .dk-tf').count())) fail('a task with no criterion was created anyway')
await page.locator('.askpanel .dk-tf .tf-spec').fill('Backfill state before dropping status.')
await page.locator('.askpanel .dk-tf .tf-type').selectOption('test')
await page.locator('.askpanel .dk-tf .tf-val').fill('test_backfill_state')
await page.locator('.askpanel .dk-tf .tf-create').click()
await page.waitForFunction(() => document.querySelectorAll('.askpanel .dk-task').length >= 2, null, { timeout: 15000 })
  .catch(() => fail('a task made from an answer did not appear in the thread'))
const fromAnswer = await (await fetch(base + '/api/review', { headers: H })).json()
const fromAsk = fromAnswer.tasks.find(t => t.spec === 'Backfill state before dropping status.')
if (!fromAsk) fail(`the edited spec was not what got stored: ${JSON.stringify(fromAnswer.tasks.map(t => t.spec))}`)
if (fromAsk.acceptance.name !== 'test_backfill_state') fail(`the chosen criterion was not stored: ${JSON.stringify(fromAsk.acceptance)}`)

// Turning a plan down is recorded, so the offer is not made again.
await page.locator('.askpanel .dk-notnow').click()
await page.waitForFunction(() => {
  const last = document.querySelector('.askpanel .dk-t:last-child')
  return last && !last.querySelector('.dk-acts') && last.querySelector('.dk-note')
}, null, { timeout: 10000 }).catch(() => fail('a declined plan still offered to open a task'))
if (!(await page.locator('.askpanel .dk-note').count())) fail('the declined plan left no trace in the thread')
const declined = await (await fetch(base + '/api/review', { headers: H })).json()
if (!declined.notes.some(n => n.kind === 'decision')) fail('the decision was not journalled')
// Two tasks exist by now — the instruction agreed to and the option chosen — and
// declining this plan must not have added a third.
if (declined.counts.tasks !== 3) fail(`a declined plan opened a task anyway: ${JSON.stringify(declined.counts)}`)

// ── the Tasks tab: the merge gate ─────────────────────────────────────────────
// The review is not one of the report's tabs: it is its own destination at the end
// of the strip, and the report's tabs are hidden while you are in it.
if ((await page.locator('.modebar .modetab').count()) !== 2) fail('the served page has no Report/Review switch')
if (await page.locator('#tabs .tab[data-pane="tasks"]').count()) fail('the review is still a report tab')
// The badge counts everything this page exists for: what blocks, what nobody has
// decided, and what is waiting to be applied — 3 tasks plus 3 undecided findings here.
const badge0 = await page.locator('.modebar .modetab').nth(1).locator('.cnt').textContent()
const live0 = await (await fetch(base + '/api/review', { headers: H })).json()
const want0 = String(live0.counts.blocking + live0.coverage.open.length)
if (badge0 !== want0) fail(`the review badge does not count what needs deciding (got "${badge0}", expected ${want0})`)
await page.locator('.modebar .modetab').nth(1).click()
await page.waitForTimeout(200)
if (!(await page.locator('body.reviewing').count())) fail('opening the review did not leave the report')
if (await page.evaluate(() => !!document.querySelector('#tabs .tab[data-pane="story"]')?.offsetParent)) {
  fail('the report tabs are still competing for attention inside the review')
}
const verdict = await page.locator('#tkVerdict').textContent()
if (!/blocking 3/.test(verdict || '')) fail(`the verdict does not lead with what blocks: "${verdict}"`)
if (!/·/.test(verdict || '')) fail(`the verdict's parts ran together: "${verdict}"`)
if ((await page.locator('.tkgroup').count()) !== 3) fail('tasks were not grouped by where the problem came from, next to what is still undecided')
if (!/From a test gap/.test(await page.locator('.tkgroup h3').nth(1).textContent())) fail('a task chosen from an option was not grouped by its finding')
if (!/You asked for these/.test(await page.locator('.tkgroup h3').first().textContent())) fail('a reviewer instruction was not grouped as one')
// The decision manifest: findings the map reported that nobody has answered.
if (!/decided \d+\/\d+/.test(verdict || '')) fail(`the verdict carries no decision manifest: "${verdict}"`)
if (!/Not decided yet/.test(await page.locator('.tkgroup h3').last().textContent())) fail('undecided findings were counted but not listed')
if (!(await page.locator('.tkcard.undecided').count())) fail('no undecided finding was listed')
const card = page.locator('.tkcard').first()
if ((await card.locator('.st').textContent()) !== 'in progress') fail('the card does not lead with the task state')
if (!/test_refund_unshipped_order_settles/.test(await card.locator('.tkmeta').textContent())) fail('the card does not say what proves it done')

// The queue is handed to the session that can actually do the work.
await page.context().grantPermissions(['clipboard-read', 'clipboard-write'])
await page.locator('.tk-copy').click()
await page.waitForTimeout(200)
if (!/paste it into/.test(await page.locator('.tk-said').textContent())) fail('copying the queue reported nothing')
const clip = await page.evaluate(() => navigator.clipboard.readText())
if (!/Work the whydiff review queue/.test(clip) || !/review\.log\.jsonl/.test(clip)) fail(`the copied prompt is not a handoff: ${clip.slice(0, 200)}`)
if (!/proved done by: test_refund_unshipped_order_settles/.test(clip)) fail('the copied prompt dropped the acceptance criterion')

// The anchor is a link back into the report, on whichever tab it lives.
await page.locator('.tkcard .tk-open').first().click()
await page.waitForTimeout(400)
if (!(await page.locator('#tabs .tab[data-pane="stories"].active').count())) fail('opening a task did not jump to the tab its anchor lives on')
if (!(await page.locator('.askpanel.on').count())) fail('opening a task did not open its thread')

// Declining needs a reason, and the journal is what says so.
await page.locator('.modebar .modetab').nth(1).click()
await page.waitForTimeout(200)
await page.locator('.tkcard .tk-decline').first().click()
if (!(await page.locator('.tkrow .tk-do[disabled]').count())) fail('decline was offered without a reason')
await page.locator('.tkrow .tk-why').fill('the burst window question is unanswered')
await page.locator('.tkrow .tk-do').click()
await page.waitForFunction(() => document.querySelector('.tkcard.declined'), null, { timeout: 10000 })
  .catch(() => fail('declining did not land on the card'))
if (!/blocking 2/.test(await page.locator('#tkVerdict').textContent())) fail('the verdict did not drop the declined task from what blocks')
const liveAfter = await (await fetch(base + '/api/review', { headers: H })).json()
if ((await page.locator('.modebar .modetab').nth(1).locator('.cnt').textContent()) !== String(liveAfter.counts.blocking + liveAfter.coverage.open.length)) {
  fail('the review badge still counts a declined task')
}
if (!/burst window question/.test(await page.locator('.tkcard.declined .tkmeta').textContent())) fail('the decline reason is not shown where the decision is')
const afterDecline = await (await fetch(base + '/api/review', { headers: H })).json()
if (afterDecline.tasks[0].state !== 'declined' || !afterDecline.tasks[0].declinedReason) fail('the decline was not journalled with its reason')
await page.locator('.tk-copy').click()
await page.waitForTimeout(200)
const clip2 = await page.evaluate(() => navigator.clipboard.readText())
if (/Reject over-limit calls/.test(clip2)) fail('the queue handed over a task that was declined')
if (!/Guard the unshipped path/.test(clip2)) fail('the queue dropped the still-open task chosen from an option')

// ── options from the UI: only on a finding, and a chosen one becomes the task ──
// The switch is also the way back into the report.
await page.locator('.modebar .modetab').first().click()
if (await page.locator('body.reviewing').count()) fail('the switch did not take us back to the report')
if (!(await page.locator('#tabs .tab[data-pane="story"]').isVisible())) fail('the report tabs did not come back')
// Refused where there is no finding to cite: a Logic block is a place to ask about,
// not a problem the map reported.
await page.locator('#tabs .tab[data-pane="story"]').click()
await page.waitForTimeout(200)
await page.locator('#story .step[data-anchor]').first().hover()
await page.locator('#story .step[data-anchor] .askbtn').first().click()
const propBtn = page.locator('.askpanel .dk-mode button[data-mode="propose"]')
if (!(await propBtn.isDisabled())) fail('Options were offered on a Logic block, which cites no finding')
if (!/only offered for a problem/.test(await propBtn.getAttribute('title') || '')) fail('the disabled Options button does not say why')

// Offered where the map did report a problem — reached from the undecided list.
await page.locator('.modebar .modetab').nth(1).click()
await page.waitForTimeout(200)
await page.locator('.tkcard.undecided .tk-open').first().click()
await page.waitForTimeout(500)
if (await propBtn.isDisabled()) fail('Options were refused on a finding the map itself reported')
await propBtn.click()
if (!(await page.locator('.askpanel textarea[hidden]').count())) fail('Options mode still asked the reviewer to type something')
await page.locator('.askpanel .dk-send').click()
await page.waitForFunction(() => document.querySelectorAll('.askpanel .dk-var').length === 2, null, { timeout: 30000 })
  .catch(() => fail('the options did not render as two distinct variants'))
const vk = await page.locator('.askpanel .dk-var .vk').allTextContents()
if (vk.join(',') !== 'point fix,at the root') fail(`options do not lead with their kind: ${vk.join(',')}`)
if (!/decided \d+\/\d+/.test(await page.locator('#tkVerdict').textContent())) fail('the decision manifest vanished')
const beforePick = (await (await fetch(base + '/api/review', { headers: H })).json()).coverage.open.length
await page.locator('.askpanel .dk-pick').first().click()
await page.waitForFunction(() => document.querySelector('.askpanel .dk-task'), null, { timeout: 15000 })
  .catch(() => fail('choosing an option did not open a task'))
const afterPick = await (await fetch(base + '/api/review', { headers: H })).json()
if (afterPick.coverage.open.length !== beforePick - 1) fail('choosing an option did not settle its finding in the manifest')
const born = afterPick.tasks[afterPick.tasks.length - 1]
if (born.origin !== 'proposal' || !born.finding) fail(`the task from a chosen option lost its origin: ${JSON.stringify(born)}`)

// A question on selected text leaves the text highlighted with an inline pin.
await page.locator('#tabs .tab[data-pane="story"]').click()
await page.waitForTimeout(200)
// Select across an inline element on purpose: the prose is full of <code>, so a
// selection that straddles element boundaries is the normal case, not the edge.
const spanned = await page.evaluate(() => {
  for (const el of document.querySelectorAll('#story .step .step-text')) {
    const w = document.createTreeWalker(el, NodeFilter.SHOW_TEXT)
    const texts = []
    for (let n = w.nextNode(); n; n = w.nextNode()) if (n.nodeValue.trim()) texts.push(n)
    if (texts.length < 2) continue // no inline markup in this block — try the next
    const r = document.createRange()
    r.setStart(texts[0], Math.max(0, texts[0].nodeValue.length - 12))
    r.setEnd(texts[1], Math.min(20, texts[1].nodeValue.length))
    const s = getSelection(); s.removeAllRanges(); s.addRange(r)
    el.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }))
    return true
  }
  return false
})
if (!spanned) fail('could not build a cross-element selection to test with')
await page.waitForTimeout(200)
if (await page.locator('.asksel:visible').count()) {
  await page.locator('.asksel').click()
  await page.locator('.askpanel textarea').fill('What does this phrase mean?')
  await page.locator('.askpanel .dk-send').click()
  await page.waitForFunction(() => !document.querySelector('.askpanel .spin'), null, { timeout: 30000 })
  if (!(await page.locator('.askquote').count())) fail('the quoted text was not highlighted after asking about it')
  if (!(await page.locator('.askquote .askpin').count())) fail('the highlighted quote got no inline pin')
}

// Multi-select of Logic blocks composes one anchor out of several.
const blocks = page.locator('#story .step[data-anchor]')
if ((await blocks.count()) >= 2) {
  await blocks.nth(0).click({ modifiers: ['Meta'] })
  await blocks.nth(1).click({ modifiers: ['Meta'] })
  if (!(await page.locator('.askbar.on').count())) fail('multi-select bar did not appear for 2 picked blocks')
  await page.locator('.askbar .bar-ask').click()
  const anchorLine = await page.locator('.askpanel .dk-anchor').textContent()
  if (!/^blocks /.test(anchorLine || '')) fail(`multi-select produced the wrong anchor: "${anchorLine}"`)
}

// Switching tabs must not move the content sideways. Questions are a stable count
// on each tab — no floating rail, no reserved left gutter that appears on some tabs
// and not others — so the reading column keeps the same left edge on every tab.
const leftOn = async (pane) => {
  await page.locator(`#tabs .tab[data-pane="${pane}"]`).click()
  await page.waitForTimeout(250)
  return page.evaluate(() => Math.round(document.querySelector('.main-panel').getBoundingClientRect().left))
}
const lStory = await leftOn('story')
const lStories = await leftOn('stories')
const lStandards = await leftOn('standards')
if (lStory !== lStories || lStory !== lStandards) {
  fail(`content shifted between tabs (main-panel left: story ${lStory}, stories ${lStories}, standards ${lStandards})`)
}
if (await page.locator('.rail .bm').count()) fail('the floating rail is gone; no bookmarks should render')

// Questions are counted on their tab's button, wherever you are.
const storyBadge = await page.locator('#tabs .tab[data-pane="stories"] .qcnt').textContent()
if (!/\d/.test(storyBadge || '')) fail(`the stories tab did not count its questions (got "${storyBadge}")`)

// The chat panel is a full-height column that stays put while the report scrolls.
await page.locator('#tabs .tab[data-pane="stories"]').click()
await page.waitForTimeout(200)
await page.locator('.ustory[data-anchor="story:0"] .askmark').click()
await page.waitForTimeout(300)
const panelTop = () => page.evaluate(() => Math.round(document.querySelector('.askpanel').getBoundingClientRect().top))
const pinnedBefore = await panelTop()
await page.evaluate(() => scrollBy(0, 600))
await page.waitForTimeout(250)
const pinnedAfter = await panelTop()
if (Math.abs(pinnedAfter - pinnedBefore) > 4) fail(`the chat panel scrolled away (${pinnedBefore} → ${pinnedAfter})`)
if (await page.evaluate(() => document.querySelector('.askpanel .dk-threads').scrollTop) !== 0) {
  fail('opening a thread jumped past the question to the end of the last answer')
}
await page.evaluate(() => scrollTo(0, 0))

// ── and now the negative case: the plain assembled file must have no ask UI ───
const plainHtml = join(work, 'plain.html')
const { execFileSync } = await import('node:child_process')
execFileSync('node', [join(root, 'scripts', 'assemble.mjs'), mapPath, '--out', plainHtml], { stdio: 'inherit' })
const page2 = await browser.newPage()
const errors2 = []
page2.on('pageerror', (e) => errors2.push(`pageerror: ${e.message}`))
await page2.goto('file://' + plainHtml)
await page2.waitForTimeout(300)
if (await page2.locator('body.can-ask').count()) fail('the standalone file enabled the ask UI without a server')
if (await page2.locator('.askpanel').count()) fail('the standalone file built the chat panel')
if (await page2.locator('.askbtn, .askmark, .askpin').count()) fail('the standalone file rendered ask controls')
if (await page2.locator('.rail').count()) fail('the standalone file rendered the bookmark rail')
if (await page2.locator('#tabs .tab[data-pane="tasks"], #pane-tasks').count()) fail('the standalone file built a Tasks tab it could never fill')
if (errors2.length) fail('standalone page errors:\n' + errors2.join('\n'))

if (errors.length) fail('served page errors:\n' + errors.join('\n'))

await browser.close()
stop()
console.log(`OK: serve.mjs contract (403 without token, streamed ${kinds.length} events with steps+deltas, Q+A journalled and projected, marker rendered, trace folded, markdown rendered, quote pinned, answer turned into a task, instruct planned+agreed+declined, options normalised+chosen, tasks tab gated+grouped+handed off, multi-select anchored, content stays put across tabs, standalone file has no ask UI)`)
