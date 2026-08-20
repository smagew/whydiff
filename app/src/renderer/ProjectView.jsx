import React, { useEffect, useState } from 'react'
import { ReviewCounts } from './ProjectList.jsx'
import RowMenu from './RowMenu.jsx'
import { refLabel, OPTIONAL, MODE_HINT, COMMIT_PAGE, branchOptions, defaultCompare, filterCommits, plannedStages, statusOf, applyStageEvent } from './logic.mjs'

// Re-read from disk. Drawn rather than typed: the ⟳ character falls back to a different
// face in the UI font stack and lands as a stray mark next to the label.
const RefreshIcon = () => (
  <svg className="ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M21 12a9 9 0 1 1-2.64-6.36" /><path d="M21 3v6h-6" />
  </svg>
)

function StageProgress({ stages, text, onCancel, cancelling }) {
  const cancelBtn = onCancel
    ? <button className="btn ghost cancel-run" onClick={onCancel} disabled={cancelling}>{cancelling ? 'Cancelling…' : 'Cancel'}</button>
    : null
  // role=status + aria-live: a run takes minutes, and without this a screen reader hears
  // nothing at all between pressing Analyze and the map opening.
  if (!stages || !stages.length) {
    return <div className="run" role="status" aria-live="polite"><span className="spin" /> <span className="run-txt">{text || 'working…'}</span>{cancelBtn}</div>
  }
  const done = stages.filter((s) => statusOf(s) === 'done').length
  const running = stages.find((s) => statusOf(s) === 'running')
  const pct = Math.round((done / stages.length) * 100)
  return (
    <div className="prog" role="status" aria-live="polite">
      <div className="prog-head">
        <div className="prog-bar"><span style={{ width: `${pct}%` }} /></div>
        {cancelBtn}
      </div>
      {/* One spoken sentence for the whole bar; the chips below are decoration to a reader. */}
      <span className="sr-only">{`${done} of ${stages.length} passes done${running ? `, running ${running.label}` : ''}`}</span>
      <div className="prog-stages" aria-hidden="true">
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

// The report preset — which passes a run generates. It sits inside the run card, beside the
// button that starts a run, because that is when the cost is decided; every Analyze on the
// page uses the preset shown here.
function ReportPicker({ mode, setMode, custom, setCustom, edits, setEdits, disabled }) {
  return (
    <div className="report">
      <div className="report-row">
        <span className="report-label" id="report-label">Report</span>
        <div className="seg" role="radiogroup" aria-labelledby="report-label">
          {[['quick', 'Quick'], ['full', 'Full'], ['custom', 'Custom']].map(([v, label]) => (
            <button key={v} role="radio" aria-checked={mode === v} className={`seg-btn ${mode === v ? 'on' : ''}`} disabled={disabled} onClick={() => setMode(v)}>{label}</button>
          ))}
        </div>
        <span className="hint">{MODE_HINT[mode]}</span>
      </div>
      {mode === 'custom' && (
        <div className="report-sections">
          <span className="core-note">Always: Diagrams · Code map · Ops</span>
          {OPTIONAL.map((o) => (
            <label className="opt-sec" key={o.id}>
              <input type="checkbox" checked={custom[o.id]} disabled={disabled} onChange={(e) => setCustom((c) => ({ ...c, [o.id]: e.target.checked }))} />
              <span>{o.label}</span>
            </label>
          ))}
        </div>
      )}
      <label className="opt-full">
        <input type="checkbox" checked={edits} onChange={(e) => setEdits(e.target.checked)} disabled={disabled} />
        <span>Allow edits in the map <span className="hint">— a task can be worked in a throwaway worktree (runs Claude, uses tokens)</span></span>
      </label>
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
  const [cancelling, setCancelling] = useState(false)
  const [progress, setProgress] = useState('')
  const [stages, setStages] = useState(null) // live @stage progress during a run
  const [error, setError] = useState('')
  const [errorHasLog, setErrorHasLog] = useState(false) // a run failed → offer "Show log"
  const [logText, setLogText] = useState(null) // the last-run log, shown in a modal when set
  const [missing, setMissing] = useState(null) // preflight: which CLIs are absent
  const [busyId, setBusyId] = useState(null) // "<id>:export" | "<id>:pdf" — one long action at a time
  const [refreshing, setRefreshing] = useState(false)
  // Commit browsing: which branch, how far back, and a local filter over what's loaded.
  const [branch, setBranch] = useState('') // '' = the checked-out branch
  const [commits, setCommits] = useState([])
  const [more, setMore] = useState(false)
  const [loadingMore, setLoadingMore] = useState(false)
  const [query, setQuery] = useState('')
  const [compare, setCompare] = useState(null) // { base, head } while the compare row is open
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
  const busy = analyzing || cloning

  const refreshAnalyses = async () => setAnalyses(await window.api.analysesForProject(project.id))
  const loadRepo = async (r, ref = branch) => {
    const st = await window.api.gitState(r, { limit: COMMIT_PAGE, ref })
    setState(st)
    setCommits(st.ok ? st.commits : [])
    setMore(!!st.more)
    if (!isLocal) window.api.listPRs(project).then(setPrs).catch((e) => setPrsError(e?.message || String(e)))
  }
  useEffect(() => {
    setState(null); setPrs(null); setPrsError(''); setError(''); setBranch(''); setQuery(''); setCompare(null)
    // Both calls can fail (the store, the repo); a rejected promise here used to leave a
    // blank screen with no explanation.
    refreshAnalyses().catch((e) => setError(e?.message || String(e)))
    window.api.resolveProject(project)
      .then((r) => { setResolved(r); if (isLocal || r.cloned) return loadRepo(r.repo, '') })
      .catch((e) => setError(e?.message || String(e)))
  }, [project.id])
  // Preflight the external CLIs once: the main button shells out to `claude` (and `git`), so
  // warn up front if either is missing rather than letting a run die with a bare exit code.
  useEffect(() => {
    window.api.preflight?.().then((p) => {
      const gone = []
      if (p && !p.claude) gone.push('claude')
      if (p && !p.git) gone.push('git')
      setMissing(gone.length ? gone : null)
    }).catch(() => {})
  }, [])

  // Re-read everything from disk: git moved on outside the app (a commit in the terminal,
  // a branch switch), and there was no way to say so.
  const refreshAll = async () => {
    if (!repo) return
    setRefreshing(true); setError('')
    try {
      await Promise.all([loadRepo(repo, branch), refreshAnalyses()])
    } catch (e) { setError(e?.message || String(e)) } finally { setRefreshing(false) }
  }
  const switchBranch = async (ref) => {
    setBranch(ref); setQuery('')
    if (!repo) return
    try { await loadRepo(repo, ref) } catch (e) { setError(e?.message || String(e)) }
  }
  const loadMore = async () => {
    if (!repo) return
    setLoadingMore(true)
    try {
      const r = await window.api.moreCommits(repo, { limit: COMMIT_PAGE, skip: commits.length, ref: branch })
      setCommits((prev) => [...prev, ...r.commits])
      setMore(!!r.more)
    } catch (e) { setError(e?.message || String(e)) } finally { setLoadingMore(false) }
  }

  const cancelAnalyze = async () => {
    setCancelling(true)
    try { await window.api.cancelAnalyze() } catch {} // the run's own promise resolves to cancelled
  }
  const showLog = async () => {
    try { setLogText((await window.api.lastRunLog()) || '(no log for the last run)') } catch (e) { setLogText(String(e)) }
  }

  const cloneNow = async () => {
    setError(''); setCloning(true); setCloneMsg('cloning…')
    const unsub = window.api.onCloneProgress(setCloneMsg)
    try {
      const { repo: r } = await window.api.cloneProject(project)
      setResolved({ repo: r, cloned: true })
      await loadRepo(r, '')
    } catch (e) { setError(e?.message || String(e)) } finally { unsub(); setCloning(false); setCloneMsg('') }
  }

  const analyze = async ({ range, kind, ref, title, analysisId }) => {
    const sections = sectionsFor()
    const full = mode === 'full'
    setError(''); setErrorHasLog(false); setAnalyzing(true); setCancelling(false); setProgress('starting the analysis…')
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
      const res = await window.api.analyze({ repo, range, projectId: project.id, kind, ref, title, full, sections, analysisId })
      if (!res || res.cancelled) { setProgress('Analysis cancelled.'); return } // neutral, not an error
      await refreshAnalyses()
      setStages((prev) => (prev ? prev.map((s) => ({ ...s, finished: Math.max(s.finished, s.started || 1), started: s.started || 1 })) : prev))
      setProgress('opening the map…')
      await window.api.openAnalysis(res.analysis.id, { work: edits })
      setProgress('')
    } catch (e) {
      setError(e?.message || String(e))
      setErrorHasLog(true) // a real failure left a run log — offer to show it
      setProgress('') // don't leave a stale progress line beside the error
    } finally { unsub(); setAnalyzing(false); setCancelling(false); setStages(null) }
  }
  const analyzeCommit = async (c) => analyze({ range: await window.api.rangeForCommit(repo, c.hash), kind: 'commit', ref: c.hash, title: `${project.name} · ${c.short}` })
  const analyzePr = async (pr) => {
    setError(''); setAnalyzing(true); setProgress(`fetching PR #${pr.number}…`)
    try {
      const range = await window.api.rangeForPr(repo, pr.number, pr.baseRef)
      await analyze({ range, kind: 'pr', ref: `pr:${pr.number}`, title: `${project.name} · PR #${pr.number}` })
    } catch (e) { setError(e?.message || String(e)); setAnalyzing(false) }
  }
  // Compare two refs — the pipeline has always taken an arbitrary range; this is the UI
  // being able to ask for one.
  const analyzeCompare = async () => {
    const { base, head } = compare || {}
    setError(''); setAnalyzing(true); setProgress(`comparing ${base}…${head}`)
    try {
      const range = await window.api.compareRange(repo, base, head)
      await analyze({ range, kind: 'commit', ref: range, title: `${project.name} · ${base}…${head}` })
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
  // Export runs for several seconds (the PDF path serves the map and prints it off-screen).
  // Mark which row is working so the action can't be fired twice and the wait is visible.
  const runExport = async (id, kind) => {
    setError(''); setBusyId(`${id}:${kind}`)
    try { await (kind === 'pdf' ? window.api.exportAnalysisPdf(id) : window.api.exportAnalysis(id)) }
    catch (e) { setError(e?.message || String(e)) } finally { setBusyId(null) }
  }
  const drop = async (id) => { try { await window.api.removeAnalysis(id); await refreshAnalyses() } catch (e) { setError(e?.message || String(e)) } }

  const working = latestByRef.get('')
  const needsClone = !isLocal && resolved && !resolved.cloned
  const dirty = state?.ok && state.uncommitted?.dirty
  const shown = filterCommits(commits, query)
  const options = branchOptions(state?.branches)
  const analysisMenu = (a) => [
    { label: 'Export HTML', title: 'A shareable HTML file with the notes baked in', disabled: busy || !!busyId, busy: busyId === `${a.id}:html`, onSelect: () => runExport(a.id, 'html') },
    { label: 'Export PDF', title: 'Notes become real PDF comments, questions become links', disabled: busy || !!busyId, busy: busyId === `${a.id}:pdf`, onSelect: () => runExport(a.id, 'pdf') },
    { label: 'Re-run', title: 'Regenerate this analysis in place (runs the model again)', disabled: busy, onSelect: () => rerun(a) },
    { label: 'Remove', danger: true, disabled: busy, onSelect: () => drop(a.id) },
  ]

  return (
    <>
      <header className="head pv-head">
        <button className="link-back" onClick={onBack} disabled={busy}>← projects</button>
        <div className="pv-id">
          <div className="brand sm">{project.name}</div>
          <div className="loc">{isLocal ? project.path : project.url}{state?.branch ? ` · ${state.branch}` : ''}</div>
        </div>
        <button className="btn ghost refresh" onClick={refreshAll} disabled={busy || refreshing || !repo} title="Re-read git state, analyses and pull requests">
          <RefreshIcon />{refreshing ? 'Refreshing…' : 'Refresh'}
        </button>
      </header>

      {missing ? (
        <div className="banner warn">
          <span>{missing.includes('claude')
            ? 'Claude Code (the “claude” command) wasn’t found on your PATH — analysis needs it.'
            : 'git wasn’t found on your PATH — analysis needs it.'}</span>
          {missing.includes('claude')
            ? <button className="btn" onClick={() => window.api.openClaudeInstall?.()}>Install Claude Code</button>
            : null}
        </div>
      ) : null}

      {analyzing ? <StageProgress stages={stages} text={progress} onCancel={cancelAnalyze} cancelling={cancelling} />
        : cloning ? <div className="run" role="status" aria-live="polite"><span className="spin" /> <span className="run-txt">{cloneMsg || 'cloning…'}</span></div>
        : progress ? <div className="run-txt" role="status" aria-live="polite">{progress}</div>
        : null}
      {error ? (
        <div className="err">
          <span>{error}</span>
          {errorHasLog ? <button className="btn ghost" onClick={showLog}>Show log</button> : null}
        </div>
      ) : null}

      {logText != null ? (
        <div className="modal-back" onClick={() => setLogText(null)}>
          <div className="log-modal" onClick={(e) => e.stopPropagation()}>
            <div className="log-head"><span>Last run log</span><button className="btn ghost" onClick={() => setLogText(null)}>Close</button></div>
            <pre className="log-body">{logText}</pre>
          </div>
        </div>
      ) : null}

      {needsClone ? (
        <div className="banner">
          <div>This GitHub repo isn't cloned yet. Clone it to browse its commits and pull requests.</div>
          <button className="btn primary" disabled={cloning} onClick={cloneNow}>Clone repo</button>
        </div>
      ) : !resolved ? (
        <div className="empty">Resolving…</div>
      ) : (
        <>
          {/* The point of the screen, first: what to review right now, with the preset that
              governs the run sitting beside the button that starts it. */}
          <section className="runcard">
            <div className="runcard-head">
              <div className="runcard-what">
                {!state ? 'Reading git state…'
                  : !state.ok ? state.reason
                  : dirty ? <><b>{state.uncommitted.count}</b> uncommitted change{state.uncommitted.count === 1 ? '' : 's'} in the working tree</>
                  : 'The working tree is clean — review a commit, a comparison, or a pull request below'}
              </div>
              <div className="runcard-acts">
                {working && <button className="btn" disabled={busy} onClick={() => open(working.id)}>View last map</button>}
                <button className="btn primary" disabled={busy || !dirty}
                  title={dirty ? 'Run a review of the uncommitted changes' : 'Nothing uncommitted to review'}
                  onClick={() => analyze({ range: '', kind: 'working', ref: '', title: `${project.name} · working tree` })}>
                  Analyze working changes
                </button>
              </div>
            </div>
            <ReportPicker mode={mode} setMode={setMode} custom={custom} setCustom={setCustom} edits={edits} setEdits={setEdits} disabled={analyzing} />
          </section>

          {analyses.length > 0 && (
            <section className="sec">
              <h2 className="sec-title">Recent analyses</h2>
              <div className="list">
                {analyses.slice(0, 6).map((a) => (
                  <div className="row" key={a.id}>
                    <span className={`tag ${a.kind === 'working' ? 'local' : ''}`}>{a.kind}</span>
                    <div className="meta">
                      <div className="name">{a.title || refLabel(a)}</div>
                      <div className="loc">{refLabel(a)} · {a.created_at.slice(0, 16).replace('T', ' ')}</div>
                    </div>
                    <ReviewCounts counts={a.counts} />
                    <button className="btn" disabled={busy} onClick={() => open(a.id)}>View</button>
                    <RowMenu items={analysisMenu(a)} label={`More actions for ${a.title || refLabel(a)}`} disabled={busy} />
                  </div>
                ))}
              </div>
            </section>
          )}

          {!isLocal && (
            <section className="sec">
              <h2 className="sec-title">Pull requests</h2>
              <div className="list">
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
                          ? <><button className="btn" disabled={busy} onClick={() => open(a.id)}>View</button>
                              <button className="btn ghost" disabled={busy} onClick={() => analyzePr(pr)}>Re-run</button></>
                          : <button className="btn" disabled={busy} onClick={() => analyzePr(pr)}>Analyze</button>}
                      </div>
                    )
                  })}
              </div>
            </section>
          )}

          {!state ? <div className="empty">Reading git state…</div>
            : !state.ok ? <div className="note">{state.reason}</div>
            : (
              <section className="sec">
                <div className="sec-head">
                  <h2 className="sec-title">Commits</h2>
                  <div className="sec-tools">
                    <label className="pick">
                      <span className="sr-only">Branch</span>
                      {/* Grouped natively, so the current branch is marked by where it sits
                          rather than by a suffix that overflows the control. */}
                      <select className="in sel" value={branch} disabled={busy} onChange={(e) => switchBranch(e.target.value)}>
                        <optgroup label="Checked out"><option value="">{state.branch || 'HEAD'}</option></optgroup>
                        {['Local', 'Remote'].map((g) => {
                          const inGroup = options.filter((o) => o.group === g && o.value !== state.branch)
                          return inGroup.length ? (
                            <optgroup key={g} label={g}>
                              {inGroup.map((o) => <option key={o.value} value={o.value}>{o.value}</option>)}
                            </optgroup>
                          ) : null
                        })}
                      </select>
                    </label>
                    <input className="in find" placeholder="Filter loaded commits…" value={query} spellCheck={false}
                      aria-label="Filter loaded commits" onChange={(e) => setQuery(e.target.value)} />
                    <button className="btn ghost" disabled={busy} onClick={() => setCompare(compare ? null : defaultCompare(state.branches, branch || state.branch))}>
                      {compare ? 'Close compare' : 'Compare…'}
                    </button>
                  </div>
                </div>

                {compare && (
                  <div className="cmp">
                    <label className="cmp-f"><span className="cmp-l">Base</span>
                      <input className="in" value={compare.base} spellCheck={false} aria-label="Base ref"
                        onChange={(e) => setCompare((c) => ({ ...c, base: e.target.value }))} /></label>
                    <span className="cmp-dots">…</span>
                    <label className="cmp-f"><span className="cmp-l">Branch</span>
                      <input className="in" value={compare.head} spellCheck={false} aria-label="Branch ref"
                        onChange={(e) => setCompare((c) => ({ ...c, head: e.target.value }))} /></label>
                    <button className="btn primary" disabled={busy || !compare.base.trim() || !compare.head.trim()} onClick={analyzeCompare}>Analyze comparison</button>
                  </div>
                )}

                <div className="list">
                  {commits.length === 0 ? <div className="empty">No commits yet.</div>
                    : shown.length === 0 ? <div className="empty">No loaded commit matches “{query}”.</div>
                    : shown.map((c) => {
                      const a = latestByRef.get(c.hash)
                      return (
                        <div className="row" key={c.hash}>
                          <span className="hash">{c.short}</span>
                          <div className="meta">
                            <div className="name">{a ? <span className="mapped" title="has a saved map">●</span> : null}{c.subject}</div>
                            <div className="loc">{c.author} · {c.date}</div>
                          </div>
                          {a
                            ? <><button className="btn" disabled={busy} onClick={() => open(a.id)}>View</button>
                                <button className="btn ghost" disabled={busy} onClick={() => analyzeCommit(c)}>Re-run</button></>
                            : <button className="btn" disabled={busy} onClick={() => analyzeCommit(c)}>Analyze</button>}
                        </div>
                      )
                    })}
                </div>
                {more && (
                  <div className="more">
                    <button className="btn ghost" disabled={busy || loadingMore} onClick={loadMore}>
                      {loadingMore ? 'Loading…' : `Load ${COMMIT_PAGE} more`}
                    </button>
                  </div>
                )}
              </section>
            )}
        </>
      )}
    </>
  )
}
