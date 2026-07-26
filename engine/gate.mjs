// SPDX-FileCopyrightText: 2026 Munsik-Park
// SPDX-License-Identifier: Elastic-2.0
// engine/gate.mjs — the gate calculator (issue #2, §1.5). M1 engine module 2.
//
// Behavioral equivalence with the enforced calculator is the point of this module,
// so it mirrors `.claude/hooks/check-autoflow-gate.sh` > check_scores (:467-493)
// exactly: `{score: n}` unwrapping, the `security` / `보안` key alias, the
// precedence order (security ≤ 3 → item < 7 → avg < 7.5 → PASS), `avg` rounded as
// `add/length*10 | round /10`, and empty `scores` → fail-closed "evaluation not run".
// Where the hook's behavior is odd it is REPRODUCED, not fixed (equivalence-only,
// HANDOFF.md decision 3) — including the literal `security` key detection, which on
// today's corpus never matches the `audit` gate's own item names.
//
// Thresholds are an injected parameter, never a hard-coded constant (DCR-5c): the
// criteria layer is deliberately empty, so the current values are prose-sourced and
// the seam has to exist from the start.

export const THRESHOLDS = {
  securityMax: 3,
  itemMin: 7,
  avgMin: 7.5,
  source: 'prose:CLAUDE.md > Phase Playbook Loading Contract',
}

// `{score: n}` and a bare number are the two shapes the hook and the digest
// emitter's `snorm` both accept.
const unwrap = (v) => (v !== null && typeof v === 'object' ? v.score : v)
const num = (v) => Number(unwrap(v))

// Shared "round to 1 dp" formula — mirrors the hook's `add/length*10 | round /10`
// (see module header). `replay.mjs` reuses this rather than redefining it, so the
// rounding rule lives in exactly one place.
export const round1 = (x) => Math.round(x * 10) / 10

export function computeVerdict(scores, thresholds = THRESHOLDS) {
  const entries = Object.entries(scores || {})
  if (entries.length === 0) {
    return { pass: false, avg: 0, min: 0, security: null, reason: 'evaluation not run', below7: [] }
  }

  const pairs = entries.map(([k, v]) => [k, num(v)])
  const vals = pairs.map(([, n]) => n)
  const avg = round1(vals.reduce((a, b) => a + b, 0) / vals.length)
  const min = Math.min(...vals)
  const rawSec = scores.security !== undefined && scores.security !== null
    ? scores.security
    : (scores['보안'] !== undefined && scores['보안'] !== null ? scores['보안'] : null)
  const security = rawSec === null ? null : unwrap(rawSec)
  const below7 = pairs.filter(([, n]) => n < thresholds.itemMin).map(([k]) => k).sort()

  if (security !== null && security <= thresholds.securityMax) {
    return { pass: false, avg, min, security, reason: `security score ${security} — automatic rework`, below7 }
  }
  if (min < thresholds.itemMin) {
    return { pass: false, avg, min, security, reason: `lowest score ${min} — each item must be ≥ ${thresholds.itemMin}`, below7 }
  }
  if (avg < thresholds.avgMin) {
    return { pass: false, avg, min, security, reason: `average ${avg} — must be ≥ ${thresholds.avgMin}`, below7 }
  }
  return { pass: true, avg, min, security, reason: 'PASS', below7 }
}
