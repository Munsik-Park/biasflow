// SPDX-FileCopyrightText: 2026 Munsik-Park
// SPDX-License-Identifier: Elastic-2.0
// engine/run-state.mjs — the persisted run state (issue #4, feature design §2.1/§8).
//
// ============================ State document contract ============================
//
// THE READ-BACK RULE. A persisted state document is admitted iff every value the
// engine will ACT ON after reading it back has the type that action requires. The
// contract enforces exactly those paths, at exactly that depth, and nothing beyond
// them. Three clauses decide any shape this file never mentions:
//
//   R1 — enforce what is ACTED ON. A path is enforced when the engine, on a document
//        `loadState()` returned, dereferences it further (`state.pending.step`), uses
//        it as a key or index (`spec.steps.get(step)`, `counters[capKey]`), spreads it
//        (`{...state.counters}`), or does arithmetic on it (`spent + 1`). Those are
//        exactly the uses that turn a wrong-typed value into one of the two harms this
//        module exists to prevent: an untyped crash INSIDE the executor, or a silent
//        forgery of the cap invariant (`{...null}` is `{}` → a fresh budget).
//   R2 — stop at PASS-THROUGH. A path is not enforced when the engine only carries the
//        value — into an event, into the notify record, into `history`. A pass-through
//        hands the operator back their own bytes: it cannot crash the engine, cannot
//        resume a run and cannot grant a budget, so the only thing enforcing it can do
//        is refuse a document a real run wrote. "Never read at all" is its degenerate
//        case.
//   R3 — TYPES AND SHAPES, never value domains. "Is this a string?" is a property of
//        the document. "Is this a spec step id?" is the document's agreement with a
//        spec this module does not hold — it imports only `node:fs` and is spec-free by
//        construction. A value-domain check here would make an unchanged, in-flight
//        document become inadmissible after an unrelated `spec/**` edit. Those
//        questions are answered TYPED at the point of use instead
//        (`StepResolutionError`, engine/flow.mjs).
//
// The enforced half is `STATE_FIELDS` (a row per path, `shape` for depth); the
// deliberately-open half is `STATE_UNENFORCED` (a row per path, with its clause and
// reason). Both are exported DATA: a new constraint is a ROW, never a branch, and
// "you did not validate X" is answered by citing a table rather than by patching one
// more witness. Adding a check for a shape neither table mentions means adding a row.
//
// The schema is CLOSED at the top level: `load(save(s))` deep-equals `s`, which is
// what makes the round-trip assertable as a deep-equal rather than a field-by-field
// spot check. Nested key sets stay OPEN — that is R2, not an omission: a nested key
// nothing reads is carried, so a request-shape edit cannot invalidate documents
// already on disk. Four rejections, all typed, none of them a silent coercion:
//   1. unparseable JSON (the truncated-write case) → StateCorruptError
//   2. an unknown schema version                  → StateVersionError
//   3. a key set other than the closed one        → StateCorruptError
//   4. a value the rule enforces, wrongly typed   → StateCorruptError
// A resume from a corrupt document must stop, never restart at the first step with
// empty counters — that would silently grant a fresh budget. Check 4 exists because
// the skeleton checks alone do not close that: `counters: null` passes 1-3, and
// `{...null}` is `{}`, so the run resumes on a budget that was already spent.
//
// Both directions run the SAME pass in the SAME order, so nothing can be written that
// cannot be read back — over the whole document, `version` included.
// =================================================================================
import { readFileSync, renameSync, writeFileSync } from 'node:fs'

export const STATE_VERSION = 1

const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v)
const isNullableObject = (v) => v === null || isPlainObject(v)
const isString = (v) => typeof v === 'string'

// The per-field type contract of §2.1, total over the closed key set minus `version`
// (which carries its own, earlier rejection). `expected` is the phrase the refusal
// reports; it names a type, never the offending value. `shape` — when present — is the
// same kind of table applied to the field's OWN properties, consulted only when the
// value is a non-null object; a property with no row is carried, not rejected.
export const STATE_FIELDS = Object.freeze({
  counters: {
    expected: 'an object whose values are non-negative integers',
    ok: (v) => isPlainObject(v) && Object.values(v).every((n) => Number.isInteger(n) && n >= 0),
  },
  halt: { expected: 'null or an object', ok: isNullableObject },
  history: { expected: 'an array', ok: (v) => Array.isArray(v) },
  issue: { expected: 'a string', ok: isString },
  pending: {
    expected: 'null or an object',
    ok: isNullableObject,
    // R1: a delegating resume reads `state.pending.step` and hands it to
    // `spec.steps.get()` as a key (engine/flow.mjs:288). The type that read requires
    // is a string — so this row, and not a branch about `{}`, is what refuses an
    // empty marker.
    shape: Object.freeze({ step: { expected: 'a string', ok: isString } }),
  },
  status: { expected: 'a string', ok: isString },
  step: { expected: 'a string', ok: isString },
  terminal: { expected: 'null or a string', ok: (v) => v === null || isString(v) },
})

