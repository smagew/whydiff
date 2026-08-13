import React, { useEffect, useState } from 'react'

const refLabel = (a) => a.kind === 'working' ? 'working tree' : a.kind === 'pr' ? a.ref.replace(/^pr:/, 'PR #') : (a.ref || '').slice(0, 8)

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
  const [error, setError] = useState('')
  const [fullReport, setFullReport] = useState(false) // opt-in: the extra passes cost time + tokens, so off by default
  const [edits, setEdits] = useState(false) // opt-in: open maps in a mode that can run a fix in a worktree (uses tokens)

  const latestByRef = new Map()
  for (const a of analyses) if (!latestByRef.has(a.ref)) latestByRef.set(a.ref, a)
  const repo = resolved?.repo

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

  const analyze = async ({ range, kind, ref, title }) => {
    setError(''); setAnalyzing(true); setProgress('starting the analysis…')
    const unsub = window.api.onAnalyzeProgress(setProgress)
    try {
      const { analysis } = await window.api.analyze({ repo, range, projectId: project.id, kind, ref, title, full: fullReport })
      await refreshAnalyses()
      setProgress('opening the map…')
      await window.api.openAnalysis(analysis.id, { work: edits })
      setProgress('')
    } catch (e) { setError(e?.message || String(e)) } finally { unsub(); setAnalyzing(false) }
  }
  const analyzeCommit = async (c) => analyze({ range: await window.api.rangeForCommit(repo, c.hash), kind: 'commit', ref: c.hash, title: `${project.name} · ${c.short}` })
  const analyzePr = async (pr) => {
    setError(''); setAnalyzing(true); setProgress(`fetching PR #${pr.number}…`)
    try {
      const range = await window.api.rangeForPr(repo, pr.number, pr.baseRef)
      await analyze({ range, kind: 'pr', ref: `pr:${pr.number}`, title: `${project.name} · PR #${pr.number}` })
    } catch (e) { setError(e?.message || String(e)); setAnalyzing(false) }
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

      <div className="opts">
        <label className="opt-full">
          <input type="checkbox" checked={fullReport} onChange={(e) => setFullReport(e.target.checked)} disabled={analyzing} />
          <span>Full report <span className="hint">— also Summary, user stories, standards &amp; tests (slower, more tokens)</span></span>
        </label>
        <label className="opt-full">
          <input type="checkbox" checked={edits} onChange={(e) => setEdits(e.target.checked)} disabled={analyzing} />
          <span>Allow edits in the map <span className="hint">— a task can be worked in a throwaway worktree (runs Claude, uses tokens)</span></span>
        </label>
      </div>

      {(analyzing || cloning) && <div className="run"><span className="spin" /> <span className="run-txt">{cloning ? (cloneMsg || 'cloning…') : (progress || 'working…')}</span></div>}
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
                    <button className="btn" onClick={() => open(a.id)}>View</button>
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
