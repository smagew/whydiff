import React, { useEffect, useState } from 'react'

// A selected project: its git state, and the ways to run a review. A local repo with
// uncommitted work offers to map that straight away; otherwise pick a commit. Each
// analysis runs whydiff (streaming progress) and opens the map in its own window.
// GitHub projects are cloned in Phase 5, so here they show a note.
export default function ProjectView({ project, onBack }) {
  const isLocal = project.kind === 'local'
  const [state, setState] = useState(null) // null=loading, {ok,...}
  const [analyzing, setAnalyzing] = useState(false)
  const [progress, setProgress] = useState('')
  const [error, setError] = useState('')

  useEffect(() => {
    if (!isLocal) { setState({ ok: false, reason: 'GitHub repos are cloned in a later phase — add a local folder for now.' }); return }
    let live = true
    window.api.gitState(project.path).then((s) => { if (live) setState(s) })
    return () => { live = false }
  }, [project.id])

  const analyze = async (range, title) => {
    setError(''); setAnalyzing(true); setProgress('starting the analysis…')
    const unsub = window.api.onAnalyzeProgress(setProgress)
    try {
      const { mapPath } = await window.api.analyze(project.path, range)
      setProgress('opening the map…')
      await window.api.openMap(project.path, mapPath, title || project.name)
      setProgress('')
    } catch (e) {
      setError(e?.message || String(e))
    } finally { unsub(); setAnalyzing(false) }
  }
  const analyzeCommit = async (c) => {
    const range = await window.api.rangeForCommit(project.path, c.hash)
    analyze(range, `${project.name} · ${c.short}`)
  }

  return (
    <>
      <header className="head pv-head">
        <button className="link-back" onClick={onBack} disabled={analyzing}>← projects</button>
        <div>
          <div className="brand sm">{project.name}</div>
          <div className="loc">{isLocal ? project.path : project.url}{state?.branch ? ` · ${state.branch}` : ''}</div>
        </div>
      </header>

      {analyzing && (
        <div className="run">
          <span className="spin" /> <span className="run-txt">{progress || 'working…'}</span>
        </div>
      )}
      {error ? <div className="err">{error}</div> : null}

      {!state ? (
        <div className="empty">Reading git state…</div>
      ) : !state.ok ? (
        <div className="note">{state.reason}</div>
      ) : (
        <>
          {state.uncommitted?.dirty && (
            <div className="banner">
              <div>
                <b>{state.uncommitted.count}</b> uncommitted change{state.uncommitted.count === 1 ? '' : 's'} in the working tree.
              </div>
              <button className="btn primary" disabled={analyzing} onClick={() => analyze('', `${project.name} · working tree`)}>
                Analyze working changes
              </button>
            </div>
          )}

          <div className="sec-title">Recent commits</div>
          <section className="list">
            {state.commits.length === 0 ? (
              <div className="empty">No commits yet.</div>
            ) : (
              state.commits.map((c) => (
                <div className="row" key={c.hash}>
                  <span className="hash">{c.short}</span>
                  <div className="meta">
                    <div className="name">{c.subject}</div>
                    <div className="loc">{c.author} · {c.date}</div>
                  </div>
                  <button className="btn" disabled={analyzing} onClick={() => analyzeCommit(c)}>Analyze</button>
                </div>
              ))
            )}
          </section>
        </>
      )}
    </>
  )
}
