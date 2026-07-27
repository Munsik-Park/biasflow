// SPDX-FileCopyrightText: 2026 Munsik-Park
// SPDX-License-Identifier: Elastic-2.0
// test/spec/fixtures/flow-outcomes.mjs — the mock-outcome apparatus shared by the
// two runners (issue #4, feature design §1 / D8; verification design §3, E6.3).
//
// Extracted verbatim from test/spec/run.mjs (`oneShot`/`MAIN_LINE`/`mainLine` at
// :1529-1558, the 44-row `EDGES_EXPECTED` at :1564-1610). Under two runners the
// 44-row table — which exists precisely to be THE single derived-edge oracle —
// would otherwise exist in two copies, which is the drift the table is there to
// prevent. E6.3 asserts the resulting property repo-wide: exactly one
// `const EDGES_EXPECTED` binding exists across test/**, and both runners import it.
//
// Stdlib only, no imports at all: this module is pure data plus two closures over
// it, so it stays loadable by any runner without dragging in a spec model.


const oneShot = (step, outcome) => {
  let fired = false
  return (s) => (!fired && s === step ? ((fired = true), outcome) : null)
}

// The main-line outcome table: every step's "keep going" answer, so a scenario
// only has to override the step under test.
const MAIN_LINE = {
  preflight: 'ready',
  diagnose: 'code-change-needed-feat',
  architect: 'converged',
  gate_plan: 'pass',
  dispatch: 'assigned',
  red: 'red-confirmed',
  green: 'done',
  verify: 'pass',
  refine: 'green-reconfirmed',
  validate: 'done',
  audit: 'pass',
  gate_quality: 'pass',
  deliver: 'pushed',
  integrate: 'pass',
  gate_hypothesis: 'pass',
  handoff: null,
}
const mainLine = (overrides = {}) => (s, state) => {
  const o = Object.prototype.hasOwnProperty.call(overrides, s) ? overrides[s] : MAIN_LINE[s]
  return typeof o === 'function' ? o(s, state) : o
}

// AC2.0 — the 44 authored edge cases. The expected targets are authored from the
// declarations; R12 then asserts this authored/traversed set EQUALS the set the
// engine derives from spec/steps/*.yaml, so an added edge fails CI until a case
// exists and a case naming a removed edge fails too.
const EDGES_EXPECTED = [
  ['architect', 'converged', 'gate_plan'],
  ['architect', 'escalate', 'escalate'],
  ['audit', 'pass', 'gate_quality'],
  ['audit', 'fail', 'green'],
  ['audit', 'cap-exhausted', 'escalate'],
  ['deliver', 'pushed', 'integrate'],
  ['diagnose', 'code-change-needed-bug', 'gate_hypothesis'],
  ['diagnose', 'code-change-needed-feat', 'architect'],
  ['diagnose', 'already-satisfied', 'close'],
  ['diagnose', 'non-code-lever', 'escalate'],
  ['diagnose', 'intake-prerequisite-missing', 'escalate'],
  ['diagnose', 'loop-check-match', 'escalate'],
  ['dispatch', 'assigned', 'red'],
  ['gate_hypothesis', 'pass', 'architect'],
  ['gate_hypothesis', 'fail', 'diagnose'],
  ['gate_hypothesis', 'non-code-root-cause', 'escalate'],
  ['gate_hypothesis', 'cap-exhausted', 'escalate'],
  ['gate_plan', 'pass', 'dispatch'],
  ['gate_plan', 'fail', 'architect'],
  ['gate_plan', 'cap-exhausted', 'escalate'],
  ['gate_quality', 'pass', 'deliver'],
  ['gate_quality', 'fail', 'red'],
  ['gate_quality', 'cap-exhausted', 'escalate'],
  ['green', 'done', 'verify'],
  ['green', 'ac-contradiction', 'verify'],
  ['handoff', 'review-clean', 'end'],
  ['handoff', 'review-findings', 'diagnose'],
  ['handoff', 'ci-code-failure', 'red'],
  ['handoff', 'env-failure', 'handoff'],
  ['handoff', 'cap-exhausted', 'escalate'],
  ['integrate', 'pass', 'handoff'],
  ['integrate', 'fail', 'red'],
  ['preflight', 'ready', 'diagnose'],
  ['preflight', 'paused-prior-cycle', 'escalate'],
  ['preflight', 'dirty-unresolvable', 'escalate'],
  ['red', 'red-confirmed', 'green'],
  ['refine', 'green-reconfirmed', 'validate'],
  ['refine', 'cap-exhausted', 'validate'],
  ['validate', 'done', 'audit'],
  ['verify', 'pass', 'refine'],
  ['verify', 'test-issue', 'red'],
  ['verify', 'impl-issue', 'green'],
  ['verify', 'design-contradiction', 'architect'],
  ['verify', 'undecidable', 'escalate'],
]

export { oneShot, MAIN_LINE, mainLine, EDGES_EXPECTED }
