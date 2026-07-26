// SPDX-FileCopyrightText: 2026 Munsik-Park
// SPDX-License-Identifier: Elastic-2.0
// engine/routing.mjs — the routing table (issue #2, §1.4). M1 engine module 1.
//
// Pure over a SpecModel: no I/O, no simulator dependency. A bounded unit is
// identified by an explicit declaration marker, never by graph topology (D1) — a
// step is bounded iff it declares a `loop:` block or a `cap-exhausted` outcome.
//
// Bounded units come in two structurally different kinds (D11):
//   CAP_EDGES  — bounded EDGES, counted per traversal, keyed `<step>:<outcome>`
//   CAP_LOOPS  — bounded LOOPS / internal retries, counted per re-entry, keyed `<step>`
// Both resolve to a CAP KEY, and counters are keyed by that cap key, never by the
// lookup's input (D20) — which is what makes `verify.round-trips` one budget across
// both cause branches and `gate_plan.retry` one budget across two steps.

export const RESERVED = new Set(['end', 'escalate', 'close'])

const DECL = 'declaration'
const REGRESSIONS = 'prose:CLAUDE.md > Flow Control > Regressions'

export const CAP_EDGES = {
  'gate_hypothesis:fail': { capKey: 'gate_hypothesis.retry', source: DECL },
  'gate_plan:fail': { capKey: 'gate_plan.retry', source: DECL },
  // shared counter — spec/bindings/claude.yaml:23, spec/steps/gate_plan.yaml:9
  'verify:design-contradiction': { capKey: 'gate_plan.retry', source: REGRESSIONS },
  'verify:test-issue': { capKey: 'verify.round-trips', source: DECL },
  'verify:impl-issue': { capKey: 'verify.round-trips', source: DECL },
  'audit:fail': { capKey: 'audit.retry', source: DECL },
  'gate_quality:fail': { capKey: 'gate_quality.retry', source: DECL },
  // handoff owns two caps behind one `cap-exhausted` outcome; the split is prose-sourced
  'handoff:env-failure': { capKey: 'handoff.env-retry', source: REGRESSIONS },
  'handoff:review-findings': { capKey: 'handoff.review-response', source: REGRESSIONS },
}

export const CAP_LOOPS = {
  architect: { capKey: 'architect.loop', source: DECL },
  refine: { capKey: 'refine.retry', source: DECL },
}

// What the declaration layer does not supply is made visible, never absorbed (D15).
// Asserted by exact deep-equal, so a third undeclared dependency cannot appear
// silently and a future spec/ amendment that declares one fails until the row goes.
export const PROSE_SOURCED = [
  {
    where: 'verify',
    what: 'exhaustion-target',
    value: 'undecidable',
    source: 'prose:CLAUDE.md > Flow Control > Human escalation',
  },
  {
    where: 'handoff',
    what: 'missing-outcome',
    value: 'label-present & max_severity < Medium → re-review, no cap consumption',
    source: 'prose:CLAUDE.md > Flow Control > HANDOFF rows',
  },
]

const stepIds = (spec) => [...spec.steps.keys()]
const stepOf = (spec, id) => spec.steps.get(id)
const nextEntries = (step) => [...step.next.entries()]

export function edges(spec) {
  const rows = []
  for (const id of stepIds(spec)) {
    for (const [outcome, target] of nextEntries(stepOf(spec, id))) {
      rows.push({ step: id, outcome, target, reserved: RESERVED.has(target) })
    }
  }
  return rows
}

export function resolve(spec, stepId, outcome) {
  const step = stepOf(spec, stepId)
  if (!step) throw new Error(`no such step: ${stepId}`)
  if (!step.next.has(outcome)) throw new Error(`step ${stepId} declares no outcome "${outcome}"`)
  const target = step.next.get(outcome)
  return { target, reserved: RESERVED.has(target) }
}

export function reachable(spec, fromId) {
  const seen = new Set()
  const queue = [fromId]
  let first = true
  while (queue.length) {
    const id = queue.shift()
    if (!first) {
      if (seen.has(id)) continue
      seen.add(id)
    }
    first = false
    const step = stepOf(spec, id)
    if (!step) continue
    for (const [, target] of nextEntries(step)) {
      if (RESERVED.has(target) || seen.has(target)) continue
      queue.push(target)
    }
  }
  return seen
}

export function backEdges(spec) {
  const out = new Set()
  const closures = new Map()
  for (const id of stepIds(spec)) {
    for (const [outcome, target] of nextEntries(stepOf(spec, id))) {
      if (RESERVED.has(target)) continue
      if (target === id) {
        out.add(`${id}:${outcome}`)
        continue
      }
      if (!closures.has(target)) closures.set(target, reachable(spec, target))
      if (closures.get(target).has(id)) out.add(`${id}:${outcome}`)
    }
  }
  return out
}

export function capKeyFor(stepId, outcome) {
  const row = CAP_EDGES[`${stepId}:${outcome}`]
  return row ? row.capKey : null
}

export function capKeyForLoop(stepId) {
  const row = CAP_LOOPS[stepId]
  return row ? row.capKey : null
}

export function capValue(spec, capKey) {
  return spec.binding.caps[capKey]
}
