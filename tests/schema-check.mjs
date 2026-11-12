#!/usr/bin/env node
// Unit tests for scripts/schema-check.mjs — the dependency-free checker that holds
// every map to schema/review-map.schema.json. Proves it accepts the reference maps,
// rejects the drift seen in real runs (nameless groups, object-form ops entries), and
// understands every keyword the schema uses, so a new keyword cannot be silently ignored.

import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { checkSchema, reviewMapSchema } from '../scripts/schema-check.mjs'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
let failures = 0
const check = (c, m) => { if (!c) { console.error(`FAIL: ${m}`); failures++ } }
const load = (p) => JSON.parse(readFileSync(join(root, p), 'utf8'))
const clone = (o) => JSON.parse(JSON.stringify(o))

for (const p of ['examples/rate-limit/review-map.json', 'tests/fixtures/eval/synthetic-map.json']) {
  const e = checkSchema(load(p))
  check(!e.length, `${p} must match the schema, got:\n  ${e.join('\n  ')}`)
}

const base = load('examples/rate-limit/review-map.json')
const expectErr = (label, mutate, re) => {
  const m = clone(base); mutate(m)
  const e = checkSchema(m)
  check(e.some(x => re.test(x)), `${label}: expected an error matching ${re}, got:\n  ${e.join('\n  ') || '(none)'}`)
}
expectErr('nameless group', m => { delete m.groups[0].name }, /^\$\.groups\[0\]: missing required "name"$/)
expectErr('group without role', m => { delete m.groups[0].role }, /groups\[0\]: missing required "role"/)
expectErr('object migration', m => { m.ops = { migrations: [{ name: 'a', note: 'b' }] } }, /^\$\.ops\.migrations\[0\]: expected string, got object/)
expectErr('file without counts', m => { delete Object.values(m.files)[0].add }, /\$\.files\..*missing required "add"/)
expectErr('non-integer count', m => { Object.values(m.files)[0].del = 1.5 }, /expected integer/)
expectErr('edge too short', m => { m.edges[0] = ['a', 'b'] }, /edges\[0\]: needs at least 3/)
expectErr('edge title not a string', m => { m.edges[0] = [m.edges[0][0], m.edges[0][1], 7] }, /edges\[0\]\[2\]: expected string/)
expectErr('bad diagram kind', m => { m.diagrams[0].kind = 'pie' }, /diagrams\[0\]\.kind: "pie" is not one of/)
expectErr('story item of neither shape', m => { m.story = [{ text: 'no label' }] }, /story\[0\]/)
expectErr('generated id unknown', m => { m.generated = ['nope'] }, /generated\[0\]/)
check(!checkSchema(clone(base)).length, 'the unmodified example has no errors')

// Every keyword used anywhere in the schema must be one the checker handles or one
// that only annotates. A new validation keyword would otherwise be silently ignored.
const HANDLED = new Set(['type', 'required', 'properties', 'additionalProperties', 'items', 'prefixItems', 'minItems', 'maxItems', 'enum', 'oneOf'])
const ANNOTATION = new Set(['$schema', '$id', 'title', 'description', 'default', 'examples'])
const seen = new Set()
const walk = (s) => {
  if (!s || typeof s !== 'object') return
  if (Array.isArray(s)) return s.forEach(walk)
  for (const [k, v] of Object.entries(s)) {
    seen.add(k)
    if (k === 'properties') Object.values(v).forEach(walk)
    else if (['items', 'additionalProperties'].includes(k)) walk(v)
    else if (['prefixItems', 'oneOf'].includes(k)) v.forEach(walk)
  }
}
walk(reviewMapSchema())
const unknown = [...seen].filter(k => !HANDLED.has(k) && !ANNOTATION.has(k))
check(!unknown.length, `schema uses keyword(s) the checker does not implement: ${unknown.join(', ')}`)

if (failures) { console.error(`\nschema-check: ${failures} failure(s)`); process.exit(1) }
console.log(`OK: schema-check — reference maps pass, ${11} kinds of drift are caught, every schema keyword is implemented`)
