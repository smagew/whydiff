// Where prepared fixture repos live. NOT inside this repo: Claude Code refuses
// writes inside the --plugin-dir it loaded (a "sensitive file", and no hook can
// approve it), so a fixture under the plugin's own folder cannot be analysed —
// the agents' Write into <fixture>/.whydiff/ is denied. Override with
// WHYDIFF_FIXTURES; the Makefile passes its FIXDIR through that variable.
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'

export const fixturesDir = () => resolve(process.env.WHYDIFF_FIXTURES || join(homedir(), '.cache', 'whydiff', 'fixtures'))
