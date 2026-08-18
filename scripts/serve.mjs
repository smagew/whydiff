#!/usr/bin/env node
// Serves an assembled change map locally and answers questions asked from inside
// it by shelling out to the Claude Code CLI.
//
//   node scripts/serve.mjs <review-map.json> --repo <path> [--port 7777]
//                          [--html <file.html>] [--claude-cmd claude]
//
// Why a server at all: the report is a self-contained HTML file, and a published
// artifact's CSP blocks every outgoing request — so the page cannot reach a model
// on its own. This mode trades self-containment for a live answer, and only works
// for the locally served copy. The assembled file and the published artifact stay
// exactly as they are: the ask UI is gated on a token this server injects, so it
// is absent (not broken) anywhere else.
//
// The page is served from this origin rather than opened from file://, which keeps
// every request same-origin — no CORS, and the token never rides a cross-origin
// preflight. The listener is bound to loopback and every /api route requires the
// token, so another local process cannot drive `claude` through this.

import { readFileSync, writeFileSync, mkdirSync, rmSync, existsSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { createServer } from 'node:http'
import { spawn, execFileSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { resolve, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { anchorOffers, appendEvents, coverage, migrateThreads, newId, readReview, threadOf, turns, REVIEW_LOG } from './review.mjs'

const args = process.argv.slice(2)
const jsonPath = args.find(a => !a.startsWith('--'))
if (!jsonPath) {
  console.error('usage: serve.mjs <review-map.json> --repo <path> [--port 7777] [--html <file.html>] [--claude-cmd claude] [--work]')
  process.exit(1)
}
const opt = (name, dflt = null) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : dflt }
const rootDir = join(dirname(fileURLToPath(import.meta.url)), '..')
const mapPath = resolve(jsonPath)
const repo = resolve(opt('--repo') || '.')
const port = Number(opt('--port', '7777'))
const claudeCmd = opt('--claude-cmd', 'claude')
const timeoutMs = Number(opt('--timeout', '180000'))
// A lazy section (user stories, standards, tests) runs a FULL analysis pass, not a
// quick Q&A — it reads the whole diff and repo, so it gets a much longer budget than
// an ask. Raise it with --gen-timeout on a large diff.
const genTimeoutMs = Number(opt('--gen-timeout', '600000'))
const workTimeoutMs = Number(opt('--work-timeout', '900000'))
// Opt-in: without it this server only reads. With it, an agreed task can be worked
// by an agent — in a throwaway git worktree, never in the tree under review, and
// the result reaches that tree only through an explicit apply.
const workMode = args.includes('--work')
// Open the report in the default browser on startup. Default on — the whole point is to
// land the reviewer on the live map without a copy-paste step. Off with --no-open (CI, or a
// host like the desktop app that loads the URL in its own window).
const noOpen = args.includes('--no-open')
const reviewDir = dirname(mapPath)
const patchDir = join(reviewDir, 'tasks')

// Assemble on demand so `serve` is usable straight after a merge.
let htmlPath = opt('--html')
if (!htmlPath) {
  htmlPath = mapPath.replace(/\.json$/, '.served.html')
  execFileSync('node', [join(rootDir, 'scripts', 'assemble.mjs'), mapPath, '--repo', repo, '--out', htmlPath], { stdio: 'inherit' })
}
let body = readFileSync(htmlPath, 'utf8')
const token = randomBytes(16).toString('hex')

// Answers outlive the tab: a live answer that vanishes when the window closes
// would make the same question get asked (and paid for) again. They go into the
// review journal (scripts/review.mjs) — the same append-only log the Tasks work
// reads — so a question asked here and a task opened in the terminal share one
// history instead of two files that drift.
const migrated = migrateThreads(reviewDir)
let review = readReview(reviewDir).state

// The viewer template is body content (the artifact host supplies the document
// shell), so serving it needs a real document around it — and that is also where
// the token goes. Nothing else in the pipeline learns about the token.
const SERVE_GLOBAL = JSON.stringify({ token, repo, journal: join(reviewDir, REVIEW_LOG), work: workMode })
const renderPage = () => `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<script>window.__WHYDIFF_SERVE__=${SERVE_GLOBAL}</script>
</head><body>
${body}
</body></html>`
let page = renderPage()
// A generated section is folded into the map on disk; re-assembling the HTML and
// rebuilding `page` is what makes a reload show it. Cheap: it is the same one-shot
// assemble the server already runs at startup.
const rebuildPage = () => {
  execFileSync('node', [join(rootDir, 'scripts', 'assemble.mjs'), mapPath, '--repo', repo, '--out', htmlPath], { stdio: 'inherit' })
  body = readFileSync(htmlPath, 'utf8')
  page = renderPage()
}

const json = (res, code, obj) => {
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8' })
  res.end(JSON.stringify(obj))
}
const readBody = (req) => new Promise((ok, no) => {
  let b = ''
  req.on('data', (c) => { b += c; if (b.length > 1e6) no(new Error('body too large')) })
  req.on('end', () => { try { ok(b ? JSON.parse(b) : {}) } catch (e) { no(e) } })
})

// What the anchor was attached to, rendered for the model. The page sends the text
// it had on screen, so the answer is grounded in what the reviewer actually saw.
const anchorBlock = (a = {}) => {
  const lines = [`Anchor kind: ${a.kind || 'unknown'}`]
  if (a.label) lines.push(`Anchor label: ${a.label}`)
  if (a.files?.length) lines.push(`Files behind the anchor: ${a.files.join(', ')}`)
  if (a.quote) lines.push(`Exact text the reviewer selected:\n"""\n${a.quote}\n"""`)
  if (a.context) lines.push(`Surrounding content shown on screen:\n"""\n${a.context}\n"""`)
  return lines.join('\n')
}

// What both prompts share: where the map, the repo and the patch are, and the
// standing rule that the code outranks the map.
const groundingBlock = (anchor, history) => `The review map (the report's own data, including the causal story, per-file explanations, standards findings, test gaps and user stories) is on disk at:
  ${mapPath}
The repository it describes is your working directory: ${repo}
The diff it describes is at ${join(dirname(mapPath), 'diff.patch')} when present.

Read whatever you need from those first — the map, then the actual code. The map is a model's analysis and can be wrong; when the code contradicts it, the code wins and you should say so.

${anchorBlock(anchor)}
${history?.length ? `\nEarlier in this thread:\n${history.map(h => `${h.request}\n→ ${h.response}`).join('\n\n')}\n` : ''}`

const buildPrompt = (anchor, question, history) => `You are answering a reviewer's question asked from inside a whydiff change map — an interactive report about a specific git diff.

The reviewer selected something in that report and asked about it. Answer THAT question, about THIS diff.

${groundingBlock(anchor, history)}
Reviewer's question:
"""
${question}
"""

Answer in ${anchor.lang || 'the same language as the question'}. Be direct and specific: cite concrete file:line references, and prefer showing the two or three lines that settle the question over describing them. If the honest answer is that the report is wrong, or that the code cannot be determined without running it, say that plainly. Keep it under 250 words unless the question genuinely needs more. Plain prose and short code snippets only — no headings, no preamble like "Great question".

Two things to keep out of the reply. Never discuss your own tools, permissions, session or connectors: the reviewer is reading a report, not administering you, and this run is read-only by design. And if what they said is really a request to change something rather than a question, answer what would have to change and say in one closing line that **Instruct** plans it and **Options** offers alternatives — they are one click away in the same panel, and a task can be opened straight from your answer.`

// The instruct prompt. The reviewer is telling you to change something; the reply
// is a PLAN they approve or turn down, never an edit — which is also enforced
// structurally, by the read-only tool allowlist this server spawns the CLI with.
const buildPlanPrompt = (anchor, instruction, history) => `You are planning a change for a reviewer who is reading a whydiff change map — an interactive report about a specific git diff.

The reviewer selected something in that report and told you what they want changed. Produce a PLAN for that change. Do NOT change anything: you have read-only tools, and the reviewer approves the plan before any work starts.

${groundingBlock(anchor, history)}
Reviewer's instruction:
"""
${instruction}
"""

Reply in ${anchor.lang || 'the same language as the instruction'}, as plain prose under 200 words, covering exactly these, in this order:
- what you would change, file by file — \`path\`: what happens there;
- how it will be proved done: an existing or new test, a user story that must flip to delivered, or a standards finding that must disappear;
- what could break — name files outside the diff when the blast radius reaches them;
- anything you must have answered before starting. If the instruction is ambiguous, ASK instead of guessing, and say plainly that the plan is provisional.

Then, as the very last thing in your reply with nothing after it, one fenced json block:
\`\`\`json
{"spec": "one sentence: what must change", "acceptance": {"type": "test|story|finding|manual", "name|key|what": "…"}, "files": ["path"], "risks": ["…"], "questions": ["…"]}
\`\`\`
Acceptance rules: type "test" with the test \`name\` when a test can prove it; "story" with the story \`key\` from the map when a user story must flip; "finding" with the finding \`key\` when a standards finding must disappear; "manual" with \`what\` the reviewer must check, only when nothing else can prove it. Use no other fenced blocks anywhere in the reply.`

// The propose prompt. Unlike a plan, this is not asked for in words: the reviewer
// clicked a finding the map itself reported, and the answer is a small set of
// genuinely different ways to deal with it — including doing nothing.
const buildProposePrompt = (anchor, finding, history) => `You are offering a reviewer options for a problem a whydiff change map reported about a specific git diff.

The reviewer clicked that finding and wants ways to deal with it. Do NOT change anything: you have read-only tools, and the reviewer decides.

${groundingBlock(anchor, history)}
The finding to answer: ${finding}

Give TWO or THREE options that differ in KIND, not in wording:
- "local" — fix the symptom where it shows. Cheapest, narrowest.
- "root" — fix the invariant that let it happen. More expensive, wider blast radius.
- "document" — do not change the behaviour; pin it with a test or a note so it is deliberate.
Never give two options of the same kind, and never pad: if the honest answer is that nothing should change, return no options and say why in "noFixNeeded" instead.

Reply in ${anchor.lang || 'the language of the report'}: first ONE sentence of prose on what is actually wrong here (or that nothing is), then, as the very last thing with nothing after it, one fenced json block:
\`\`\`json
{"variants": [{"kind": "local|root|document", "what": "what you would do, one sentence", "cost": "how much work", "risk": "what it risks", "blast": ["paths outside the diff it touches"], "acceptance": {"type": "test|story|finding|manual", "name|key|what": "…"}}], "noFixNeeded": null}
\`\`\`
Every option needs an \`acceptance\` — the criterion the finished work would be judged by: type "test" with the test \`name\`, "story" with a \`key\` from the menu below that must flip to delivered, "finding" with a \`key\` from the menu that must disappear, or "manual" with \`what\` the reviewer must check.
${keyMenu()}
Use no other fenced blocks anywhere in the reply.`

// The machine-readable tail, split off the prose the reviewer reads. A model that
// ignored the format costs the structured fields, not the reply.
const FENCE = /\n?```json\s*([\s\S]*?)```\s*$/
const tailJSON = (text) => {
  const m = FENCE.exec(text)
  if (!m) return { prose: text.trim(), raw: null }
  let raw = null
  try { raw = JSON.parse(m[1]) } catch {}
  return { prose: text.slice(0, m.index).trim() || text.trim(), raw }
}
const MANUAL = { type: 'manual', what: 'the reviewer checks the change' }
const VARIANT_KINDS = ['local', 'root', 'document']

// A `story`/`finding` criterion is only worth anything if it names a key something
// can re-check. A first live run had the model answer with the story's prose instead,
// which reads fine and verifies nothing — so the prompt is given the actual menu of
// keys, and whatever comes back is matched against it.
const offersForKeys = () => anchorOffers(JSON.parse(readFileSync(mapPath, 'utf8')))
  .filter(o => ['story', 'finding', 'gap'].includes(o.kind))
const keyMenu = () => {
  const rows = offersForKeys().map(o => `  ${o.key} — ${String(o.text).replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').slice(0, 90)}`)
  return rows.length ? `Keys you may use in an acceptance criterion (use the key exactly, never its wording):\n${rows.join('\n')}` : ''
}
const fixAcceptance = (acc) => {
  if (!acc?.type) return MANUAL
  if (!['story', 'finding'].includes(acc.type)) return acc
  const offers = offersForKeys()
  const key = String(acc.key || '').trim()
  if (offers.some(o => o.key === key)) return acc
  // The model answered with the wording; find the key that wording belongs to.
  const flat = (v) => String(v || '').replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim().toLowerCase()
  const hit = offers.find(o => flat(o.text) && (flat(key).includes(flat(o.text)) || flat(o.text).includes(flat(key))))
  if (hit) return { ...acc, type: hit.kind === 'gap' ? 'finding' : hit.kind, key: hit.key }
  // Nothing to re-check: say so, rather than storing a criterion no pass can close.
  return { type: 'manual', what: key || 'the reviewer checks the change' }
}

// Normalised here so the journal can insist on a typed criterion without a sloppy
// reply costing the reviewer the whole proposal they just paid for.
const splitProposal = (text, finding) => {
  const { prose, raw } = tailJSON(text)
  const seen = new Set()
  const variants = (Array.isArray(raw?.variants) ? raw.variants : [])
    .filter(v => VARIANT_KINDS.includes(v?.kind) && String(v?.what || '').trim() && !seen.has(v.kind) && seen.add(v.kind))
    .slice(0, 3)
    .map(v => ({
      kind: v.kind, what: String(v.what).trim(),
      cost: String(v.cost || '').trim(), risk: String(v.risk || '').trim(),
      blast: Array.isArray(v.blast) ? v.blast.slice(0, 20) : [],
      acceptance: v.acceptance?.type ? fixAcceptance(v.acceptance) : { ...MANUAL, what: `the reviewer checks: ${String(v.what).trim().slice(0, 120)}` },
    }))
  const noFixNeeded = !variants.length && typeof raw?.noFixNeeded === 'string' && raw.noFixNeeded.trim()
    ? raw.noFixNeeded.trim() : null
  return { prose, proposal: { finding, variants, noFixNeeded } }
}
const splitPlan = (text, instruction) => {
  const { prose, raw } = tailJSON(text)
  const acc = raw?.acceptance && typeof raw.acceptance === 'object' && raw.acceptance.type ? raw.acceptance : MANUAL
  return {
    prose,
    plan: {
      spec: String(raw?.spec || instruction).trim() || instruction,
      acceptance: fixAcceptance(acc),
      files: Array.isArray(raw?.files) ? raw.files.slice(0, 40) : [],
      risks: Array.isArray(raw?.risks) ? raw.risks.slice(0, 10) : [],
      questions: Array.isArray(raw?.questions) ? raw.questions.slice(0, 10) : [],
    },
  }
}

// One-line summaries of what the model is doing, so the wait shows progress
// instead of a spinner. Tool inputs are trimmed to the one field worth reading.
const stepText = (name, input = {}) => {
  const rel = (p) => String(p || '').replace(repo + '/', '')
  switch (name) {
    case 'Read': return `read ${rel(input.file_path)}`
    case 'Grep': return `grep ${input.pattern || ''}${input.path ? ` in ${rel(input.path)}` : ''}`
    case 'Glob': return `glob ${input.pattern || ''}`
    case 'Bash': return `run ${String(input.command || '').slice(0, 80)}`
    default: return name
  }
}

// Streams the CLI's own event log so the page can show the work in progress and
// then collapse it. `on(event)` receives {kind:'step'|'delta'|'text', ...}.
//
// Read-only by construction: this server answers and plans, it never edits. The
// allowlist is what makes that a property of the process rather than a promise in
// a prompt — anything else the model reaches for is refused, and in print mode
// there is nobody to ask for permission.
const READ_ONLY_TOOLS = 'Read,Grep,Glob'
// An allowlist only pre-approves; it does not take anything away — a first live run
// showed the "read-only" answer path happily shelling out to ls and grep. What makes
// read-only a property of the process is the deny list: the editing tools, the shell,
// and subagents (which would otherwise be the way around it).
const DENY_WRITES = 'Edit,Write,NotebookEdit,Bash,Task,Agent'
// Only the worker gets these, and only inside a throwaway worktree: editing is the
// job there, and the shell is what lets it run the test its criterion names.
const WRITE_TOOLS = 'Read,Grep,Glob,Edit,Write,Bash'
const run = (prompt, on, { cwd = repo, tools = READ_ONLY_TOOLS, deny = DENY_WRITES, timeout = timeoutMs } = {}) => new Promise((ok, no) => {
  const child = spawn(claudeCmd, [
    '-p', prompt,
    '--allowedTools', tools,
    ...(deny ? ['--disallowedTools', deny] : []),
    '--output-format', 'stream-json', '--include-partial-messages', '--verbose',
  ], {
    cwd,
    // stdin closed: the CLI otherwise waits 3s for piped input on every ask.
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  const kill = setTimeout(() => { child.kill('SIGKILL'); no(new Error(`timed out after ${Math.round(timeout / 1000)}s`)) }, timeout)
  let buf = '', err = '', final = '', lastText = ''
  child.stderr.on('data', (d) => { err += d })
  child.stdout.on('data', (d) => {
    buf += d
    const lines = buf.split('\n')
    buf = lines.pop()
    for (const line of lines) {
      if (!line.trim()) continue
      let j
      try { j = JSON.parse(line) } catch { continue }
      if (j.type === 'assistant') {
        for (const c of j.message?.content || []) {
          if (c.type === 'tool_use') on({ kind: 'step', text: stepText(c.name, c.input) })
          // Interim prose ("I'll read the file") is part of the trace, not the
          // answer — the final answer is the `result` field below.
          else if (c.type === 'text' && c.text.trim()) { lastText = c.text.trim(); on({ kind: 'text', text: lastText }) }
        }
      } else if (j.type === 'stream_event' && j.event?.type === 'content_block_delta' && j.event.delta?.type === 'text_delta') {
        on({ kind: 'delta', text: j.event.delta.text })
      } else if (j.type === 'result') {
        final = String(j.result ?? '').trim()
      }
    }
  })
  child.on('error', (e) => { clearTimeout(kill); no(new Error(`${claudeCmd} failed to start: ${e.message}`)) })
  child.on('close', (code) => {
    clearTimeout(kill)
    const answer = final || lastText
    if (!answer) return no(new Error(`${claudeCmd} exited ${code} with no answer${err ? ` — ${err.slice(0, 400)}` : ''}`))
    ok(answer)
  })
})

// The journal needs a kind and a key on every anchor; a remark made with neither
// still belongs somewhere, so it lands on `unanchored`.
const normalizeAnchor = (payload) => {
  const raw = payload.anchor && typeof payload.anchor === 'object' ? payload.anchor : {}
  const key = payload.anchorKey || raw.key || 'unanchored'
  return { ...raw, key, kind: raw.kind || key.split(':')[0] || 'unanchored' }
}
const turnFor = (key, requestId) => {
  const all = turns(review)
  return all.find(t => t.requestId === requestId) || all.filter(t => t.anchorKey === key).pop()
}
let inFlight = 0

// The projection as the page reads it: journal state plus how much of what the map
// reported has actually been decided.
const rmForCoverage = JSON.parse(readFileSync(mapPath, 'utf8'))

// The journal has another writer — a Claude Code session running /whydiff-work in
// the same repo. Holding the projection in memory would make the page quietly stale
// the moment that session records anything, so re-read whenever the log has moved.
let logStamp = 0
const refresh = () => {
  try {
    const m = statSync(join(reviewDir, REVIEW_LOG)).mtimeMs
    if (m !== logStamp) { logStamp = m; review = readReview(reviewDir).state }
  } catch {}
}
const reviewRead = () => { refresh(); return { ...review, coverage: coverage(rmForCoverage, review) } }

const FIELD = { ask: 'question', instruct: 'instruction', propose: 'finding' }
const SIGIL = { ask: '?', instruct: '»', propose: '*' }

/**
 * One exchange with the model: a question answered, an instruction planned, or a
 * finding answered with options. All three stream the same NDJSON events to the
 * page and all three end by journalling what was said, so the panel has a single
 * renderer and the log a single shape.
 */
const exchange = async (res, payload, mode) => {
  // A proposal is asked for by clicking a finding, so its "text" is that finding —
  // which is also what makes the citation impossible to omit.
  const text = String(payload[FIELD[mode]] || (mode === 'propose' ? payload.anchorKey : '') || '').trim()
  if (!text) return json(res, 400, { error: `empty ${FIELD[mode]}` })
  // The text is passed to spawn as an argv entry, never through a shell.
  const anchor = normalizeAnchor(payload)
  const history = turns(review).filter(t => t.anchorKey === anchor.key)
    .map(t => ({ request: t.request, response: t.response }))
  inFlight++
  process.stdout.write(`  ${SIGIL[mode]} ${anchor.key}: ${text.slice(0, 70)}${text.length > 70 ? '…' : ''}\n`)
  // Newline-delimited JSON rather than SSE: the request is a POST (the anchor
  // does not fit in a query string), and fetch's ReadableStream reads this
  // directly. Flushed per event so the page shows progress as it happens.
  res.writeHead(200, {
    'content-type': 'application/x-ndjson; charset=utf-8',
    'cache-control': 'no-cache',
    'x-accel-buffering': 'no',
  })
  const emit = (o) => { try { res.write(JSON.stringify(o) + '\n') } catch {} }
  const steps = []
  let tail = ''      // what the model has streamed, to spot the json fence
  try {
    const prompt = mode === 'ask' ? buildPrompt(anchor, text, history)
      : mode === 'instruct' ? buildPlanPrompt(anchor, text, history)
        : buildProposePrompt(anchor, text, history)
    const reply = await run(prompt, (ev) => {
      if (ev.kind === 'step') steps.push(ev.text)
      // A plan and a proposal both end in a machine-readable block the reviewer has
      // no reason to watch being typed. It is always last, so suppressing from the
      // fence on hides it without hiding anything else.
      if (mode !== 'ask' && (ev.kind === 'delta' || ev.kind === 'text')) {
        tail = ev.kind === 'text' ? ev.text : tail + ev.text
        if (tail.includes('```json')) return
      }
      emit(ev)
    })
    const at = new Date().toISOString()
    const split = mode === 'instruct' ? splitPlan(reply, text)
      : mode === 'propose' ? splitProposal(reply, anchor.key)
        : { prose: reply }
    const { prose, plan = null, proposal = null } = split
    // A proposal with neither options nor a reason is not an answer. It is shown —
    // the reviewer paid for it — but nothing that empty goes into the log.
    const emptyProposal = mode === 'propose' && !proposal.variants.length && !proposal.noFixNeeded
    // Persist, but never at the cost of the reply: the reviewer already paid for
    // it, so a rejected append is reported and the reply still shown.
    let turn = { anchorKey: anchor.key, anchor, at, kind: mode, request: mode === 'propose' ? null : text, response: prose, steps, plan, proposal, task: null, decision: null }
    try {
      if (emptyProposal) throw new Error('the model returned no options and no reason')
      const reqId = newId('n')
      review = appendEvents(reviewDir, mode === 'ask' ? [
        { type: 'note.added', noteId: reqId, by: 'reviewer', kind: 'question', anchor, text },
        { type: 'note.added', by: 'claude', kind: 'answer', anchor, text: prose, steps, replyTo: reqId },
      ] : mode === 'instruct' ? [
        { type: 'note.added', noteId: reqId, by: 'reviewer', kind: 'instruction', anchor, text },
        { type: 'note.added', by: 'claude', kind: 'report', anchor, text: prose, steps, plan, replyTo: reqId },
      ] : [
        { type: 'note.added', noteId: reqId, by: 'claude', kind: 'proposal', anchor, text: prose, steps, proposal },
      ], { now: at }).state
      turn = turnFor(anchor.key, reqId) || turn
    } catch (e) {
      process.stdout.write(`  ! not journalled: ${e.message}\n`)
    }
    process.stdout.write(`  ✓ ${mode === 'ask' ? 'answered' : mode === 'instruct' ? 'planned' : `${proposal?.variants.length || 0} option(s)`} (${prose.length} chars, ${steps.length} step(s))\n`)
    emit({ kind: 'done', turn })
  } catch (e) {
    process.stdout.write(`  ✗ ${e.message}\n`)
    emit({ kind: 'error', error: e.message })
  } finally { inFlight--; res.end() }
}

// ── working a task in a throwaway worktree ──────────────────────────────────────
// Why a worktree: the whole point of the report is that no LLM edit lands in the
// reviewed tree unlooked-at. The agent gets a copy of that tree, produces a patch,
// and the patch is applied only when the reviewer says so. This isolates *files*,
// not the process — the worker can run commands, which is what makes it able to run
// the tests its criterion names, and is why the mode is opt-in.
const git = (cwd, argv) => execFileSync('git', ['-C', cwd, ...argv], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })

/**
 * A worktree holding what the reviewer is actually looking at. The reviewed change
 * is often the working tree itself, so seeding from HEAD would hand the agent a
 * tree without the diff under review. `git stash create` snapshots the modified
 * tracked files as a commit without touching anything; untracked files cannot ride
 * along, so they are reported rather than silently missing.
 */
const makeWorktree = (taskId) => {
  const dir = join(tmpdir(), `whydiff-work-${taskId}-${randomBytes(3).toString('hex')}`)
  let base = git(repo, ['rev-parse', 'HEAD']).trim()
  let seeded = 'HEAD'
  const dirty = git(repo, ['status', '--porcelain']).trim()
  if (dirty) {
    const snap = git(repo, ['stash', 'create']).trim()
    if (snap) { base = snap; seeded = 'the working tree as it stands' }
  }
  const untracked = git(repo, ['ls-files', '--others', '--exclude-standard']).split('\n')
    .map(s => s.trim()).filter(Boolean).filter(p => !p.startsWith('.whydiff/'))
  git(repo, ['worktree', 'add', '--detach', dir, base])
  return { dir, base, seeded, untracked }
}
const dropWorktree = (dir) => {
  try { git(repo, ['worktree', 'remove', '--force', dir]) } catch { try { rmSync(dir, { recursive: true, force: true }) } catch {} }
}
// Reclaim worktrees a killed run left behind. Ours are named `whydiff-work-*`:
// `prune` clears registrations whose directory is already gone (a reboot wiped the
// temp dir); a force-remove reclaims the ones a SIGKILL left on disk. Only our own
// worktrees are touched — never someone else's. Runs once at startup, under --work.
// (Two `serve --work` on one repo is unsupported — the worker lock is per process —
// so a second start reclaiming a first's in-flight worktree is not a real case.)
const sweepWorktrees = () => {
  try { git(repo, ['worktree', 'prune']) } catch {}
  let list = ''
  try { list = git(repo, ['worktree', 'list', '--porcelain']) } catch { return }
  let cleaned = 0
  for (const block of list.split('\n\n')) {
    const m = /^worktree (.+)$/m.exec(block)
    if (!m || !m[1].includes('/whydiff-work-')) continue
    try { git(repo, ['worktree', 'remove', '--force', m[1]]) } catch {}
    try { rmSync(m[1], { recursive: true, force: true }) } catch {}
    cleaned++
  }
  if (cleaned) { try { git(repo, ['worktree', 'prune']) } catch {} }
  if (cleaned) process.stdout.write(`  ⌫ reclaimed ${cleaned} leftover worktree(s) from a previous run\n`)
}

const buildWorkPrompt = (task, thread, wt) => `You are doing one agreed task from a whydiff code review, inside a throwaway git worktree.

Your working directory is a COPY of the reviewer's tree (seeded from ${wt.seeded}). Change it freely: nothing here touches their checkout. Do NOT commit, and do not create branches or worktrees.${wt.untracked.length ? `\nUntracked files did not come along: ${wt.untracked.slice(0, 20).join(', ')}. Do not recreate them; if the task genuinely needs one, stop and say so.` : ''}

The review map that discussed this change is at ${mapPath} (read-only reference; the code in your working directory is the ground truth when they disagree).

THE TASK
${task.spec}

PROVED DONE BY
${task.acceptance.type}: ${task.acceptance.name || task.acceptance.key || task.acceptance.what}

WHERE IT WAS DISCUSSED
${task.anchor.label || task.anchor.key}${task.anchor.files?.length ? `\nFiles named in the discussion: ${task.anchor.files.join(', ')}` : ''}

THE DISCUSSION THAT PRODUCED IT
${thread.map(n => `[${n.by} ${n.kind}] ${n.text.replace(/\s+/g, ' ').slice(0, 700)}`).join('\n') || '(nothing beyond the task itself)'}

RULES
- The task above is the boundary. If the work turns out to need something nobody agreed to — a refactor, a new dependency, a schema change — do NOT do it: stop and explain what is needed and why.
- If the discussion leaves a question that has to be answered before this can be done right, do not guess: stop and ask it.
- When the criterion names a test, write or run it. Report what you actually ran and what it printed; never claim a pass you did not see.
- Match the surrounding code: its conventions, its naming, its comment density.

Finish with a short report in ${task.anchor.lang || 'the language of the discussion above'}: what you changed file by file, what you ran and its result, and anything you deliberately did not do. Plain prose, under 200 words.`

// The produced patch, split for reading: file, counts, and the changed lines with
// the same add/del/ctx shape the report's own fragments use.
const PATCH_FILES = 40
const PATCH_LINES = 300
const parsePatch = (text) => {
  const files = []
  let cur = null
  for (const line of text.split('\n')) {
    if (line.startsWith('diff --git ')) {
      const m = / b\/(.*)$/.exec(line)
      cur = { path: m ? m[1] : '?', isNew: false, add: 0, del: 0, hunks: [] }
      if (files.length < PATCH_FILES) files.push(cur)
      else cur = null
      continue
    }
    if (!cur) continue
    if (line.startsWith('new file mode')) { cur.isNew = true; continue }
    if (line.startsWith('---') || line.startsWith('+++') || line.startsWith('\\')) continue
    if (line.startsWith('@@')) { if (cur.hunks.length < PATCH_LINES) cur.hunks.push(['ctx', line.slice(0, 200)]); continue }
    const c = line[0]
    if (c !== '+' && c !== '-' && c !== ' ') continue
    if (c === '+') cur.add++
    else if (c === '-') cur.del++
    if (cur.hunks.length < PATCH_LINES) cur.hunks.push([c === '+' ? 'add' : c === '-' ? 'del' : 'ctx', line.slice(1, 200)])
  }
  return files
}

// One at a time: two agents at once would double the spend and make the report of
// what happened ambiguous, and neither is worth it for a queue a human is watching.
let working = null

const workTask = async (res, taskId) => {
  refresh()
  const task = review.tasks.find(t => t.taskId === taskId)
  if (!task) return json(res, 404, { error: `unknown task ${taskId}` })
  if (!['open', 'in_progress'].includes(task.state)) return json(res, 400, { error: `task is ${task.state} — only an agreed task is worked` })
  if (working) return json(res, 409, { error: `already working ${working}` })
  working = taskId

  res.writeHead(200, { 'content-type': 'application/x-ndjson; charset=utf-8', 'cache-control': 'no-cache', 'x-accel-buffering': 'no' })
  const emit = (o) => { try { res.write(JSON.stringify(o) + '\n') } catch {} }
  const steps = []
  let wt = null
  try {
    wt = makeWorktree(taskId)
    emit({ kind: 'step', text: `worktree from ${wt.seeded}` })
    if (wt.untracked.length) emit({ kind: 'step', text: `${wt.untracked.length} untracked file(s) not carried over` })
    if (task.state === 'open') {
      try { review = appendEvents(reviewDir, { type: 'task.state', taskId, state: 'in_progress' }, { by: 'claude' }).state } catch {}
    }
    process.stdout.write(`  ⚙ working ${taskId} in ${wt.dir}\n`)
    const report = await run(buildWorkPrompt(task, threadOf(review, task), wt), (ev) => {
      if (ev.kind === 'step') steps.push(ev.text)
      emit(ev)
    }, { cwd: wt.dir, tools: WRITE_TOOLS, deny: null, timeout: workTimeoutMs })

    git(wt.dir, ['add', '-A'])
    const patch = git(wt.dir, ['diff', '--cached'])
    if (!patch.trim()) {
      // A resolution with an empty patch would be a lie; hand the task back instead.
      try {
        review = appendEvents(reviewDir, [
          { type: 'note.added', by: 'claude', kind: 'report', anchor: task.anchor, taskId, text: report },
          { type: 'task.state', taskId, state: 'open' },
        ], { by: 'claude' }).state
      } catch (e) { process.stdout.write(`  ! not journalled: ${e.message}\n`) }
      process.stdout.write(`  ∅ ${taskId} produced no changes\n`)
      return emit({ kind: 'done', empty: true, report, review: reviewRead(), threads: turns(review) })
    }
    mkdirSync(patchDir, { recursive: true })
    const patchPath = join(patchDir, `${taskId}.patch`)
    writeFileSync(patchPath, patch)
    const files = parsePatch(patch)
    try {
      review = appendEvents(reviewDir, [
        { type: 'note.added', by: 'claude', kind: 'report', anchor: task.anchor, taskId, text: report, steps },
        { type: 'task.resolved', taskId, patch: patchPath, files: files.map(f => f.path) },
      ], { by: 'claude' }).state
    } catch (e) { process.stdout.write(`  ! not journalled: ${e.message}\n`) }
    process.stdout.write(`  ✓ ${taskId} → ${files.length} file(s), patch ${patchPath}\n`)
    emit({ kind: 'done', report, patch: patchPath, files, review: reviewRead(), threads: turns(review) })
  } catch (e) {
    process.stdout.write(`  ✗ ${taskId}: ${e.message}\n`)
    emit({ kind: 'error', error: e.message })
  } finally {
    if (wt) dropWorktree(wt.dir)
    working = null
    res.end()
  }
}

// The gate. A patch that does not apply cleanly is reported, never forced: the
// reviewed tree moved on, or this patch is already in it.
const applyPatch = (res, taskId) => {
  refresh()
  const task = review.tasks.find(t => t.taskId === taskId)
  if (!task?.resolution?.patch) return json(res, 400, { error: 'this task has no patch to apply' })
  if (!existsSync(task.resolution.patch)) return json(res, 400, { error: `patch is gone: ${task.resolution.patch}` })
  try {
    git(repo, ['apply', '--check', task.resolution.patch])
  } catch (e) {
    // Tell the two cases apart, because the fix differs. If the reverse patch
    // applies cleanly the change is already in the tree — nothing to do. Otherwise
    // the tree moved on since this task was worked, and the honest recovery is to
    // re-run the task so the worker rebases it on the tree as it stands now. The
    // gate stays clean-or-refuse: a patch that does not fit is never forced, so the
    // working tree is never left half-applied or carrying conflict markers.
    let already = false
    try { git(repo, ['apply', '--reverse', '--check', task.resolution.patch]); already = true } catch {}
    return already
      ? json(res, 409, { applied: true, error: 'this patch is already in your working tree — there is nothing to apply' })
      : json(res, 409, { movedOn: true, error: `the patch no longer fits the working tree — it changed since this task was worked. Re-run the task to rebase it on the tree as it stands now (${String(e.stderr || e.message).trim().slice(0, 200)})` })
  }
  try {
    git(repo, ['apply', task.resolution.patch])
  } catch (e) {
    return json(res, 500, { error: String(e.stderr || e.message).trim().slice(0, 300) })
  }
  try {
    review = appendEvents(reviewDir, {
      type: 'note.added', by: 'reviewer', kind: 'decision', anchor: task.anchor, taskId,
      applied: task.resolution.files,
      text: `Patch applied to the working tree: ${task.resolution.files.join(', ')}`,
    }).state
  } catch (e) { process.stdout.write(`  ! apply not journalled: ${e.message}\n`) }
  process.stdout.write(`  ⇩ applied ${taskId} to ${repo}\n`)
  return json(res, 200, { applied: task.resolution.files, review: reviewRead(), threads: turns(review) })
}

// ── generating an optional section on demand ────────────────────────────────────
// The core run builds the Code map/Diagrams/Ops(env). The other passes are lazy:
// clicking Generate runs that pass's own agent against the same diff, read-only,
// and folds its keys into the map. Read-only by construction (same allowlist as
// ask/plan) — this writes only the report's own JSON in .whydiff, never the repo.
const SECTIONS = {
  story: { agent: 'summariser', keys: ['story'] },
  standards: { agent: 'standards-reviewer', keys: ['standards', 'blastRadius'] },
  tests: { agent: 'tests-analyst', keys: ['tests'] },
  stories: { agent: 'story-writer', keys: ['userStories'] },
  // Diagrams are a core pass, but they can be re-run on demand: when the generated
  // mermaid doesn't parse, the viewer offers "Regenerate diagrams", which re-runs the
  // diagrammer through this same endpoint and replaces the map's diagrams.
  diagrams: { agent: 'diagrammer', keys: ['diagrams'] },
}
const buildSectionPrompt = (section, lang) => {
  const { agent, keys } = SECTIONS[section]
  // The agent's own instructions carry its expertise; strip the frontmatter and
  // override its "write to a file" protocol — here it prints, read-only.
  const md = readFileSync(join(rootDir, 'agents', `${agent}.md`), 'utf8').replace(/^---[\s\S]*?\n---\n/, '').trim()
  return `You are the whydiff "${agent}" analysis pass, run on demand to add ONE section to an existing review map.

Follow these pass instructions:
"""
${md}
"""

Grounding for THIS run:
REPO: ${repo}
DIFF: ${join(reviewDir, 'diff.patch')}
MANIFEST: ${join(reviewDir, 'manifest.json')}
MAP (the report so far, for context only): ${mapPath}
REPORT_LANGUAGE: ${lang || 'en'}

Read the diff and whatever code you need, then produce your result.

OUTPUT CONTRACT — this OVERRIDES any instruction above about writing to a file (\`OUT:\`). You have read-only tools and MUST NOT write anything. Reply with NOTHING but one fenced json block, nothing before or after it:
\`\`\`json
{ ${keys.map(k => `"${k}": …`).join(', ')} }
\`\`\`
Use exactly these top-level keys (${keys.join(', ')}), each shaped as the pass documents and the schema requires. No prose, no other fenced blocks.`
}
const generateSection = async (res, payload) => {
  const section = String(payload.section || '')
  if (!SECTIONS[section]) return json(res, 400, { error: `unknown section: ${section}` })
  let lang = 'en'
  try { lang = JSON.parse(readFileSync(mapPath, 'utf8')).meta?.lang || 'en' } catch {}
  res.writeHead(200, { 'content-type': 'application/x-ndjson; charset=utf-8', 'cache-control': 'no-cache', 'x-accel-buffering': 'no' })
  const emit = (o) => { try { res.write(JSON.stringify(o) + '\n') } catch {} }
  inFlight++
  process.stdout.write(`  + generate ${section}\n`)
  try {
    // Forward the pass's tool steps, and — once — the moment it stops reading and starts
    // writing its answer (first text/delta). That read→write transition is the real signal
    // the viewer uses to advance its progress bar past the exploration phase.
    let wroteOnce = false
    const reply = await run(buildSectionPrompt(section, lang), (ev) => {
      if (ev.kind === 'step') emit(ev)
      else if (!wroteOnce && (ev.kind === 'text' || ev.kind === 'delta')) { wroteOnce = true; emit({ kind: 'phase', phase: 'writing' }) }
    }, { timeout: genTimeoutMs })
    const { raw } = tailJSON(reply)
    if (!raw || typeof raw !== 'object') throw new Error('the pass returned no JSON block')
    const { keys } = SECTIONS[section]
    const patch = {}
    for (const k of keys) if (k in raw && raw[k] != null) patch[k] = raw[k]
    if (!Object.keys(patch).length) throw new Error(`the pass returned none of: ${keys.join(', ')}`)
    const map = JSON.parse(readFileSync(mapPath, 'utf8'))
    Object.assign(map, patch)
    map.generated = Array.from(new Set([...(Array.isArray(map.generated) ? map.generated : []), section]))
    writeFileSync(mapPath, JSON.stringify(map, null, 2))
    rebuildPage()
    process.stdout.write(`  ✓ generated ${section} (${Object.keys(patch).join(', ')})\n`)
    emit({ kind: 'done', section })
  } catch (e) {
    const msg = /timed out/.test(e.message)
      ? `${e.message} — this pass reads the whole diff; restart the server with --gen-timeout <ms> to allow more time`
      : e.message
    process.stdout.write(`  ✗ generate ${section}: ${e.message}\n`)
    emit({ kind: 'error', error: msg })
  } finally { inFlight--; res.end() }
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost')
  if (url.pathname === '/' || url.pathname === '/index.html') {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    return res.end(page)
  }
  if (!url.pathname.startsWith('/api/')) return json(res, 404, { error: 'not found' })
  if (req.headers['x-whydiff-token'] !== token) return json(res, 403, { error: 'bad token' })

  if (url.pathname === '/api/ping') return json(res, 200, { ok: true, repo, map: mapPath, work: workMode })
  // Completed exchanges, in the shape the panel renders.
  if (url.pathname === '/api/threads') { refresh(); return json(res, 200, { threads: turns(review) }) }
  // The whole projection — notes, tasks, counts — for the Tasks tab, plus the
  // decision-coverage manifest. Coverage is a read model, not journal state: it
  // needs the map, which the projection on disk deliberately knows nothing about.
  if (url.pathname === '/api/review') return json(res, 200, reviewRead())

  if (req.method !== 'POST') return json(res, 404, { error: 'not found' })
  let payload
  try { payload = await readBody(req) } catch (e) { return json(res, 400, { error: e.message }) }

  if (url.pathname === '/api/ask') return exchange(res, payload, 'ask')
  if (url.pathname === '/api/instruct') return exchange(res, payload, 'instruct')
  if (url.pathname === '/api/propose') return exchange(res, payload, 'propose')
  if (url.pathname === '/api/generate') return generateSection(res, payload)

  if (url.pathname === '/api/work' || url.pathname === '/api/apply') {
    if (!workMode) return json(res, 403, { error: 'this server was started without --work: it reads and plans, it does not change the repo' })
    const taskId = String(payload.taskId || '')
    return url.pathname === '/api/work' ? workTask(res, taskId) : applyPatch(res, taskId)
  }

  // A task opens only from an approved plan: the reviewer confirms, and the spec
  // that gets stored is the agreed one, not the raw instruction.
  if (url.pathname === '/api/task') {
    const anchor = normalizeAnchor(payload)
    const spec = String(payload.spec || '').trim()
    try {
      review = appendEvents(reviewDir, {
        type: 'task.opened', taskId: newId('t'), anchor, threadKey: anchor.key,
        origin: payload.origin === 'proposal' ? 'proposal' : 'reviewer',
        from: payload.from || null, finding: payload.finding || undefined,
        spec, acceptance: payload.acceptance, state: 'open',
      }).state
    } catch (e) { return json(res, 400, { error: e.message }) }
    const task = review.tasks[review.tasks.length - 1]
    process.stdout.write(`  ✔ task ${task.taskId} opened on ${anchor.key}: ${spec.slice(0, 60)}\n`)
    return json(res, 200, { task, threads: turns(review), review: reviewRead() })
  }

  if (url.pathname === '/api/task-state') {
    try {
      review = appendEvents(reviewDir, {
        type: 'task.state', taskId: String(payload.taskId || ''),
        state: String(payload.state || ''), reason: payload.reason,
      }).state
    } catch (e) { return json(res, 400, { error: e.message }) }
    process.stdout.write(`  ✔ task ${payload.taskId} → ${payload.state}\n`)
    return json(res, 200, { threads: turns(review), review: reviewRead() })
  }

  // The reviewer's own notes — no model involved. A turned-down plan is recorded
  // rather than forgotten, so the page stops offering to open it.
  if (url.pathname === '/api/note') {
    try {
      review = appendEvents(reviewDir, {
        // `note` is a bare reviewer remark pinned to a place; `decision` is the
        // reviewer's verdict on a plan (e.g. "not now"). The client says which.
        type: 'note.added', by: 'reviewer', kind: payload.kind === 'note' ? 'note' : 'decision',
        anchor: normalizeAnchor(payload), text: String(payload.text || '').trim(),
        replyTo: payload.replyTo || undefined,
      }).state
    } catch (e) { return json(res, 400, { error: e.message }) }
    return json(res, 200, { threads: turns(review), review: reviewRead() })
  }

  return json(res, 404, { error: 'not found' })
})

// Open a URL in the OS default browser, best-effort (never let it break serving).
const openInBrowser = (url) => {
  const cmd = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'cmd' : 'xdg-open'
  const args = process.platform === 'win32' ? ['/c', 'start', '', url] : [url]
  try { const c = spawn(cmd, args, { stdio: 'ignore', detached: true }); c.on('error', () => {}); c.unref() } catch {}
}

server.listen(port, '127.0.0.1', () => {
  if (workMode) sweepWorktrees()
  const url = `http://127.0.0.1:${port}/`
  console.log(`  map    ${mapPath}`)
  console.log(`  repo   ${repo}`)
  const existing = review.counts.questions
  console.log(`  journal ${join(reviewDir, REVIEW_LOG)}${existing ? ` (${existing} question(s) already asked)` : ''}`)
  console.log(`  asking and planning via \`${claudeCmd} -p\` (${READ_ONLY_TOOLS}; ${DENY_WRITES} refused) — Ctrl-C to stop`)
  console.log(workMode
    ? `  --work is ON: an agreed task can be worked in a throwaway git worktree; its patch reaches ${repo} only when you apply it`
    : '  --work is off: nothing here edits the repo')
  if (migrated) console.log(`  migrated ${migrated} thread(s) from threads.json (kept as threads.migrated.json)`)
  if (!noOpen) openInBrowser(url)
  // The URL is the one thing the reviewer needs — print it LAST so it is the line left on
  // screen, not buried above the rest of the startup log.
  console.log(`\nwhydiff review map: ${url}${noOpen ? '' : '  (opened in your browser)'}`)
})
process.on('SIGINT', () => { console.log(`\nstopped${inFlight ? ` (${inFlight} answer(s) abandoned)` : ''}`); process.exit(0) })
