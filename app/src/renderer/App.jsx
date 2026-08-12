import React, { useEffect, useState } from 'react'

// Phase 2: the project list. Pick a folder or add a GitHub URL; the choice is
// remembered (SQLite in main) and shown here next launch. Selecting a project is
// Phase 3 (check git state → offer/run a review), so for now a row just sits there.
export default function App() {
  const [projects, setProjects] = useState([])
  const [url, setUrl] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  const refresh = async () => setProjects(await window.api.listProjects())
  useEffect(() => { refresh() }, [])

  const guard = async (fn) => {
    setError(''); setBusy(true)
    try { await fn() } catch (e) { setError(e?.message || String(e)) } finally { setBusy(false) }
  }
  const addLocal = () => guard(async () => { await window.api.addLocal(); await refresh() })
  const addGithub = () => guard(async () => {
    if (!url.trim()) return
    await window.api.addGithub(url.trim()); setUrl(''); await refresh()
  })
  const remove = (id) => guard(async () => { await window.api.removeProject(id); await refresh() })

  return (
    <div className="wrap">
      <header className="head">
        <div className="brand">whydiff</div>
        <div className="sub">Pick a project to review — its changes, mapped.</div>
      </header>

      <section className="add">
        <button className="btn" disabled={busy} onClick={addLocal}>Add local folder…</button>
        <div className="or">or</div>
        <form className="gh" onSubmit={(e) => { e.preventDefault(); addGithub() }}>
          <input
            className="in"
            placeholder="https://github.com/owner/repo"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            spellCheck={false}
          />
          <button className="btn" type="submit" disabled={busy || !url.trim()}>Add GitHub repo</button>
        </form>
      </section>

      {error ? <div className="err">{error}</div> : null}

      <section className="list">
        {projects.length === 0 ? (
          <div className="empty">No projects yet. Add a local folder or a GitHub repo to start.</div>
        ) : (
          projects.map((p) => (
            <div className="row" key={p.id}>
              <span className={`tag ${p.kind}`}>{p.kind}</span>
              <div className="meta">
                <div className="name">{p.name}</div>
                <div className="loc">{p.kind === 'local' ? p.path : p.url}</div>
              </div>
              <button className="x" title="Remove" onClick={() => remove(p.id)}>✕</button>
            </div>
          ))
        )}
      </section>
    </div>
  )
}
