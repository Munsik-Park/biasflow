// SPDX-FileCopyrightText: 2026 Munsik-Park
// SPDX-License-Identifier: Elastic-2.0
// engine/flow.mjs — the executor (issue #4, feature design §3/§5).
//
// One public entry, `advance()`. A cold start and a resume are the same call over
// the same state document, so there is no recovery code path to keep in sync.
//
// Everything routable is read from the loaded declaration through routing.mjs:
// there is no second transition table here, no default branch, and no fallthrough.
// A transition fires only on an outcome the step declares (resolve() throws
// otherwise); a bounded edge whose budget is spent is NOT re-traversed — the
// owning step supplies the exhaustion target instead.
import { PROSE_SOURCED, capKeyFor, capKeyForLoop, capValue, resolve, RESERVED } from './routing.mjs'
import { THRESHOLDS, computeVerdict } from './gate.mjs'
import { HANDLERS, StepIncompleteError } from './mechanical.mjs'
import { STATE_VERSION, saveState } from './run-state.mjs'

export { StepIncompleteError }

export class SlotUnsourcedError extends Error {
  constructor(step, role, slot) {
    super(`no source is declared for the "${slot}" slot of role "${role}" at step "${step}"`)
    this.name = 'SlotUnsourcedError'
    this.code = 'slot-unsourced'
    this.step = step
    this.role = role
    this.slot = slot
  }
}

export class MissingSlotError extends Error {
  constructor(step, role, slot, source) {
    super(`the "${slot}" slot of role "${role}" at step "${step}" reads "${source}", which the caller did not supply`)
    this.name = 'MissingSlotError'
    this.code = 'missing-slot'
    this.step = step
    this.role = role
    this.slot = slot
    this.source = source
  }
}

// The trust boundary the loader deliberately does not police: whether a well-typed
// step id is a member of THIS spec is the document's agreement with a spec, not a
// property of the document (the run-state contract's clause R3). The question is answered
// here, where the spec is in hand — and answered TYPED, so a resume that cannot
// resolve its step is identifiable by class and `code` instead of escaping as a bare
// Error. The message is unchanged.
export class StepResolutionError extends Error {
  constructor(stepId) {
    super(`no such step: ${stepId}`)
    this.name = 'StepResolutionError'
    this.code = 'no-such-step'
    this.step = stepId
  }
}

// ---- slot sourcing -------------------------------------------------------------
//
// One row per (step, role, slot) triple derived from the declaration. A slot's
// source is a design decision rather than a computation — `dev:issue` reads the
// step's own `requires` at architect but a run-level handle at green/refine/verify,
// because those steps do not declare it — so the rows are authored and the
// TOTALITY is the check: request construction refuses any declared slot with no row.
//
// Two of the kinds are declaration GAPS, made visible instead of absorbed (the
// PROSE_SOURCED idiom): `acceptance-criteria` is produced by no step, and handoff's
// review comments arrive from an effect record rather than from an artifact.
const REQUIRES = (artifact) => ({ kind: `requires:${artifact}` })
const REQUIRES_ALL = { kind: 'requires:*' }
const CRITERIA = { kind: 'criteria' }
const RUN = (handle) => ({ kind: `run:${handle}` })
const LOOP_CARRY = { kind: 'loop-carry' }
const GAP_AC = { kind: 'derived:issue#acceptance-criteria', gap: true }
const GAP_REVIEW = { kind: 'effect:handoff.reviewComments', gap: true }

