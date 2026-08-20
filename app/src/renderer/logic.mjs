// Pure, DOM-free logic behind the renderer — extracted from the JSX so it can be unit
// tested in node without React or a browser. Keep only functions here that take data and
// return data; anything that touches the DOM or window.api stays in the components.

// A short label for an analysis's ref: the working tree, a PR number, or a short hash.
export const refLabel = (a) => a.kind === 'working' ? 'working tree'
  : a.kind === 'pr' ? String(a.ref).replace(/^pr:/, 'PR #')
  : (a.ref || '').slice(0, 8)

// The optional passes a user can pick at order time (the core passes always run). `id` is
// the section id the skill understands; `agent` is the pass name run.mjs reports progress
// under, so the progress bar can name the stage.
export const OPTIONAL = [
  { id: 'story', label: 'Summary', agent: 'summariser' },
  { id: 'stories', label: 'User stories', agent: 'story-writer' },
  { id: 'standards', label: 'Standards', agent: 'standards-reviewer' },
  { id: 'tests', label: 'Tests', agent: 'tests-analyst' },
]
export const AGENT_OF = Object.fromEntries(OPTIONAL.map((o) => [o.id, o.agent]))

// Human labels for every stage run.mjs emits (@stage markers).
export const STAGE_LABEL = {
  prepare: 'Prepare', classifier: 'Code map', diagrammer: 'Diagrams',
  summariser: 'Summary', 'story-writer': 'User stories', 'standards-reviewer': 'Standards', 'tests-analyst': 'Tests',
  merge: 'Merge', assemble: 'Assemble',
}

// The stages a run WILL go through, given the chosen sections — so the bar can show what's
// planned before anything starts. Core passes always run.
export const plannedStages = (sections) => {
  const optional = sections.map((id) => AGENT_OF[id]).filter(Boolean)
  return ['prepare', 'classifier', 'diagrammer', ...optional, 'merge', 'assemble']
    .map((name) => ({ name, label: STAGE_LABEL[name] || name, started: 0, finished: 0 }))
}

// A pass is done when every start it announced has finished; running once any start
// arrives (agents run in parallel, and a sharded classifier starts several times).
export const statusOf = (s) => (s.started > 0 && s.finished >= s.started ? 'done' : s.started > 0 ? 'running' : 'pending')

export const applyStageEvent = (stages, { stage, status }) => {
  const next = stages.map((s) => ({ ...s }))
  let s = next.find((x) => x.name === stage)
  if (!s) { s = { name: stage, label: STAGE_LABEL[stage] || stage, started: 0, finished: 0 }; next.push(s) }
  if (status === 'start') s.started++
  else if (status === 'done') s.finished++
  return next
}

// How many commits a page holds — the initial load and every "load more" after it.
export const COMMIT_PAGE = 30

// The branch picker's options, in the order a reviewer looks for them: the checked-out
// branch first (it is what the working tree belongs to), then the other local branches,
// then remote-only ones. `group` labels the optgroup; `value` is what git is given.
export function branchOptions({ current, local = [], remote = [] } = {}) {
  const seen = new Set()
  const out = []
  const push = (value, group) => { if (value && !seen.has(value)) { seen.add(value); out.push({ value, group }) } }
  push(current, 'Current')
  for (const b of [...local].sort()) push(b, 'Local')
  for (const b of [...remote].sort()) push(b, 'Remote')
  return out
}

// What the compare fields start on. The useful default is "what my branch adds on top of
// the integration branch", so base is the first mainline branch the repo actually has and
// head is what is being browsed — never the same ref on both sides, which compares nothing.
const MAINLINE = ['main', 'master', 'develop', 'origin/main', 'origin/master']
export function defaultCompare(branches, browsing) {
  const all = [...(branches?.local || []), ...(branches?.remote || [])]
  const head = browsing || branches?.current || 'HEAD'
  const base = MAINLINE.find((m) => all.includes(m) && m !== head)
    || all.find((b) => b !== head)
    || head
  return { base, head }
}

// Filter the loaded commits by a free-text query — subject, author, or hash prefix. Local
// and instant: it narrows what is already on screen rather than re-running git, which is
// what "I know the commit is here somewhere" actually needs.
export function filterCommits(commits, query) {
  const q = String(query || '').trim().toLowerCase()
  if (!q) return commits || []
  return (commits || []).filter((c) =>
    (c.subject || '').toLowerCase().includes(q) ||
    (c.author || '').toLowerCase().includes(q) ||
    (c.hash || '').toLowerCase().startsWith(q) ||
    (c.short || '').toLowerCase().startsWith(q))
}

// The one-line description of what a report preset will generate — shown next to the
// button that runs it, so the cost is stated where the decision is made.
export const MODE_HINT = {
  quick: 'Diagrams, Code map & Ops — fastest, fewest tokens',
  full: 'every section — slower, most tokens',
  custom: 'core plus the sections you pick',
}

// Which review-activity pills to show for a saved analysis, given its journal counts.
// Discussions (question/task threads) and pinned notes; the discussions pill is flagged
// `attn` when some still need attention (unanswered questions + open work). Empty array
// when there is nothing to show, so the component renders nothing.
export const reviewPills = (counts) => {
  if (!counts) return []
  const pills = []
  if (counts.discussions > 0) pills.push({ kind: 'discussions', n: counts.discussions, attn: (counts.blocking || 0) > 0 })
  if (counts.notes > 0) pills.push({ kind: 'notes', n: counts.notes, attn: false })
  return pills
}
