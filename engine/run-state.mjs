// SPDX-FileCopyrightText: 2026 Munsik-Park
// SPDX-License-Identifier: Elastic-2.0
// engine/run-state.mjs — the persisted run state (issue #4, feature design §2.1/§8).
//
// The schema is CLOSED: `load(save(s))` deep-equals `s`, which is what makes the
// round-trip assertable as a deep-equal rather than a field-by-field spot check.
// Four rejections, all typed, none of them a silent coercion:
//   1. unparseable JSON (the truncated-write case) → StateCorruptError
//   2. an unknown schema version                  → StateVersionError
//   3. a key set other than the closed one        → StateCorruptError
//   4. a field whose VALUE is the wrong type      → StateCorruptError
// A resume from a corrupt document must stop, never restart at the first step with
// empty counters — that would silently grant a fresh budget. Check 4 exists because
// the skeleton checks alone do not close that: `counters: null` passes 1-3, and
// `{...null}` is `{}`, so the run resumes on a budget that was already spent.
import { readFileSync, renameSync, writeFileSync } from 'node:fs'

export const STATE_VERSION = 1

const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v)

// The per-field type contract of §2.1, total over the closed key set minus `version`
// (which carries its own, earlier rejection). `expected` is the phrase the refusal
// reports; it names a type, never the offending value.
export const STATE_FIELDS = Object.freeze({
  counters: {
    expected: 'an object whose values are non-negative integers',
    ok: (v) => isPlainObject(v) && Object.values(v).every((n) => Number.isInteger(n) && n >= 0),
  },
  halt: { expected: 'null or an object', ok: (v) => v === null || isPlainObject(v) },
  history: { expected: 'an array', ok: (v) => Array.isArray(v) },
  issue: { expected: 'a string', ok: (v) => typeof v === 'string' },
  pending: { expected: 'null or an object', ok: (v) => v === null || isPlainObject(v) },
  status: { expected: 'a string', ok: (v) => typeof v === 'string' },
  step: { expected: 'a string', ok: (v) => typeof v === 'string' },
  terminal: { expected: 'null or a string', ok: (v) => v === null || typeof v === 'string' },
})

// The closed key set of §2.1, derived from the field table so the two cannot drift,
// and sorted so the load check is one string compare — and so the field pass reports
// a deterministic, alphabetically first offender.
export const STATE_KEYS = Object.freeze([...Object.keys(STATE_FIELDS), 'version'].sort())

export class StateVersionError extends Error {
  constructor(path, version) {
    super(`${path}: unknown state schema version ${JSON.stringify(version)} — expected ${STATE_VERSION}`)
    this.name = 'StateVersionError'
    this.code = 'state-version'
    this.path = path
    this.version = version
  }
}

export class StateCorruptError extends Error {
  constructor(path, detail) {
    super(`${path}: run state is corrupt — ${detail}`)
    this.name = 'StateCorruptError'
    this.code = 'state-corrupt'
    this.path = path
    this.detail = detail
  }
}

// `typeof` reports null and arrays as 'object', and those are the two corruption
// shapes an operator most needs told apart, so they get their own words.
function describeType(value) {
  if (value === null) return 'null'
  if (Array.isArray(value)) return 'an array'
  if (typeof value === 'object') return 'an object'
  return typeof value
}

// The key set, then the fields — one detail string, or null when the document is
// admissible. Both consumers run the same pass, so nothing can be written that
// cannot be read back.
function schemaFault(doc) {
  const keys = Object.keys(doc).sort()
  if (keys.join(',') !== STATE_KEYS.join(',')) {
    return `key set [${keys.join(', ')}] is not the closed schema`
  }
  for (const key of STATE_KEYS) {
    const field = STATE_FIELDS[key]
    if (field && !field.ok(doc[key])) {
      return `field "${key}" is ${describeType(doc[key])} — expected ${field.expected}`
    }
  }
  return null
}

// Atomic by tmp + rename: a crash mid-write leaves the previous document intact
// instead of a truncated one, and the temp file never survives the call. The schema
// pass runs BEFORE the temp write, so a refused save leaves nothing behind.
export function saveState(path, state) {
  const fault = schemaFault(state)
  if (fault !== null) throw new StateCorruptError(path, fault)
  const tmp = `${path}.tmp`
  writeFileSync(tmp, `${JSON.stringify(state)}\n`)
  renameSync(tmp, path)
}

export function loadState(path) {
  let text
  try {
    text = readFileSync(path, 'utf8')
  } catch (e) {
    throw new StateCorruptError(path, `unreadable (${e.message})`)
  }
  let doc
  try {
    doc = JSON.parse(text)
  } catch (e) {
    throw new StateCorruptError(path, `unparseable (${e.message})`)
  }
  if (doc === null || typeof doc !== 'object' || Array.isArray(doc)) {
    throw new StateCorruptError(path, 'the document is not an object')
  }
  if (doc.version !== STATE_VERSION) throw new StateVersionError(path, doc.version)
  const fault = schemaFault(doc)
  if (fault !== null) throw new StateCorruptError(path, fault)
  return doc
}