// The other half of the declaration: the paths the read-back rule deliberately leaves
// open, each with the clause that decides it and the reason. Exported as data so the
// boundary is stated in BOTH directions and an unenforced property is a recorded
// decision rather than an omission. `*` is any map key, `[]` any array element.
export const STATE_UNENFORCED = Object.freeze([
  { path: 'pending.roles', clause: 'R2', reason: 'written by delegateOn (engine/flow.mjs:232) and never read back; a resume takes its delegation payload from env.delegationOutput' },
  { path: 'pending.request', clause: 'R2', reason: 'an audit record, not a resume input; enforcing it would pin the loader to buildRequest()\'s output shape, so a request-shape edit would invalidate documents already on disk' },
  { path: 'halt.reason', clause: 'R2', reason: 'copied into the halt event and the notify record; never dereferenced, never used as a key' },
  { path: 'halt.step', clause: 'R2', reason: 'as halt.reason — pass-through into the event and the notify record' },
  { path: 'halt.detail', clause: 'R2', reason: 'as halt.reason — pass-through into the event and the notify record' },
  { path: 'history[].capKey', clause: 'R2', reason: 'read behind a guard in escalate() (engine/escalate.mjs:34) and copied into the notify record; a non-object element yields undefined, not a fault' },
  { path: 'counters.*', clause: 'R3', reason: 'a counter KEY is an opaque string compared against derived cap keys; an undeclared key spends no budget, and which keys are legitimate is the spec\'s question, not the document\'s' },
  { path: 'counters.*.value', clause: 'R3', reason: 'the MAGNITUDE of a well-typed counter is a value domain, and R3 places the contract\'s boundary at the type preconditions the cap arithmetic needs. A magnitude claim is decidable document-internally — history[] entries carry capKey (engine/flow.mjs:250,257) — so a counters-vs-history consistency check is a CONSTRUCTIBLE option, deliberately out of scope for a type contract and recorded here rather than claimed impossible' },
  { path: 'step', clause: 'R3', reason: 'spec membership is not a document property; an unresolvable id fails TYPED at the point of use (StepResolutionError, engine/flow.mjs:290)' },
  { path: 'pending.step', clause: 'R3', reason: 'as step — the string TYPE is enforced by the shape row above; only spec membership is left open, and it fails typed at the point of use' },
])

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

// The one mechanism: a row's own predicate, then — for a row that declares `shape` —
// the same function again over the field's own properties. Depth is a property of the
// DECLARATION, so a deeper constraint is a `shape` entry rather than a second check
// bolted on beside this pass. Keys are walked sorted at every level, so a document
// with two faults reports a deterministic, alphabetically first offender.
function fieldFault(path, value, field) {
  if (!field.ok(value)) return `field "${path}" is ${describeType(value)} — expected ${field.expected}`
  if (field.shape && value !== null) {
    for (const key of Object.keys(field.shape).sort()) {
      const fault = fieldFault(`${path}.${key}`, value[key], field.shape[key])
      if (fault !== null) return fault
    }
  }
  return null
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
    if (field) {
      const fault = fieldFault(key, doc[key], field)
      if (fault !== null) return fault
    }
  }
  return null
}

// Atomic by tmp + rename: a crash mid-write leaves the previous document intact
// instead of a truncated one, and the temp file never survives the call. Both checks
// run BEFORE the temp write, so a refused save leaves nothing behind — and they run in
// loadState()'s order (version, then the fields), so the two directions refuse the same
// document with the same code over the whole schema rather than over eight of its nine
// keys.
export function saveState(path, state) {
  if (!isPlainObject(state) || state.version !== STATE_VERSION) {
    throw new StateVersionError(path, isPlainObject(state) ? state.version : undefined)
  }
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
