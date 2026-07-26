// SPDX-FileCopyrightText: 2026 Munsik-Park
// SPDX-License-Identifier: Elastic-2.0
// engine/lint.mjs — declaration lint, AC1 (issue #2, §1.6).
//
// Pure: `lint(spec)` takes the parsed model, so a synthetic spec exercises every
// negative case without mutating spec/ (D10). Findings are reported, never
// reconciled (§2.4) — and both cap directions are checked so the lint cannot
// degenerate into "only the caps someone remembered to wire".
import { RESERVED } from './routing.mjs'

const isBounded = (step) => !!step.loop || step.next.has('cap-exhausted')

export function lint(spec) {
  const findings = []
  const stepIds = new Set(spec.steps.keys())
  const roleIds = new Set(spec.roles.keys())
  const caps = spec.binding.caps || {}

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

    // 4 — every bounded step owns at least one integer cap key in the binding.
    if (isBounded(step)) {
      const owned = (capsByOwner.get(id) || []).filter((k) => Number.isInteger(caps[k]) && caps[k] >= 1)
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
