import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'

// Remembering the window's size and position between launches. Two things matter and
// only one is obvious: saving the bounds, and refusing to restore bounds that no longer
// land on a screen — unplug the external display the app was maximised on and a naive
// restore puts the window somewhere the user cannot reach it.
//
// The placement decision is a pure function over the saved bounds and the current
// displays, so it is tested without Electron.

export const DEFAULTS = { width: 1100, height: 760 }
const MIN = { width: 720, height: 480 }

/**
 * Where to actually open, given what was saved and which displays exist now.
 * `displays` is Electron's shape: [{ workArea: { x, y, width, height } }, …].
 * Returns bounds to use — the saved ones when they are usable, the defaults otherwise.
 * A window counts as reachable when a decent patch of its title bar area overlaps some
 * display's work area; a sliver hanging off the edge does not count.
 */
export function placeWindow(saved, displays, defaults = DEFAULTS) {
  const fallback = { ...defaults, maximized: false }
  if (!saved || !Number.isFinite(saved.width) || !Number.isFinite(saved.height)) return fallback
  const width = Math.max(MIN.width, Math.round(saved.width))
  const height = Math.max(MIN.height, Math.round(saved.height))
  const maximized = !!saved.maximized
  if (!Number.isFinite(saved.x) || !Number.isFinite(saved.y)) return { width, height, maximized }
  const x = Math.round(saved.x)
  const y = Math.round(saved.y)
  const VISIBLE = 80 // px of the window that must sit inside a work area to be grabbable
  const onScreen = (displays || []).some((d) => {
    const a = d && d.workArea
    if (!a) return false
    const overlapX = Math.min(x + width, a.x + a.width) - Math.max(x, a.x)
    const overlapY = Math.min(y + height, a.y + a.height) - Math.max(y, a.y)
    return overlapX >= VISIBLE && overlapY >= VISIBLE
  })
  return onScreen ? { x, y, width, height, maximized } : { width, height, maximized }
}

/**
 * The store behind it: a small JSON file next to the other user data. Written with
 * `remember(win)`, which reads the window's *normal* bounds (not the maximised ones,
 * so un-maximising after a restore returns to a sane size).
 */
export function openWindowState(file) {
  const read = () => { try { return JSON.parse(readFileSync(file, 'utf8')) } catch { return null } }
  const write = (data) => {
    try { mkdirSync(dirname(file), { recursive: true }); writeFileSync(file, JSON.stringify(data, null, 2) + '\n') }
    catch { /* a window position is never worth crashing over */ }
  }
  return {
    saved: read,
    place(displays, defaults) { return placeWindow(read(), displays, defaults) },
    remember(win) {
      if (!win || win.isDestroyed()) return
      const b = win.getNormalBounds ? win.getNormalBounds() : win.getBounds()
      write({ x: b.x, y: b.y, width: b.width, height: b.height, maximized: win.isMaximized() })
    },
  }
}
