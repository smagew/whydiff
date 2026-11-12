#!/usr/bin/env node
// Unit tests for templates/viewer-logic.mjs — the viewer's pure, DOM-free helpers,
// extracted from the single big script so they can be covered here instead of only via
// the browser e2e. assemble.mjs inlines this same module into the viewer (exports
// stripped), so what we test is what ships.

import { nslug, genProgressEstimate, normalizeMap, buildFileTree, fileStatus, storyboardMermaid } from '../templates/viewer-logic.mjs'

const fail = (m) => { console.error(`FAIL: ${m}`); process.exit(1) }
const ok = (c, m) => { if (!c) fail(m) }
const eq = (a, b, m) => ok(a === b, `${m}\n  got: ${JSON.stringify(a)}\n  want: ${JSON.stringify(b)}`)

// ── nslug ──────────────────────────────────────────────────────────────────
eq(nslug('Request to /api/*'), 'request-to-api', 'slug lowercases and folds non-alnum runs to single dashes')
eq(nslug('  Trim — Me!  '), 'trim-me', 'slug trims leading/trailing dashes')
eq(nslug('A_b.C'), 'a-b-c', 'slug folds punctuation')
eq(nslug(''), '', 'slug of empty is empty')
eq(nslug(123), '123', 'slug tolerates a non-string')

// ── genProgressEstimate ──────────────────────────────────────────────────────
const G = genProgressEstimate
// Defaults are safe and start low.
ok(G() >= 0.04 && G() < 0.1, `default estimate starts low, got ${G()}`)
// Reading: strictly increases with elapsed, and is capped below 0.70 (leaves room for writing).
const r0 = G({ elapsedS: 0 }), r10 = G({ elapsedS: 10 }), r60 = G({ elapsedS: 60 }), rHuge = G({ elapsedS: 100000 })
ok(r10 > r0 && r60 > r10, `reading estimate must increase with time (${r0} → ${r10} → ${r60})`)
ok(rHuge < 0.70 + 1e-9 && rHuge > 0.65, `reading estimate must plateau just under 0.70, got ${rHuge}`)
// Writing: jumps above where reading caps, increases with write time, capped below 0.97.
const w0 = G({ phase: 'writing', writeElapsedS: 0 }), w10 = G({ phase: 'writing', writeElapsedS: 10 }), wHuge = G({ phase: 'writing', writeElapsedS: 100000 })
ok(w0 >= 0.76 && w0 > rHuge, `writing estimate must start above the reading cap, got ${w0}`)
ok(w10 > w0, `writing estimate must increase with write time (${w0} → ${w10})`)
ok(wHuge < 0.97 + 1e-9 && wHuge > 0.95, `writing estimate must plateau just under 0.97, got ${wHuge}`)
// The invariant that matters: it NEVER reports 100% until the caller says it ended.
for (const s of [{ elapsedS: 1e9 }, { phase: 'writing', writeElapsedS: 1e9 }]) ok(G(s) < 1, `estimate must never reach 1 before ended (${JSON.stringify(s)} → ${G(s)})`)
eq(G({ ended: true }), 1, 'ended completes to exactly 1')
eq(G({ phase: 'writing', writeElapsedS: 3, ended: true }), 1, 'ended overrides the phase estimate')


// ── normalizeMap ─────────────────────────────────────────────────────────────
{
  const m = normalizeMap({ groups: [{ id: 'auth', files: ['a.ts'] }, { id: 'x', name: '  ', role: 'read', why: 'w', tag: 'T', files: ['b'] }],
    ops: { migrations: [{ name: '0806_add', note: 'adds a column' }, 'plain', { n: 1 }], deploy: [{ step: 'migrate' }] } })
  eq(m.groups[0].name, 'auth', 'a nameless group falls back to its id')
  eq(m.groups[0].role + '|' + m.groups[0].why, '|', 'missing role/why become empty, never undefined')
  ok(!('tag' in m.groups[0]), 'a missing tag stays absent (callers fall back to role)')
  eq(m.groups[1].name, 'x', 'a blank name falls back to the id')
  eq(m.groups[1].tag, 'T', 'present fields are kept')
  eq(JSON.stringify(m.ops.migrations), JSON.stringify(['0806_add — adds a column', 'plain', '']), 'object migrations flatten to their string fields')
  eq(JSON.stringify(m.ops.deploy), JSON.stringify(['migrate']), 'object deploy steps flatten')
  eq(normalizeMap(null), null, 'null passes through')
  const good = { groups: [{ id: 'g', name: 'G', role: 'read', why: 'w', files: [] }], ops: { migrations: ['m'] } }
  eq(JSON.stringify(normalizeMap(JSON.parse(JSON.stringify(good)))), JSON.stringify(good), 'a schema-valid map is unchanged')
}


// ── fileStatus ───────────────────────────────────────────────────────────────
eq(fileStatus({ status: 'renamed', isNew: false }), 'renamed', 'git status wins')
eq(fileStatus({ status: 'deleted' }), 'deleted', 'deleted is kept')
eq(fileStatus({ isNew: true }), 'added', 'an old map falls back to isNew → added')
eq(fileStatus({}), 'modified', 'an old map without isNew → modified')
eq(fileStatus({ status: 'bogus', isNew: true }), 'added', 'an unknown status falls back to isNew')

