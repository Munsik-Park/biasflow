// SPDX-FileCopyrightText: 2026 Munsik-Park
// SPDX-License-Identifier: Elastic-2.0
// engine/run-state.mjs — the persisted run state (issue #4, feature design §2.1/§8).
//
// The schema is CLOSED: `load(save(s))` deep-equals `s`, which is what makes the
// round-trip assertable as a deep-equal rather than a field-by-field spot check.
// Three rejections, all typed, none of them a silent coercion:
//   1. unparseable JSON (the truncated-write case) → StateCorruptError
//   2. an unknown schema version                  → StateVersionError
//   3. a key set other than the closed one        → StateCorruptError
// A resume from a corrupt document must stop, never restart at the first step with
// empty counters — that would silently grant a fresh budget.
import { readFileSync, renameSync, writeFileSync } from 'node:fs'

export const STATE_VERSION = 1

// The closed key set of §2.1, sorted so the load check is one string compare.
export const STATE_KEYS = Object.freeze([
  'counters', 'halt', 'history', 'issue', 'pending', 'status', 'step', 'terminal', 'version',
])

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

// Atomic by tmp + rename: a crash mid-write leaves the previous document intact
// instead of a truncated one, and the temp file never survives the call.
export function saveState(path, state) {
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
  const keys = Object.keys(doc).sort()
  if (keys.join(',') !== STATE_KEYS.join(',')) {
    throw new StateCorruptError(path, `key set [${keys.join(', ')}] is not the closed schema`)
  }
  return doc
}