export const SLOT_SOURCES = Object.freeze({
  'architect:dev:issue': REQUIRES('issue'),
  'architect:dev:accepted_from_previous_round': LOOP_CARRY,
  'architect:test:acceptance-criteria': GAP_AC,
  'architect:test:accepted_from_previous_round': LOOP_CARRY,
  'audit:evaluator:deliverable': REQUIRES_ALL,
  'audit:evaluator:criteria': CRITERIA,
  'diagnose:analyzer-structure:code': RUN('repo'),
  'diagnose:analyzer-issue:issue': REQUIRES('issue'),
  'gate_hypothesis:evaluator:deliverable': REQUIRES_ALL,
  'gate_hypothesis:evaluator:criteria': CRITERIA,
  'gate_plan:evaluator:deliverable': REQUIRES_ALL,
  'gate_plan:evaluator:criteria': CRITERIA,
  'gate_quality:evaluator:deliverable': REQUIRES_ALL,
  'gate_quality:evaluator:criteria': CRITERIA,
  'green:dev:issue': RUN('issue'),
  'green:dev:accepted_from_previous_round': LOOP_CARRY,
  'handoff:ingest:review-comments': GAP_REVIEW,
  'red:test:acceptance-criteria': GAP_AC,
  'red:test:accepted_from_previous_round': LOOP_CARRY,
  'refine:dev:issue': RUN('issue'),
  'refine:dev:accepted_from_previous_round': LOOP_CARRY,
  'verify:dev:issue': RUN('issue'),
  'verify:dev:accepted_from_previous_round': LOOP_CARRY,
  'verify:test:acceptance-criteria': GAP_AC,
  'verify:test:accepted_from_previous_round': LOOP_CARRY,
})

// By construction the gap-kinded subset, so the two constants cannot drift apart.
export const SLOT_GAPS = Object.freeze(
  Object.fromEntries(Object.entries(SLOT_SOURCES).filter(([, row]) => row.gap === true)),
)

const has = (map, key) => !!map && Object.prototype.hasOwnProperty.call(map, key)

function fromArtifacts(artifacts, key, step, role, slot) {
  if (!has(artifacts, key)) throw new MissingSlotError(step, role, slot, key)
  return artifacts[key]
}

function resolveSlot(step, role, slot, row, artifacts, supplied) {
  const { kind } = row
  if (kind === 'requires:*') {
    const bundle = {}
    for (const artifact of step.requires) bundle[artifact] = fromArtifacts(artifacts, artifact, step.id, role, slot)
    return bundle
  }
  if (kind.startsWith('requires:')) return fromArtifacts(artifacts, kind.slice('requires:'.length), step.id, role, slot)
  if (kind.startsWith('run:')) return fromArtifacts(artifacts, kind.slice('run:'.length), step.id, role, slot)
  if (kind.startsWith('derived:issue#')) {
    return fromArtifacts(artifacts, kind.slice('derived:issue#'.length), step.id, role, slot)
  }
  if (kind === 'criteria') {
    if (step.criteria === undefined) throw new MissingSlotError(step.id, role, slot, 'criteria')
    return step.criteria
  }
  if (kind === 'loop-carry') {
    // At a step declaring no loop the carry is a DECLARED empty, not an absent
    // source — refusing here would swallow a legitimately empty slot.
    if (!step.loop) return null
    return fromArtifacts(artifacts, slot, step.id, role, slot)
  }
  if (kind.startsWith('effect:')) {
    if (!has(supplied, slot)) throw new MissingSlotError(step.id, role, slot, kind.slice('effect:'.length))
    return supplied[slot]
  }
  throw new SlotUnsourcedError(step.id, role, slot)
}

// roles = agents ∪ loop.participants, always a list: the two deliberation steps
// carry their roles only under `participants`, so an agents-only read drops them.
const rolesOf = (step) => [...new Set([...(step.agents || []), ...((step.loop && step.loop.participants) || [])])]

function buildRequest(spec, stepId, env, supplied) {
  const step = spec.steps.get(stepId)
  const roles = rolesOf(step)
  const artifacts = env.artifacts || {}
  const bindingSteps = spec.binding.steps || {}
  const bindingRoles = spec.binding.roles || {}
  const perRole = {}
  for (const role of roles) {
    const declared = spec.roles.get(role)
    if (!declared) throw new SlotUnsourcedError(stepId, role, '<role>')
    const input = {}
    for (const slot of declared.input) {
      const row = SLOT_SOURCES[`${stepId}:${role}:${slot}`]
      if (!row) throw new SlotUnsourcedError(stepId, role, slot)
      input[slot] = resolveSlot(step, role, slot, row, artifacts, supplied)
    }
    const override = bindingSteps[stepId] || {}
    const roleDefault = bindingRoles[role] || {}
    const frame = { model: override[role] ?? roleDefault.model, input, output: declared.output }
    if (roleDefault.effort !== undefined) frame.effort = roleDefault.effort
    if (declared.session !== undefined) frame.session = declared.session
    perRole[role] = frame
  }
  const request = {
    step: stepId,
    roles,
    perRole,
    provider: spec.binding.runner,
    expectedOutcomes: [...step.next.keys()],
  }
  if (step.criteria !== undefined) request.criteria = step.criteria
  if (step.loop && step.loop.isolated !== undefined) request.isolated = step.loop.isolated
  // A loop's budget is counted per re-entry INSIDE the delegation, which the engine
  // structurally cannot observe, so it is carried across the boundary and enforced
  // by the adapter — the engine only observes the outcome that comes back.
  const loopCap = capKeyForLoop(stepId)
  if (loopCap) request.caps = { [loopCap]: capValue(spec, loopCap) }
  return request
}