// ── buildFileTree ────────────────────────────────────────────────────────────
{
  const show = (nodes, d = 0) => nodes.map(n => '  '.repeat(d) + (n.kind === 'dir' ? `${n.name}/ [${n.key}]\n` + show(n.children, d + 1) : `${n.name}\n`)).join('')
  const t = buildFileTree(['app/src/api/middleware/auth.ts', 'app/src/api/middleware/auth.test.ts', 'app/src/api/server.ts', 'app/src/config.ts', 'README.md', 'mcp/src/proxy.ts', 'mcp/package.json', 'a/b/c/d/deep.ts', 'file10.ts', 'file9.ts'])
  eq(show(t), [
    'a/b/c/d/ [a/b/c/d/]', '  deep.ts',
    'app/src/ [app/src/]', '  api/ [app/src/api/]', '    middleware/ [app/src/api/middleware/]', '      auth.test.ts', '      auth.ts', '    server.ts', '  config.ts',
    'mcp/ [mcp/]', '  src/ [mcp/src/]', '    proxy.ts', '  package.json',
    'file9.ts', 'file10.ts', 'README.md', ''].join('\n'),
    'folders first, single-folder chains compacted, natural name order, keys are full folder paths')
  const all = []
  const walk = (ns) => { for (const n of ns) n.kind === 'file' ? all.push(n.path) : walk(n.children) }
  walk(t)
  eq(all.length, 10, 'every path appears exactly once')
  eq(buildFileTree([]).length, 0, 'no paths, no nodes')
  eq(JSON.stringify(buildFileTree(['x.ts'])), JSON.stringify([{ kind: 'file', name: 'x.ts', path: 'x.ts' }]), 'a root file is a top-level file node')
  eq(buildFileTree(['a/x.ts', 'a/x.ts']).length, 1, 'a duplicate path is listed once')
}

// ── storyboardMermaid ────────────────────────────────────────────────────────
{
  const sb = {
    cards: [
      { id: 'u', kind: 'person', title: 'Manager', text: 'asks to send an SMS', status: 'same' },
      { id: 'm', kind: 'service', title: 'MCP "proxy" #1', text: '<script>alert(1)</script> & co', status: 'added', files: ['mcp/src/proxy.ts'] },
      { id: 'a', kind: 'auth', title: 'Access', text: "it's now scoped", status: 'changed', warning: 'scope "mcp" is never checked' },
      { id: 'x', kind: 'Evil Kind!', title: 'Old bridge', text: 'gone', status: 'removed' },
    ],
    arrows: [
      { from: 'u', to: 'm', label: 'asks "send"' }, { from: 'm', to: 'a', label: 'checks', status: 'added' },
      { from: 'm', to: 'x', label: 'used to call', status: 'removed' }, { from: 'm', to: 'nope', label: 'dangling' },
    ],
  }
  const src = storyboardMermaid(sb, { added: 'новый', changed: 'изменён', removed: 'удалён' })
  const labels = [...src.matchAll(/\["(.*)"\]$/gm)].map(m => m[1])
  eq(labels.length, 4, 'one node per card')
  ok(labels.every(l => !l.includes('"')), 'no raw double quote inside a node label (it would end the label)')
  ok(!/<script/i.test(src) && src.includes('&lt;script&gt;'), 'model text is HTML-escaped, never markup')
  ok(src.includes('#quot;proxy#quot; #35;1') && src.includes('it#39;s'), 'quotes, # and apostrophes become mermaid entities')
  ok(/^\s*sb0 -->\|"asks #quot;send#quot;"\| sb1$/m.test(src), 'a plain arrow with an escaped label')
  ok(/^\s*sb1 ==>\|"checks"\| sb2$/m.test(src), 'an added arrow is thick')
  ok(/^\s*sb1 -\.->\|"used to call"\| sb3$/m.test(src), 'a removed arrow is dotted')
  ok(!src.includes('dangling'), 'an arrow to an unknown card is dropped')
  ok(/class sb1 added/.test(src) && /class sb2 changed/.test(src) && /class sb3 removed/.test(src) && !/class sb0/.test(src), 'status → diff class; same → none')
  ok(src.includes("<span class='sbtag'>новый</span>") && !labels[0].includes('sbtag'), 'tags use the report-language words; an unchanged card has none')
  ok(src.includes("data-k='other'") && src.includes("data-k='service'"), 'an unknown kind falls back to other')
  ok(src.includes("<span class='sbw'>") && src.includes('scope #quot;mcp#quot; is never checked'), 'a warning is drawn, escaped')
  ok(src.includes('click sb1 call whydiffOpen("mcp/src/proxy.ts")') && (src.match(/click /g) || []).length === 1, 'a card with files opens its first file; others have no click')
  ok(src.startsWith('flowchart LR'), '≤5 cards lay out left to right')
  eq(storyboardMermaid({ cards: Array.from({ length: 6 }, (_, i) => ({ id: i, kind: 'file', title: 't', text: 'x' })) }).split('\n')[0], 'flowchart TB', 'more cards lay out top to bottom')
  eq(storyboardMermaid(null), 'flowchart LR', 'no storyboard, an empty graph (never a throw)')
}

console.log('OK: viewer-logic (nslug folds/trims/tolerates non-strings; genProgressEstimate rises while reading<0.70, jumps and rises while writing<0.97, never hits 1 before ended)')
