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
  if (!step) throw new Error(`no such step: ${stepId}`)

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
    const output = env.delegationOutput || {}
    outcome = computeVerdict(output.scores, env.thresholds || THRESHOLDS).pass ? 'pass' : 'fail'
  } else {
    // Same embedder-API guard as the gate branch above (env.delegationOutput
    // || {}): every shipped delegation is re-entered through the CLI/runFlow,
    // which always supplies an output, but this step kind is reachable the
    // same way M21 (the gate branch) turned out to be — a hand-crafted state
    // document, pending on a non-gate step, driven directly. Left in place
    // rather than deleted so that path degrades to `outcome: undefined`
    // (routed to StepIncompleteError/refusal) instead of crashing on a read
    // of `.outcome` off `undefined`.
    outcome = (env.delegationOutput || {}).outcome
  }

  return transitionOn(spec, state, env, stepId, outcome)
}