// ---- cap exhaustion ------------------------------------------------------------

export function exhaustionTarget(spec, capKey) {
  const ownerId = capKey.split('.')[0]
  const owner = spec.steps.get(ownerId)
  if (!owner) throw new Error(`no exhaustion target is derivable for ${capKey}`)
  if (owner.next.has('cap-exhausted')) {
    return { outcome: 'cap-exhausted', target: owner.next.get('cap-exhausted'), source: 'declaration' }
  }
  const prose = PROSE_SOURCED.find((row) => row.where === ownerId && row.what === 'exhaustion-target')
  if (prose && owner.next.has(prose.value)) {
    return { outcome: prose.value, target: owner.next.get(prose.value), source: prose.source }
  }
  if (owner.next.has('escalate')) {
    return { outcome: 'escalate', target: owner.next.get('escalate'), source: 'declaration' }
  }
  throw new Error(`no exhaustion target is derivable for ${capKey}`)
}

// ---- the executor --------------------------------------------------------------

// `start` defaults to 'preflight' because every shipped caller supplies it
// explicitly (an embedder API default, not a path any test exercises).
export function initialState(spec, { issue, start = 'preflight' } = {}) {
  return {
    version: STATE_VERSION,
    issue,
    step: start,
    counters: {},
    history: [],
    pending: null,
    status: 'running',
    terminal: null,
    halt: null,
  }
}

// Every state change is written before it is returned. A skipped write is the
// failure mode this port exists to close, so it is never conditional on the event.
function write(env, state) {
  const port = env.persist || saveState
  if (typeof port !== 'function') throw new Error('persist port not wired')
  port(env.statePath, state)
  return state
}

function haltOn(state, env, err) {
  const halt = { reason: err.message, step: err.step, detail: err.detail }
  const next = write(env, { ...state, status: 'halted', pending: null, halt })
  return { state: next, event: { kind: 'halt', reason: halt.reason, step: halt.step, detail: halt.detail } }
}

function delegateOn(spec, state, env, stepId, supplied) {
  const request = buildRequest(spec, stepId, env, supplied)
  const next = write(env, {
    ...state,
    status: 'delegating',
    pending: { step: stepId, roles: request.roles, request },
  })
  return { state: next, event: { kind: 'delegate', request } }
}

function transitionOn(spec, state, env, stepId, outcome) {
  const capKey = capKeyFor(stepId, outcome)
  const counters = { ...state.counters }
  const spent = counters[capKey] || 0
  const entry = { from: stepId, outcome }
  if (capKey && spent >= capValue(spec, capKey)) {
    const ex = exhaustionTarget(spec, capKey)
    entry.to = ex.target
    entry.capKey = capKey
    entry.exhausted = true
    entry.resolvedOutcome = ex.outcome
  } else {
    if (capKey) counters[capKey] = spent + 1
    const { target } = resolve(spec, stepId, outcome)
    entry.to = target
    if (capKey) entry.capKey = capKey
  }
  // The persisted history row and the returned event describe the same
  // transition, so the event is derived from the entry instead of a second
  // hand-written literal the two could drift apart from.
  const event = { kind: 'transition', ...entry }
  const next = write(env, {
    ...state,
    counters,
    step: event.to,
    pending: null,
    status: 'running',
    history: [...state.history, entry],
  })
  return { state: next, event }
}

