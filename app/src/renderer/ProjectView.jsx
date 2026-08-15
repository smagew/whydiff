import React, { useEffect, useState } from 'react'
import { ReviewCounts } from './ProjectList.jsx'

const refLabel = (a) => a.kind === 'working' ? 'working tree' : a.kind === 'pr' ? a.ref.replace(/^pr:/, 'PR #') : (a.ref || '').slice(0, 8)

// The optional passes the user can pick at order time (core always runs). `id` is the
// section id the skill understands; `agent` is the pass name run.mjs reports progress
// under, so the progress bar can name the stage.
const OPTIONAL = [
  { id: 'story', label: 'Summary', agent: 'summariser' },
  { id: 'stories', label: 'User stories', agent: 'story-writer' },
  { id: 'standards', label: 'Standards', agent: 'standards-reviewer' },
  { id: 'tests', label: 'Tests', agent: 'tests-analyst' },
]
const AGENT_OF = Object.fromEntries(OPTIONAL.map((o) => [o.id, o.agent]))
// Human labels for every stage run.mjs emits (@stage markers).
const STAGE_LABEL = {
  prepare: 'Prepare', classifier: 'Code map', diagrammer: 'Diagrams',
  summariser: 'Summary', 'story-writer': 'User stories', 'standards-reviewer': 'Standards', 'tests-analyst': 'Tests',
  merge: 'Merge', assemble: 'Assemble',
}

// The stages a run WILL go through, given the chosen sections — so the bar can show
// what's planned before anything starts. Core passes always run.
const plannedStages = (sections) => {
  const optional = sections.map((id) => AGENT_OF[id]).filter(Boolean)
  return ['prepare', 'classifier', 'diagrammer', ...optional, 'merge', 'assemble']
    .map((name) => ({ name, label: STAGE_LABEL[name] || name, started: 0, finished: 0 }))
}
// A pass is done when every start it announced has finished; running once any start
// arrives (agents run in parallel, and a sharded classifier starts several times).
const statusOf = (s) => (s.started > 0 && s.finished >= s.started ? 'done' : s.started > 0 ? 'running' : 'pending')
const applyStageEvent = (stages, { stage, status }) => {
  const next = stages.map((s) => ({ ...s }))
  let s = next.find((x) => x.name === stage)
  if (!s) { s = { name: stage, label: STAGE_LABEL[stage] || stage, started: 0, finished: 0 }; next.push(s) }
  if (status === 'start') s.started++
  else if (status === 'done') s.finished++
  return next
}

function StageProgress({ stages, text }) {
  if (!stages || !stages.length) {
    return <div className="run"><span className="spin" /> <span className="run-txt">{text || 'working…'}</span></div>
  }
  const done = stages.filter((s) => statusOf(s) === 'done').length
  const pct = Math.round((done / stages.length) * 100)
  return (
    <div className="prog">
      <div className="prog-bar"><span style={{ width: `${pct}%` }} /></div>
      <div className="prog-stages">
        {stages.map((s) => {
          const st = statusOf(s)
          return (
            <span className={`pstage ${st}`} key={s.name}>
              <span className="pdot">{st === 'done' ? '✓' : st === 'running' ? <span className="spin sm" /> : ''}</span>
              {s.label}
            </span>
          )
        })}
      </div>
      {text ? <div className="run-txt">{text}</div> : null}
    </div>
  )
}

