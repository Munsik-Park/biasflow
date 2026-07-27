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

// Signals that the hook's `tonumber` would have died on this entry, so no verdict
// exists to mirror (E1): jq exits 5 mid-pipeline and `block_with_scores` turns that
// into a hard block (.claude/hooks/check-autoflow-gate.sh:507-511).
export class ScoresNotEvaluableError extends Error {
  constructor(key, value) {
    super(`state scores are not evaluable (corrupt or non-numeric) — failing closed: scores["${key}"]`)
    this.name = 'ScoresNotEvaluableError'
    this.code = 'scores-not-evaluable'
    this.key = key
    this.value = value
  }
}

// `{score: n}` and a bare number are the two shapes the hook and the digest
// emitter's `snorm` both accept.
const unwrap = (v) => (v !== null && typeof v === 'object' ? v.score : v)

// jq 1.7's `tonumber` grammar, mirrored (E2). The whitespace class is the four
// codepoints jq actually accepts, enumerated: `\s`, `trim()` and `trimStart/End`
// follow Unicode White_Space and would strip U+000B/U+000C/U+00A0/U+1680/U+2000/
// U+2007/U+2028/U+2029/U+202F/U+205F/U+3000, on every one of which jq exits 5 —
// using any of them reintroduces the fail-open class this guard closes. [DENY].
const JQ_WS = '\\x20\\x09\\x0A\\x0D'
const JQ_NUM = new RegExp(`^[${JQ_WS}]*[+-]?(\\d+(\\.\\d*)?|\\.\\d+)([eE][+-]?\\d+)?[${JQ_WS}]*$`)

// Accepted domain: values jq coerces to a FINITE double whose rendering the mirror
// can reproduce. The `-0` reject (E4) is applied to the COERCED value, not the
// source spelling — jq renders `min -0` and `lowest score -0` where JS `${-0}` is
// `"0"`, the same literal-preservation corner as `-1e999`.
const coerce = (v) => {
  const u = unwrap(v)
  let n
  if (typeof u === 'number') n = u
  else if (typeof u === 'string' && JQ_NUM.test(u)) n = Number(u)
  else return null
  if (!Number.isFinite(n) || Object.is(n, -0)) return null
  return n
}

const num = (key, v) => {
  const n = coerce(v)
  if (n === null) throw new ScoresNotEvaluableError(key, v)
  return n
}

// Shared "round to 1 dp" formula — mirrors the hook's `add/length*10 | round /10`
// (see module header). `replay.mjs` reuses this rather than redefining it, so the
// rounding rule lives in exactly one place.
export const round1 = (x) => Math.round(x * 10) / 10

export function computeVerdict(scores, thresholds = THRESHOLDS) {
  const entries = Object.entries(scores || {})
  if (entries.length === 0) {
    return { pass: false, avg: 0, min: 0, security: null, reason: 'evaluation not run', below7: [] }
  }

  // The guard sits here (E3): the oracle tests `length == 0` (:472) before it
  // builds `$vals` (:475), and its `tonumber` error kills the process before any
  // comparison — so a corrupt value throws even when a blocking security score is
  // present, and empty `scores` still returns "evaluation not run".
  const pairs = entries.map(([k, v]) => [k, num(k, v)])
  const vals = pairs.map(([, n]) => n)
  const avg = round1(vals.reduce((a, b) => a + b, 0) / vals.length)
  const min = Math.min(...vals)
  const rawSec = scores.security ?? scores['보안'] ?? null
  const security = rawSec === null ? null : unwrap(rawSec)
  const below7 = pairs.filter(([, n]) => n < thresholds.itemMin).map(([k]) => k).sort()

  // `$sec` is deliberately NOT passed through `tonumber` (:478), and jq's total
  // order sorts every number before every string, so `"3" <= 3` is false there —
  // JS would coerce and block. `typeof` reproduces jq's ordering on every value
  // that reaches here (E6); the reported field keeps the raw/unwrapped value.
  if (typeof security === 'number' && security <= thresholds.securityMax) {
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
