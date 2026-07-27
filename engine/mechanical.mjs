// SPDX-FileCopyrightText: 2026 Munsik-Park
// SPDX-License-Identifier: Elastic-2.0
// engine/mechanical.mjs — the mechanical-step handlers (issue #4, feature design §6).
//
// Each handler is a pure decision function: it reads ONE effect record through the
// injected `effects` port and maps it onto exactly one outcome the step declares.
// No handler performs I/O, and no handler invents an outcome — an effect record that
// satisfies no declared completion condition raises StepIncompleteError, which the
// executor turns into a halt routed through the audited stop protocol.
//
// M1 ships no real side-effect layer: `NO_EFFECTS` refuses rather than silently
// succeeding, so an unwired runner fails loudly instead of reporting a fake outcome.

export class EffectsNotWiredError extends Error {
  constructor(step) {
    super(`no side-effect implementation is wired for the "${step}" step`)
    this.name = 'EffectsNotWiredError'
    this.code = 'effects-not-wired'
    this.step = step
  }
}

export class StepIncompleteError extends Error {
  constructor(step, detail) {
    super(`step "${step}" reached no declared outcome — ${detail}`)
    this.name = 'StepIncompleteError'
    this.code = 'step-incomplete'
    this.step = step
    this.detail = detail
  }
}

function effectOf(effects, step, ctx) {
  const fn = effects ? effects[step] : undefined
  if (typeof fn !== 'function') throw new EffectsNotWiredError(step)
  // `|| {}` guards a caller-supplied (embedder) effects function that returns
  // a falsy value — no shipped implementation does, but the handlers below
  // read properties straight off the result, so a broken embedder wiring
  // fails as an unmet done-when instead of crashing on `undefined.prop`.
  return fn(ctx) || {}
}

// Severity is an ordered vocabulary, so the "at least Medium" test is a comparison
// on rank rather than a membership list. An unclassified value ranks below every
// declared severity and therefore never routes as a finding.
const SEVERITY_RANK = { low: 1, medium: 2, high: 3, critical: 4 }
const rank = (s) => SEVERITY_RANK[String(s || '').toLowerCase()] || 0

// Its only caller passes `e.reviewComments`, which is always an array or `null`/
// `undefined` (the effect-record shape), so a non-array truthy input never occurs.
const present = (v) => Array.isArray(v) && v.length > 0

export const HANDLERS = Object.freeze({
  // done-when: prior cycles resolved, tree clean, remote synced, branch created
  preflight(ctx, effects) {
    const e = effectOf(effects, 'preflight', ctx)
    if (e.dirtyUnresolvable) return { outcome: 'dirty-unresolvable' }
    if (!e.priorCycleResolved) return { outcome: 'paused-prior-cycle' }
    if (e.treeClean && e.remoteSynced && e.branchCreated) return { outcome: 'ready' }
    throw new StepIncompleteError('preflight', 'preflight:done-when')
  },

  dispatch(ctx, effects) {
    const e = effectOf(effects, 'dispatch', ctx)
    if (e.assigned) return { outcome: 'assigned' }
    throw new StepIncompleteError('dispatch', 'dispatch:not-assigned')
  },

  // done-when: tests pass, scenarios itemized, docs updated, artifacts coherent
  validate(ctx, effects) {
    const e = effectOf(effects, 'validate', ctx)
    if (e.testsPass && e.scenariosItemized && e.docsUpdated && e.artifactsCoherent) return { outcome: 'done' }
    throw new StepIncompleteError('validate', 'validate:done-when')
  },

  deliver(ctx, effects) {
    const e = effectOf(effects, 'deliver', ctx)
    if (e.pushed) return { outcome: 'pushed' }
    throw new StepIncompleteError('deliver', 'deliver:not-pushed')
  },

  // done-when: the integration suite passes, OR the project registers no
  // integration layer — a defined no-op, not a discretionary skip.
  integrate(ctx, effects) {
    const e = effectOf(effects, 'integrate', ctx)
    if (e.registered === false) return { outcome: 'pass' }
    if (e.pass === true) return { outcome: 'pass' }
    if (e.pass === false) return { outcome: 'fail' }
    throw new StepIncompleteError('integrate', 'integrate:done-when')
  },

  // The one mechanical step that also declares agents: the review-finding
  // classification crosses a session boundary, so the handler RETURNS a delegation
  // and is re-entered with its result. Re-entry (not mid-function suspension) is
  // what keeps the ordered checks above the classification live on the second pass.
  handoff(ctx, effects) {
    const e = effectOf(effects, 'handoff', ctx)
    if (e.envFailure) return { outcome: 'env-failure' }
    if (!e.ciGreen) return { outcome: 'ci-code-failure' }
    if (present(e.reviewComments)) {
      if (!ctx.delegated) return { delegate: { role: 'ingest', input: { 'review-comments': e.reviewComments } } }
      if (rank(ctx.delegated.max_severity) >= rank('Medium')) return { outcome: 'review-findings' }
      // A retained review block under a sub-Medium classification has NO declared
      // outcome (engine/routing.mjs > PROSE_SOURCED). Re-looping the step silently
      // would breach the bounded-loop invariant, so this halts instead.
      if (e.reviewBlockPresent) throw new StepIncompleteError('handoff', 'handoff:missing-outcome')
    }
    return { outcome: 'review-clean' }
  },
})

// Derived from HANDLERS, so a handler added later cannot ship without its refusal.
export const NO_EFFECTS = Object.freeze(Object.fromEntries(
  Object.keys(HANDLERS).map((step) => [step, () => { throw new EffectsNotWiredError(step) }]),
))
