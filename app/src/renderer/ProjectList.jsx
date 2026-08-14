import React, { useEffect, useState } from 'react'

// The project list: add a local folder or a GitHub URL, and open one to review it.
const refLabel = (a) => a.kind === 'working' ? 'working tree' : a.kind === 'pr' ? a.ref.replace(/^pr:/, 'PR #') : (a.ref || '').slice(0, 8)

export default function ProjectList({ onOpen }) {
  const [projects, setProjects] = useState([])
  const [latest, setLatest] = useState([])
  const [url, setUrl] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [edits, setEdits] = useState(false) // opt-in: open maps able to work a fix in a worktree
  const [token, setToken] = useState(null) // { stored, available } — never the value
  const [tokenInput, setTokenInput] = useState('')
  const [showToken, setShowToken] = useState(false)
  const [upd, setUpd] = useState(null) // { available, latest, url } — a newer app release
  const [ver, setVer] = useState('') // the running app version, for the About footer
  const [checking, setChecking] = useState(false)
  const [checkMsg, setCheckMsg] = useState('') // result of a manual "Check for updates"

  const refresh = async () => {
    setProjects(await window.api.listProjects())
    setLatest(await window.api.latestAnalyses(8))
    setToken(await window.api.tokenStatus())
  }
  useEffect(() => { refresh(); window.api.appVersion?.().then(setVer).catch(() => {}) }, [])
  // Check for a newer app build once, and remember a dismissal per version so the
  // banner doesn't nag — until an even newer one ships.
  useEffect(() => {
    window.api.checkUpdate?.().then((r) => {
      if (r?.available && localStorage.getItem('whydiff.dismissedUpdate') !== r.latest) setUpd(r)
    }).catch(() => {})
  }, [])
  const dismissUpd = () => { if (upd) localStorage.setItem('whydiff.dismissedUpdate', upd.latest); setUpd(null) }
  // Manual "Check for updates": a newer build shows the banner (clearing any dismissal
  // so it isn't suppressed); otherwise say so inline.
  const checkNow = async () => {
    setChecking(true); setCheckMsg('')
    try {
      const r = await window.api.checkUpdate?.()
      if (r?.available) { localStorage.removeItem('whydiff.dismissedUpdate'); setUpd(r); setCheckMsg('') }
      else if (r) setCheckMsg("You're on the latest version.")
      else setCheckMsg("Couldn't check for updates.")
    } catch { setCheckMsg("Couldn't check for updates.") }
    finally { setChecking(false) }
  }
  const openAnalysis = async (id) => { setError(''); try { await window.api.openAnalysis(id, { work: edits }) } catch (e) { setError(e?.message || String(e)) } }
  const saveToken = () => guard(async () => { setToken(await window.api.setToken(tokenInput.trim())); setTokenInput(''); setShowToken(false) })
  const clearToken = () => guard(async () => { setToken(await window.api.clearToken()) })

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
      {upd && (
        <div className="update-banner">
          <span>A new version <b>{upd.latest}</b> is available (you have {upd.current}).</span>
          <span className="ub-acts">
            {/* Download the installer for this OS/arch directly; when we don't build one
                for it (assetUrl null), fall back to the release page. */}
            <button className="btn" title={upd.assetUrl ? 'Download the installer for this computer' : 'Open the release page'} onClick={() => window.api.openRelease(upd.assetUrl || upd.url)}>Download</button>
            {upd.assetUrl && <button className="btn ghost" title="All downloads" onClick={() => window.api.openRelease(upd.url)}>All files</button>}
            <span className="x" title="Dismiss" onClick={dismissUpd}>✕</span>
          </span>
        </div>
      )}

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

      <section className="settings">
        <div className="set-row">
          <span className="set-label">GitHub token</span>
          <span className="set-state">
            {token == null ? '…'
              : token.stored ? 'stored in your keychain'
              : token.available ? 'not set — public repos only'
              : 'keychain unavailable — use the GITHUB_TOKEN env var'}
          </span>
          {token?.stored
            ? <button className="btn ghost" disabled={busy} onClick={clearToken}>Clear</button>
            : token?.available ? <button className="btn ghost" disabled={busy} onClick={() => setShowToken((v) => !v)}>{showToken ? 'Cancel' : 'Set token'}</button>
            : null}
        </div>
        {showToken && !token?.stored && (
          <form className="gh" onSubmit={(e) => { e.preventDefault(); saveToken() }}>
            <input className="in" type="password" placeholder="ghp_… (a fine-grained or classic PAT)" value={tokenInput} onChange={(e) => setTokenInput(e.target.value)} spellCheck={false} autoFocus />
            <button className="btn" type="submit" disabled={busy || !tokenInput.trim()}>Save</button>
          </form>
        )}
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

      {latest.length > 0 && (
        <>
          <div className="sec-head">
            <div className="sec-title">Latest analyses</div>
            <label className="opt-full sm">
              <input type="checkbox" checked={edits} onChange={(e) => setEdits(e.target.checked)} />
              <span>Allow edits <span className="hint">— work a fix in a worktree (uses tokens)</span></span>
            </label>
          </div>
          <section className="list">
            {latest.map((a) => (
              <div className="row" key={a.id}>
                <span className={`tag ${a.kind === 'working' ? 'local' : ''}`}>{a.kind}</span>
                <div className="meta">
                  <div className="name">{a.projectName}</div>
                  <div className="loc">{a.title || refLabel(a)} · {a.created_at.slice(0, 16).replace('T', ' ')}</div>
                </div>
                <button className="btn" onClick={() => openAnalysis(a.id)}>View</button>
              </div>
            ))}
          </section>
        </>
      )}

      <footer className="about">
        <span className="about-ver">whydiff{ver ? ` ${ver}` : ''}</span>
        <button className="btn ghost" disabled={checking} onClick={checkNow}>{checking ? 'Checking…' : 'Check for updates'}</button>
        {checkMsg ? <span className="about-msg">{checkMsg}</span> : null}
      </footer>
    </>
  )
}