// A selected project: resolve where its git lives (a local folder, or a GitHub clone),
// show its state, and the ways to run a review — the working tree, a commit, or a pull
// request. Anything with a saved map is marked and re-opens without re-running.
export default function ProjectView({ project, onBack }) {
  const isLocal = project.kind === 'local'
  const [resolved, setResolved] = useState(null) // { repo, cloned } | null
  const [state, setState] = useState(null)
  const [analyses, setAnalyses] = useState([])
  const [prs, setPrs] = useState(null)
  const [prsError, setPrsError] = useState('')
  const [cloning, setCloning] = useState(false)
  const [cloneMsg, setCloneMsg] = useState('')
  const [analyzing, setAnalyzing] = useState(false)
  const [progress, setProgress] = useState('')
  const [stages, setStages] = useState(null) // live @stage progress during a run
  const [error, setError] = useState('')
  // What to generate: 'quick' = core only (cheapest, default), 'full' = every section,
  // 'custom' = the optional passes the user ticks. Opt-in by design — the extra passes
  // cost time and tokens.
  const [mode, setMode] = useState('quick')
  const [custom, setCustom] = useState({ story: false, stories: false, standards: false, tests: false })
  const [edits, setEdits] = useState(false) // opt-in: open maps able to run a fix in a worktree (uses tokens)

  const latestByRef = new Map()
  for (const a of analyses) if (!latestByRef.has(a.ref)) latestByRef.set(a.ref, a)
  const repo = resolved?.repo
  const sectionsFor = () => (mode === 'custom' ? OPTIONAL.filter((o) => custom[o.id]).map((o) => o.id) : [])

  const refreshAnalyses = async () => setAnalyses(await window.api.analysesForProject(project.id))
  const loadRepo = (r) => {
    window.api.gitState(r).then(setState)
    if (!isLocal) window.api.listPRs(project).then(setPrs).catch((e) => setPrsError(e?.message || String(e)))
  }
  useEffect(() => {
    setState(null); setPrs(null); setPrsError(''); setError('')
    refreshAnalyses()
    window.api.resolveProject(project).then((r) => { setResolved(r); if (isLocal || r.cloned) loadRepo(r.repo) })
  }, [project.id])

  const cloneNow = async () => {
    setError(''); setCloning(true); setCloneMsg('cloning…')
    const unsub = window.api.onCloneProgress(setCloneMsg)
    try {
      const { repo: r, state: st } = await window.api.cloneProject(project)
      setResolved({ repo: r, cloned: true }); setState(st)
      window.api.listPRs(project).then(setPrs).catch((e) => setPrsError(e?.message || String(e)))
    } catch (e) { setError(e?.message || String(e)) } finally { unsub(); setCloning(false); setCloneMsg('') }
  }

  const analyze = async ({ range, kind, ref, title, analysisId }) => {
    const sections = sectionsFor()
    const full = mode === 'full'
    setError(''); setAnalyzing(true); setProgress('starting the analysis…')
    setStages(plannedStages(full ? OPTIONAL.map((o) => o.id) : sections))
    // Route progress: @stage markers drive the bar, everything else is the ticker text.
    const unsub = window.api.onAnalyzeProgress((line) => {
      if (line.startsWith('@stage ')) {
        try { const evt = JSON.parse(line.slice(7)); setStages((prev) => (prev ? applyStageEvent(prev, evt) : prev)) } catch {}
      } else if (!line.startsWith('whydiff:')) {
        setProgress(line)
      }
    })
    try {
      const { analysis } = await window.api.analyze({ repo, range, projectId: project.id, kind, ref, title, full, sections, analysisId })
      await refreshAnalyses()
      setStages((prev) => (prev ? prev.map((s) => ({ ...s, finished: Math.max(s.finished, s.started || 1), started: s.started || 1 })) : prev))
      setProgress('opening the map…')
      await window.api.openAnalysis(analysis.id, { work: edits })
      setProgress('')
    } catch (e) { setError(e?.message || String(e)) } finally { unsub(); setAnalyzing(false); setStages(null) }
  }
  const analyzeCommit = async (c) => analyze({ range: await window.api.rangeForCommit(repo, c.hash), kind: 'commit', ref: c.hash, title: `${project.name} · ${c.short}` })
  const analyzePr = async (pr) => {
    setError(''); setAnalyzing(true); setProgress(`fetching PR #${pr.number}…`)
    try {
      const range = await window.api.rangeForPr(repo, pr.number, pr.baseRef)
      await analyze({ range, kind: 'pr', ref: `pr:${pr.number}`, title: `${project.name} · PR #${pr.number}` })
    } catch (e) { setError(e?.message || String(e)); setAnalyzing(false) }
  }
  // Regenerate a saved analysis in place (same id + dir, files overwritten), using the
  // preset selected now. The range is rebuilt from the analysis's ref.
  const rerun = async (a) => {
    if (a.kind === 'working') return analyze({ range: '', kind: 'working', ref: '', title: a.title, analysisId: a.id })
    if (a.kind === 'commit') return analyze({ range: await window.api.rangeForCommit(repo, a.ref), kind: 'commit', ref: a.ref, title: a.title, analysisId: a.id })
    if (a.kind === 'pr') {
      const num = Number(String(a.ref).replace(/^pr:/, ''))
      const pr = (prs || []).find((p) => p.number === num)
      if (!pr) return setError("Open the pull request below to re-run it — its base branch isn't loaded here.")
      setError(''); setAnalyzing(true); setProgress(`fetching PR #${num}…`)
      try {
        const range = await window.api.rangeForPr(repo, pr.number, pr.baseRef)
        await analyze({ range, kind: 'pr', ref: a.ref, title: a.title, analysisId: a.id })
      } catch (e) { setError(e?.message || String(e)); setAnalyzing(false) }
    }
  }
  const open = async (id) => { setError(''); try { await window.api.openAnalysis(id, { work: edits }) } catch (e) { setError(e?.message || String(e)) } }
  const drop = async (id) => { try { await window.api.removeAnalysis(id); await refreshAnalyses() } catch (e) { setError(e?.message || String(e)) } }

  const working = latestByRef.get('')
  const needsClone = !isLocal && resolved && !resolved.cloned

  return (
    <>
      <header className="head pv-head">
        <button className="link-back" onClick={onBack} disabled={analyzing || cloning}>← projects</button>
        <div>
          <div className="brand sm">{project.name}</div>
          <div className="loc">{isLocal ? project.path : project.url}{state?.branch ? ` · ${state.branch}` : ''}</div>
        </div>
      </header>

      <div className="order">
        <div className="order-row">
          <span className="order-label">Report</span>
          <div className="seg" role="tablist">
            {[['quick', 'Quick'], ['full', 'Full'], ['custom', 'Custom']].map(([v, label]) => (
              <button key={v} role="tab" aria-selected={mode === v} className={`seg-btn ${mode === v ? 'on' : ''}`} disabled={analyzing} onClick={() => setMode(v)}>{label}</button>
            ))}
          </div>
          <span className="hint">
            {mode === 'quick' ? 'Diagrams, Code map & Ops — fast, cheapest'
              : mode === 'full' ? 'every section — slower, more tokens'
              : 'core plus the sections you pick'}
          </span>
        </div>
        {mode === 'custom' && (
          <div className="order-sections">
            <span className="core-note">Always: Diagrams · Code map · Ops</span>
            {OPTIONAL.map((o) => (
              <label className="opt-sec" key={o.id}>
                <input type="checkbox" checked={custom[o.id]} disabled={analyzing} onChange={(e) => setCustom((c) => ({ ...c, [o.id]: e.target.checked }))} />
                <span>{o.label}</span>
              </label>
            ))}
          </div>
        )}
        <label className="opt-full">
          <input type="checkbox" checked={edits} onChange={(e) => setEdits(e.target.checked)} disabled={analyzing} />
          <span>Allow edits in the map <span className="hint">— a task can be worked in a throwaway worktree (runs Claude, uses tokens)</span></span>
        </label>
      </div>

      {analyzing ? <StageProgress stages={stages} text={progress} />
        : cloning ? <div className="run"><span className="spin" /> <span className="run-txt">{cloneMsg || 'cloning…'}</span></div>
        : null}
      {error ? <div className="err">{error}</div> : null}

      {needsClone ? (
        <div className="banner">
          <div>This GitHub repo isn't cloned yet. Clone it to browse its commits and pull requests.</div>
          <button className="btn primary" disabled={cloning} onClick={cloneNow}>Clone repo</button>
        </div>
      ) : !resolved ? (
        <div className="empty">Resolving…</div>
      ) : (
        <>
          {analyses.length > 0 && (
            <>
              <div className="sec-title">Recent analyses</div>
              <section className="list">
                {analyses.slice(0, 6).map((a) => (
                  <div className="row" key={a.id}>
                    <span className={`tag ${a.kind === 'working' ? 'local' : ''}`}>{a.kind}</span>
                    <div className="meta">
                      <div className="name">{a.title || refLabel(a)}</div>
                      <div className="loc">{refLabel(a)} · {a.created_at.slice(0, 16).replace('T', ' ')}</div>
                    </div>
                    <ReviewCounts counts={a.counts} />
                    <button className="btn" disabled={analyzing} onClick={() => open(a.id)}>View</button>
                    <button className="btn ghost" disabled={analyzing} title="Regenerate this analysis in place (runs the model again)" onClick={() => rerun(a)}>Re-run</button>
                    <span className="x" title="Remove" onClick={() => drop(a.id)}>✕</span>
                  </div>
                ))}
              </section>
            </>
          )}

          {!isLocal && (
            <>
              <div className="sec-title">Pull requests</div>
              <section className="list">
                {prsError ? <div className="note">{prsError}</div>
                  : prs === null ? <div className="empty">Loading pull requests…</div>
                  : prs.length === 0 ? <div className="empty">No open pull requests.</div>
                  : prs.map((pr) => {
                    const a = latestByRef.get(`pr:${pr.number}`)
                    return (
                      <div className="row" key={pr.number}>
                        <span className="hash">#{pr.number}</span>
                        <div className="meta">
                          <div className="name">{a ? <span className="mapped" title="has a saved map">●</span> : null}{pr.title}{pr.draft ? ' · draft' : ''}</div>
                          <div className="loc">{pr.author} · {pr.headRef} → {pr.baseRef} · {pr.updated}</div>
                        </div>
                        {a
                          ? <><button className="btn" disabled={analyzing} onClick={() => open(a.id)}>View</button>
                              <button className="btn ghost" disabled={analyzing} onClick={() => analyzePr(pr)}>Re-run</button></>
                          : <button className="btn" disabled={analyzing} onClick={() => analyzePr(pr)}>Analyze</button>}
                      </div>
                    )
                  })}
              </section>
            </>
          )}

          {state?.ok && state.uncommitted?.dirty && (
            <div className="banner">
              <div><b>{state.uncommitted.count}</b> uncommitted change{state.uncommitted.count === 1 ? '' : 's'} in the working tree.</div>
              <div className="banner-acts">
                {working && <button className="btn" disabled={analyzing} onClick={() => open(working.id)}>View last map</button>}
                <button className="btn primary" disabled={analyzing} onClick={() => analyze({ range: '', kind: 'working', ref: '', title: `${project.name} · working tree` })}>Analyze working changes</button>
              </div>
            </div>
          )}

          {!state ? <div className="empty">Reading git state…</div>
            : !state.ok ? <div className="note">{state.reason}</div>
            : (
              <>
                <div className="sec-title">Recent commits</div>
                <section className="list">
                  {state.commits.length === 0 ? <div className="empty">No commits yet.</div>
                    : state.commits.map((c) => {
                      const a = latestByRef.get(c.hash)
                      return (
                        <div className="row" key={c.hash}>
                          <span className="hash">{c.short}</span>
                          <div className="meta">
                            <div className="name">{a ? <span className="mapped" title="has a saved map">●</span> : null}{c.subject}</div>
                            <div className="loc">{c.author} · {c.date}</div>
                          </div>
                          {a
                            ? <><button className="btn" disabled={analyzing} onClick={() => open(a.id)}>View</button>
                                <button className="btn ghost" disabled={analyzing} onClick={() => analyzeCommit(c)}>Re-run</button></>
                            : <button className="btn" disabled={analyzing} onClick={() => analyzeCommit(c)}>Analyze</button>}
                        </div>
                      )
                    })}
                </section>
              </>
            )}
        </>
      )}
    </>
  )
}
