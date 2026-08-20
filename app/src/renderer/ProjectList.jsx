import React, { useEffect, useState } from 'react'
import RowMenu from './RowMenu.jsx'
import { LOGO } from './logo.mjs'
import { refLabel, reviewPills } from './logic.mjs'

// The project list: add a local folder or a GitHub URL, and open one to review it.

// The same two glyphs the map's diagram badges use (CHAT_ICON / NOTE_ICON in
// templates/viewer.html), so a report shows one visual language everywhere. They stroke
// in currentColor, inheriting the pill's colour (accent when something needs attention).
const ChatIcon = () => (
  <svg className="rvc-i" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
  </svg>
)
const NoteIcon = () => (
  <svg className="rvc-i" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M12 20h9" /><path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4z" />
  </svg>
)

const ChevronMark = () => (
  <svg className="chev" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2.75"
    strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M5 3.5 L10.5 8 L5 12.5" />
  </svg>
)

const GithubIcon = () => (
  <svg className="ico" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
    <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38
      0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01
      1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95
      0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82a7.4 7.4 0 0 1 2-.27c.68 0
      1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0
      3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01
      8.01 0 0 0 16 8c0-4.42-3.58-8-8-8Z" />
  </svg>
)

// Review activity a saved analysis carries — discussions (questions/tasks) and pinned
// notes, from its journal. reviewPills() decides what to show; this only renders it.
export function ReviewCounts({ counts }) {
  const pills = reviewPills(counts)
  if (!pills.length) return null
  return (
    <span className="rvcounts">
      {pills.map((p) => p.kind === 'discussions' ? (
        <span key="d" className={`rvc ${p.attn ? 'attn' : ''}`}
          title={`${p.n} discussion${p.n === 1 ? '' : 's'}${counts.blocking ? ` · ${counts.blocking} still need${counts.blocking === 1 ? 's' : ''} attention` : ''}`}>
          <ChatIcon />{p.n}
        </span>
      ) : (
        <span key="n" className="rvc" title={`${p.n} note${p.n === 1 ? '' : 's'}`}>
          <NoteIcon />{p.n}
        </span>
      ))}
    </span>
  )
}

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
  const [busyId, setBusyId] = useState(null) // "<id>:html" | "<id>:pdf" — one export at a time
  const [theme, setThemeState] = useState('system') // 'system' | 'light' | 'dark'

  const refresh = async () => {
    setProjects(await window.api.listProjects())
    setLatest(await window.api.latestAnalyses(8))
    setToken(await window.api.tokenStatus())
  }
  // A rejected call here used to leave an empty screen with nothing said; show the reason.
  useEffect(() => {
    refresh().catch((e) => setError(e?.message || String(e)))
    window.api.appVersion?.().then(setVer).catch(() => {})
    window.api.getTheme?.().then((t) => setThemeState(t?.preference || 'system')).catch(() => {})
  }, [])
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
  // An export takes seconds (the PDF one serves the map and prints it off-screen). Mark the
  // row as working so it reads as in-flight and cannot be fired a second time.
  const runExport = async (id, kind) => {
    setError(''); setBusyId(`${id}:${kind}`)
    try { await (kind === 'pdf' ? window.api.exportAnalysisPdf(id) : window.api.exportAnalysis(id)) }
    catch (e) { setError(e?.message || String(e)) } finally { setBusyId(null) }
  }
  const pickTheme = async (t) => { setThemeState(t); try { await window.api.setTheme?.(t) } catch {} }
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
            <button className="x" type="button" aria-label="Dismiss this update notice" title="Dismiss" onClick={dismissUpd}>✕</button>
          </span>
        </div>
      )}

      <header className="head">
        <div className="brand">
          <img className="mark" src={LOGO} alt="" width="35" height="36" />
          {/* The prompt chevron: this is a tool you point at a repository. Drawn, not typed —
              the design system caps type at weight 500, and a stroke gives it real thickness. */}
          <ChevronMark />
          whydiff
        </div>
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

      <section className="sec list">
        {projects.length === 0 ? (
          <div className="empty">No projects yet. Add a local folder or a GitHub repo to start.</div>
        ) : (
          projects.map((p) => (
            /* The whole row opens the project, but Remove has to be its own control — a
               button inside a button is invalid, and the ✕ span it replaces could not be
               reached by keyboard at all. The open button is stretched over the row
               (::after, in the stylesheet) so the big click target survives. */
            <div className="row row-open" key={p.id}>
              <span className={`tag ${p.kind}`}>{p.kind}</span>
              <div className="meta">
                <button className="rowlink name" onClick={() => onOpen(p)}>{p.name}</button>
                <div className="loc">{p.kind === 'local' ? p.path : p.url}</div>
              </div>
              <button className="x" type="button" aria-label={`Remove ${p.name}`} title="Remove" onClick={(e) => remove(e, p.id)}>✕</button>
            </div>
          ))
        )}
      </section>

      {latest.length > 0 && (
        <section className="sec">
          <div className="sec-head">
            <h2 className="sec-title">Latest analyses</h2>
            <label className="opt-full sm">
              <input type="checkbox" checked={edits} onChange={(e) => setEdits(e.target.checked)} />
              <span>Allow edits <span className="hint">— work a fix in a worktree (uses tokens)</span></span>
            </label>
          </div>
          <div className="list">
            {latest.map((a) => (
              <div className="row" key={a.id}>
                <span className={`tag ${a.kind === 'working' ? 'local' : ''}`}>{a.kind}</span>
                <div className="meta">
                  <div className="name">{a.projectName}</div>
                  <div className="loc">{a.title || refLabel(a)} · {a.created_at.slice(0, 16).replace('T', ' ')}</div>
                </div>
                <ReviewCounts counts={a.counts} />
                <button className="btn" onClick={() => openAnalysis(a.id)}>View</button>
                <RowMenu
                  label={`More actions for ${a.projectName}`}
                  items={[
                    { label: 'Export HTML', title: 'A shareable HTML file with the notes baked in', disabled: !!busyId, busy: busyId === `${a.id}:html`, onSelect: () => runExport(a.id, 'html') },
                    { label: 'Export PDF', title: 'Notes become real PDF comments, questions become links', disabled: !!busyId, busy: busyId === `${a.id}:pdf`, onSelect: () => runExport(a.id, 'pdf') },
                  ]}
                />
              </div>
            ))}
          </div>
        </section>
      )}

      <footer className="about">
        <span className="about-ver">whydiff{ver ? ` ${ver}` : ''}</span>
        <button className="btn ghost" disabled={checking} onClick={checkNow}>{checking ? 'Checking…' : 'Check for updates'}</button>
        {checkMsg ? <span className="about-msg">{checkMsg}</span> : null}
        <span className="about-gap" />
        <button className="iconbtn" type="button" title="whydiff on GitHub" aria-label="Open the whydiff repository on GitHub"
          onClick={() => window.api.openGithub?.()}>
          <GithubIcon />
        </button>
        <span className="seg" role="radiogroup" aria-label="Appearance">
          {[['system', 'System'], ['light', 'Light'], ['dark', 'Dark']].map(([v, label]) => (
            <button key={v} role="radio" aria-checked={theme === v} className={`seg-btn ${theme === v ? 'on' : ''}`} onClick={() => pickTheme(v)}>{label}</button>
          ))}
        </span>
      </footer>
    </>
  )
}