export function advance(spec, state, env = {}) {
  // Embedder-API affordance, not a path the shipped CLI/runFlow re-enter: both
  // break their drive loop on the first non-transition event, so this guard is
  // for an embedder that calls advance() again on an already-halted document —
  // without it, re-entry would fall through to the step lookup below and
  // re-execute (or misroute) a step the flow already stopped on.
  if (state.status === 'halted') {
    const event = state.halt
      ? { kind: 'halt', reason: state.halt.reason, step: state.halt.step, detail: state.halt.detail }
      : { kind: 'terminal', terminal: state.terminal }
    return { state, event }
  }
  if (RESERVED.has(state.step)) {
    return {
      state: { ...state, status: 'halted', terminal: state.step },
      event: { kind: 'terminal', terminal: state.step },
    }
  }

  const stepId = state.pending ? state.pending.step : state.step
  const step = spec.steps.get(stepId)
  if (!step) throw new StepResolutionError(stepId)

  let outcome
  if (step.kind === 'mechanical') {
    const handler = HANDLERS[stepId]
    if (!handler) throw new Error(`no handler for mechanical step: ${stepId}`)
    const ctx = { spec, step: stepId, state, artifacts: env.artifacts, delegated: state.pending ? env.delegationOutput : undefined }
    let result
    try {
      result = handler(ctx, env.effects)
    } catch (e) {
      if (e.code === 'step-incomplete') return haltOn(state, env, e)
      throw e
    }
    if (result.delegate) return delegateOn(spec, state, env, stepId, result.delegate.input)
    outcome = result.outcome
  } else if (!state.pending) {
    return delegateOn(spec, state, env, stepId, undefined)
  } else if (step.kind === 'gate') {
    // Invariant 3: the verdict is computed from the raw scores. Nothing the
    // evaluator self-reports about its own verdict is read.
    //
    // The absence rule (INPUT_BOUNDARY, below): an absent delegated result is
    // REFUSED here, typed, before any write — never coerced to an empty object.
    // computeVerdict's own answer for an absent score table is "evaluation not
    // run", which is not a verdict, and the coercion discarded that distinction
    // to persist a `fail` and spend a retry for an evaluation that never ran.
    // The required field is declaration-backed: `scores` is what the evaluator
    // role declares under must_contain, not a name invented in the engine.
    const scores = requiredDelegated(env.delegationOutput, stepId, step.kind, 'scores')
    outcome = computeVerdict(scores, env.thresholds || THRESHOLDS).pass ? 'pass' : 'fail'
  } else {
    // The sibling of the branch above, decided by the SAME rule and refusing
    // with the same class — step.kind selects WHICH field is required, never
    // whether one is. Before this, absence degraded to `outcome: undefined` and
    // crashed one module down in resolve() as a bare Error with no `code`:
    // inert against the document, but undeclared and untyped, which is the
    // defect rather than the defence.
    outcome = requiredDelegated(env.delegationOutput, stepId, step.kind, 'outcome')
  }

  return transitionOn(spec, state, env, stepId, outcome)
}

// ---- the runtime input boundary ------------------------------------------------
//
// Placement, and it is load-bearing rather than stylistic: this block ships at the
// FOOT of the module. The suite resolves a fixed table of `flow.mjs:<line>` anchors
// into this file, six of which are cited from the test file itself, and an insert
// above the executor would silently invalidate anchors no in-scope edit can repoint.
// A declaration below the last anchored line costs nothing and breaks nothing;
// `advance()` reaches both names at call time, long after module evaluation.

// The refusal a resume raises when the caller supplied no delegated result. Its
// message deliberately reuses MissingSlotError's tail — it is the same statement
// about a different input — and `field` tells a caller WHICH half of the delegated
// result was absent without parsing that message.
export class DelegationOutputMissingError extends Error {
  constructor(step, kind, field) {
    super(`the "${step}" step was resumed without a delegated "${field}", which the caller did not supply`)
    this.name = 'DelegationOutputMissingError'
    this.code = 'delegation-output-missing'
    this.step = step
    this.kind = kind
    this.field = field
  }
}

