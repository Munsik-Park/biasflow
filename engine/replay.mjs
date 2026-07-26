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
import { computeVerdict } from './gate.mjs'

const DIGEST = 'docs/cycle-digest.jsonl'
const round1 = (x) => Math.round(x * 10) / 10

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
  const caps = spec.binding.caps || {}
  let roundingDivergence = false

  for (const rec of records) {
    for (const [name, gate] of Object.entries(rec.gates || {})) {
      // A verdict-shaped gate object ("skipped (feat issue)" / "not-evaluated")
      // carries no scores: not applicable, never a finding and never a throw.
      if (!gate || !gate.items) continue
      const verdict = computeVerdict(gate.items)
      const where = rec.issue

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
    const rounds = rec.architect ? rec.architect.rounds : undefined
    const loopCap = caps['architect.loop']
    if (typeof rounds === 'number' && typeof loopCap === 'number' && rounds > loopCap) {
      findings.push(capFinding(rec.issue, 'architect.rounds', rounds, loopCap, escalate))
    }

    const autofix = rec.regressions ? rec.regressions.review_autofix_cycles : undefined
    const reviewCap = caps['handoff.review-response']
    if (typeof autofix === 'number' && typeof reviewCap === 'number' && autofix > reviewCap) {
      findings.push(capFinding(rec.issue, 'regressions.review_autofix_cycles', autofix, reviewCap, escalate))
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
