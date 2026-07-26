// SPDX-FileCopyrightText: 2026 Munsik-Park
// SPDX-License-Identifier: Elastic-2.0
// engine/replay.mjs — digest replay, AC3 (issue #2, §1.8).
//
// Report-only by construction: this module exports no mutation API and touches no
// file. A mismatch is a finding; nothing is reconciled and no digest line is
// rewritten.
//
// Oracle field set (DCR-4). In scope: `gates.*.items` / `.avg` / `.below7` /
// `.pass`, `architect.rounds`, `regressions.review_autofix_cycles`. Out of scope
// with a stated reason: `regressions.{gate_plan,verify,audit,gate_quality}` are
// hard-coded constants in scripts/handoff/emit-cycle-digest.sh:180-183, so
// replaying them would manufacture false confirmations.
//
// `pass` is replayed against the HOOK formula (D4), not the emitter's weaker
// `below7|length == 0`; today's 13 records yield 0 divergences, which is a
// coincidence of the corpus, not equivalence evidence.
import { computeVerdict, round1, ScoresNotEvaluableError } from './gate.mjs'
import { capValue } from './routing.mjs'

const DIGEST = 'docs/cycle-digest.jsonl'

// Table-driven cap-overrun tracking (DCR-7's `escalate` fold-in applies uniformly
// across rows): each row names the digest field to read and the cap key that
// bounds it. Adding the next digest-tracked cap is one row, not a new block.
const CAP_CHECKS = [
  {
    metric: 'architect.rounds',
    capKey: 'architect.loop',
    value: (rec) => (rec.architect ? rec.architect.rounds : undefined),
  },
  {
    metric: 'regressions.review_autofix_cycles',
    capKey: 'handoff.review-response',
    value: (rec) => (rec.regressions ? rec.regressions.review_autofix_cycles : undefined),
  },
]

// Deliberately the opposite posture to parseYamlSubset's strict throw: there the
// input is the contract itself; here it is a historical log whose lines are
// independent observations, and a throw would suppress every other record's
// findings — inverting "report, never reconcile" into "crash, report nothing" (D16).
export function parseDigest(text) {
  const records = []
  const findings = []
  const lines = String(text).split('\n')
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    if (!line.trim()) continue
    try {
      records.push(JSON.parse(line))
    } catch (e) {
      findings.push({
        code: 'digest-unparseable',
        severity: 'error',
        where: `${DIGEST}:${i + 1}`,
        line: i + 1,
        message: `line ${i + 1} is not valid JSON and was skipped: ${e.message}`,
      })
    }
  }
  return { records, findings }
}

function capFinding(where, metric, actual, expected, escalate) {
  return {
    code: 'cap-exceeded',
    severity: 'error',
    where,
    metric,
    actual,
    expected,
    // U-4: the digest field is a text-occurrence count over ledger prose
    // (emit-cycle-digest.sh:53,62), not a counter of the capped quantity — the
    // divergence is reported, its cause is not resolved.
    provenance: 'derived-by-grep',
    // DCR-7: the escalate observation is folded in as a field rather than raised
    // as a second finding over the same underlying fact.
    escalate,
    message: `${where}: recorded ${metric} ${actual} exceeds the declared cap ${expected}`,
  }
}

export function replay(spec, records) {
  const findings = []
  let roundingDivergence = false

  for (const rec of records) {
    for (const [name, gate] of Object.entries(rec.gates || {})) {
      // A verdict-shaped gate object ("skipped (feat issue)" / "not-evaluated")
      // carries no scores: not applicable, never a finding and never a throw.
      if (!gate || !gate.items) continue
      const where = rec.issue

      // D16 again (E7): `computeVerdict` now throws on an entry the gate calculator
      // refuses to evaluate. Letting it escape would suppress every other record's
      // findings — "crash, report nothing" instead of "report, never reconcile" —
      // so the record is reported and the walk continues.
      let verdict
      try {
        verdict = computeVerdict(gate.items)
      } catch (e) {
        if (!(e instanceof ScoresNotEvaluableError)) throw e
        findings.push({
          code: 'items-not-evaluable',
          severity: 'error',
          where,
          metric: `gates.${name}.items`,
          actual: JSON.stringify(e.value),
          expected: 'a value the gate calculator can evaluate',
          message: `${where}/${name}: item "${e.key}" is not evaluable by the gate calculator; this gate object was skipped`,
        })
        continue
      }

      if (typeof gate.avg === 'number') {
        if (gate.avg !== round1(gate.avg)) roundingDivergence = true
        if (round1(verdict.avg) !== round1(gate.avg)) {
          findings.push({
            code: 'avg-mismatch',
            severity: 'error',
            where,
            metric: `gates.${name}.avg`,
            actual: gate.avg,
            expected: verdict.avg,
            message: `${where}/${name}: recorded avg ${gate.avg} does not reproduce at 1 dp from the recorded items`,
          })
        }
      }

      if (Array.isArray(gate.below7)) {
        const recorded = gate.below7.slice().sort()
        const computed = verdict.below7.slice().sort()
        if (JSON.stringify(recorded) !== JSON.stringify(computed)) {
          findings.push({
            code: 'below7-mismatch',
            severity: 'error',
            where,
            metric: `gates.${name}.below7`,
            actual: recorded,
            expected: computed,
            message: `${where}/${name}: recorded below7 set does not reproduce from the recorded items`,
          })
        }
      }

      if (typeof gate.pass === 'boolean' && gate.pass !== verdict.pass) {
        findings.push({
          code: 'pass-mismatch',
          severity: 'error',
          where,
          metric: `gates.${name}.pass`,
          actual: gate.pass,
          expected: verdict.pass,
          message: `${where}/${name}: recorded pass ${gate.pass} disagrees with the hook formula`,
        })
      }
    }

    const escalate = !!(rec.architect && rec.architect.escalate)
    for (const { metric, capKey, value } of CAP_CHECKS) {
      const actual = value(rec)
      const cap = capValue(spec, capKey)
      if (typeof actual === 'number' && typeof cap === 'number' && actual > cap) {
        findings.push(capFinding(rec.issue, metric, actual, cap, escalate))
      }
    }
  }

  // DCR-2: the emitter writes an unrounded `add/length` while the hook rounds to
  // 1 dp. Comparing at 1 dp absorbs the per-record noise; the policy difference
  // itself is reported ONCE, corpus-wide, rather than per record or suppressed.
  if (roundingDivergence) {
    findings.push({
      code: 'avg-rounding-policy-divergence',
      severity: 'warn',
      where: 'corpus',
      metric: 'gates.*.avg',
      actual: 'unrounded add/length (scripts/handoff/emit-cycle-digest.sh:158)',
      expected: 'add/length*10 | round /10 (.claude/hooks/check-autoflow-gate.sh:476)',
      message: 'the digest emitter and the gate calculator use different rounding policies for the gate average; the replay compares at 1 dp on both sides',
    })
  }

  return findings
}
