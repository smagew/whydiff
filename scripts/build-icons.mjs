#!/usr/bin/env node
// Builds templates/storyboard-icons.json: the few icons the storyboard's card kinds use,
// cut from the Lucide set (ISC; see templates/storyboard-icons.LICENSE.md). The whole set
// is a 1 MB devDependency; the viewer inlines only this ~30-icon subset, so installed
// plugins carry no icon dependency. Re-run after changing KINDS:
//
//   node scripts/build-icons.mjs
//
// KINDS is the storyboard card vocabulary (schema: storyboard.cards[].kind). Keep it
// generic — what a reader recognises at a glance, not a product or a brand.

import { readFileSync, writeFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { createRequire } from 'node:module'

export const KINDS = {
  person: 'user', team: 'users', browser: 'globe', app: 'monitor', phone: 'smartphone', ai: 'bot',
  service: 'server', api: 'plug', database: 'database', queue: 'layers', cloud: 'cloud', storage: 'hard-drive',
  file: 'file-text', config: 'settings', auth: 'shield-check', secret: 'key-round', payment: 'credit-card',
  money: 'wallet', message: 'message-square', email: 'mail', notification: 'bell', schedule: 'clock',
  job: 'cpu', cli: 'terminal', webhook: 'webhook', package: 'package', test: 'list-checks', search: 'search',
  store: 'store', delivery: 'truck', document: 'receipt', other: 'box',
}
// Marks the viewer draws on a card, not kinds an agent picks.
export const MARKS = { warning: 'triangle-alert' }

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const require = createRequire(import.meta.url)
  const set = require('@iconify-json/lucide/icons.json')
  const info = require('@iconify-json/lucide/info.json')
  const version = require('@iconify-json/lucide/package.json').version
  const pick = (name) => {
    const icon = set.icons[name]
    if (!icon) throw new Error(`lucide has no icon "${name}"`)
    return icon.body
  }
  const out = {
    source: `Lucide ${info.author?.name ? `(${info.author.name})` : ''} via @iconify-json/lucide@${version}, ISC — see storyboard-icons.LICENSE.md`.replace('  ', ' '),
    viewBox: `0 0 ${set.width || 24} ${set.height || 24}`,
    kinds: Object.fromEntries(Object.entries(KINDS).map(([k, n]) => [k, pick(n)])),
    marks: Object.fromEntries(Object.entries(MARKS).map(([k, n]) => [k, pick(n)])),
  }
  writeFileSync(join(root, 'templates', 'storyboard-icons.json'), JSON.stringify(out, null, 1) + '\n')
  console.log(`wrote templates/storyboard-icons.json: ${Object.keys(out.kinds).length} kinds + ${Object.keys(out.marks).length} marks`)
}
