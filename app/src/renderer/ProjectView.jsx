import React, { useEffect, useState } from 'react'

const refLabel = (a) => a.kind === 'working' ? 'working tree' : a.kind === 'pr' ? a.ref.replace(/^pr:/, 'PR #') : (a.ref || '').slice(0, 8)

// A selected project: its git state, the ways to run a review, and the maps already
// made. A commit that has a saved map is marked and opens without re-running.
// GitHub projects are cloned in Phase 5, so here they show a note.
export default function ProjectView({ project, onBack }) {
  const isLocal = project.kind === 'local'
  const [state, setState] = useState(null)
  const [analyses, setAnalyses] = useState([])
  const [analyzing, setAnalyzing] = useState(false)
  const [progress, setProgress] = useState('')
  const [error, setError] = useState('')

  // Most-recent analysis per ref (the list comes newest-first), for marking + View.
  const latestByRef = new Map()
  for (const a of analyses) if (!latestByRef.has(a.ref)) latestByRef.set(a.ref, a)

  const refreshAnalyses = async () => setAnalyses(await window.api.analysesForProject(project.id))
  useEffect(() => {
    refreshAnalyses()
    if (!isLocal) { setState({ ok: false, reason: 'GitHub repos are cloned in a later phase — add a local folder for now.' }); return }
    let live = true
    window.api.gitState(project.path).then((s) => { if (live) setState(s) })
    return () => { live = false }
  }, [project.id])

  const analyze = async ({ range, kind, ref, title }) => {
    setError(''); setAnalyzing(true); setProgress('starting the analysis…')
    const unsub = window.api.onAnalyzeProgress(setProgress)
    try {
      const { analysis } = await window.api.analyze({ repo: project.path, range, projectId: project.id, kind, ref, title })
      await refreshAnalyses()
      setProgress('opening the map…')
      await window.api.openAnalysis(analysis.id)
      setProgress('')
    } catch (e) { setError(e?.message || String(e)) } finally { unsub(); setAnalyzing(false) }
  }
  const analyzeCommit = async (c) => {
    const range = await window.api.rangeForCommit(project.path, c.hash)
    analyze({ range, kind: 'commit', ref: c.hash, title: `${project.name} · ${c.short}` })
  }
  const open = async (id) => { setError(''); try { await window.api.openAnalysis(id) } catch (e) { setError(e?.message || String(e)) } }
  const drop = async (id) => { try { await window.api.removeAnalysis(id); await refreshAnalyses() } catch (e) { setError(e?.message || String(e)) } }

  const working = latestByRef.get('')

  return (
    <>
      <header className="head pv-head">
        <button className="link-back" onClick={onBack} disabled={analyzing}>← projects</button>
        <div>
          <div className="brand sm">{project.name}</div>
          <div className="loc">{isLocal ? project.path : project.url}{state?.branch ? ` · ${state.branch}` : ''}</div>
        </div>
      </header>

      {analyzing && <div className="run"><span className="spin" /> <span className="run-txt">{progress || 'working…'}</span></div>}
      {error ? <div className="err">{error}</div> : null}

      {!state ? (
        <div className="empty">Reading git state…</div>
      ) : !state.ok ? (
        <div className="note">{state.reason}</div>
      ) : (
        <>
          {state.uncommitted?.dirty && (
            <div className="banner">
              <div><b>{state.uncommitted.count}</b> uncommitted change{state.uncommitted.count === 1 ? '' : 's'} in the working tree.</div>
              <div className="banner-acts">
                {working && <button className="btn" disabled={analyzing} onClick={() => open(working.id)}>View last map</button>}
                <button className="btn primary" disabled={analyzing} onClick={() => analyze({ range: '', kind: 'working', ref: '', title: `${project.name} · working tree` })}>
                  Analyze working changes
                </button>
              </div>
            </div>
          )}

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

          <div className="sec-title">Recent commits</div>
          <section className="list">
            {state.commits.length === 0 ? (
              <div className="empty">No commits yet.</div>
            ) : (
              state.commits.map((c) => {
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
              })
            )}
          </section>
        </>
      )}
    </>
  )
}
