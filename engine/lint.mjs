// SPDX-FileCopyrightText: 2026 Munsik-Park
// SPDX-License-Identifier: Elastic-2.0
// engine/lint.mjs — declaration lint, AC1 (issue #2, §1.6).
//
// Pure: `lint(spec)` takes the parsed model, so a synthetic spec exercises every
// negative case without mutating spec/ (D10). Findings are reported, never
// reconciled (§2.4) — and both cap directions are checked so the lint cannot
// degenerate into "only the caps someone remembered to wire".
import { RESERVED, CAP_LOOPS, edges, capKeyFor, capKeyForLoop } from './routing.mjs'

const isBounded = (step) => !!step.loop || step.next.has('cap-exhausted')

const capValid = (caps, key) => Number.isInteger(caps[key]) && caps[key] >= 1

// The required caps are per EDGE, not per owner (E8): `handoff` declares one
// `cap-exhausted` outcome but owns two cap keys, so the spec alone cannot express
// "two required caps" — the routing table is the only place the split is declared
// (engine/routing.mjs:31-32, D20/L13). A row applies only if the spec still
// declares its step and its outcome (E11), so a mutated clone raises no phantom;
// for a CAP_LOOPS row the step-side test is `isBounded`, NOT a literal `loop:`
// block — `refine` carries a CAP_LOOPS row and is bounded through `cap-exhausted`.
// Requirements deduplicate by cap key, which is what preserves D20's shared
// counters (`verify.round-trips`, `gate_plan.retry`). Resolution reuses
// routing.mjs's own accessors (`edges`/`capKeyFor`/`capKeyForLoop`) rather than
// re-parsing the `<step>:<outcome>` table keys by hand.
function requiredCaps(spec) {
  const keys = new Set()
  const steps = new Set()
  const mark = (id, capKey) => { keys.add(capKey); steps.add(id) }
  for (const { step: id, outcome } of edges(spec)) {
    const capKey = capKeyFor(id, outcome)
    if (capKey) mark(id, capKey)
  }
  for (const id of Object.keys(CAP_LOOPS)) {
    const step = spec.steps.get(id)
    if (!step || !isBounded(step)) continue
    mark(id, capKeyForLoop(id))
  }
  return { keys, steps }
}

export function lint(spec) {
  const findings = []
  const stepIds = new Set(spec.steps.keys())
  const roleIds = new Set(spec.roles.keys())
  const caps = spec.binding.caps || {}
  const required = requiredCaps(spec)

  // Bucket cap keys by owner (the segment before the first `.`) once, so check 4
  // below is a single lookup per step instead of a full re-scan of `caps`.
  const capsByOwner = new Map()
  for (const key of Object.keys(caps)) {
    const owner = key.split('.')[0]
    if (!capsByOwner.has(owner)) capsByOwner.set(owner, [])
    capsByOwner.get(owner).push(key)
  }

  for (const [id, step] of spec.steps) {
    // 1 — every `next` target resolves to a declared step or a reserved sentinel.
    for (const [outcome, target] of step.next) {
      if (stepIds.has(target) || RESERVED.has(target)) continue
      findings.push({
        code: 'next-target-unresolved',
        severity: 'error',
        where: `${id}:${outcome}`,
        step: id,
        outcome,
        target,
        message: `step "${id}" outcome "${outcome}" targets "${target}", which is neither a declared step nor one of ${[...RESERVED].join('/')}`,
        expected: 'a declared step id or a reserved sentinel',
        actual: target,
      })
    }

    // 2 — every role reference (agents and loop.participants alike) is declared.
    const refs = [
      ...(step.agents || []).map((r) => ['agents', r]),
      ...((step.loop && step.loop.participants) || []).map((r) => ['loop.participants', r]),
    ]
    for (const [field, role] of refs) {
      if (roleIds.has(role)) continue
      findings.push({
        code: 'agent-undeclared',
        severity: 'error',
        where: `${id}.${field}`,
        step: id,
        message: `step "${id}" references role "${role}" via ${field}, which is not declared under spec/roles/`,
        expected: 'a role declared in spec/roles/',
        actual: role,
      })
    }

    // 3 — every gate declares criteria AND a fresh evaluator (presence, not resolution).
    if (step.kind === 'gate') {
      if (step.criteria === undefined || step.criteria === null || step.criteria === '') {
        findings.push({
          code: 'gate-incomplete',
          severity: 'error',
          where: `${id}.criteria`,
          step: id,
          message: `gate "${id}" declares no criteria`,
          expected: 'a non-empty criteria name',
          actual: step.criteria === undefined ? 'absent' : String(step.criteria),
        })
      }
      if (!(step.agents || []).includes('evaluator')) {
        findings.push({
          code: 'gate-incomplete',
          severity: 'error',
          where: `${id}.agents`,
          step: id,
          message: `gate "${id}" declares no evaluator agent`,
          expected: 'agents containing "evaluator"',
          actual: JSON.stringify(step.agents || []),
        })
      } else {
        const evaluator = spec.roles.get('evaluator')
        if (!evaluator || evaluator.session !== 'fresh') {
          findings.push({
            code: 'gate-incomplete',
            severity: 'error',
            where: `${id}.agents.evaluator`,
            step: id,
            message: `gate "${id}" uses the evaluator role, which does not declare "session: fresh" (invariant 2)`,
            expected: 'session: fresh',
            actual: evaluator ? String(evaluator.session) : 'role absent',
          })
        }
      }
    }

    // 4, Arm B — fallback for a bounded step that no applying table row names, so
    // a step declared bounded but absent from the routing tables is still reported
    // (E9) and `isBounded` (D1) stays a live input to the lint. Mutually exclusive
    // with Arm A below, so the two never double-report (E10).
    if (isBounded(step) && !required.steps.has(id)) {
      const owned = (capsByOwner.get(id) || []).filter((k) => capValid(caps, k))
      if (owned.length === 0) {
        findings.push({
          code: 'cap-missing',
          severity: 'error',
          where: id,
          step: id,
          message: `bounded step "${id}" owns no "${id}." cap key with an integer value ≥ 1 in the binding`,
          expected: `a binding cap key prefixed "${id}."`,
          actual: 'none',
        })
      }
    }
  }

  // 4, Arm A — every required cap key is declared with an integer value ≥ 1 (E13),
  // checked per key rather than per owner: that is what makes
  // `handoff.review-response = 0` reportable while `handoff.env-retry = 2` is valid.
  for (const key of required.keys) {
    if (capValid(caps, key)) continue
    findings.push({
      code: 'cap-missing',
      severity: 'error',
      where: key,
      step: key.split('.')[0],
      message: `bounded edge cap key "${key}" is not declared with an integer value ≥ 1 in the binding`,
      expected: `a binding cap key "${key}" with an integer value ≥ 1`,
      actual: key in caps ? JSON.stringify(caps[key]) : 'none',
    })
  }

  // 5 — the reverse direction: no cap key is dead overlay.
  for (const key of Object.keys(caps)) {
    const owner = key.split('.')[0]
    const step = spec.steps.get(owner)
    if (step && isBounded(step)) continue
    findings.push({
      code: 'cap-orphan',
      severity: 'error',
      where: key,
      step: owner,
      message: step
        ? `cap key "${key}" binds a cap to "${owner}", which declares neither a loop nor a cap-exhausted outcome`
        : `cap key "${key}" names "${owner}", which is not a declared step`,
      expected: 'a declared, bounded step',
      actual: owner,
    })
  }

  return findings
}
