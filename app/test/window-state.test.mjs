// window-state.mjs — where the window opens. The interesting half is not "did we save the
// bounds" but "are the saved bounds still reachable": restoring onto a display that has
// since been unplugged puts the window somewhere the user cannot drag it back from.
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { placeWindow, openWindowState, DEFAULTS } from '../src/main/window-state.mjs'

const fail = (m) => { console.error(`FAIL: ${m}`); process.exit(1) }
const ok = (c, m) => { if (!c) fail(m) }

const laptop = { workArea: { x: 0, y: 25, width: 1512, height: 945 } }
const external = { workArea: { x: 1512, y: 0, width: 2560, height: 1440 } }

// Nothing saved yet → the defaults, unpositioned (Electron centres it).
{
  const p = placeWindow(null, [laptop])
  ok(p.width === DEFAULTS.width && p.height === DEFAULTS.height, 'no saved state → default size')
  ok(p.x === undefined && p.y === undefined, 'no saved state → no position, so the OS centres it')
}

// Saved bounds that sit on a present display come back exactly.
{
  const p = placeWindow({ x: 100, y: 80, width: 1300, height: 900 }, [laptop, external])
  ok(p.x === 100 && p.y === 80 && p.width === 1300 && p.height === 900, 'usable bounds are restored as-is')
}

// The regression this exists for: the display the window lived on is gone.
{
  const p = placeWindow({ x: 2000, y: 400, width: 1300, height: 900 }, [laptop])
  ok(p.x === undefined && p.y === undefined, 'off-screen position is dropped')
  ok(p.width === 1300 && p.height === 900, 'but the size the user chose is kept')
}

// A window peeking in by a few pixels is not reachable either.
{
  const p = placeWindow({ x: 1500, y: 400, width: 1300, height: 900 }, [laptop])
  ok(p.x === undefined, '12px of overlap does not count as on-screen')
  const q = placeWindow({ x: 1400, y: 400, width: 1300, height: 900 }, [laptop])
  ok(q.x === 1400, 'a properly overlapping window is kept')
}

// Sizes below the window's own minimum are raised rather than honoured.
{
  const p = placeWindow({ x: 10, y: 40, width: 200, height: 100 }, [laptop])
  ok(p.width >= 720 && p.height >= 480, 'a saved size below the minimum is clamped up')
}

// Garbage in the file is treated as "nothing saved", never as a crash.
{
  const p = placeWindow({ x: 'left', width: null }, [laptop])
  ok(p.width === DEFAULTS.width, 'a corrupt entry falls back to the defaults')
}

// Round trip through the file, with a fake window.
{
  const file = join(mkdtempSync(join(tmpdir(), 'wd-winstate-')), 'window.json')
  const st = openWindowState(file)
  ok(st.saved() === null, 'no file yet → nothing saved')
  st.remember({
    isDestroyed: () => false,
    getNormalBounds: () => ({ x: 12, y: 34, width: 1200, height: 800 }),
    isMaximized: () => true,
  })
  const back = st.saved()
  ok(back.x === 12 && back.width === 1200 && back.maximized === true, 'bounds and the maximised flag round-trip')
  const placed = st.place([laptop, external])
  ok(placed.maximized === true && placed.width === 1200, 'the placement carries the maximised flag through')
}

// A destroyed window is not asked for its bounds (it throws in Electron).
{
  const file = join(mkdtempSync(join(tmpdir(), 'wd-winstate2-')), 'window.json')
  const st = openWindowState(file)
  st.remember({ isDestroyed: () => true, getNormalBounds: () => { throw new Error('gone') }, isMaximized: () => false })
  ok(st.saved() === null, 'nothing written for a destroyed window')
}

console.log('window-state: ok')
