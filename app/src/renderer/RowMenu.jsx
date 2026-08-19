import React, { useEffect, useRef, useState } from 'react'

// The secondary actions on a list row (export, re-run, remove), behind one button instead
// of four. Four same-weight buttons per row crowded the row so hard that the row's own
// subtitle was truncated mid-date; one primary action plus this menu gives the text its
// space back and says which action is the expected one.
//
// It is a real menu: a button that owns `aria-expanded`, items that are buttons, Escape and
// click-outside to close, and focus returned to the trigger — the ✕ span it replaces could
// not be reached by keyboard at all.
export default function RowMenu({ items, label = 'More actions', disabled }) {
  const [open, setOpen] = useState(false)
  const box = useRef(null)
  const trigger = useRef(null)
  const usable = (items || []).filter(Boolean)

  useEffect(() => {
    if (!open) return
    const onDown = (e) => { if (box.current && !box.current.contains(e.target)) setOpen(false) }
    const onKey = (e) => { if (e.key === 'Escape') { setOpen(false); trigger.current?.focus() } }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => { document.removeEventListener('mousedown', onDown); document.removeEventListener('keydown', onKey) }
  }, [open])

  if (!usable.length) return null
  return (
    <span className="rowmenu" ref={box}>
      <button
        ref={trigger}
        className="btn ghost rowmenu-btn"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={label}
        disabled={disabled}
        onClick={() => setOpen((v) => !v)}
      >⋯</button>
      {open && (
        <span className="rowmenu-pop" role="menu">
          {usable.map((it) => (
            <button
              key={it.label}
              role="menuitem"
              className={`rowmenu-item ${it.danger ? 'danger' : ''}`}
              disabled={it.disabled}
              title={it.title || undefined}
              onClick={() => { setOpen(false); it.onSelect() }}
            >{it.busy ? `${it.label}…` : it.label}</button>
          ))}
        </span>
      )}
    </span>
  )
}
