// A minimal JSON-Schema checker for the review-map contract — exactly the keywords
// schema/review-map.schema.json uses (type, required, properties,
// additionalProperties, items, prefixItems, minItems, maxItems, enum, oneOf), with
// no dependency. Annotation keywords (description, default, examples) are ignored.
//
// Why it exists: the agents write the map, and an agent sometimes drifts from the
// format — groups with only {id, files}, ops.migrations as {name, note} objects. The
// structural checks in lib.mjs looked at cross-references only, so such a map passed
// as "valid" and the viewer printed "undefined" / "[object Object]". The schema is
// the contract; this makes it enforced rather than documented.

import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const schemaPath = join(dirname(fileURLToPath(import.meta.url)), '..', 'schema', 'review-map.schema.json')
let cached
export const reviewMapSchema = () => (cached ||= JSON.parse(readFileSync(schemaPath, 'utf8')))

const typeOf = (v) => v === null ? 'null' : Array.isArray(v) ? 'array' : typeof v
function typeOk(v, t) {
  if (t === 'integer') return Number.isInteger(v)
  if (t === 'number') return typeof v === 'number' && Number.isFinite(v)
  return typeOf(v) === t
}
const show = (v) => { const s = JSON.stringify(v); return s && s.length > 60 ? s.slice(0, 57) + '…' : s }

/** Errors for `value` against `schema`, each prefixed with its JSON path. */
export function checkSchema(value, schema = reviewMapSchema(), path = '$') {
  const out = []
  if (!schema || typeof schema !== 'object') return out
  if (schema.oneOf) {
    const fits = schema.oneOf.filter(s => !checkSchema(value, s, path).length)
    if (fits.length !== 1) {
      // Report the branch that came closest, so the message names the real problem.
      const tries = schema.oneOf.map(s => checkSchema(value, s, path)).sort((a, b) => a.length - b.length)
      out.push(...(fits.length ? [`${path}: matches more than one allowed shape`] : tries[0]))
    }
  }
  if (schema.enum && !schema.enum.some(e => e === value)) out.push(`${path}: ${show(value)} is not one of ${schema.enum.join(' | ')}`)
  if (schema.type && !typeOk(value, schema.type)) {
    out.push(`${path}: expected ${schema.type}, got ${typeOf(value)} ${show(value)}`)
    return out // the rest of the keywords assume the right type
  }
  if (typeOf(value) === 'object') {
    for (const k of schema.required || []) if (!(k in value) || value[k] === undefined || value[k] === null) out.push(`${path}: missing required "${k}"`)
    for (const [k, v] of Object.entries(value)) {
      const sub = schema.properties?.[k] ?? (typeof schema.additionalProperties === 'object' ? schema.additionalProperties : null)
      if (sub) out.push(...checkSchema(v, sub, `${path}.${/^[A-Za-z_$][\w$]*$/.test(k) ? k : JSON.stringify(k)}`))
    }
  }
  if (typeOf(value) === 'array') {
    if (schema.minItems != null && value.length < schema.minItems) out.push(`${path}: needs at least ${schema.minItems} item(s), has ${value.length}`)
    if (schema.maxItems != null && value.length > schema.maxItems) out.push(`${path}: allows at most ${schema.maxItems} item(s), has ${value.length}`)
    value.forEach((v, i) => {
      const sub = schema.prefixItems?.[i] ?? (schema.prefixItems ? null : schema.items)
      if (sub) out.push(...checkSchema(v, sub, `${path}[${i}]`))
    })
  }
  return out
}
