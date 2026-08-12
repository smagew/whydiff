import React, { useEffect, useState } from 'react'

// The project list: add a local folder or a GitHub URL, and open one to review it.
export default function ProjectList({ onOpen }) {
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
  const remove = (e, id) => { e.stopPropagation(); guard(async () => { await window.api.removeProject(id); await refresh() }) }

  return (
    <>
      <header className="head">
        <div className="brand">whydiff</div>
        <div className="sub">Pick a project to review — its changes, mapped.</div>
      </header>

      <section className="add">
        <button className="btn" disabled={busy} onClick={addLocal}>Add local folder…</button>
        <div className="or">or</div>
        <form className="gh" onSubmit={(e) => { e.preventDefault(); addGithub() }}>
          <input className="in" placeholder="https://github.com/owner/repo" value={url} onChange={(e) => setUrl(e.target.value)} spellCheck={false} />
          <button className="btn" type="submit" disabled={busy || !url.trim()}>Add GitHub repo</button>
        </form>
      </section>

      {error ? <div className="err">{error}</div> : null}

      <section className="list">
        {projects.length === 0 ? (
          <div className="empty">No projects yet. Add a local folder or a GitHub repo to start.</div>
        ) : (
          projects.map((p) => (
            <button className="row row-btn" key={p.id} onClick={() => onOpen(p)} title="Open">
              <span className={`tag ${p.kind}`}>{p.kind}</span>
              <div className="meta">
                <div className="name">{p.name}</div>
                <div className="loc">{p.kind === 'local' ? p.path : p.url}</div>
              </div>
              <span className="x" title="Remove" onClick={(e) => remove(e, p.id)}>✕</span>
            </button>
          ))
        )}
      </section>
    </>
  )
}