// The one mechanism both resume branches share. Absence is NULLISH — the key is
// missing, or the value is `null` or `undefined`. It is not truthiness: a supplied
// `0`, `false`, `''`, `[]` or `{}` is a PRESENT value, and whether it is a USEFUL
// one is the adapter's contract breach, answered by the layers that already own it
// (computeVerdict for a score table, resolve() for an outcome). Reading a field off
// a primitive yields `undefined` rather than throwing, so no `typeof` guard is
// needed for the check to be total.
function requiredDelegated(output, stepId, kind, field) {
  const value = output == null ? undefined : output[field]
  if (value == null) throw new DelegationOutputMissingError(stepId, kind, field)
  return value
}

// The engine's runtime input boundary — one row per caller-supplied value READ SITE,
// with the DISPOSITION the absence rule assigns it. A row is a DECLARATION, not a
// branch: the code refuses / defaults / branches on its own, and this table is what a
// test compares the code's actual `env.` reads against, so a coercion added later
// cannot ship without a row (and a row cannot be added without naming which
// disposition it takes). `input` is dotted where the read is of a FIELD of a caller
// value; the totality check compares on the segment before the first dot.
//
// THE RULE. At this boundary an absent caller-supplied value may be:
//   default  — replaced by a declared substitute named in the module;
//   branch   — tested for and routed on, as a distinct declared state;
//   opaque   — handed to a port the engine never interprets it for;
//   refuse   — stopped by a typed error, raised at the read site, BEFORE any write.
// It may never be COERCED into a value of the same shape as a present one.
//
// THE TEST A NEW ROW MUST PASS. Drive advance() twice on the same document, once with
// the input ABSENT and once with a legitimate CONTROL value, and project each
// persisted result onto the closed FOUR-ELEMENT consequential set: (i) a `history`
// append, (ii) a `counters` increment, (iii) a `step` change, (iv) loss of a `pending`
// record. consequential(doc) = {historyLen, counters, step, pendingStep}. The coercion
// is ADMISSIBLE iff the absent run falls in exactly ONE of three buckets, and this
// row's `reason` names WHICH. These are the only bucket names:
//   b-i    IMMATERIAL — the projection equals the CONTROL's; the value is not
//          load-bearing on that path.
//   b-ii   DECLARED INERTIA — the projection equals the INPUT document's, AND the run
//          stops in a DECLARED way: a declared event (`delegate`, a declared outcome),
//          OR a typed error (`code` set) belonging to the engine vocabulary, i.e. an
//          Error class an engine module exports. That typed-stop sub-case is what a
//          `refuse` row takes; it is a sub-case of b-ii, not a bucket of its own.
//          The conjunct is engine vocabulary, and DELIBERATELY not "names the missing
//          input": measured, EffectsNotWiredError names the STEP and MissingSlotError
//          names the SLOT, so a naming conjunct would refuse two rows the rule admits.
//          Whether a stop names its input is recorded per row as an observation.
//   b-iii  PORT-OWNED — available ONLY to a row whose disposition is `opaque` (the
//          engine hands the value to a port and dereferences it NOWHERE): the
//          projection of the ENGINE's own persisted document equals the INPUT
//          document's, and the run stops in a typed error raised INSIDE the port,
//          outside the engine vocabulary. Because that stop names nothing the engine
//          owns, such a row MUST state its measured PORT-LEVEL consequence in `reason`
//          and a case MUST pin it; without both conjuncts the bucket is unavailable
//          and the row refuses.
// ANYTHING ELSE is inadmissible and the site REFUSES. In particular a projection equal
// to the input's that stops in an UNTYPED throw is NOT admissible — that is precisely
// what `env.delegationOutput` at the delegated resume used to do — and the WHOLE
// projection is compared, never field-wise.
// Inertness alone is NOT enough, and a halt is NOT inert: haltOn() writes
// {status:'halted', pending: null} — element (iv).
export const INPUT_BOUNDARY = Object.freeze([
  { input: 'delegationOutput.scores', site: 'advance:gate-resume', disposition: 'refuse', reason: 'DelegationOutputMissingError - lands in NO bucket: measured, the absent run persists a fail transition, spends gate_plan.retry and moves the step, which equals NEITHER the control (pass, step dispatch) NOR the input document. Refused typed at the read site, before any write, so nothing is persisted and no cap is spent for an evaluation that never ran' },
  { input: 'delegationOutput.outcome', site: 'advance:delegated-resume', disposition: 'refuse', reason: 'DelegationOutputMissingError - the projection equals the INPUT document (0 writes, measured on every delegated non-gate step) and it STILL lands in no bucket: b-ii additionally requires a DECLARED stop - a declared event, or a typed error in the engine vocabulary - and the measured stop was a BARE Error with an undefined code, thrown in resolve() one module below the read. Inertness without a declared stop is the defect, not the defence' },
  { input: 'delegationOutput', site: 'advance:mechanical-re-entry', disposition: 'branch', reason: 'admissible on EVERY record class the handoff handler ordered checks distinguish (mechanical.mjs:98-106: envFailure, then ciGreen, then present(reviewComments), then rank(ctx.delegated.max_severity), then reviewBlockPresent) - the domain is that derivation, not a count, and it moves with the handler. reviewComments-ABSENT classes take b-i: the projection is byte-identical to the control, because ctx.delegated is dereferenced ONLY at mechanical.mjs:101-102, both inside a present(reviewComments) test. reviewComments-PRESENT classes take b-ii: a declared delegate event, history 0, counters unchanged, pending RETAINED, whatever the control does - and the controls do three different things (transition review-clean; HALT on a missing outcome with pending destroyed; and, on a Medium max_severity, transition review-findings to diagnose spending handoff.review-response). The absence never produces a consequence the control does not. NOT "never reaches a write": an envFailure record reaches transitionOn() and spends handoff.env-retry with the input absent. NOT opaque: unlike artifacts into ctx, this value IS dereferenced by a handler' },
  { input: 'artifacts', site: 'advance:buildRequest', disposition: 'refuse', reason: 'MissingSlotError per slot at first read via fromArtifacts(), so the coercion to an empty map is terminal - b-ii, typed-stop sub-case: measured, the projection equals the input document (0 writes) and the stop is typed in the engine vocabulary (code missing-slot). Observed and recorded rather than assumed: that message names the SLOT and its declared source, never the env key, which is why the applied conjunct is engine vocabulary and not naming' },
  { input: 'artifacts', site: 'advance:mechanical-ctx', disposition: 'opaque', reason: 'b-i - handed to ctx.artifacts and dereferenced by no handler, so the projection is identical to the control and absence produces no outcome' },
  { input: 'effects', site: 'mechanical:effectOf', disposition: 'refuse', reason: 'b-ii, typed-stop sub-case - EffectsNotWiredError (code effects-not-wired), raised inside effectOf before any write; measured, it names the STEP rather than the env key, which is the second row establishing that the applied conjunct is engine vocabulary. NOTE: a WIRED port that RETURNS no record is a different, measured, unfixed defect of the port contract (open item O6), not an absence at this read site' },
  { input: 'thresholds', site: 'advance:gate-resume', disposition: 'default', reason: 'b-i - THRESHOLDS, declared in engine/gate.mjs and identical for every caller, so absence is not under-specification. NOTE: a PRESENT empty table imposes no floor and passes every gate - a fabricated pass on the VALIDITY axis, recorded as open item O1 and out of scope for an absence rule' },
  { input: 'persist', site: 'write', disposition: 'default', reason: 'b-i - saveState, declared in the run-state module; measured, the projection is identical to a control that passes saveState explicitly. NOTE: a present non-function stops as a bare untyped Error, non-consequential, recorded and not fixed' },
  { input: 'statePath', site: 'write', disposition: 'opaque', reason: 'b-iii, port-owned - the ONLY b-iii row. Handed to the port unread (dereferenced nowhere in the engine), the engine own persisted document is unchanged from the input, and the stop is a typed error raised INSIDE the port (TypeError, ERR_INVALID_ARG_TYPE, from node:fs). It reaches b-iii and NOT b-ii because that stop lies outside the engine vocabulary, and NOT b-i because the control transitions where this throws. The MANDATORY b-iii declaration, measured: this row is NOT inert off the four elements - saveState writes a .tmp file before renaming, so an absent path deposits at ./undefined.tmp in the process CWD a COMPLETE state document whose four-element projection is BYTE-IDENTICAL to the control run persisted document, i.e. the transition completes at the wrong path, before renameSync fails. Pinned by E4.53 in a sandboxed CWD; open item O2 against the run-state port, out of AC-C4 scope' },
])
