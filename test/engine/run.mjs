// SPDX-FileCopyrightText: 2026 Munsik-Park
// SPDX-License-Identifier: Elastic-2.0
// M1 flow-engine suite (issue #4) — mechanical execution + delegation (AC1),
// routing and caps (AC2), gate verdicts (AC3), persisted state / resume (AC4),
// the non-interactive escalate protocol (AC5), and this suite's own wiring (AC6).
//
// Run: node test/engine/run.mjs      (stdlib only; no package.json, no framework)
//
// Written from the acceptance criteria and the verification design
// (.autoflow/issue-4-verification-design.md §1), NOT from an implementation —
// engine/{flow,mechanical,run-state,escalate,cli}.mjs do not exist when this file
// is authored. Idiom: test/spec/run.mjs (which in turn follows
// test/workflows/run.mjs) — hand-rolled test(name, fn), `ok`/`FAIL` lines, a
// `failures` counter, and a process.exit(failures ? 1 : 0) tail, so a red case is
// a live CI signal rather than a log line (E6.2a).
//
// Missing-module posture: engine/** is loaded through loadEngine(), which yields a
// throwing proxy when the module is absent. Every case then fails individually
// (Red) instead of the suite aborting at import time with zero case lines.
//
// Oracle discipline (inherited from the M0.5 suite, verification design §0):
// expectations are DERIVED from spec/steps/*.yaml + spec/bindings/claude.yaml at
// run time, never authored as counts, and a table the engine owns is never its own
// oracle. The only authored literals below are design statements in the
// PROSE_SOURCED shape (STOP_PROTOCOL, EXIT_CODES, the two gap kinds).
import assert from 'node:assert/strict'
import { readFileSync, readdirSync, existsSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { oneShot, MAIN_LINE, mainLine, EDGES_EXPECTED } from '../spec/fixtures/flow-outcomes.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..', '..')
const started = Date.now()

let failures = 0
let cases = 0
async function test(name, fn) {
  cases++
  try {
    await fn()
    console.log(`  ok    ${name}`)
  } catch (e) {
    failures++
    console.log(`  FAIL  ${name}\n        ${e.message}`)
  }
}

// ---- engine module loading ----------------------------------------------------

function missingModule(rel, err) {
  return new Proxy({}, {
    get(_t, prop) {
      if (prop === 'then') return undefined // keep `await import()` from resolving into the trap
      throw new Error(`${rel} not loadable — accessed export "${String(prop)}" (${err.message})`)
    },
  })
}

async function loadEngine(rel) {
  try {
    return await import(new URL(`../../engine/${rel}`, import.meta.url))
  } catch (e) {
    return missingModule(`engine/${rel}`, e)
  }
}

const SL = await loadEngine('spec-load.mjs')     // settled (M0.5)
const RT = await loadEngine('routing.mjs')       // settled (M0.5) — reused unmodified
const GATE = await loadEngine('gate.mjs')        // settled (M0.5) — reused unmodified
const FLOW = await loadEngine('flow.mjs')        // M1 subject
const MECH = await loadEngine('mechanical.mjs')  // M1 subject
const RS = await loadEngine('run-state.mjs')     // M1 subject
const ESC = await loadEngine('escalate.mjs')     // M1 subject

// ---- shared helpers -----------------------------------------------------------

const mget = (m, k) => (m instanceof Map ? m.get(k) : m ? m[k] : undefined)
const mkeys = (m) => (m instanceof Map ? [...m.keys()] : m ? Object.keys(m) : [])
const mhas = (m, k) => (m instanceof Map ? m.has(k) : !!m && Object.prototype.hasOwnProperty.call(m, k))

let _spec = null
function spec() {
  if (!_spec) _spec = SL.loadSpec(root)
  return _spec
}

function stepOf(sp, id) {
  const s = mget(sp.steps, id)
  if (!s) throw new Error(`step "${id}" not present in the loaded spec`)
  return s
}

function cloneStep(st) {
  return {
    ...st,
    requires: [...(st.requires || [])],
    produces: [...(st.produces || [])],
    agents: [...(st.agents || [])],
    loop: st.loop ? { ...st.loop, participants: [...(st.loop.participants || [])] } : undefined,
    next: new Map(mkeys(st.next).map((k) => [k, mget(st.next, k)])),
  }
}

// Deep enough that a negative case can inject a violation without mutating the
// live spec model (the cloneSpec idiom, test/spec/run.mjs:96-105). `role.input` is
// copied per role here because the M1 negatives (E1.4c1) mutate exactly that array.
function cloneSpec(sp) {
  return {
    steps: new Map(mkeys(sp.steps).map((id) => [id, cloneStep(mget(sp.steps, id))])),
    roles: new Map(mkeys(sp.roles).map((id) => {
      const r = mget(sp.roles, id)
      return [id, { ...r, input: [...(r.input || [])], output: { ...r.output } }]
    })),
    binding: JSON.parse(JSON.stringify(sp.binding)),
    criteria: new Set(sp.criteria ? [...sp.criteria] : []),
  }
}

const readRepo = (rel) => readFileSync(join(root, rel), 'utf8')
const engineSources = () =>
  readdirSync(join(root, 'engine')).filter((f) => f.endsWith('.mjs')).map((f) => [f, readRepo(join('engine', f))])
const gitShow = (rev) => execFileSync('git', ['show', rev], { cwd: root, encoding: 'utf8' })

// ---- the cycle's diff base ------------------------------------------------------
//
// BASE is the commit this cycle started from — the branch's merge base with the
// default branch, NOT `HEAD`. "What this cycle changed" has to be measured from the
// starting point: measured against `HEAD` the subject set empties the moment the
// cycle commits, silently vacating both the reuse byte-compares (E2.3/E3.5) and the
// cap-literal scan (E2.4) exactly when the code they guard arrives.
//
// Which ref names the default branch depends on the checkout, and git's DWIM does
// NOT fall back from `main` to `origin/main` (its search order is refs/heads/,
// refs/tags/, refs/remotes/, refs/remotes/<name>/HEAD — `refs/remotes/origin/main`
// is not reachable as a bare `main`):
//   - a developer clone has a local `main`;
//   - an actions/checkout CI checkout has only `refs/remotes/origin/main`;
//   - a shallow checkout may have neither, and no merge base at all.
// So candidates are tried in order and the first that resolves wins. `origin/main`
// comes first because it is the ref that tracks the real default branch; a local
// `main` may sit behind it.
//
// If none resolves, resolution does NOT degrade to an empty subject set — that would
// convert the three cases above into vacuous passes, which is precisely what BASE
// exists to prevent. It records the failure and every case that needs a base fails
// loudly with an actionable message, while the rest of the suite still runs (the
// module must not abort at import with zero case lines).
const BASE_CANDIDATES = ['origin/main', 'main', 'refs/remotes/origin/HEAD']

const gitTry = (args) =>
  execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()

function resolveBase(candidates = BASE_CANDIDATES) {
  const tried = []
  for (const ref of candidates) {
    try {
      const sha = gitTry(['merge-base', 'HEAD', ref])
      if (sha) return { sha, ref, tried }
      tried.push(`${ref} (no merge base)`)
    } catch (e) {
      const why = String(e.stderr || e.message).split('\n')[0].trim()
      tried.push(`${ref} (${why || 'unresolved'})`)
    }
  }
  return { sha: null, ref: null, tried }
}

const CYCLE_BASE = resolveBase()

function requireBase(b = CYCLE_BASE) {
  if (b.sha) return b.sha
  throw new Error(
    `cannot resolve the cycle's diff base — tried ${b.tried.join('; ')}. `
    + 'A shallow or single-branch checkout has no merge base with the default branch: '
    + 'set fetch-depth: 0 on the workflow checkout step. Falling back to HEAD is not an '
    + 'option — it would empty the subject set and make E2.3/E2.4/E3.5 pass vacuously.',
  )
}

// The engine modules this cycle ADDS, derived rather than listed: the modules that
// already existed at BASE are separately asserted byte-identical to BASE (E2.3, E3.5),
// so a literal inside one of them is not this cycle's subject.
const _baseEngineFiles = new Map()
function baseEngineFiles(b = CYCLE_BASE) {
  const sha = requireBase(b)
  if (!_baseEngineFiles.has(sha)) {
    _baseEngineFiles.set(sha, new Set(
      gitTry(['ls-tree', '--name-only', sha, 'engine/']).split('\n')
        .filter((l) => l !== '').map((l) => l.replace(/^engine\//, '')),
    ))
  }
  return _baseEngineFiles.get(sha)
}
const newEngineSources = (b = CYCLE_BASE) => engineSources().filter(([f]) => !baseEngineFiles(b).has(f))

// Read a subject module with a failure message that names the missing subject
// rather than surfacing a raw ENOENT.
function engineSrc(name) {
  assert.ok(existsSync(join(root, 'engine', name)), `engine/${name} does not exist yet`)
  return readRepo(join('engine', name))
}

// ---- declaration-derived vocabularies -----------------------------------------
//
// Every set below comes from the loaded declaration, so a spec/** amendment moves
// the expectation with it. Nothing here reads an engine-owned table (D12).

const stepIds = (sp) => mkeys(sp.steps).sort()
const isMechanical = (sp, id) => stepOf(sp, id).kind === 'mechanical'
const mechanicalIds = (sp) => stepIds(sp).filter((id) => isMechanical(sp, id))
const delegatedIds = (sp) => stepIds(sp).filter((id) => !isMechanical(sp, id))
const rolesOf = (st) => [...new Set([...(st.agents || []), ...((st.loop && st.loop.participants) || [])])]

// (step, role) pairs that cross a session boundary: the delegated steps, plus any
// mechanical step that declares `agents:` (today only `handoff`, C9/DCR-1).
function rolePairs(sp) {
  const out = []
  for (const id of stepIds(sp)) for (const r of rolesOf(stepOf(sp, id))) out.push([id, r])
  return out
}

function slotTriples(sp) {
  const out = []
  for (const [id, r] of rolePairs(sp)) {
    for (const slot of mget(sp.roles, r).input) out.push(`${id}:${r}:${slot}`)
  }
  return out.sort()
}

// Cap keys the ENGINE counts: the CAP_EDGES keys only. CAP_LOOPS is enforced by the
// adapter (D3 / U-6), so its two keys are excluded here by derivation, not by a list.
const engineCapKeys = () => [...new Set(Object.values(RT.CAP_EDGES).map((r) => r.capKey))].sort()
const edgeRowsFor = (capKey) => Object.keys(RT.CAP_EDGES).filter((k) => RT.CAP_EDGES[k].capKey === capKey).sort()

// Exhaustion target derived from the DECLARATION (+ the recorded prose rows), never
// from engine/flow.mjs's own exhaustionTarget() — that function is a subject here.
// `via` names WHICH of the three resolution rules answered, so the case below can
// assert that all three are still exercised by some cap key. Without it, a rule whose
// sole witness disappears stops being tested silently — which is exactly how the
// declared-`escalate` rule (witnessed only by `architect.loop`) went unasserted.
function expectedExhaustion(sp, capKey) {
  const owner = capKey.split('.')[0]
  const nx = stepOf(sp, owner).next
  if (mhas(nx, 'cap-exhausted')) {
    return { outcome: 'cap-exhausted', target: mget(nx, 'cap-exhausted'), source: 'declaration', via: 'declared:cap-exhausted' }
  }
  const prose = RT.PROSE_SOURCED.find((r) => r.where === owner && r.what === 'exhaustion-target')
  if (prose && mhas(nx, prose.value)) {
    return { outcome: prose.value, target: mget(nx, prose.value), source: prose.source, via: 'prose' }
  }
  if (mhas(nx, 'escalate')) {
    return { outcome: 'escalate', target: mget(nx, 'escalate'), source: 'declaration', via: 'declared:escalate' }
  }
  throw new Error(`no exhaustion target is derivable for ${capKey}`)
}

// Every cap key the declaration binds — the 7 CAP_EDGES keys the engine counts plus
// the 2 CAP_LOOPS keys the adapter enforces. Derived from the routing tables and
// cross-checked against spec/bindings/claude.yaml, so neither family can be dropped.
const allCapKeys = () => [...new Set([
  ...Object.values(RT.CAP_EDGES).map((r) => r.capKey),
  ...Object.values(RT.CAP_LOOPS).map((r) => r.capKey),
])].sort()

// ---- driving the engine -------------------------------------------------------

const FAILING_SCORES = { a: 6, b: 9, c: 9 }   // one item < 7 → computeVerdict fail
const PASSING_SCORES = { a: 9, b: 9, c: 9 }

// Effect records per mechanical step (feature design §2.3 / §6). Each maps the
// WANTED declared outcome back onto the record that produces it, so a scenario
// names outcomes and never hand-builds a record.
const EFFECT_FOR = {
  preflight: (o) => ({
    priorCycleResolved: o !== 'paused-prior-cycle',
    treeClean: o !== 'dirty-unresolvable',
    dirtyUnresolvable: o === 'dirty-unresolvable',
    remoteSynced: true,
    branchCreated: true,
  }),
  dispatch: (o) => ({ assigned: o === 'assigned' }),
  validate: (o) => ({ testsPass: o === 'done', scenariosItemized: o === 'done', docsUpdated: o === 'done', artifactsCoherent: o === 'done' }),
  deliver: (o) => ({ pushed: o === 'pushed' }),
  integrate: (o) => ({ registered: true, pass: o === 'pass' }),
  handoff: (o) => ({
    envFailure: o === 'env-failure',
    ciGreen: o !== 'ci-code-failure',
    prOpen: true,
    reviewComments: o === 'review-findings' ? ['reviewer comment'] : null,
    reviewBlockPresent: o === 'review-findings',
  }),
}

// The caller-supplied artifacts map, derived: every artifact any step declares in
// `requires`, plus the two run-level handles and the two declaration gaps. `counters`
// and `history` are deliberate EXTRA keys — invariant 4's subset assertion (E1.4a)
// is only meaningful when the map carries keys no role declares.
function artifactsMap(sp) {
  const m = { issue: '#4 issue body', repo: root, counters: 'MUST NOT LEAK', history: 'MUST NOT LEAK' }
  for (const id of stepIds(sp)) for (const a of stepOf(sp, id).requires) m[a] = `<${a}>`
  m['acceptance-criteria'] = '<acceptance-criteria>'          // gap A
  m['accepted_from_previous_round'] = '<accepted round n-1>'  // loop-carry
  m['review-comments'] = ['reviewer comment']                 // gap B
  return m
}

function delegationOutputFor(sp, stepId, wanted, opts = {}) {
  // Trap D (cycle 3, measured at RED). A pending step id the spec does not carry —
  // `undefined` from the reviewer's `pending: {}` witness — makes stepOf() throw HERE,
  // before advance() has been called, so the harness reports its own lookup failure as
  // the document's consequence. Handing the delegation through unresolved lets the
  // ENGINE raise its own error at its own trust boundary, which is the thing under
  // test. No existing caller reaches this branch: every other case names a real step.
  if (!mhas(sp.steps, stepId)) return { outcome: wanted }
  if (stepId === 'handoff') {
    return { max_severity: opts.maxSeverity || 'Medium', findings: [], low_confidence_items: [] }
  }
  if (stepOf(sp, stepId).kind === 'gate') {
    const scores = opts.scores || (wanted === 'pass' ? PASSING_SCORES : FAILING_SCORES)
    // `spec/roles/evaluator.yaml` declares must_contain: [scores] — a MINIMUM, not an
    // exclusive list — so a real evaluator plausibly emits a verdict alongside its
    // scores. The double therefore always self-reports the OPPOSITE of what the scores
    // compute (invariant 3, spec/roles/evaluator.yaml:9-11: "the verdict is not this
    // role's to declare"). Every gate-driving case below is consequently a live
    // invariant-3 discriminator: an engine that reads `pass` or `verdict` routes every
    // one of them backwards.
    const computed = GATE.computeVerdict(scores)
    return { scores, pass: !computed.pass, verdict: computed.pass ? 'FAIL' : 'PASS' }
  }
  return { outcome: wanted }
}

// Every (step, outcome) pair the engine actually traverses, for the E2.2 coverage
// equality. Populated by runFlow(), so any case that drives a hop contributes.
const TRAVERSED = new Set()

// The generic driver. `outcomes(step, ctx)` names the DECLARED outcome wanted at
// `step`; null means "stop here" (the modelled no-transition). Mechanical steps get
// it through an effect record, gate steps through raw scores fed to the real
// computeVerdict, other delegated steps through the delegation's own `outcome`.
function runFlow(sp, opts = {}) {
  const {
    start = 'preflight', outcomes, maxSteps = 60, artifacts, persist, statePath = SCRATCH_STATE,
    seedCounters, state: initialState, thresholds, maxSeverity, effects: effectsOverride, effectSeq, maxHops,
  } = opts
  let state = initialState || FLOW.initialState(sp, { issue: '#4', start })
  if (seedCounters) state = { ...state, counters: { ...state.counters, ...seedCounters } }
  const arts = artifacts === undefined ? artifactsMap(sp) : artifacts
  const trace = []
  const requests = []
  const events = []
  let visitWanted = null
  let event = null
  let iterations = 0
  for (; iterations < maxSteps; iterations++) {
    if (state.status === 'halted') break
    const reserved = RT.RESERVED.has(state.step)
    const active = state.pending ? state.pending.step : state.step
    let wanted
    if (!reserved) {
      // The oracle is consulted exactly ONCE per visit to a step. A delegated step
      // takes two advance() calls (emit the request, then consume its output — E1.2),
      // and a mechanical step re-enters its own handler after raising a delegation
      // (E1.6). Consulting on every iteration would drain a stateful queue oracle at
      // two entries per traversal, and would let a one-shot oracle silently change the
      // check-then-act effect record between a handler's two runs.
      if (visitWanted !== null) {
        wanted = visitWanted
      } else {
        wanted = outcomes ? outcomes(active, { trace, counters: state.counters, state }) : null
        if (wanted == null) break
        visitWanted = wanted
      }
    }
    const effects = effectsOverride || {}
    if (!effectsOverride) {
      for (const id of mechanicalIds(sp)) {
        effects[id] = () => (effectSeq && effectSeq[id] && effectSeq[id].length
          ? effectSeq[id].shift()
          : EFFECT_FOR[id](wanted))
      }
    }
    const env = {
      effects, artifacts: arts, persist, statePath, thresholds,
      delegationOutput: state.pending
        ? delegationOutputFor(sp, state.pending.step, wanted, { maxSeverity, scores: opts.scores })
        : undefined,
    }
    const r = FLOW.advance(sp, state, env)
    state = r.state
    event = r.event
    events.push(event)
    if (event.kind === 'delegate') requests.push(event.request)
    // The visit ends on anything but a delegation; a delegate event leaves the same
    // step pending, so its chosen outcome is carried into the consuming call.
    if (event.kind !== 'delegate') visitWanted = null
    if (event.kind === 'transition') {
      trace.push(event)
      TRAVERSED.add(`${event.from}:${event.resolvedOutcome || event.outcome}`)
    }
    if (event.kind === 'terminal' || event.kind === 'halt') break
    if (maxHops && trace.length >= maxHops) break
  }
  return { state, trace, requests, events, event, iterations }
}

// How a declared edge is reached through the engine. A `cap-exhausted` outcome is
// never fed directly when the engine owns its counter — it is produced by driving
// the bounded edge one traversal past its cap, which is the only way the engine can
// emit it. Which caps the engine owns is derived from CAP_EDGES, not listed.
function edgePlan(sp, step, outcome) {
  if (outcome !== 'cap-exhausted') return { seed: undefined, feed: outcome }
  const rows = Object.keys(RT.CAP_EDGES).filter((k) => k.split(':')[0] === step).sort()
  if (rows.length === 0) return { seed: undefined, feed: outcome } // CAP_LOOPS-owned → agent-reported (E2.5b)
  const capKey = RT.CAP_EDGES[rows[0]].capKey
  return { seed: { [capKey]: RT.capValue(sp, capKey) }, feed: rows[0].split(':')[1] }
}

// The effect fields each mechanical handler's declared `done-when` CONJOINS
// (feature design §2.3 / §6). `done-when` is stored as an opaque folded string and
// nothing parses it (engine/spec-load.mjs, C10), so the field names are a design
// statement rather than a spec derivation — the PROSE_SOURCED shape. What is derived
// is that every listed conjunct is independently load-bearing: no count is authored,
// the cases iterate the table.
const DONE_WHEN = {
  preflight: { outcome: 'ready', conjuncts: ['treeClean', 'remoteSynced', 'branchCreated'] },
  dispatch: { outcome: 'assigned', conjuncts: ['assigned'] },
  validate: { outcome: 'done', conjuncts: ['testsPass', 'scenariosItemized', 'docsUpdated', 'artifactsCoherent'] },
  deliver: { outcome: 'pushed', conjuncts: ['pushed'] },
}

// One advance() over one mechanical step with a caller-supplied effect record, so a
// case can present a PARTIALLY satisfied done-when. The EFFECT_FOR oracle derives
// every field from a single wanted outcome, which moves the fields together and can
// therefore never witness one conjunct at a time.
function advanceMechanical(sp, stepId, record, extra = {}) {
  return FLOW.advance(sp, FLOW.initialState(sp, { issue: '#4', start: stepId }), {
    effects: { [stepId]: () => record },
    artifacts: artifactsMap(sp),
    persist: () => {},
    statePath: SCRATCH_STATE,
    ...extra,
  })
}

// A gate step's outcome domain under advance() is exactly {pass, fail} — invariant 3
// makes computeVerdict() the ONLY source of a gate outcome (E3.2), and it is a
// two-valued function — plus `cap-exhausted`, which the engine produces itself on
// exhaustion. A gate step that ALSO declares a non-verdict outcome therefore cannot
// emit it while it carries `kind: gate`. That set is derived and asserted below
// (E2.1b) so a second such edge fails loudly instead of being absorbed here.
const GATE_VERDICT_OUTCOMES = ['pass', 'fail', 'cap-exhausted']
function gateUnreachableRows(sp) {
  const out = []
  for (const id of stepIds(sp)) {
    if (stepOf(sp, id).kind !== 'gate') continue
    for (const o of mkeys(stepOf(sp, id).next)) {
      if (!GATE_VERDICT_OUTCOMES.includes(o)) out.push(`${id}:${o}`)
    }
  }
  return out.sort()
}

// The routing property under test for such a row is unchanged — the edge is still
// driven through advance() and must land on its declared target. Only the marker that
// forces the verdict branch is lifted on a CLONE, so the executor takes its ordinary
// delegated-step path and the declaration itself is untouched.
function specForEdge(sp, step, outcome) {
  if (!gateUnreachableRows(sp).includes(`${step}:${outcome}`)) return sp
  const c = cloneSpec(sp)
  delete stepOf(c, step).kind
  return c
}

// A single delegation request for `stepId`, with an effects port that must never be
// touched (a delegated step runs no handler — E1.2).
const THROWING_EFFECTS = new Proxy({}, {
  get(_t, p) { throw new Error(`effects.${String(p)}() was called while executing a delegated step`) },
})

function requestFor(sp, stepId, { artifacts } = {}) {
  const r = FLOW.advance(sp, FLOW.initialState(sp, { issue: '#4', start: stepId }), {
    effects: THROWING_EFFECTS,
    artifacts: artifacts === undefined ? artifactsMap(sp) : artifacts,
    persist: () => {},
    statePath: SCRATCH_STATE,
  })
  return r
}

const tmpRoots = []
function tmpRoot() {
  const d = mkdtempSync(join(tmpdir(), 'autoflow-engine-'))
  tmpRoots.push(d)
  return d
}

// The scratch state path every case gets when it does not name one of its own.
// `persist` has a documented default (`saveState`, feature design §2.4), so a case
// that supplies no spy still writes a real file — this keeps that write inside a
// suite-owned temp root rather than wherever the process happens to be running
// (E4.6's property: no write escapes the temp dir during tests).
const SCRATCH_STATE = join(tmpRoot(), 'scratch-state.json')

// ================================================================================
// GROUP 0 — the new suite's own wiring (AC6). Authored first: every later group
// would pass vacuously in a CI run that never invoked this runner (E6.4, E6.2a).
// ================================================================================

const WF = '.github/workflows/spec-simulator.yml'
const wfText = () => readRepo(WF)

await test('E6.4(a)/AC6: the spec-simulator workflow invokes test/engine/run.mjs with bare node', () => {
  const t = wfText()
  assert.match(t, /run:\s*node test\/engine\/run\.mjs/,
    'without a run: step the second suite never executes and every case below is vacuous in CI')
  assert.ok(!/npm (ci|install)/.test(t), 'the repo is stdlib-only — no install step')
})

await test('E6.4(b)/AC6: test/engine/** is in BOTH the pull_request: and push: path filters', () => {
  const t = wfText()
  const pr = t.slice(t.indexOf('pull_request:'), t.indexOf('push:') > 0 ? t.indexOf('push:') : undefined)
  const push = t.slice(t.indexOf('push:'), t.indexOf('permissions:') > 0 ? t.indexOf('permissions:') : undefined)
  assert.ok(pr.includes('test/engine/**'), 'pull_request filter omits test/engine/** — the suite would be dead on its own changes')
  assert.ok(push.includes('test/engine/**'), 'push filter omits test/engine/**')
})

await test('E6.2(a)/AC6: this runner ends in process.exit(failures ? 1 : 0) and counts a throw as a failure', () => {
  const src = readRepo('test/engine/run.mjs')
  assert.match(src, /process\.exit\(failures \? 1 : 0\)/,
    'a runner whose tail always exits 0 passes vacuously in CI')
  assert.match(src, /catch \([\s\S]{0,80}failures\+\+/,
    'a thrown case must increment `failures`, not be swallowed')
})

await test('E6.3/AC6: exactly one `const EDGES_EXPECTED` binding exists repo-wide and both runners import it', () => {
  const hits = []
  // Composed rather than written as a contiguous literal, so this case's own source
  // is not counted as a second binding.
  const binding = new RegExp('^\\s*const ' + 'EDGES_EXPECTED\\s*=', 'm')
  const walk = (rel) => {
    for (const e of readdirSync(join(root, rel), { withFileTypes: true })) {
      const child = `${rel}/${e.name}`
      if (e.isDirectory()) walk(child)
      else if (e.name.endsWith('.mjs') && binding.test(readRepo(child))) hits.push(child)
    }
  }
  walk('test')
  assert.deepEqual(hits, ['test/spec/fixtures/flow-outcomes.mjs'],
    'the 44-row table exists to be THE single derived-edge oracle — a second copy is the drift it prevents')
  for (const runner of ['test/spec/run.mjs', 'test/engine/run.mjs']) {
    assert.match(readRepo(runner), /from '\.{1,2}\/(spec\/)?fixtures\/flow-outcomes\.mjs'/,
      `${runner} must import the extracted table rather than re-declare it`)
  }
  assert.equal(EDGES_EXPECTED.length, RT.edges(spec()).length,
    'the fixture row count is derived from spec/steps/*.yaml, never authored')
})

await test('E6.6/AC6: docs/maintained-docs.md registers the new suite and no longer carries the stale module enumeration', () => {
  const md = readRepo('docs/maintained-docs.md')
  assert.ok(md.includes('test/engine/run.mjs'),
    'the :90 Workflow Regression row is the precedent — a gated suite file is named in its registry row')
  assert.ok(md.includes('test/engine/**'), 'the Spec Simulator row scope line must gain test/engine/**')
  if (engineSources().length !== 5) {
    assert.ok(!md.includes('the five `engine/*.mjs` modules'),
      `the enumeration says five while engine/ holds ${engineSources().length} modules`)
  }
})

// ================================================================================
// GROUP 1 — gate verdicts (AC3) and edge traversal (AC2.1-2.3)
// ================================================================================

const GATE_STEPS = () => stepIds(spec()).filter((id) => stepOf(spec(), id).kind === 'gate')

for (const gate of GATE_STEPS()) {
  await test(`E3.1/AC3: ${gate} — computeVerdict over the evaluator's raw scores decides pass vs fail`, () => {
    const sp = spec()
    const nx = stepOf(sp, gate).next
    for (const [wanted, scores] of [['pass', PASSING_SCORES], ['fail', FAILING_SCORES]]) {
      const r = runFlow(sp, { start: gate, outcomes: oneShot(gate, wanted), scores })
      assert.equal(r.trace.length, 1, `expected one hop, got ${JSON.stringify(r.trace)}`)
      assert.equal(r.trace[0].outcome, wanted)
      assert.equal(r.trace[0].to, mget(nx, wanted))
    }
  })
}

await test('E3.1/AC3: score sets straddling each threshold route on the calculator, not on their shape', () => {
  const sp = spec()
  const nx = stepOf(sp, 'gate_plan').next
  const cases = [
    [{ a: 7, b: 7, c: 9 }, 'fail'],   // avg 7.67 ≥ 7.5 but… (7+7+9)/3 = 7.7 → pass; see below
    [{ a: 7, b: 7, c: 7 }, 'fail'],   // every item ≥ 7 but avg 7.0 < 7.5
    [{ a: 6, b: 10, c: 10 }, 'fail'], // avg 8.7 but one item < 7
    [{ security: 3, b: 10, c: 10 }, 'fail'], // security ≤ 3 → automatic rework
    [{ a: 8, b: 8, c: 8 }, 'pass'],
  ]
  for (const [scores, want] of cases) {
    const expected = GATE.computeVerdict(scores).pass ? 'pass' : 'fail'
    const r = runFlow(sp, { start: 'gate_plan', outcomes: oneShot('gate_plan', expected), scores })
    assert.equal(r.trace[0].to, mget(nx, expected), `scores ${JSON.stringify(scores)} (declared intent ${want})`)
  }
})

await test('E3.2/AC3: invariant 3 — the engine never reads the evaluator\'s self-reported pass claim', () => {
  const sp = spec()
  const nx = stepOf(sp, 'gate_plan').next
  // Precondition, asserted rather than assumed: the double really does self-report a
  // verdict, and really does contradict its own scores. Without this the case silently
  // degrades into a duplicate of E3.1 — which is exactly what it had done.
  const failing = delegationOutputFor(sp, 'gate_plan', 'x', { scores: FAILING_SCORES })
  assert.equal(failing.pass, true, 'the double must self-report a PASS while its scores fail')
  assert.equal(failing.verdict, 'PASS')
  const passing = delegationOutputFor(sp, 'gate_plan', 'x', { scores: PASSING_SCORES })
  assert.equal(passing.pass, false, 'the double must self-report a FAIL while its scores pass')
  assert.equal(passing.verdict, 'FAIL')

  const a = runFlow(sp, { start: 'gate_plan', outcomes: oneShot('gate_plan', 'x'), scores: FAILING_SCORES })
  assert.equal(a.trace[0].outcome, 'fail')
  assert.equal(a.trace[0].to, mget(nx, 'fail'), 'a self-reported {pass:true} must not route to the pass target')

  const b = runFlow(sp, {
    start: 'gate_plan', outcomes: oneShot('gate_plan', 'x'),
    scores: PASSING_SCORES,
  })
  assert.equal(b.trace[0].outcome, 'pass')
  assert.equal(b.trace[0].to, mget(nx, 'pass'), 'a self-reported {pass:false} must not route to the fail target')
})

await test('E3.2/AC3: the self-reported fields are ignored even when they contradict the scores', () => {
  const sp = spec()
  const nx = stepOf(sp, 'gate_plan').next
  const drive = (output, wantOutcome) => {
    let state = FLOW.initialState(sp, { issue: '#4', start: 'gate_plan' })
    const base = { effects: {}, artifacts: artifactsMap(sp), persist: () => {}, statePath: SCRATCH_STATE }
    let r = FLOW.advance(sp, state, base)
    assert.equal(r.event.kind, 'delegate')
    r = FLOW.advance(sp, r.state, { ...base, delegationOutput: output })
    assert.equal(r.event.outcome, wantOutcome)
    assert.equal(r.event.to, mget(nx, wantOutcome))
  }
  drive({ pass: true, verdict: 'PASS', scores: { a: 6, b: 9, c: 9 } }, 'fail')
  drive({ pass: false, verdict: 'FAIL', scores: { a: 9, b: 9, c: 9 } }, 'pass')
})

await test('E3.3/AC3: empty scores fail closed; a non-numeric score propagates as a halt, never a silent pass', () => {
  const sp = spec()
  const nx = stepOf(sp, 'gate_plan').next
  const base = { effects: {}, artifacts: artifactsMap(sp), persist: () => {}, statePath: SCRATCH_STATE }
  const pending = FLOW.advance(sp, FLOW.initialState(sp, { issue: '#4', start: 'gate_plan' }), base)
  const empty = FLOW.advance(sp, pending.state, { ...base, delegationOutput: { scores: {} } })
  assert.equal(empty.event.outcome, 'fail', 'an unrun evaluation must not be readable as a pass')
  assert.equal(empty.event.to, mget(nx, 'fail'))
  assert.throws(
    () => FLOW.advance(sp, pending.state, { ...base, delegationOutput: { scores: { a: 'nine' } } }),
    (e) => e.code === 'scores-not-evaluable',
    'ScoresNotEvaluableError is a fail-closed hard block — swallowing it converts it into a routing decision',
  )
})

await test('E3.4/AC3: gate thresholds are injected, not hard-coded in the engine', () => {
  const sp = spec()
  const nx = stepOf(sp, 'gate_plan').next
  // FAILING_SCORES fails only because one item is < itemMin. Lower itemMin and the
  // SAME scores must route pass — impossible if the engine holds its own constant.
  const r = runFlow(sp, {
    start: 'gate_plan', outcomes: oneShot('gate_plan', 'x'), scores: FAILING_SCORES,
    thresholds: { ...GATE.THRESHOLDS, itemMin: 5, avgMin: 5 },
  })
  assert.equal(r.trace[0].to, mget(nx, 'pass'))
  for (const [name, src] of engineSources()) {
    if (name === 'gate.mjs') continue
    assert.ok(!/(itemMin|avgMin|securityMax)\s*[:=]\s*\d/.test(src),
      `engine/${name} hard-codes a gate threshold instead of passing GATE.THRESHOLDS through`)
  }
})

await test('E3.5/AC3: engine/gate.mjs is reused unmodified — byte-identical to the cycle base', () => {
  assert.equal(readRepo('engine/gate.mjs'), gitShow(`${requireBase()}:engine/gate.mjs`),
    'AC3 says reuse; any edit here means the calculator was reimplemented rather than reused')
})

for (const [step, outcome, target] of EDGES_EXPECTED) {
  await test(`E2.1/AC2: declared edge ${step}:${outcome} → ${target} is traversable through advance()`, () => {
    const sp = specForEdge(spec(), step, outcome)
    const plan = edgePlan(sp, step, outcome)
    const r = runFlow(sp, {
      start: step, outcomes: oneShot(step, plan.feed), seedCounters: plan.seed,
      maxSeverity: outcome === 'review-findings' ? 'Medium' : 'Low',
    })
    assert.equal(r.trace.length, 1, `expected exactly one hop, got ${JSON.stringify(r.trace)}`)
    const h = r.trace[0]
    assert.deepEqual(
      { from: h.from, outcome: h.resolvedOutcome || h.outcome, to: h.to },
      { from: step, outcome, to: target },
    )
  })
}

await test('E2.1b/AC2: the gate outcomes the verdict domain cannot produce are a RECORDED, derived set', () => {
  assert.deepEqual(gateUnreachableRows(spec()), ['gate_hypothesis:non-code-root-cause'],
    'a declared gate outcome that is not a verdict cannot be emitted while invariant 3 holds; '
    + 'the set is recorded in the PROSE_SOURCED shape so a SECOND one fails loudly rather than '
    + 'being quietly routed around by the harness')
  // The gap is in the gate branch, not in the routing table: the edge itself resolves.
  assert.equal(RT.resolve(spec(), 'gate_hypothesis', 'non-code-root-cause').target, 'escalate')
})

await test('E2.2/AC2: the (step, outcome) set traversed through the engine EQUALS the set derived from spec/steps/*.yaml', () => {
  const derived = RT.edges(spec()).map((e) => `${e.step}:${e.outcome}`).sort()
  assert.equal(derived.length, EDGES_EXPECTED.length, 'target derived at run time, never hard-coded')
  assert.deepEqual([...TRAVERSED].sort(), derived,
    'a newly declared edge fails until an engine case exists; a case naming a removed edge fails too')
})

await test('E2.3/AC2: transitions are computed by reading the spec through resolve(), not from a second table', () => {
  const sp = cloneSpec(spec())
  stepOf(sp, 'red').next.set('red-confirmed', 'validate')  // mutate the declaration only
  const r = runFlow(sp, { start: 'red', outcomes: oneShot('red', 'red-confirmed') })
  assert.equal(r.trace[0].to, 'validate',
    'the hop followed a target the engine cannot know except by reading the spec')
})

await test('E2.3b/AC2: the cycle diff base resolves to a real commit that is a STRICT ancestor of HEAD', () => {
  const sha = requireBase()
  assert.match(sha, /^[0-9a-f]{7,40}$/, 'the base must be a commit id, not a ref name that a later command re-resolves')
  assert.equal(gitTry(['cat-file', '-t', sha]), 'commit', 'the resolved base must be a real commit object')
  assert.doesNotThrow(() => gitTry(['merge-base', '--is-ancestor', sha, 'HEAD']),
    'a base that is not an ancestor of HEAD cannot describe what this cycle changed')
  assert.notEqual(sha, gitTry(['rev-parse', 'HEAD']),
    'the base must not be HEAD itself — that is exactly the vacating this constant exists to prevent')
  assert.ok(newEngineSources().length > 0,
    'the base yields an empty subject set, so the cap-literal scan and both reuse byte-compares are vacuous')
  assert.ok(BASE_CANDIDATES.includes(CYCLE_BASE.ref))
})

await test('E2.3b/AC2: an unresolvable base RAISES with an actionable message — it never degrades to an empty subject set', () => {
  // The CI-shallow shape: no candidate resolves. Reproduced by resolving against a
  // ref that cannot exist, so the case does not depend on the checkout it runs in.
  const none = resolveBase(['refs/heads/no-such-ref-for-this-case'])
  assert.equal(none.sha, null)
  assert.equal(none.tried.length, 1, 'every attempted candidate must be recorded for the operator')
  assert.match(none.tried[0], /no-such-ref-for-this-case/, 'the message must name what it tried')

  assert.throws(() => requireBase(none), /cannot resolve the cycle's diff base/)
  assert.throws(() => requireBase(none), /fetch-depth: 0/, 'the message must name the fix, not just the symptom')

  // The load-bearing half: the subject-set path must propagate the failure rather
  // than returning [], which would turn E2.4's scan into a vacuous pass.
  assert.throws(() => baseEngineFiles(none), /cannot resolve the cycle's diff base/)
  assert.throws(() => newEngineSources(none), /cannot resolve the cycle's diff base/)

  // Every candidate is tried before giving up, so a checkout that has only one of
  // them still resolves. Conditioned on this checkout having a base at all, so the
  // guard above stays assertable in the very checkout it exists to diagnose.
  if (CYCLE_BASE.sha) {
    const partial = resolveBase(['refs/heads/no-such-ref-for-this-case', ...BASE_CANDIDATES])
    assert.equal(partial.sha, CYCLE_BASE.sha, 'a leading unresolvable candidate must not abort the search')
  }
})

await test('E2.3/AC2 structural: engine/routing.mjs is byte-identical to the cycle base (reused, not reimplemented)', () => {
  assert.equal(readRepo('engine/routing.mjs'), gitShow(`${requireBase()}:engine/routing.mjs`),
    'exhaustionTarget() belongs in engine/flow.mjs precisely so this check stands unweakened')
})

await test('E2.3/AC2 structural: flow.mjs imports the routing vocabulary rather than re-declaring it', () => {
  const src = engineSrc('flow.mjs')
  const imported = [...src.matchAll(/import\s*\{([^}]*)\}\s*from\s*['"]\.\/routing\.mjs['"]/g)]
    .flatMap((m) => m[1].split(',').map((s) => s.trim().split(/\s+as\s+/)[0]))
  for (const sym of ['resolve', 'capKeyFor', 'capValue']) {
    assert.ok(imported.includes(sym), `engine/flow.mjs does not import ${sym} from ./routing.mjs`)
  }
  for (const table of ['CAP_EDGES', 'CAP_LOOPS', 'RESERVED', 'PROSE_SOURCED']) {
    assert.ok(!new RegExp(`(const|let|var)\\s+${table}\\b`).test(src),
      `engine/flow.mjs re-declares ${table} instead of reading it from ./routing.mjs`)
  }
})

// ================================================================================
// GROUP 2 — caps, shared budgets, invariant 6 (AC2.4-2.9)
// ================================================================================

await test('E2.4/AC2: cap values come from spec/bindings/claude.yaml — a cloned binding changes when exhaustion fires', () => {
  const sp = cloneSpec(spec())
  sp.binding.caps['gate_plan.retry'] = 1
  const q = { gate_plan: ['fail', 'fail'] }
  const r = runFlow(sp, { start: 'gate_plan', outcomes: (s) => (q[s] && q[s].length ? q[s].shift() : MAIN_LINE[s]) })
  const hops = r.trace.filter((h) => h.from === 'gate_plan')
  assert.ok(!hops[0].exhausted, 'the first traversal is within a cap of 1')
  assert.ok(hops[1] && hops[1].exhausted, 'with cap 1 the SECOND fail must exhaust — the 3rd would mean a constant')
})

await test('E2.4/AC2 negative-derivation: no engine source pairs a cap key with its literal bound', () => {
  const caps = spec().binding.caps
  const sources = newEngineSources()
  assert.ok(sources.length > 0, 'the M1 engine modules must exist for this scan to mean anything')
  for (const [name, src] of sources) {
    for (const [key, value] of Object.entries(caps)) {
      const re = new RegExp(`${key.replace('.', '\\.')}[^\\n]{0,40}\\b${value}\\b`)
      assert.ok(!re.test(src), `engine/${name} hard-codes the bound for ${key} — it must read spec.binding.caps`)
    }
  }
})

for (const capKey of engineCapKeys()) {
  await test(`E2.5/AC2: ${capKey} — boundary triple (N-1, N traverse; N+1 exhausts to the declared target)`, () => {
    const sp = spec()
    const [step, outcome] = edgeRowsFor(capKey)[0].split(':')
    const cap = RT.capValue(sp, capKey)
    const ex = expectedExhaustion(sp, capKey)
    const bounded = RT.resolve(sp, step, outcome).target
    for (const prior of [cap - 2, cap - 1]) {
      if (prior < 0) continue
      const r = runFlow(sp, { start: step, outcomes: oneShot(step, outcome), seedCounters: { [capKey]: prior } })
      const h = r.trace[0]
      assert.ok(!h.exhausted, `at ${prior}/${cap} the bounded edge must still traverse`)
      assert.equal(h.to, bounded)
      assert.equal(r.state.counters[capKey], prior + 1, 'a traversal consumes exactly one unit of the budget')
    }
    const r = runFlow(sp, { start: step, outcomes: oneShot(step, outcome), seedCounters: { [capKey]: cap } })
    const h = r.trace[0]
    assert.ok(h.exhausted, `at ${cap}/${cap} the bounded edge must NOT be re-entered`)
    assert.equal(h.capKey, capKey)
    assert.equal(h.resolvedOutcome, ex.outcome)
    assert.equal(h.to, ex.target, 'the owning step supplies the exhaustion target')
    assert.equal(r.state.counters[capKey], cap, 'an exhausted edge does not increment the counter again')
  })
}

await test('E2.5b/AC2: the two CAP_LOOPS budgets are carried into the delegation, not counted by the engine', () => {
  const sp = spec()
  for (const [step, row] of Object.entries(RT.CAP_LOOPS)) {
    const r = requestFor(sp, step)
    assert.equal(r.event.kind, 'delegate', `${step} must delegate`)
    assert.equal(r.event.request.caps[row.capKey], RT.capValue(sp, row.capKey),
      `${step}'s request must carry ${row.capKey} — D3 puts its enforcement in the adapter`)
  }
})

await test('E2.5b/AC2: an agent-reported loop outcome routes through resolve() with no special case', () => {
  const sp = spec()
  for (const step of Object.keys(RT.CAP_LOOPS)) {
    const nx = stepOf(sp, step).next
    const outcome = mhas(nx, 'cap-exhausted') ? 'cap-exhausted' : 'escalate'
    const r = runFlow(sp, { start: step, outcomes: oneShot(step, outcome) })
    assert.equal(r.trace[0].to, mget(nx, outcome))
    assert.ok(!r.trace[0].capKey, 'the engine must not count a CAP_LOOPS key it cannot observe')
  }
})

await test('E2.5c/AC2: EVERY bound cap key resolves an exhaustion — outcome, target AND source — from the declaration', () => {
  const sp = spec()
  const keys = allCapKeys()
  assert.deepEqual(keys, Object.keys(sp.binding.caps).sort(),
    'the cap keys the routing tables claim must be exactly the ones the binding bounds — no key is unresolved '
    + 'and none is invented; both sides are derived, so a spec/** amendment moves them together')
  for (const capKey of keys) {
    const want = expectedExhaustion(sp, capKey)
    let got
    assert.doesNotThrow(() => { got = FLOW.exhaustionTarget(sp, capKey) },
      `${capKey} has no derivable exhaustion target — an exhausted cap with nowhere to go cannot satisfy invariant 6`)
    assert.deepEqual({ outcome: got.outcome, target: got.target, source: got.source },
      { outcome: want.outcome, target: want.target, source: want.source },
      `${capKey}: the owning step supplies the target, and the source records where it came from`)
  }
  // `refine.retry` is the recorded counterexample to "an exhausted cap escalates"
  // (DCR-2): it abandons the refactor and proceeds. Derived, so the case states the
  // declaration rather than a slogan about it.
  assert.notEqual(expectedExhaustion(sp, 'refine.retry').target, 'escalate')
  assert.equal(expectedExhaustion(sp, 'refine.retry').target, mget(stepOf(sp, 'refine').next, 'cap-exhausted'))
})

await test('E2.5c/AC2: all THREE exhaustion-resolution rules are still witnessed by some cap key', () => {
  const sp = spec()
  const witnesses = {}
  for (const capKey of allCapKeys()) {
    const { via } = expectedExhaustion(sp, capKey)
    ;(witnesses[via] = witnesses[via] || []).push(capKey)
  }
  assert.deepEqual(Object.keys(witnesses).sort(), ['declared:cap-exhausted', 'declared:escalate', 'prose'],
    'a resolution rule whose last witness disappears must fail loudly here rather than quietly stop being tested — '
    + 'the declared:escalate rule has exactly one witness, which is how it went unasserted in the first place')
  for (const [via, keys] of Object.entries(witnesses)) {
    assert.ok(keys.length > 0, `${via} has no witness`)
  }
})

await test('E2.5d/AC2 (invariant 6): a CAP_LOOPS exhaustion lands on the declared target and never re-enters the step', () => {
  const sp = spec()
  for (const [step, row] of Object.entries(RT.CAP_LOOPS)) {
    const cap = RT.capValue(sp, row.capKey)
    const ex = expectedExhaustion(sp, row.capKey)
    // D3 / U-6: the engine structurally cannot observe a loop's internal rounds, so
    // the exhaustion arrives as the adapter's reported outcome. What the executor
    // still owns — and what invariant 6 asserts — is where that outcome LANDS and
    // that the bounded step is not re-entered.
    const r = runFlow(sp, {
      start: step, maxSteps: 20, seedCounters: { [row.capKey]: cap },
      outcomes: oneShot(step, ex.outcome),
    })
    assert.equal(r.trace[0].to, ex.target, `${row.capKey}: exhaustion must route to the declared target`)
    assert.equal(r.trace.filter((h) => h.from === step).length, 1, `${row.capKey}: ${step} ran more than once`)
    assert.ok(!r.trace.some((h) => h.to === step), `${row.capKey}: the bounded step was re-entered — invariant 6`)
    assert.equal(r.state.counters[row.capKey], cap,
      `${row.capKey}: the engine must not count a loop cap it cannot observe (D3) — the seeded value must be untouched`)
  }
})

await test('E2.6/AC2 (D20): verify.round-trips is ONE budget across both cause branches', () => {
  const sp = spec()
  const cap = RT.capValue(sp, 'verify.round-trips')
  const q = { verify: ['test-issue', 'impl-issue', 'test-issue', 'impl-issue', 'test-issue'] }
  const r = runFlow(sp, { start: 'verify', maxSteps: 80, outcomes: (s) => (q[s] && q[s].length ? q[s].shift() : MAIN_LINE[s]) })
  const counted = r.trace.filter((h) => h.capKey === 'verify.round-trips')
  const spent = counted.filter((h) => !h.exhausted)
  assert.equal(spent.length, cap, 'the budget is shared, so it is spent at the shared total — not per branch')
  assert.ok(new Set(spent.map((h) => h.outcome)).size > 1, 'both cause branches must draw on the same counter')
  assert.ok(counted[cap] && counted[cap].exhausted, `the ${cap + 1}th round trip must exhaust`)
})

await test('E2.6/AC2 (D20): gate_plan.retry is ONE budget across gate_plan:fail and verify:design-contradiction', () => {
  const sp = spec()
  const cap = RT.capValue(sp, 'gate_plan.retry')
  const q = { gate_plan: ['fail', 'pass', 'fail', 'fail'], verify: ['design-contradiction'] }
  const r = runFlow(sp, { start: 'gate_plan', maxSteps: 80, outcomes: (s) => (q[s] && q[s].length ? q[s].shift() : MAIN_LINE[s]) })
  const counted = r.trace.filter((h) => h.capKey === 'gate_plan.retry')
  const spent = counted.filter((h) => !h.exhausted)
  assert.equal(spent.length, cap)
  assert.deepEqual([...new Set(spent.map((h) => h.from))].sort(), ['gate_plan', 'verify'],
    'the counter is keyed by cap key, never by the lookup input — both steps draw on it')
  assert.ok(counted[cap] && counted[cap].exhausted)
})

await test('E2.7/AC2: invariant 6 — a permanently bounded outcome terminates without reaching the ceiling', () => {
  const sp = spec()
  const ceiling = 60
  const r = runFlow(sp, { start: 'verify', maxSteps: ceiling, outcomes: (s) => (s === 'verify' ? 'test-issue' : MAIN_LINE[s]) })
  assert.ok(r.iterations < ceiling - 1, `the run reached the ${ceiling}-step ceiling — the loop is unbounded`)
  assert.equal(r.event.kind, 'terminal')
  assert.ok(RT.RESERVED.has(r.state.step), 'termination lands on a reserved sentinel')
  assert.ok(r.trace.some((h) => h.exhausted), 'termination came from cap exhaustion, not from the oracle running dry')
})

await test('E2.8/AC2: invariant 5 — an undeclared outcome throws rather than routing', () => {
  const sp = spec()
  assert.throws(
    () => runFlow(sp, { start: 'red', outcomes: oneShot('red', 'no-such-outcome') }),
    /no-such-outcome|declares no outcome/,
    'there is no default branch — a transition fires only on a declared completion condition',
  )
})

await test('E2.8/AC2: a handler whose completion condition is unmet produces no hop and no state advance', () => {
  const sp = spec()
  const r = runFlow(sp, { start: 'validate', outcomes: oneShot('validate', 'incomplete') })
  assert.equal(r.event.kind, 'halt')
  assert.equal(r.event.step, 'validate')
  assert.equal(r.trace.length, 0, 'inventing a transition here would breach invariant 5')
  assert.equal(r.state.step, 'validate', 'the step must not advance')
  assert.deepEqual(r.state.history, [], 'no history entry is appended for a halt')
})

await test('E2.9/AC2 (R16/D22): counters are per-run, never module-scoped', () => {
  const sp = spec()
  const drive = () => runFlow(sp, { start: 'verify', maxSteps: 40, outcomes: (s) => (s === 'verify' ? 'test-issue' : MAIN_LINE[s]) })
  const a = drive()
  const b = drive()
  assert.equal(a.state.counters['verify.round-trips'], b.state.counters['verify.round-trips'],
    'a leaked module-scoped budget would make the second run exhaust earlier')
  const one = runFlow(sp, { start: 'verify', outcomes: oneShot('verify', 'test-issue') })
  assert.equal(one.state.counters['verify.round-trips'], 1)
  const two = runFlow(sp, { start: 'verify', outcomes: oneShot('verify', 'test-issue') })
  assert.equal(two.state.counters['verify.round-trips'], 1)
})

// ================================================================================
// GROUP 3 — classification, delegation, per-role frames (AC1)
// ================================================================================

await test('E1.1/AC1: the execute set is DERIVED from spec/steps/*.yaml, and it is the handler table', () => {
  const sp = spec()
  const derived = mechanicalIds(sp)
  assert.deepEqual(derived, ['deliver', 'dispatch', 'handoff', 'integrate', 'preflight', 'validate'],
    'the declaration statement this cycle: six kind: mechanical steps')
  assert.deepEqual(Object.keys(MECH.HANDLERS).sort(), derived,
    'HANDLERS must cover exactly the steps the declaration marks mechanical')
})

await test('E1.1/AC1 negative: a synthetic 17th mechanical step is classified mechanical AND throws — never delegated', () => {
  const sp = cloneSpec(spec())
  sp.steps.set('synthetic', {
    id: 'synthetic', source: '<synthetic>', kind: 'mechanical',
    requires: [], produces: [], agents: [], next: new Map([['done', 'end']]),
  })
  assert.deepEqual(mechanicalIds(sp).includes('synthetic'), true, 'classification is derived, not a literal list')
  assert.throws(
    () => runFlow(sp, { start: 'synthetic', outcomes: oneShot('synthetic', 'done') }),
    /no handler for mechanical step/,
    'falling through to the delegation branch would open an LLM session for a mechanical step — the AC1 violation',
  )
})

await test('E1.2/AC1: every non-mechanical step returns a delegation request and runs no handler', () => {
  const sp = spec()
  for (const id of delegatedIds(sp)) {
    const r = requestFor(sp, id)
    assert.equal(r.event.kind, 'delegate', `${id} executed instead of delegating`)
    const req = r.event.request
    assert.equal(req.step, id)
    assert.ok(Array.isArray(req.roles) && req.roles.length > 0, `${id}'s request carries no roles array`)
    assert.deepEqual(r.state.pending.step, id)
    assert.equal(r.state.status, 'delegating')
    assert.deepEqual(r.state.history, [], 'a delegation fires no transition')
  }
})

await test('E1.3/AC1: roles = step.agents ∪ step.loop.participants, as a LIST — never a first element', () => {
  const sp = spec()
  const twoRole = []
  for (const id of delegatedIds(sp)) {
    const expected = rolesOf(stepOf(sp, id))
    const req = requestFor(sp, id).event.request
    assert.deepEqual(req.roles, expected, `${id}: an agents[0]-style request drops the second participant`)
    assert.deepEqual(Object.keys(req.perRole).sort(), [...expected].sort(), `${id}: one frame per role`)
    if (expected.length === 2) twoRole.push(id)
  }
  assert.deepEqual(twoRole.sort(), ['architect', 'diagnose', 'verify'],
    'architect/verify carry roles only under loop.participants — a `agents ?? participants` fallback yields []')
})

await test('E1.3/AC1 negative (invariant 1): diagnose produces two SEPARATE frames, never one merged frame', () => {
  const sp = spec()
  const req = requestFor(sp, 'diagnose').event.request
  const structure = req.perRole['analyzer-structure'].input
  const issue = req.perRole['analyzer-issue'].input
  assert.ok('code' in structure && !('issue' in structure), 'the structure analyzer must never see the issue')
  assert.ok('issue' in issue && !('code' in issue), 'the issue analyzer must never see the code')
})

await test('E1.3b/AC1: per-role binding resolution — a step-level override wins over the role default', () => {
  const sp = spec()
  assert.equal(sp.binding.roles.test.model, 'sonnet', 'precondition: the role default differs from the override')
  assert.equal(sp.binding.steps.architect.test, 'opus', 'precondition: architect overrides test')
  const req = requestFor(sp, 'architect').event.request
  assert.equal(req.perRole.test.model, 'opus', 'a role-default fallback would yield sonnet here')
  assert.equal(req.perRole.dev.model, sp.binding.steps.architect.dev)
})

await test('E1.3b/AC1: the role default applies where the step declares no override', () => {
  const sp = spec()
  assert.ok(!sp.binding.steps.red, 'precondition: red declares no step-level override')
  const req = requestFor(sp, 'red').event.request
  assert.equal(req.perRole.test.model, sp.binding.roles.test.model)
})

await test('E1.3b/AC1: resolution is a derivation — a cloned binding moves the frame with it', () => {
  const sp = cloneSpec(spec())
  sp.binding.steps.green.dev = 'sonnet'
  assert.equal(requestFor(sp, 'green').event.request.perRole.dev.model, 'sonnet')
})

await test('E1.3b/AC1: effort and provider come from the binding — effort is never defaulted', () => {
  const sp = spec()
  for (const [id, role] of rolePairs(sp)) {
    if (isMechanical(sp, id)) continue
    const req = requestFor(sp, id).event.request
    assert.equal(req.provider, sp.binding.runner, `${id}: provider is request-level, from the binding`)
    assert.equal(req.perRole[role].effort, sp.binding.roles[role].effort,
      `${id}:${role} — effort is declared only where the binding declares it, never defaulted`)
  }
})

await test('E1.3c/AC1: expectedOutcomes is the step\'s declared outcome set — the boundary tells the adapter what it may return', () => {
  const sp = spec()
  for (const id of delegatedIds(sp)) {
    const req = requestFor(sp, id).event.request
    assert.deepEqual(req.expectedOutcomes, mkeys(stepOf(sp, id).next),
      `${id}: an empty or partial list lets the adapter return an outcome resolve() will only reject later`)
  }
})

await test('E1.3c/AC1: criteria crosses the boundary exactly where the step declares it (invariant 10)', () => {
  const sp = spec()
  const declaring = delegatedIds(sp).filter((id) => stepOf(sp, id).criteria !== undefined)
  assert.ok(declaring.length > 0, 'derived witness set must not be empty')
  for (const id of delegatedIds(sp)) {
    const req = requestFor(sp, id).event.request
    const declared = stepOf(sp, id).criteria
    if (declared === undefined) {
      assert.ok(!('criteria' in req), `${id} declares no criteria, so the request must not invent one`)
    } else {
      assert.equal(req.criteria, declared, `${id}: the criteria name must reach the evaluator`)
    }
  }
})

await test('E1.3c/AC1 (invariant 7): isolated crosses the boundary exactly where the loop declares it', () => {
  const sp = spec()
  const isolating = delegatedIds(sp).filter((id) => stepOf(sp, id).loop && stepOf(sp, id).loop.isolated !== undefined)
  assert.ok(isolating.length > 0, 'derived witness set must not be empty — invariant 7 has no carrier otherwise')
  for (const id of delegatedIds(sp)) {
    const st = stepOf(sp, id)
    const req = requestFor(sp, id).event.request
    const declared = st.loop ? st.loop.isolated : undefined
    if (declared === undefined) {
      assert.ok(!('isolated' in req), `${id} declares no isolation, so the request must not assert one`)
    } else {
      assert.equal(req.isolated, declared,
        `${id}: invariant 7 is carried by this field — dropping it silently lets round-by-round cross-talk escape`)
    }
  }
})

await test('E1.3c/AC1 (invariant 2): session crosses the boundary exactly where the ROLE declares it', () => {
  const sp = spec()
  const declaring = rolePairs(sp).filter(([, r]) => mget(sp.roles, r).session !== undefined)
  assert.ok(declaring.length > 0, 'derived witness set must not be empty — invariant 2 has no carrier otherwise')
  for (const [id, role] of rolePairs(sp)) {
    if (isMechanical(sp, id)) continue
    const frame = requestFor(sp, id).event.request.perRole[role]
    const declared = mget(sp.roles, role).session
    if (declared === undefined) {
      assert.ok(!('session' in frame), `${id}:${role} — the role declares no session, so the frame must not invent one`)
    } else {
      assert.equal(frame.session, declared,
        `${id}:${role} — "fresh" is invariant 2; dropping it lets the adapter reuse a session with prior history`)
    }
  }
})

await test('E1.2b/AC1: the persisted pending marker carries the roles the request was built for', () => {
  const sp = spec()
  for (const id of delegatedIds(sp)) {
    const r = requestFor(sp, id)
    assert.deepEqual(r.state.pending.roles, r.event.request.roles,
      `${id}: a resumed run reads pending, so a pending marker without roles cannot say who is outstanding`)
    assert.deepEqual(r.state.pending.request, r.event.request)
  }
})

await test('E1.4(a)/AC1 (invariants 1+4): every frame\'s input keys are a SUBSET of that role\'s declared input', () => {
  const sp = spec()
  for (const [id, role] of rolePairs(sp)) {
    if (isMechanical(sp, id)) continue
    const declared = new Set(mget(sp.roles, role).input)
    const req = requestFor(sp, id).event.request
    for (const k of Object.keys(req.perRole[role].input)) {
      assert.ok(declared.has(k), `${id}:${role} frame carries "${k}", which the role does not declare`)
    }
  }
})

await test('E1.4(b)/AC1: every declared slot of every (step, role) pair is PRESENT as a key', () => {
  const sp = spec()
  const seen = new Set()
  for (const id of delegatedIds(sp)) {
    const req = requestFor(sp, id).event.request
    for (const role of req.roles) {
      for (const k of Object.keys(req.perRole[role].input)) seen.add(`${id}:${role}:${k}`)
    }
  }
  // handoff's ingest frame crosses the boundary from inside a mechanical handler
  const ho = runFlow(sp, { start: 'handoff', outcomes: oneShot('handoff', 'review-findings') })
  const ingest = ho.requests.find((q) => q.roles.includes('ingest'))
  assert.ok(ingest, 'handoff:ingest is one of the (step, role) pairs and must produce a frame')
  for (const k of Object.keys(ingest.perRole.ingest.input)) seen.add(`handoff:ingest:${k}`)
  assert.deepEqual([...seen].sort(), slotTriples(sp),
    'the triple set is derived from the loaded spec at run time — no count is authored')
})

await test('E1.4(c1)/AC1: a declared slot with no SLOT_SOURCES row is refused at construction (slot-unsourced)', () => {
  const sp = cloneSpec(spec())
  mget(sp.roles, 'dev').input.push('unsourced-slot')
  let thrown = null
  assert.throws(() => { requestFor(sp, 'green') }, (e) => { thrown = e; return true })
  assert.equal(thrown.code, 'slot-unsourced',
    'a spec that grows a slot the table cannot source is declaration/engine drift, not a caller error')
})

await test('E1.4(c2)/AC1: a row whose source is absent from the artifacts map is refused (missing-slot + payload)', () => {
  const sp = spec()
  assert.deepEqual(mget(sp.roles, 'dev').input, ['issue', 'accepted_from_previous_round'], 'witness precondition')
  assert.ok(!stepOf(sp, 'green').loop, 'green declares no loop:, so its dev frame sources issue from the run')
  const arts = artifactsMap(sp)
  delete arts.issue
  let thrown = null
  assert.throws(() => { requestFor(sp, 'green', { artifacts: arts }) }, (e) => { thrown = e; return true })
  assert.equal(thrown.code, 'missing-slot', 'an empty-but-well-formed frame is indistinguishable from a correct one')
  assert.deepEqual(
    { step: thrown.step, role: thrown.role, slot: thrown.slot },
    { step: 'green', role: 'dev', slot: 'issue' },
  )
  assert.equal(typeof thrown.source, 'string', 'the payload names the source, which is what separates the two refusals')
})

await test('E1.4(c2)/AC1 non-case: a loop-carry row at a loop-less step resolves to null and raises nothing', () => {
  const sp = spec()
  const loopLess = delegatedIds(sp).filter((id) => !stepOf(sp, id).loop && rolesOf(stepOf(sp, id)).some(
    (r) => mget(sp.roles, r).input.includes('accepted_from_previous_round')))
  assert.ok(loopLess.length > 0, 'derived witness set (green/red/refine this cycle) must not be empty')
  const arts = artifactsMap(sp)
  delete arts['accepted_from_previous_round']
  for (const id of loopLess) {
    const req = requestFor(sp, id, { artifacts: arts }).event.request
    for (const role of req.roles) {
      if (!mget(sp.roles, role).input.includes('accepted_from_previous_round')) continue
      assert.equal(req.perRole[role].input['accepted_from_previous_round'], null,
        `${id}:${role} — a DECLARED empty must not be swallowed by the missing-slot refusal`)
    }
  }
})

await test('E1.4(c3)/AC1: a step delegating to an UNDECLARED role is refused, never given an empty frame', () => {
  const sp = cloneSpec(spec())
  assert.ok(!mhas(sp.roles, 'ghost-role'), 'precondition: the role really is undeclared')
  stepOf(sp, 'red').agents = [...stepOf(sp, 'red').agents, 'ghost-role']
  let thrown = null
  assert.throws(() => { requestFor(sp, 'red') }, (e) => { thrown = e; return true })
  assert.equal(thrown.code, 'slot-unsourced',
    'a role the declaration does not define has no input vocabulary — building a frame for it would breach invariant 1')
  assert.equal(thrown.role, 'ghost-role')
})

await test('E1.4(c4)/AC1: a criteria slot with no declared criteria is refused, never filled with undefined', () => {
  const sp = cloneSpec(spec())
  const gate = 'gate_plan'
  assert.notEqual(stepOf(spec(), gate).criteria, undefined, 'precondition: the live step declares criteria')
  assert.ok(mget(sp.roles, 'evaluator').input.includes('criteria'), 'precondition: the role declares the slot')
  delete stepOf(sp, gate).criteria
  let thrown = null
  assert.throws(() => { requestFor(sp, gate) }, (e) => { thrown = e; return true })
  assert.equal(thrown.code, 'missing-slot',
    'an evaluator scored against an undefined criteria set is the fail-open case invariant 10 exists to prevent')
  assert.deepEqual(
    { step: thrown.step, role: thrown.role, slot: thrown.slot, source: thrown.source },
    { step: gate, role: 'evaluator', slot: 'criteria', source: 'criteria' },
  )
})

await test('E1.4b/AC1: SLOT_SOURCES is total over the spec-derived triple set', () => {
  assert.deepEqual(Object.keys(FLOW.SLOT_SOURCES).sort(), slotTriples(spec()),
    'the row key set is the derivation, never an authored cardinality')
})

await test('E1.4b/AC1: the source-kind domain is a partition — every kind is sourced-or-gap, gap:true iff gap kind', () => {
  const GAP_KINDS = ['derived:issue#acceptance-criteria', 'effect:handoff.reviewComments']
  const rows = Object.values(FLOW.SLOT_SOURCES)
  for (const r of rows) {
    assert.equal(r.gap === true, GAP_KINDS.includes(r.kind), `kind "${r.kind}" disagrees with its gap flag`)
  }
  const kinds = [...new Set(rows.map((r) => r.kind))]
  assert.ok(kinds.length > 0)
  // no cardinality is asserted on either family — only that the two partition the domain
  const gapKinds = kinds.filter((k) => GAP_KINDS.includes(k))
  const sourced = kinds.filter((k) => !GAP_KINDS.includes(k))
  assert.deepEqual([...gapKinds].sort(), [...GAP_KINDS].sort(), 'a third undeclared gap must fail loudly')
  assert.ok(sourced.length > 0, 'the sourced family must be non-empty')
})

await test('E1.4b/AC1: SLOT_GAPS — the KIND set is the 2-element design statement, the KEY set is derived', () => {
  const sp = spec()
  assert.deepEqual(
    [...new Set(Object.values(FLOW.SLOT_GAPS).map((r) => r.kind))].sort(),
    ['derived:issue#acceptance-criteria', 'effect:handoff.reviewComments'],
    'the PROSE_SOURCED idiom: an amendment that CLOSES a gap breaks this deep-equal loudly',
  )
  const derivedGapKeys = slotTriples(sp).filter((k) => {
    const [step, role, slot] = k.split(':')
    return (role === 'test' && slot === 'acceptance-criteria') || (step === 'handoff' && role === 'ingest')
  }).sort()
  assert.deepEqual(Object.keys(FLOW.SLOT_GAPS).sort(), derivedGapKeys, 'no gap count is authored')
  const gapKinded = Object.keys(FLOW.SLOT_SOURCES).filter((k) => FLOW.SLOT_SOURCES[k].gap === true).sort()
  assert.deepEqual(Object.keys(FLOW.SLOT_GAPS).sort(), gapKinded,
    'SLOT_GAPS is by construction the gap-kinded subset — the two constants cannot drift apart')
})

await test('E1.5/AC1: a mechanical step with an EMPTY agents list never returns a delegate result', () => {
  const sp = spec()
  const pure = mechanicalIds(sp).filter((id) => rolesOf(stepOf(sp, id)).length === 0)
  assert.deepEqual(pure, ['deliver', 'dispatch', 'integrate', 'preflight', 'validate'],
    'derived at run time — a future agents: addition moves the step into E1.6\'s shape, not into a failure')
  for (const id of pure) {
    const r = runFlow(sp, { start: id, outcomes: oneShot(id, MAIN_LINE[id]) })
    assert.equal(r.events[0].kind, 'transition', `${id} opened a session instead of executing in engine code`)
    assert.equal(r.requests.length, 0)
  }
})

for (const [step, { outcome, conjuncts }] of Object.entries(DONE_WHEN)) {
  await test(`E1.5b/AC1 (invariant 5): ${step} — EVERY done-when conjunct is independently load-bearing`, () => {
    const sp = spec()
    const satisfied = EFFECT_FOR[step](outcome)
    for (const field of conjuncts) {
      assert.ok(field in satisfied, `the satisfying record does not carry "${field}" — the table and the fixture disagree`)
    }
    const ok = advanceMechanical(sp, step, satisfied)
    assert.equal(ok.event.kind, 'transition', `${step}: the fully satisfied record must reach its declared outcome`)
    assert.equal(ok.event.outcome, outcome)

    for (const field of conjuncts) {
      const partial = { ...satisfied, [field]: false }
      const r = advanceMechanical(sp, step, partial)
      assert.equal(r.event.kind, 'halt',
        `${step}: with "${field}" unmet the handler still reached an outcome — a transition fired on an undeclared completion condition`)
      assert.equal(r.event.step, step)
      assert.equal(r.state.step, step, `${step}: the step must not advance`)
      assert.deepEqual(r.state.history, [], `${step}: no history entry for an unmet done-when`)
    }
  })
}

await test('E1.5b/AC1: integrate — the declared no-op (no integration layer registered) is a PASS, not a skip', () => {
  const sp = spec()
  const nx = stepOf(sp, 'integrate').next
  // spec/steps/integrate.yaml's done-when is a disjunction: the suite passes, OR the
  // project registers no integration layer. The second arm has to be witnessed on its
  // own, with `pass` absent — otherwise the arm can be deleted with the suite green.
  const noop = advanceMechanical(sp, 'integrate', { registered: false })
  assert.equal(noop.event.kind, 'transition', 'the no-op arm must reach a declared outcome')
  assert.equal(noop.event.outcome, 'pass')
  assert.equal(noop.event.to, mget(nx, 'pass'))

  const passing = advanceMechanical(sp, 'integrate', { registered: true, pass: true })
  assert.equal(passing.event.outcome, 'pass')
  const failing = advanceMechanical(sp, 'integrate', { registered: true, pass: false })
  assert.equal(failing.event.outcome, 'fail')
  assert.equal(failing.event.to, mget(nx, 'fail'))

  // Registered but with no verdict reported satisfies neither arm.
  const silent = advanceMechanical(sp, 'integrate', { registered: true })
  assert.equal(silent.event.kind, 'halt', 'a registered layer that reported nothing must not be read as a pass')
})

await test('E1.5/AC1: NO_EFFECTS refuses rather than silently succeeding — M1 ships no real side-effect layer', () => {
  const sp = spec()
  for (const id of mechanicalIds(sp)) {
    assert.throws(() => MECH.NO_EFFECTS[id]({ spec: sp, step: id, state: null, artifacts: {} }),
      (e) => e.code === 'effects-not-wired', `NO_EFFECTS.${id} must throw EffectsNotWiredError`)
  }
})

// ================================================================================
// GROUP 4 — persisted state and resume (AC4)
// ================================================================================

await test('E4.1/AC4: state is written at EVERY state change, not at phase boundaries', () => {
  const sp = spec()
  const dir = tmpRoot()
  const path = join(dir, 'run-4.json')
  const writes = []
  const r = runFlow(sp, {
    start: 'preflight', maxSteps: 80, statePath: path,
    persist: (p, s) => writes.push([p, s]),
    outcomes: mainLine(),
  })
  const changing = r.events.filter((e) => ['transition', 'delegate', 'halt'].includes(e.kind))
  assert.ok(changing.length > 1, 'the scenario must produce several state changes')
  assert.equal(writes.length, changing.length,
    'one write per state change — the hop count is derived from the returned trace, never authored')
  assert.ok(r.events.some((e) => e.kind === 'delegate'), 'the run must include a delegate event')
})

await test('E4.1/AC4: a delegate and a halt each write; omitting the persist port is LOUD, never a skipped write', () => {
  const sp = spec()
  const dir = tmpRoot()
  const path = join(dir, 'run-4.json')
  const d = []
  runFlow(sp, { start: 'gate_plan', statePath: path, persist: (p, s) => d.push(s), outcomes: oneShot('gate_plan', 'pass') })
  assert.ok(d.length >= 2, 'the delegate event and the following transition must both persist')
  const h = []
  runFlow(sp, { start: 'validate', statePath: path, persist: (p, s) => h.push(s), outcomes: oneShot('validate', 'incomplete') })
  assert.equal(h.length, 1, 'a halt is a state change and must be persisted')

  // A skipped write is the AC4 failure mode, so "no persist port supplied" must never
  // mean "no write". Feature design §2.4 gives the port a documented default
  // (`saveState`); the property is therefore asserted on the DEFAULT rather than on a
  // refusal — and asserting it this way exercises the real transport end to end,
  // which a throw never would.
  const dpath = join(tmpRoot(), 'run-4.json')
  const r = runFlow(sp, { start: 'preflight', statePath: dpath, persist: undefined, outcomes: oneShot('preflight', 'ready') })
  assert.equal(r.trace.length, 1, 'precondition: the scenario fires one transition')
  assert.ok(existsSync(dpath), 'the default persist port did not run — the state change was silently dropped')
  assert.deepEqual(RS.loadState(dpath), r.state, 'the written document must be the state the hop returned')

  // The port is still VALIDATED rather than silently bypassed: a wired-but-unusable
  // port is a programming error and is loud.
  assert.throws(
    () => runFlow(sp, { start: 'preflight', statePath: dpath, persist: 'not-a-function', outcomes: oneShot('preflight', 'ready') }),
    /persist port not wired/,
    'a non-callable persist port must not fall back to a silent no-op',
  )
})

await test('E4.2/AC4: the persisted document round-trips by deep-equal, and its key set is closed', () => {
  const sp = spec()
  const dir = tmpRoot()
  const path = join(dir, 'run-4.json')
  const r = runFlow(sp, { start: 'preflight', maxSteps: 20, statePath: path, persist: () => {}, outcomes: mainLine({ verify: 'test-issue' }) })
  RS.saveState(path, r.state)
  assert.deepEqual(RS.loadState(path), r.state, 'a spot check would let a dropped field survive a round-trip')
  assert.deepEqual(
    Object.keys(r.state).sort(),
    ['counters', 'halt', 'history', 'issue', 'pending', 'status', 'step', 'terminal', 'version'],
    'the schema is closed (feature design §2.1), which is what makes the round-trip a deep-equal',
  )
  assert.equal(r.state.version, RS.STATE_VERSION)
})

await test('E4.2/AC4 (D20): counters are keyed by CAP KEY, never by step:outcome', () => {
  const sp = spec()
  const declared = new Set([
    ...Object.values(RT.CAP_EDGES).map((x) => x.capKey),
    ...Object.values(RT.CAP_LOOPS).map((x) => x.capKey),
  ])
  const r = runFlow(sp, { start: 'verify', maxSteps: 60, persist: () => {}, outcomes: (s) => (s === 'verify' ? 'test-issue' : MAIN_LINE[s]) })
  const keys = Object.keys(r.state.counters)
  assert.ok(keys.length > 0, 'the scenario must consume a budget')
  for (const k of keys) {
    assert.match(k, /^[a-z_]+\.[a-z-]+$/, `counter key "${k}" is not shaped like a cap key`)
    assert.ok(declared.has(k), `counter key "${k}" is not a declared cap key`)
  }
})

await test('E4.2/AC4: a state version mismatch is rejected, never silently coerced', () => {
  const dir = tmpRoot()
  const path = join(dir, 'run-4.json')
  writeFileSync(path, JSON.stringify({ version: RS.STATE_VERSION + 99, issue: '#4', step: 'preflight', counters: {}, history: [], pending: null, status: 'running', terminal: null, halt: null }))
  assert.throws(() => RS.loadState(path), (e) => e.code === 'state-version')
})

await test('E4.3/AC4: resume is the same entry path as cold start — one exported executor entry, no recovery symbol', () => {
  assert.equal(typeof FLOW.advance, 'function')
  for (const name of Object.keys(FLOW)) {
    assert.ok(!/resum|recover|restart/i.test(name), `engine/flow.mjs exports "${name}" — resume must not be a code path`)
  }
})

await test('E4.3/AC4: an interrupted-and-reloaded run produces the same trace as an uninterrupted one', () => {
  const sp = spec()
  const dir = tmpRoot()
  const path = join(dir, 'run-4.json')
  const oracle = () => mainLine({ gate_plan: (() => { let n = 0; return () => (n++ === 0 ? 'fail' : 'pass') })() })
  const whole = runFlow(sp, { start: 'preflight', maxSteps: 80, statePath: path, persist: () => {}, outcomes: oracle() })

  // Same run, but every single hop crosses a save/load boundary.
  const outcomes = oracle()
  let state = FLOW.initialState(sp, { issue: '#4', start: 'preflight' })
  const piecewise = []
  for (let i = 0; i < 80; i++) {
    RS.saveState(path, state)
    // One HOP per call, not one advance() call: a delegated step spans two advance()
    // calls, and splitting them across two runFlow invocations would consult the
    // oracle twice for one traversal.
    const r = runFlow(sp, { state: RS.loadState(path), maxHops: 1, maxSteps: 6, statePath: path, persist: () => {}, outcomes })
    if (r.events.length === 0) break
    piecewise.push(...r.trace)
    state = r.state
    if (r.event.kind === 'terminal' || r.event.kind === 'halt') break
  }
  assert.deepEqual(piecewise, whole.trace, 'resume must not be observable in the trace')
  assert.deepEqual(state.counters, whole.state.counters)
})

await test('E4.4/AC4: cap counters survive a resume from disk — a restart does not grant a fresh budget', () => {
  const sp = spec()
  const dir = tmpRoot()
  const path = join(dir, 'run-4.json')
  const cap = RT.capValue(sp, 'gate_plan.retry')
  // Spend the WHOLE budget before the interrupt, so the single fail fed after the
  // resume is the one the cap must refuse. A run that reset its counters on reload
  // would traverse it instead — which is the discriminator asserted at the end.
  const q = { gate_plan: Array(cap).fill('fail') }
  const first = runFlow(sp, {
    start: 'gate_plan', maxSteps: 40, statePath: path, persist: () => {},
    outcomes: (s) => (q[s] && q[s].length ? q[s].shift() : (s === 'gate_plan' ? null : MAIN_LINE[s])),
  })
  assert.equal(first.state.counters['gate_plan.retry'], cap, 'precondition: the budget is fully spent')
  assert.ok(!first.trace.some((h) => h.exhausted), 'precondition: nothing has exhausted yet')
  RS.saveState(path, first.state)

  const resumed = runFlow(sp, {
    state: RS.loadState(path), maxSteps: 10, statePath: path, persist: () => {},
    outcomes: oneShot('gate_plan', 'fail'),
  })
  const last = resumed.trace[resumed.trace.length - 1]
  assert.ok(last && last.exhausted, 'the resumed run reset the budget and granted unbounded retries across restarts')
  assert.equal(last.to, expectedExhaustion(sp, 'gate_plan.retry').target)

  // The discriminator: the SAME step and the SAME outcome, entered cold, traverses.
  // So the refusal above came from the counters that survived the reload, not from
  // anything intrinsic to the step.
  const cold = runFlow(sp, { start: 'gate_plan', outcomes: oneShot('gate_plan', 'fail') })
  assert.ok(!cold.trace[0].exhausted, 'a cold start must still have its full budget')
})

await test('E4.5/AC4: crash-safety — a truncated, a version-skewed and an unknown-key document are each rejected typed', () => {
  const dir = tmpRoot()
  const good = { version: RS.STATE_VERSION, issue: '#4', step: 'preflight', counters: {}, history: [], pending: null, status: 'running', terminal: null, halt: null }
  const p1 = join(dir, 'truncated.json')
  writeFileSync(p1, JSON.stringify(good).slice(0, 20))
  assert.throws(() => RS.loadState(p1), (e) => e.code === 'state-corrupt',
    'a raw SyntaxError escaping, or a {} default, would silently restart at preflight with empty counters')
  const p2 = join(dir, 'skewed.json')
  writeFileSync(p2, JSON.stringify({ ...good, version: 'next' }))
  assert.throws(() => RS.loadState(p2), (e) => e.code === 'state-version')
  const p3 = join(dir, 'extra.json')
  writeFileSync(p3, JSON.stringify({ ...good, surpriseField: 1 }))
  assert.throws(() => RS.loadState(p3), (e) => e.code === 'state-corrupt',
    'the closed key set is what lets E4.2 be a deep-equal round-trip')
})

await test('E4.5/AC4: a well-formed JSON document that is not a state OBJECT is rejected typed', () => {
  const dir = tmpRoot()
  // JSON.parse succeeds on each of these, so a loader that goes straight to
  // `doc.version` raises a bare TypeError (or, for an array, mis-reports a version
  // skew) instead of the typed state-corrupt the resume path is guaranteed to give.
  for (const [name, body] of [['null', 'null'], ['array', '[]'], ['string', '"preflight"'], ['number', '42']]) {
    const p = join(dir, `not-an-object-${name}.json`)
    writeFileSync(p, body)
    let thrown = null
    assert.throws(() => { RS.loadState(p) }, (e) => { thrown = e; return true }, `${name} was accepted`)
    assert.equal(thrown.code, 'state-corrupt', `a ${name} document must be rejected as corrupt, not coerced or mis-typed`)
  }
})

await test('E4.5/AC4: an unreadable or absent state file is rejected typed, not as a raw fs error', () => {
  const dir = tmpRoot()
  let thrown = null
  assert.throws(() => { RS.loadState(join(dir, 'never-written.json')) }, (e) => { thrown = e; return true })
  assert.equal(thrown.code, 'state-corrupt',
    'a caller distinguishing "no cycle in flight" from "the state is broken" reads the typed code, not an errno')
  assert.equal(thrown.name, 'StateCorruptError')
})

await test('E4.5/AC4: the write is atomic (tmp + rename) and leaves no partial document behind', () => {
  const dir = tmpRoot()
  const path = join(dir, 'run-4.json')
  const state = { version: RS.STATE_VERSION, issue: '#4', step: 'preflight', counters: {}, history: [], pending: null, status: 'running', terminal: null, halt: null }
  RS.saveState(path, state)
  assert.deepEqual(RS.loadState(path), state)
  assert.deepEqual(readdirSync(dir), ['run-4.json'], 'the temp file must be renamed, not left in the state root')
  const src = engineSrc('run-state.mjs')
  assert.match(src, /renameSync/, 'a plain writeFileSync can leave a truncated state file after a crash mid-write')
})

await test('E4.6/AC4: advance() derives no in-repo default state path, and every observed write stays under the temp root', () => {
  const flowSrc = engineSrc('flow.mjs')
  const uncommented = flowSrc.split('\n').filter((l) => !l.trim().startsWith('//')).join('\n')
  assert.ok(!uncommented.includes('.autoflow'),
    'engine/flow.mjs must never reach for a fallback path inside the repo tree — statePath is caller-supplied')
  const sp = spec()
  const dir = tmpRoot()
  const path = join(dir, 'run-4.json')
  const seen = []
  runFlow(sp, { start: 'preflight', maxSteps: 40, statePath: path, persist: (p) => seen.push(p), outcomes: mainLine() })
  assert.ok(seen.length > 0)
  for (const p of seen) assert.ok(p.startsWith(dir), `a write escaped the temp root: ${p}`)
})

// ================================================================================
// GROUP 4 (cycle 2) — the load boundary checks FIELD VALUES, not only the key set
// ================================================================================
//
// Authored from .autoflow/issue-4-verification-design.md (cycle 2) §2, against the
// acceptance criteria — not against an implementation. The gap: loadState() proves a
// document has the right SKELETON (readable, parseable, an object, the right version,
// the closed key set) and never looks at what the fields hold. So a nine-key document
// with `history: null` loads, and dies one layer down inside the executor as a raw
// `TypeError: state.history is not iterable` (engine/flow.mjs:264) — while one with
// `counters: null` does not die at all: `{...null}` is `{}` (engine/flow.mjs:239), so
// the resume silently restarts on a fresh cap budget. That second mode fails OPEN and
// is the graver of the two, because it defeats exactly the property
// engine/run-state.mjs:11-12 declares the module exists to enforce. E4.14 is its
// behavioural witness; E4.13 is the named TypeError's.
//
// Oracle discipline (verification design §3.4). The ACCEPTED side is derived from
// documents real runs persist (acceptanceCorpus below); the REJECTED side is a fixed
// witness literal in the PROSE_SOURCED shape. No case reads STATE_FIELDS[key].ok or
// .expected — that is the tautology in which a wrong predicate satisfies its own
// oracle. Iterating Object.keys(STATE_FIELDS) to GENERATE an input is permitted and
// used once, by the totality case (E4.18).

// The nine-key document a real run would accept — the same fixture the cycle-1
// group-4 cases build (:1496), rebuilt per call so a case can mutate one field
// without sharing a reference with another.
const goodDoc = () => ({
  version: RS.STATE_VERSION, issue: '#4', step: 'preflight', counters: {}, history: [],
  pending: null, status: 'running', terminal: null, halt: null,
})

function writeDoc(dir, name, doc) {
  const p = join(dir, name)
  writeFileSync(p, JSON.stringify(doc))
  return p
}

// The load result as DATA rather than as a throw, so a case can report what the
// executor then did with an accepted document. A case that could only assert
// `assert.throws` would state that the refusal is missing but never what the missing
// refusal costs — which is the whole of E4.13 and E4.14.
function loadOutcome(p) {
  try {
    return { doc: RS.loadState(p), refusal: null }
  } catch (e) {
    return { doc: null, refusal: e }
  }
}

// The runtime type tag of a value: `typeof` collapses null and arrays into 'object',
// and those are the two shapes this cycle is about.
const tagOf = (v) => (v === null ? 'null' : Array.isArray(v) ? 'array' : typeof v)

// The ACCEPTANCE corpus — documents real executor runs persist. Every "this must
// still load" expectation below is derived from here, never from the engine's own
// table, so the characteristic defect of a new validation layer (over-rejection) is
// caught by behaviour rather than by agreement with the thing under test.
let _corpus = null
function acceptanceCorpus() {
  if (_corpus) return _corpus
  const sp = spec()
  const dir = tmpRoot()
  const docs = []
  const keep = (p, s) => docs.push(s)
  runFlow(sp, { start: 'preflight', maxSteps: 80, statePath: join(dir, 'c1.json'), persist: keep, outcomes: mainLine() })
  runFlow(sp, { start: 'gate_plan', statePath: join(dir, 'c2.json'), persist: keep, outcomes: oneShot('gate_plan', 'pass') })
  runFlow(sp, { start: 'validate', statePath: join(dir, 'c3.json'), persist: keep, outcomes: oneShot('validate', 'incomplete') })
  const term = runFlow(sp, { start: 'preflight', maxSteps: 40, statePath: join(dir, 'c4.json'), persist: keep, outcomes: mainLine({ verify: 'test-issue' }) })
  docs.push(term.state)
  _corpus = docs
  return _corpus
}

// The eight FIELD keys, derived from a document a real run produced: the closed key
// set minus `version`. `version` carries its own rejection (StateVersionError, raised
// before any field pass), so it is a row of the KEY set and not of the field layer;
// its precedence is asserted by E4.10 instead.
const fieldKeys = () => Object.keys(acceptanceCorpus()[0]).filter((k) => k !== 'version').sort()

// The type tags each field is OBSERVED to carry across the corpus. A lower bound
// derived from behaviour — which is what makes "this shape must still load" an
// independent expectation rather than a restatement of the predicate under test.
function acceptedTags() {
  const acc = {}
  for (const k of fieldKeys()) acc[k] = new Set()
  for (const d of acceptanceCorpus()) for (const k of fieldKeys()) acc[k].add(tagOf(d[k]))
  return acc
}

// Six top-level type tags, authored as a design statement in the PROSE_SOURCED shape
// (:20-25). A key's negative row set is WITNESSES minus the tags the corpus proves it
// legitimately carries, computed at run time — so no per-field expectation is authored.
const WITNESSES = Object.freeze([null, true, 42, 'x', [], {}])

// PROSE_SOURCED: the expected-type phrase each field's rejection must report,
// transcribed from the feature design (.autoflow/issue-4-feature-design.md §2.1).
// Deliberately NOT read off RS.STATE_FIELDS[key].expected: their AGREEMENT with the
// table is the assertion, not its premise (verification design §3.4).
const EXPECTED_PHRASE = Object.freeze({
  counters: 'an object whose values are non-negative integers',
  halt: 'null or an object',
  history: 'an array',
  issue: 'a string',
  pending: 'null or an object',
  status: 'a string',
  step: 'a string',
  terminal: 'null or a string',
})

// What the message must call the offending value, authored from the same design
// section rather than imported from the engine's describe(): 'null' and 'an array'
// are spelled out because `typeof` reports both as 'object'.
const actualWord = (v) => (v === null ? 'null' : Array.isArray(v) ? 'an array' : typeof v)

await test('E4.7/AC4 (cycle 2): the reviewer\'s named document — nine keys, right version, history: null — is refused typed at the load boundary', () => {
  const dir = tmpRoot()
  const { doc, refusal } = loadOutcome(writeDoc(dir, 'history-null.json', { ...goodDoc(), history: null }))
  assert.ok(refusal,
    `the document was ACCEPTED and returned (history = ${JSON.stringify(doc && doc.history)}) — `
    + 'the failure is deferred into the executor, where it surfaces as a raw TypeError at engine/flow.mjs:264')
  assert.equal(refusal.code, 'state-corrupt', 'the refusal must keep the code every existing caller reads')
  assert.equal(refusal.name, 'StateCorruptError')
  assert.ok(refusal instanceof RS.StateCorruptError)
})

await test('E4.8/AC4 (cycle 2): EVERY field is type-checked, not just history — the wrong-type witness matrix', () => {
  const dir = tmpRoot()
  const accepted = acceptedTags()
  const keys = fieldKeys()
  assert.ok(keys.length > 1, 'precondition: the matrix must span the whole field layer, not one key')
  for (const key of keys) {
    assert.ok(EXPECTED_PHRASE[key], `no expected-type phrase is transcribed for the field "${key}"`)
  }
  const survived = []
  let rows = 0
  for (const key of keys) {
    for (const w of WITNESSES) {
      // A tag a real run persists for this field is not a negative row — refusing it
      // would be the over-rejection failure, which E4.12 owns.
      if (accepted[key].has(tagOf(w))) continue
      rows++
      const { refusal } = loadOutcome(writeDoc(dir, `wrong-${key}-${tagOf(w)}.json`, { ...goodDoc(), [key]: w }))
      if (!refusal) { survived.push(`${key}: ${tagOf(w)}`); continue }
      assert.equal(refusal.code, 'state-corrupt', `${key}: ${tagOf(w)} — the refusal must keep the existing code`)
      // Driven from the LOOP VARIABLE and anchored on the key in quoted position, so a
      // fix that emits one fixed string fails on every row and another field's message
      // cannot satisfy this one.
      assert.match(refusal.detail, new RegExp(`field "${key}" is `),
        `${key}: ${tagOf(w)} — the refusal does not name the field that was mutated: ${refusal.detail}`)
      assert.ok(refusal.detail.includes(actualWord(w)),
        `${key}: ${tagOf(w)} — the refusal does not report the ACTUAL type: ${refusal.detail}`)
      assert.ok(refusal.detail.includes(EXPECTED_PHRASE[key]),
        `${key}: ${tagOf(w)} — the refusal does not report the EXPECTED type: ${refusal.detail}`)
    }
  }
  assert.ok(rows > keys.length, 'precondition: the matrix must carry more than one witness per key')
  assert.deepEqual(survived, [], `wrong-typed fields the loader accepted: ${survived.join(', ')}`)
})

await test('E4.9/AC4 (cycle 2): counter VALUES are typed, not only the counters container — a forged budget is refused', () => {
  const dir = tmpRoot()
  // Neither of these raises anywhere downstream today: '999' coerces at the
  // `spent >= capValue(...)` compare (engine/flow.mjs:242) and forges exhaustion,
  // while -5 makes `spent + 1` count DOWN and enlarges the budget. Both are the
  // fail-open class one level below `counters: null`, so a container-only check
  // leaves the worse half of the finding open.
  for (const [name, value] of [['string', '999'], ['negative', -5]]) {
    const { refusal } = loadOutcome(writeDoc(dir, `counters-${name}.json`, { ...goodDoc(), counters: { 'gate_plan.retry': value } }))
    assert.ok(refusal, `counters: { 'gate_plan.retry': ${JSON.stringify(value)} } was accepted — a forged budget survives the load boundary`)
    assert.equal(refusal.code, 'state-corrupt')
    assert.match(refusal.detail, /field "counters" is /)
  }
})

await test('E4.10/AC4 (cycle 2): the new field pass does not re-classify the rejections cycle 1 pinned', () => {
  const dir = tmpRoot()
  // A wrong-typed field alone reports the field — the layer exists.
  const only = loadOutcome(writeDoc(dir, 'wrong-only.json', { ...goodDoc(), status: 42 }))
  assert.ok(only.refusal, 'a wrong-typed field on an otherwise well-formed document was accepted')
  assert.equal(only.refusal.code, 'state-corrupt')
  assert.match(only.refusal.detail, /field "status" is /)

  // Version skew still wins: a future schema version may legitimately carry different
  // field types, so a skewed document must keep reporting state-version (:1503).
  const skew = loadOutcome(writeDoc(dir, 'skew-and-wrong.json', { ...goodDoc(), version: 'next', history: null }))
  assert.ok(skew.refusal)
  assert.equal(skew.refusal.code, 'state-version',
    'the field pass ran before the version check and silently re-classified a version skew as corruption')

  // The key set still wins: the field pass is defined only over the closed key set,
  // so a document whose real defect is an unknown or a missing key must report that.
  const extra = loadOutcome(writeDoc(dir, 'extra-and-wrong.json', { ...goodDoc(), surpriseField: 1, history: null }))
  assert.ok(extra.refusal)
  assert.equal(extra.refusal.code, 'state-corrupt')
  assert.match(extra.refusal.detail, /key set/, 'an unknown key must still be reported as a key-set defect')
  const missing = goodDoc()
  delete missing.halt
  const gone = loadOutcome(writeDoc(dir, 'missing-and-wrong.json', { ...missing, history: null }))
  assert.ok(gone.refusal)
  assert.match(gone.refusal.detail, /key set/, 'a missing key must still be reported as a key-set defect')
})

await test('E4.11/AC4 (cycle 2): the refusal distinguishes null from an object, and reports a deterministic first offender', () => {
  const dir = tmpRoot()
  const asNull = loadOutcome(writeDoc(dir, 'history-null-2.json', { ...goodDoc(), history: null }))
  const asObj = loadOutcome(writeDoc(dir, 'history-object.json', { ...goodDoc(), history: {} }))
  assert.ok(asNull.refusal && asObj.refusal, 'both wrong-typed shapes must be refused')
  // A typeof-only message collapses both to 'object', which is what makes the two most
  // likely corruption shapes indistinguishable to whoever reads the stderr line.
  assert.notEqual(asNull.refusal.detail, asObj.refusal.detail,
    'null and {} produced the SAME message — the operator cannot tell which corruption occurred')
  assert.ok(asNull.refusal.detail.includes('null'), `a null field must be reported as null: ${asNull.refusal.detail}`)
  assert.ok(asObj.refusal.detail.includes('object'), `an object field must be reported as an object: ${asObj.refusal.detail}`)

  // Two bad fields: the reported one is the sorted-first of the keys THIS CASE mutated,
  // computed here rather than read off the engine's table. A standing guard — while the
  // table is authored in sorted order this cannot discriminate a sort-less loop; its
  // trigger is the removal of the loop's own ordering once the table has drifted.
  // Reordering the table's rows is deliberately NOT a regression.
  const mutated = ['counters', 'history']
  const both = loadOutcome(writeDoc(dir, 'two-bad.json', { ...goodDoc(), counters: null, history: null }))
  assert.ok(both.refusal, 'a document with two wrong-typed fields was accepted')
  assert.match(both.refusal.detail, new RegExp(`field "${[...mutated].sort()[0]}" is `),
    `the first-reported field is not the alphabetically first offender: ${both.refusal.detail}`)
  assert.ok(!both.refusal.detail.includes(`field "${[...mutated].sort()[1]}"`),
    'exactly one field is reported, so the report is deterministic')
})

await test('E4.12/AC4 (cycle 2): every document a real run persists still loads, deep-equal — the refusal is not over-broad', () => {
  const dir = tmpRoot()
  const docs = acceptanceCorpus()
  assert.ok(docs.length > 3, 'precondition: the corpus must span several persisted hops')
  docs.forEach((s, i) => {
    const wire = JSON.parse(JSON.stringify(s))
    const { doc, refusal } = loadOutcome(writeDoc(dir, `corpus-${i}.json`, s))
    assert.ok(!refusal, `a document a real run persisted was refused: ${refusal && refusal.detail}`)
    assert.deepEqual(doc, wire, 'the round-trip must stay a deep-equal, not a spot check')
  })
  // The corpus must actually EXHIBIT the non-null and non-empty forms. Without this the
  // accepted set degrades silently — a corpus that never produced a non-null `pending`
  // would derive "pending is always null" and turn a correct loader's acceptance of a
  // delegating document into a rejection row.
  const some = (f, what) => assert.ok(docs.some(f), `the corpus exhibits no ${what} — every expectation derived from it is weaker than it reads`)
  some((d) => d.pending !== null, 'non-null pending')
  some((d) => d.halt !== null, 'non-null halt')
  some((d) => d.terminal !== null, 'non-null terminal')
  some((d) => typeof d.issue === 'string' && d.issue !== '', 'non-empty string issue')
  some((d) => Object.keys(d.counters).length > 0, 'non-empty counters')
  some((d) => d.history.length > 0, 'non-empty history')
})

await test('E4.13/AC4 (cycle 2): an embedder resume never reaches the executor — the raw TypeError is replaced by a typed refusal', () => {
  const sp = spec()
  const dir = tmpRoot()
  const path = writeDoc(dir, 'resume-history-null.json', { ...goodDoc(), step: 'gate_plan', history: null })
  let hops = 0
  // The fully wired two-hop form. An unwired env dies earlier at missing-slot, so a
  // case built on one naive advance() would witness the harness's artifact map rather
  // than the loader (the pattern at :632-636).
  const twoHop = (state) => {
    const base = { effects: {}, artifacts: artifactsMap(sp), persist: () => {}, statePath: path }
    hops++
    const first = FLOW.advance(sp, state, base)
    assert.equal(first.event.kind, 'delegate', 'precondition: hop 1 must raise the delegation')
    hops++
    return FLOW.advance(sp, first.state, { ...base, delegationOutput: { scores: PASSING_SCORES } })
  }
  const { doc, refusal } = loadOutcome(path)
  let downstream = null
  if (!refusal) { try { twoHop(doc) } catch (e) { downstream = e } }
  assert.ok(refusal,
    'the document was ACCEPTED at the load boundary and the executor was entered; it then raised '
    + `${downstream && downstream.name}: ${downstream && downstream.message} — a raw language error, `
    + 'thrown one layer below the boundary that is supposed to refuse it')
  assert.equal(refusal.code, 'state-corrupt')
  assert.ok(!(refusal instanceof TypeError), 'the refusal must be the typed load-boundary error, not a language error')
  assert.equal(hops, 0, 'the executor must never be entered with an unvalidated document')
})

await test('E4.14/AC4 (cycle 2): counters: null is refused — unrefused it fails OPEN, restarting the run on a fresh cap budget', () => {
  const sp = spec()
  const dir = tmpRoot()
  const cap = RT.capValue(sp, 'gate_plan.retry')
  const spent = { ...goodDoc(), step: 'gate_plan', counters: { 'gate_plan.retry': cap } }
  // The reference behaviour, measured rather than authored: with the budget intact on
  // disk, the resumed run refuses the next retry and routes to the declared exhaustion
  // target. This is the behaviour the corrupted document must not be able to escape.
  const intact = runFlow(sp, {
    state: JSON.parse(JSON.stringify(spent)), maxSteps: 10, statePath: join(dir, 'intact.json'),
    persist: () => {}, outcomes: oneShot('gate_plan', 'fail'),
  })
  const intactLast = intact.trace[intact.trace.length - 1]
  assert.ok(intactLast && intactLast.exhausted, 'precondition: a resume carrying the spent budget must refuse the retry')

  // The same document with one field corrupted. Nothing downstream raises: `{...null}`
  // is `{}` (engine/flow.mjs:239), so the run continues on a budget that was already
  // spent — the failure mode engine/run-state.mjs:11-12 names as the reason the module
  // exists, and the fail-OPEN sibling of the history: null TypeError.
  const { doc, refusal } = loadOutcome(writeDoc(dir, 'counters-null.json', { ...spent, counters: null }))
  let resumed = null
  if (!refusal) {
    resumed = runFlow(sp, {
      state: doc, maxSteps: 10, statePath: join(dir, 'corrupt.json'),
      persist: () => {}, outcomes: oneShot('gate_plan', 'fail'),
    })
  }
  const last = resumed && resumed.trace[resumed.trace.length - 1]
  assert.ok(refusal,
    'counters: null was ACCEPTED and the resume ran on: exhausted = '
    + `${last ? !!last.exhausted : 'n/a'} where the intact document refuses, counters = `
    + `${JSON.stringify(resumed && resumed.state.counters)} — the ${cap} spent retries were `
    + 'silently discarded and nothing was raised anywhere')
  assert.equal(refusal.code, 'state-corrupt')
  assert.match(refusal.detail, /field "counters" is null/)
})

await test('E4.15/AC4 (cycle 2): saveState refuses a document its own loader would refuse, BEFORE the temp write', () => {
  const sp = spec()
  const dir = tmpRoot()
  const path = join(dir, 'run-4.json')
  assert.throws(() => RS.saveState(path, { ...goodDoc(), history: null }), (e) => e.code === 'state-corrupt',
    'the engine must not be able to persist a document it cannot read back')
  // Ordering is the assertion, not a detail: a check placed one line late leaves
  // run-4.json.tmp in the state root and regresses the atomicity property at :1539.
  assert.deepEqual(readdirSync(dir), [], 'the refused save left a temp file in the state root')
  const missing = goodDoc()
  delete missing.halt
  assert.throws(() => RS.saveState(path, missing), (e) => e.code === 'state-corrupt', 'the key set is checked on the write side too')

  RS.saveState(path, goodDoc())
  const before = readFileSync(path, 'utf8')
  assert.throws(() => RS.saveState(path, { ...goodDoc(), counters: null }), (e) => e.code === 'state-corrupt')
  assert.equal(readFileSync(path, 'utf8'), before, 'the refused save overwrote the previous document')
  assert.deepEqual(readdirSync(dir), ['run-4.json'], 'the refused save left a temp file beside the previous document')

  // The embedder default path, whose failure this refusal exists to catch: with `issue`
  // omitted, JSON.stringify drops the key and the run persists an 8-key document that
  // its own loader refuses at the next resume. The refusal must land at the WRITE that
  // caused it, naming the field.
  let e5 = null
  assert.throws(() => RS.saveState(join(dir, 'default-path.json'), FLOW.initialState(sp, { start: 'preflight' })),
    (e) => { e5 = e; return true },
    'initialState() with issue omitted still persists a document that cannot be loaded back')
  assert.equal(e5.code, 'state-corrupt')
  assert.match(e5.detail, /field "issue" is undefined/)
})

await test('E4.16/AC4 (cycle 2): one contract, two consumers — both directions refuse the same document with the same code', () => {
  const dir = tmpRoot()
  const bad = { ...goodDoc(), pending: 7 }
  let write = null
  assert.throws(() => RS.saveState(join(dir, 'w.json'), bad), (e) => { write = e; return true },
    'the writer accepted a document the reader must refuse')
  const read = loadOutcome(writeDoc(dir, 'r.json', bad))
  assert.ok(read.refusal, 'the reader accepted a document the writer refuses')
  assert.equal(write.code, read.refusal.code, 'the two directions must agree on the CODE')

  // Deliberately not asserted at the DETAIL level. `issue: undefined` is the input that
  // proves they cannot agree there: JSON.stringify erases the key, so the writer sees a
  // bad FIELD while the reader sees a missing KEY. Both refuse; a detail-level
  // equivalence assertion would fail a CORRECT implementation.
  const undef = { ...goodDoc(), issue: undefined }
  let write2 = null
  assert.throws(() => RS.saveState(join(dir, 'w2.json'), undef), (e) => { write2 = e; return true })
  const read2 = loadOutcome(writeDoc(dir, 'r2.json', undef))
  assert.ok(read2.refusal)
  assert.equal(write2.code, read2.refusal.code)
  assert.match(read2.refusal.detail, /key set/, 'the reader sees an 8-key document, so its defect is the key set')
})

await test('E4.17/AC4 (cycle 2): the write check rejects nothing a real run produces — the corpus through the REAL saveState port', () => {
  const sp = spec()
  const dir = tmpRoot()
  const path = join(dir, 'run-4.json')
  // Every scenario in this suite stubs `persist`, so a write check stricter than a real
  // run's output would be invisible to all of them. This case wires the real port, so
  // that cost surfaces here rather than after the implementation lands.
  let hops = 0
  const port = (p, s) => { hops++; RS.saveState(p, s) }
  runFlow(sp, { start: 'preflight', maxSteps: 80, statePath: path, persist: port, outcomes: mainLine() })
  runFlow(sp, { start: 'gate_plan', statePath: path, persist: port, outcomes: oneShot('gate_plan', 'pass') })
  runFlow(sp, { start: 'validate', statePath: path, persist: port, outcomes: oneShot('validate', 'incomplete') })
  assert.ok(hops > 3, 'precondition: several real hops must have gone through the real write port')
  assert.deepEqual(Object.keys(RS.loadState(path)).sort(), Object.keys(goodDoc()).sort())
})

await test('E4.18/AC4 (cycle 2): the type contract is TOTAL over the closed key set, and STATE_KEYS is still the nine-key set', () => {
  const dir = tmpRoot()
  // The derived constant must reproduce the value this suite pinned before any field
  // table existed (:1399-1403, asserted over a document a real run produced). The
  // expectation predates the table, so this is not the table asserting itself.
  assert.deepEqual([...RS.STATE_KEYS].sort(),
    ['counters', 'halt', 'history', 'issue', 'pending', 'status', 'step', 'terminal', 'version'])

  assert.ok(RS.STATE_FIELDS && typeof RS.STATE_FIELDS === 'object',
    'engine/run-state.mjs must export the per-field table, so totality is asserted by construction rather than by a hand-maintained list')
  const tableKeys = Object.keys(RS.STATE_FIELDS).sort()
  assert.deepEqual(tableKeys, fieldKeys(), 'the table must cover exactly the closed key set minus version')
  // `true` is inadmissible under every row, so one generator covers the table
  // exhaustively and a field added later without a working predicate fails HERE rather
  // than passing unnoticed. The table supplies the case's INPUT only; the expectation
  // ("refused, typed, naming the field") is authored, and .ok / .expected are not read.
  for (const key of tableKeys) {
    const { refusal } = loadOutcome(writeDoc(dir, `true-${key}.json`, { ...goodDoc(), [key]: true }))
    assert.ok(refusal, `${key}: true was accepted — this field has no working admissibility predicate`)
    assert.equal(refusal.code, 'state-corrupt')
    assert.match(refusal.detail, new RegExp(`field "${key}" is `))
  }
})

await test('E4.19/AC4 (cycle 2): the refusal stops where the design says it stops — the boundary forms still load', () => {
  const dir = tmpRoot()
  const g = goodDoc()
  // A refusal layer's characteristic defect is over-reach, so the boundary is asserted
  // rather than assumed. Each row below is a shape the design deliberately admits; a
  // later, broader check must therefore be a decision rather than a drift.
  const rows = [
    ['history entries are not element-checked', { ...g, history: [{}, { anything: 1 }, { from: 'a', outcome: 'b', to: 'c' }] }],
    ['pending is a nullable OBJECT', { ...g, pending: { step: 'gate_plan', roles: ['evaluator'], request: {} } }],
    ['halt is a nullable OBJECT', { ...g, halt: { reason: 'incomplete', step: 'validate', detail: null } }],
    ['terminal is a nullable STRING', { ...g, terminal: 'escalate' }],
    ['the empty containers initialState() writes', { ...g, counters: {}, history: [] }],
    ['populated counters', { ...g, counters: { 'gate_plan.retry': 3 } }],
    ['counter KEY names are not validated', { ...g, counters: { 'not-a-declared-cap-key': 1 } }],
  ]
  rows.forEach(([why, doc], i) => {
    const { refusal } = loadOutcome(writeDoc(dir, `boundary-${i}.json`, doc))
    assert.ok(!refusal, `over-rejection — ${why}: ${refusal && refusal.detail}`)
  })
})

await test('E4.20/AC4 (cycle 2): the rejection message reports the field and its types — it never echoes the untrusted VALUE', () => {
  const dir = tmpRoot()
  // The message is the only new externally visible surface, and it reaches stderr
  // through engine/cli.mjs. It is safe by construction — the key comes from the trusted
  // table, the type word from a fixed vocabulary, the expected phrase from the table —
  // but nothing holds it there, so a later "improve the message" edit that appends the
  // offending value would regress it silently. Held as a case.
  const marker = 'UNTRUSTED-9f3c1a-VALUE'
  const rows = [['history', marker], ['halt', marker], ['step', [marker]], ['counters', { [`${marker}-key`]: marker }]]
  for (const [key, value] of rows) {
    const { refusal } = loadOutcome(writeDoc(dir, `echo-${key}.json`, { ...goodDoc(), [key]: value }))
    assert.ok(refusal, `${key}: the document was accepted`)
    assert.match(refusal.detail, new RegExp(`field "${key}" is `), `${key}: the message must still be actionable`)
    assert.ok(refusal.detail.includes(EXPECTED_PHRASE[key]), `${key}: the message must still report the expected type`)
    assert.ok(!refusal.detail.includes(marker), `${key}: the detail echoes the untrusted value — ${refusal.detail}`)
    assert.ok(!refusal.message.includes(marker), `${key}: the message echoes the untrusted value — ${refusal.message}`)
  }
})

// ================================================================================
// GROUP 4 (cycle 3) — the STATED contract, and its deliberately unenforced half
// ================================================================================
//
// Authored from .autoflow/issue-4-verification-design.md (cycle 3) §2/§3 and the
// acceptance criterion .autoflow/issue-4-c3-acceptance-criterion.md, before the
// implementation — not from it. Cycle 1 closed a missing skeleton check, cycle 2 a
// missing field-TYPE check, and each closed one witness. The complaint class did not
// terminate, because engine/run-state.mjs states no criterion for where admission
// STOPS: with nothing written down, one more unvalidated shape can always be named.
//
// The rule this cycle ships (feature design §1.1), transcribed here so a reader of
// the suite finds the criterion beside the cases that enforce it:
//
//   A persisted state document is admitted iff every value the engine will ACT ON
//   after reading it back has the type that action requires.
//     R1 — enforce what is dereferenced, used as a key/index, spread, or counted on.
//     R2 — stop at pass-through: a value only carried into an event, a notify record
//          or history cannot crash the executor and cannot forge a budget.
//     R3 — types and shapes, never value domains: "is this a string?" is a document
//          property; "is this a spec step id?" is the document's agreement with a
//          spec the loader does not hold.
//
// Both halves are held here, and the second half is the one that makes this a
// contract rather than a patch. The ENFORCED half is E4.21/E4.21b/E4.25/E4.29. The
// UNENFORCED half is E4.24(ii)/(iii) and E4.27: if a path STATE_UNENFORCED declares
// open silently BECAME enforced, those cases go red. A declaration whose "we
// deliberately do not check X" is untested is documentation, not a contract.
//
// Oracle discipline is cycle 2's, extended to depth (verification §3.4). The
// declaration supplies INPUTS and names the partition under test; it never supplies
// an expectation. No case reads `.ok` or `.expected`, no case reads a fixture's own
// `.ok`/`.expected` verdict field, and the nested refusal phrase is PROSE_SOURCED
// from feature design §4.3 rather than read off the table it is asserted against.
//
// Housekeeping (GATE:PLAN cycle-3 carry condition 5): verification §2's superseded
// three-bucket "Method" sentence is NOT transcribed anywhere below. The classifier
// implements the binding five-bucket partition of §2/§3.1 only.

// The three clause ids the rule defines. Authored from feature design §1.1, so a row
// carrying an invented clause fails rather than being absorbed.
const CLAUSES = Object.freeze(['R1', 'R2', 'R3'])

// ---- the generated corpus (verification design §3.1, rejection side) -----------
//
// 14 paths x 7 witness forms = 98 rows. The eight top-level paths come from
// fieldKeys() — derived from a document a real run persisted, NOT from the engine's
// table — and the six nested paths are authored from §0.1's consumption table. The
// nested six are authored on purpose: a generator that shrank with the declaration
// could never witness a path the declaration forgot.
const NESTED_PROBE_PATHS = Object.freeze([
  'halt.detail', 'halt.reason', 'halt.step',
  'pending.request', 'pending.roles', 'pending.step',
])
const ABSENT = Symbol('absent')
const WITNESS_FORMS = Object.freeze([...WITNESSES, ABSENT])
const witnessWord = (w) => (w === ABSENT ? 'absent' : tagOf(w))

// Parent containers a real run persists (engine/flow.mjs:232 for `pending`,
// engine/flow.mjs:271 for `halt`), so a nested witness perturbs an otherwise
// legitimate document rather than one this case invented.
const delegatingDoc = () => ({
  ...goodDoc(), step: 'gate_plan', status: 'delegating',
  pending: { step: 'gate_plan', roles: ['evaluator'], request: { role: 'evaluator' } },
})
const haltedDoc = () => ({
  ...goodDoc(), step: 'validate', status: 'halted',
  halt: { reason: 'incomplete', step: 'validate', detail: null },
})

const baseFor = (path) => (path.startsWith('pending.') ? delegatingDoc()
  : path.startsWith('halt.') ? haltedDoc() : goodDoc())

function placeWitness(path, witness) {
  const doc = baseFor(path)
  const seg = path.split('.')
  const container = seg.length === 1 ? doc : doc[seg[0]]
  const leaf = seg[seg.length - 1]
  if (witness === ABSENT) delete container[leaf]
  else container[leaf] = witness
  return doc
}

const corpusPaths = () => [...fieldKeys(), ...NESTED_PROBE_PATHS].sort()

function generatedRows() {
  const rows = []
  for (const path of corpusPaths()) {
    for (const w of WITNESS_FORMS) {
      rows.push({ path, id: `${path}=${witnessWord(w)}`, doc: placeWitness(path, w) })
    }
  }
  return rows
}

// ---- the classifier (verification design §3.1, BINDING leg) --------------------
//
// The executor leg is runFlow() + mainLine() + this suite's wired mechanical effect
// records — the one component here that already supplies a correct per-step
// delegation outcome. A hand-rolled two-hop advance() loop withholds
// env.delegationOutput on hop 0 and kills every pending.roles / pending.request row
// at engine/routing.mjs:75, which would report the HARNESS as the document's
// consequence and reverse this cycle's central finding. The
// `classify(goodDoc()) === BENIGN` precondition below is what makes that trap a red
// harness instead of a false product finding.

// Trap C, measured at RED and not predicted by the verification design. runFlow()
// consults its outcome oracle on the ACTIVE step id BEFORE calling advance(), and a
// null answer means "stop here". An unresolvable id — `undefined` from `pending: {}`,
// or `'bogus'` from `step` — is not in MAIN_LINE, so every oracle answers null and the
// driver BREAKS WITHOUT EVER ENTERING THE EXECUTOR. Measured consequence at b6377f6:
// the classifier reported FAULT-UNTYPED = 0 and BENIGN = 53, i.e. it certified the
// reviewer's own witness as harmless. This is the same class as §0.2's traps A and B —
// the harness, not the document — and it is why the precondition and this wrapper are
// load-bearing rather than decorative. The wrapper answers a probe outcome for an id
// the SPEC does not carry, so advance() runs and its real consequence is observed,
// while a legitimate stop at a resolvable step (handoff → null) is untouched.
const PROBE_OUTCOME = 'probe-unresolvable-step-id'
const probing = (oracle) => (s, ctx) => {
  const o = oracle(s, ctx)
  return o == null && !mhas(spec().steps, s) ? PROBE_OUTCOME : o
}

// The engine error classes a typed fault may be an instance of. Read as a class
// LIST, not as an oracle: the expectation ("an accepted document may only fault
// typed") is authored. FLOW.StepResolutionError does not exist at b6377f6 and is
// filtered out rather than crashing the filter.
const declaredErrorClasses = () => [
  RS.StateCorruptError, RS.StateVersionError, MECH.EffectsNotWiredError,
  MECH.StepIncompleteError, FLOW.SlotUnsourcedError, FLOW.MissingSlotError,
  FLOW.StepResolutionError,
].filter((c) => typeof c === 'function')

// Class and `code`, never the message. Feature design §4.4 preserves
// `no such step: ${id}` byte-for-byte, so a message-based discriminator would
// classify the pre-change bare Error identically and this whole case would be green
// at b6377f6. The message's STABILITY is asserted separately, by E4.33(i).
const isTypedEngineError = (e) => !!e
  && typeof e.code === 'string' && e.code !== ''
  && e.constructor !== Error
  && declaredErrorClasses().some((C) => e instanceof C)

// A spent budget that did not survive the resume. Compared against the document the
// loader RETURNED, so the reference is the input rather than a second expectation.
function capViolated(input, final) {
  const before = input && input.counters
  if (!before || typeof before !== 'object' || Array.isArray(before)) return false
  const after = final && final.counters
  if (!after || typeof after !== 'object') return true
  return Object.keys(before).some((k) => !(k in after) || after[k] < before[k])
}

let _classifyDir = null
function classify(doc, name) {
  if (!_classifyDir) _classifyDir = tmpRoot()
  const p = writeDoc(_classifyDir, `${String(name).replace(/[^\w=.-]/g, '_')}.json`, doc)
  const { doc: loaded, refusal } = loadOutcome(p)
  if (refusal) return { bucket: 'REFUSED', refusal }
  let r = null
  let err = null
  try {
    r = runFlow(spec(), { state: loaded, outcomes: probing(mainLine()), persist: () => {}, statePath: p, maxSteps: 80 })
  } catch (e) { err = e }
  if (err) {
    if (err.code === 'effects-not-wired') return { bucket: 'UNREACHABLE', err }
    return { bucket: isTypedEngineError(err) ? 'FAULT-TYPED' : 'FAULT-UNTYPED', err }
  }
  if (capViolated(loaded, r.state)) return { bucket: 'CAP-VIOLATION', r }
  return { bucket: 'BENIGN', r }
}

const BUCKETS = Object.freeze(['REFUSED', 'BENIGN', 'FAULT-TYPED', 'FAULT-UNTYPED', 'CAP-VIOLATION', 'UNREACHABLE'])

// One measurement, shared by E4.22 (the rule), E4.24 (the honesty of the unenforced
// set) and E4.33(iii) — one mechanism on the test side too, and the executor runs
// once per accepted shape rather than once per case.
let _classified = null
function classifiedCorpus() {
  if (_classified) return _classified
  _classified = generatedRows().map((row) => ({ ...row, ...classify(row.doc, row.id) }))
  return _classified
}
function bucketCounts() {
  const c = Object.fromEntries(BUCKETS.map((b) => [b, 0]))
  for (const r of classifiedCorpus()) c[r.bucket]++
  return c
}
const countLine = () => BUCKETS.map((b) => `${b}=${bucketCounts()[b]}`).join(' ')

// ---- the declaration, read as INPUT only (verification design §3.4) ------------

// Every path the enforced table declares: the top-level rows, plus one level of
// `shape` rows. Path SETS are the subject of the coverage claims below; `.ok` and
// `.expected` are never read.
function declaredPaths() {
  const t = RS.STATE_FIELDS || {}
  const out = []
  for (const k of Object.keys(t)) {
    out.push(k)
    const shape = t[k] && t[k].shape
    if (shape && typeof shape === 'object') for (const sk of Object.keys(shape)) out.push(`${k}.${sk}`)
  }
  return out.sort()
}
const unenforcedRows = () => (Array.isArray(RS.STATE_UNENFORCED) ? RS.STATE_UNENFORCED : [])
const unenforcedPaths = () => unenforcedRows().map((r) => r && r.path).filter((p) => typeof p === 'string')

// The per-row honesty predicate, factored out so E4.31 can apply it to a MUTATED row
// without touching the engine.
function unenforcedRowFault(row) {
  if (!row || typeof row !== 'object') return 'the row is not an object'
  if (typeof row.path !== 'string' || row.path.trim() === '') return 'the row carries no path'
  if (!CLAUSES.includes(row.clause)) return `clause ${JSON.stringify(row.clause)} is not one of ${CLAUSES.join('/')}`
  if (typeof row.reason !== 'string' || row.reason.trim() === '') return 'the reason is empty — a reason a machine cannot read is a comment'
  return null
}

// A document carrying a deliberately odd value at an unenforced path. Pattern
// segments are resolved generically — `*` is an arbitrary (undeclared) map key,
// `*.value` the magnitude stored under a declared one, `[]` one array element — so a
// row the design never listed still gets a witness instead of being skipped.
function unenforcedWitnessDoc(path, value) {
  const doc = goodDoc()
  const segs = path.replace(/\[\]/g, '.[]').split('.').filter(Boolean)
  const [head, ...rest] = segs
  const key = rest.join('.')
  if (head === 'counters') {
    if (key === '') return { ...doc, counters: { 'gate_plan.retry': 1 } }
    return { ...doc, counters: key === '*' ? { 'no-such-declared-cap-key': 1 } : { 'gate_plan.retry': 0 } }
  }
  if (head === 'history') {
    if (key === '') return { ...doc, history: [] }
    return { ...doc, history: [key === '[]' ? { unread: value } : { [rest[rest.length - 1]]: value }] }
  }
  if (head === 'pending') {
    return { ...doc, status: 'delegating', pending: { step: 'gate_plan', [key || 'step']: value } }
  }
  if (head === 'halt') {
    return { ...doc, status: 'halted', halt: { reason: 'incomplete', step: 'validate', detail: null, [key || 'reason']: value } }
  }
  return { ...doc, [head]: value }
}

// ---- the totality hook's extractor (verification design §8.3) ------------------
//
// Pure functions of (source text, path sets), so E4.31 can apply a mutation to the
// INPUTS and demonstrate the kill without editing engine/**.

// A trailing segment produced by an intrinsic rather than by the document. The value
// read is the Array's own, so no witness can be placed at it and no row can be
// written for it — it normalises to its parent. Stated as a rule, so a later
// `state.counters.length` normalises the same way without a second decision.
const INTRINSIC_TAILS = Object.freeze(['length'])

function extractStateReads(sources) {
  const found = new Set()
  for (const src of sources) {
    for (const line of src.split('\n')) {
      // Drop import lines: the specifier './run-state.mjs' otherwise yields the
      // phantom path `mjs`, measured at b6377f6 rather than predicted.
      if (/^\s*import\b/.test(line) || /\bfrom\s+['"]/.test(line)) continue
      for (const m of line.matchAll(/\bstate\.[A-Za-z_]\w*(?:\.[A-Za-z_]\w*)*/g)) {
        const segs = m[0].slice('state.'.length).split('.')
        if (segs.length > 1 && INTRINSIC_TAILS.includes(segs[segs.length - 1])) segs.pop()
        found.add(segs.join('.'))
      }
    }
  }
  return [...found].sort()
}

// One-way (coverage) on purpose: the converse — every declared path is read — would
// forbid the retained pass-through rows, which exist precisely because nothing reads
// them. The declarations supply the COVERING set and the engine source the COVERED
// set; neither supplies the other, and no `.ok`/`.expected` is consulted.
const uncoveredReads = (reads, declared, open) => {
  const cover = new Set([...declared, ...open])
  return reads.filter((p) => !cover.has(p))
}

// ---- pinned integers ----------------------------------------------------------
//
// [carry condition 1, GATE:PLAN cycle 3] These are RE-MEASURED under §3.1's BINDING
// leg at RED and pinned here as literals. They are NOT verification §0.2's legs
// (a)-(c) numbers, which were measured under three executor legs §3.1 subsequently
// withdrew as measurably wrong; the divergence is reported in the RED report rather
// than absorbed. The pins below are stated as the POST-change expectation, which is
// why the pinned case is red at b6377f6.
const CORPUS_ROWS = 98                 // 14 paths x 7 witness forms
const REFUSED_AT_BASE = 45             // measured at b6377f6, binding leg
const BENIGN_AT_BASE = 44              // measured at b6377f6, binding leg
// Seven rows move from accepted to REFUSED under the `shape` row, and their
// COMPOSITION is not the verification design's: the six NON-STRING `pending.step`
// witnesses (null, true, 42, [], {}, absent) plus the reviewer's own `pending: {}`
// witness, whose refusal also derives from the `pending.step` row. `pending.step: 'x'`
// is a STRING, so no type row can refuse it — it stays ACCEPTED and must fault TYPED,
// which is why the R3 row for `pending.step` is load-bearing rather than decorative.
const REFUSED_MOVED = 7
const REFUSED_EXPECTED = REFUSED_AT_BASE + REFUSED_MOVED
const ACCEPTED_EXPECTED = CORPUS_ROWS - REFUSED_EXPECTED
// BENIGN is INVARIANT across the change — the machine form of AC-C3 point 6, and the
// pin this cycle is most likely to trip. The rows that move were faults, not benign
// ones, so a BENIGN that shrinks is over-rejection.
const BENIGN_EXPECTED = BENIGN_AT_BASE
const FAULT_TYPED_EXPECTED = ACCEPTED_EXPECTED - BENIGN_EXPECTED

await test('E4.21/AC-C3-1 (cycle 3): the DECLARATION is the contract — every refusal is attributable to a declared row, and a row exists wherever the rule requires one', () => {
  assert.ok(RS.STATE_FIELDS && typeof RS.STATE_FIELDS === 'object', 'the enforced half must be one exported declaration')
  assert.ok(Object.isFrozen(RS.STATE_FIELDS), 'the declaration must be frozen — a mutable contract is not a contract')
  assert.deepEqual([...RS.STATE_KEYS].sort(), [...Object.keys(RS.STATE_FIELDS), 'version'].sort(),
    'STATE_KEYS must stay DERIVED from the declaration, so the key set and the field set cannot drift')

  const declared = new Set(declaredPaths())
  const rows = classifiedCorpus()
  assert.equal(rows.length, CORPUS_ROWS, 'precondition: the generated corpus must span every path x witness form')

  // (a) Attribution. A refusal whose detail names a path the declaration does not
  // carry is a check living OUTSIDE the contract — the hand-added branch AC-C3
  // point 2 forbids. The key-set and version rejections are the two declared
  // non-field routes and are named here rather than pattern-matched loosely.
  const unattributed = []
  for (const r of rows) {
    if (r.bucket !== 'REFUSED') continue
    if (r.refusal.code === 'state-version') continue
    const m = /field "([^"]+)" is /.exec(r.refusal.detail || '')
    if (!m) {
      if (/key set/.test(r.refusal.detail || '')) continue
      unattributed.push(`${r.id} -> ${r.refusal.detail}`)
      continue
    }
    if (!declared.has(m[1])) unattributed.push(`${r.id} -> names undeclared path "${m[1]}"`)
  }
  assert.deepEqual(unattributed, [], `refusals that no declared row accounts for: ${unattributed.join(' | ')}`)

  // (b) The other direction, which is what makes this red rather than decorative: a
  // path at which an ACCEPTED document reaches an UNTYPED executor fault is a path
  // the rule's R1 clause requires the contract to hold, so it must be declared.
  const missing = [...new Set(rows.filter((r) => r.bucket === 'FAULT-UNTYPED').map((r) => r.path))]
    .filter((p) => !declared.has(p))
  assert.deepEqual(missing, [],
    'the loader accepted documents that then died UNTYPED inside the executor at paths the declaration '
    + `does not carry: ${missing.join(', ')} — declared paths are [${[...declared].join(', ')}] (${countLine()})`)
})

await test('E4.21b/AC-C3-2 (cycle 3): totality at the declared DEPTH — one inadmissible value at every declared path is refused, typed, naming that path', () => {
  const dir = tmpRoot()
  const paths = declaredPaths()
  // The contract's depth is a property of the DECLARATION, not of a branch bolted on
  // beside it (AC-C3 points 1-2). Authored expectation, not a reading of the table's
  // correctness: if the depth lives anywhere else, a row cannot be what adds it.
  const nested = paths.filter((p) => p.includes('.'))
  assert.ok(nested.length > 0,
    'the declaration expresses no depth at all — every nested constraint therefore lives in a branch, '
    + `which is what AC-C3 point 2 forbids (declared: [${paths.join(', ')}])`)

  // `true` is inadmissible under every row this contract can carry, so one generator
  // covers the declaration exhaustively and a path added later without a working
  // predicate fails HERE. The declaration supplies the INPUT; the expectation
  // ("refused, typed, naming the path") is authored.
  for (const path of paths) {
    const { refusal } = loadOutcome(writeDoc(dir, `total-${path.replace(/\./g, '_')}.json`, placeWitness(path, true)))
    assert.ok(refusal, `${path}: true was accepted — this declared path has no working admissibility predicate`)
    assert.equal(refusal.code, 'state-corrupt', `${path}: the refusal must keep the code every existing caller reads`)
    assert.match(refusal.detail, new RegExp(`field "${path.replace(/\./g, '\\.')}" is `),
      `${path}: the refusal does not name the path that was mutated: ${refusal.detail}`)
  }
})

await test('E4.22/AC-C3-OQ (cycle 3): the consumption classifier — an accepted document is BENIGN or faults TYPED at a recorded path, and nothing else', () => {
  // The precondition that converts §0.2's two harness traps into a red harness rather
  // than a false finding about the documents. Under every executor leg the
  // verification design measured and withdrew, this line fails.
  const reference = classify(goodDoc(), 'classifier-precondition')
  assert.equal(reference.bucket, 'BENIGN',
    'precondition: the unmodified reference document must classify BENIGN before any row is scored — '
    + `it classified ${reference.bucket} (${reference.err ? `${reference.err.name}: ${reference.err.message}` : ''}${reference.refusal ? reference.refusal.detail : ''}), `
    + 'so the classifier is measuring the harness, not the documents')

  const rows = classifiedCorpus()
  const c = bucketCounts()
  const accepted = rows.length - c.REFUSED
  const recorded = new Set(unenforcedPaths())
  const declared = new Set(declaredPaths())

  // The rule. accepted => (BENIGN | FAULT-TYPED), where FAULT-TYPED is admitted ONLY
  // when the unenforced half records a row naming the faulting path — so a typed
  // fault at an UNDECLARED path is still a failure. FAULT-UNTYPED and CAP-VIOLATION
  // on an accepted document are unconditional failures.
  const violations = []
  for (const r of rows) {
    if (r.bucket === 'REFUSED') {
      if (!declared.has(r.path)) violations.push(`${r.id}: REFUSED at a path the declaration does not mark enforced`)
      continue
    }
    if (r.bucket === 'BENIGN') continue
    if (r.bucket === 'FAULT-TYPED') {
      if (!recorded.has(r.path)) violations.push(`${r.id}: faults TYPED but no STATE_UNENFORCED row names "${r.path}"`)
      continue
    }
    violations.push(`${r.id}: ${r.bucket} — ${r.err ? `${r.err.name}: ${r.err.message}` : 'no error'}`)
  }
  assert.deepEqual(violations, [], `${violations.length} row(s) break the rule (${countLine()}):\n        ${violations.join('\n        ')}`)

  // Vacuity guard — the partition IDENTITY, which a classifier that stops measuring
  // cannot satisfy because an unobserved row has no bucket, plus the pinned literals.
  assert.equal(c.BENIGN + c['FAULT-TYPED'] + c['FAULT-UNTYPED'] + c['CAP-VIOLATION'], accepted,
    `the partition is not total over the accepted shapes — some row has no observed consequence (${countLine()})`)
  assert.equal(c.UNREACHABLE, 0, `the executor leg is mis-wired: ${countLine()}`)
  assert.equal(c.REFUSED, REFUSED_EXPECTED, `REFUSED moved off its pin (${countLine()})`)
  assert.equal(accepted, ACCEPTED_EXPECTED, `accepted moved off its pin (${countLine()})`)
  assert.equal(c.BENIGN, BENIGN_EXPECTED, `BENIGN is not invariant across the change — the contract over-rejects (${countLine()})`)
  assert.equal(c['FAULT-TYPED'], FAULT_TYPED_EXPECTED, `the observed-and-typed floor moved (${countLine()})`)
})

await test('E4.23/AC-C3-5 (cycle 3): no loader-accepted TYPE fault can restart a spent budget', () => {
  const sp = spec()
  const dir = tmpRoot()
  const capKey = 'gate_plan.retry'
  const cap = RT.capValue(sp, capKey)
  const spentBase = () => ({ ...goodDoc(), step: 'gate_plan', counters: { [capKey]: cap } })
  const resume = (state, tag) => runFlow(sp, {
    state, maxSteps: 12, statePath: join(dir, `${tag}.json`), persist: () => {}, outcomes: probing(oneShot('gate_plan', 'fail')),
  })

  // The reference is MEASURED, not authored: with the budget intact on disk the
  // resume refuses the retry and routes to the declared exhaustion target.
  const ref = resume(JSON.parse(JSON.stringify(spentBase())), 'reference')
  const refLast = ref.trace[ref.trace.length - 1]
  assert.ok(refLast && refLast.exhausted, 'precondition: a resume carrying the spent budget must refuse the retry')

  // Scope, narrowed by the design (verification §2 / feature §1.3 `counters.*.value`):
  // the generator perturbs counters BY TYPE TAG only. `counters: {}` and
  // `counters: {'gate_plan.retry': 0}` are well-typed TAMPERING, declared out of the
  // threat model, so `counters` rows are excluded here by declaration rather than
  // discovered as a red row.
  const rows = generatedRows().filter((r) => r.path !== 'counters')
  assert.ok(rows.length > CORPUS_ROWS - 10, 'precondition: only the counters rows are out of scope')

  const escaped = []
  let drivenAccepted = 0
  for (const row of rows) {
    const doc = { ...row.doc, ...spentBase(), ...(row.path.startsWith('counters') ? {} : {}) }
    // Re-place the witness on the spent-budget base so the mutation, not the base,
    // is what varies.
    const seg = row.path.split('.')
    if (seg.length === 1) {
      if (!(seg[0] in row.doc)) delete doc[seg[0]]
      else doc[seg[0]] = row.doc[seg[0]]
    } else {
      doc[seg[0]] = row.doc[seg[0]]
    }
    doc.counters = { [capKey]: cap }
    const p = writeDoc(dir, `spent-${row.id.replace(/[^\w=.-]/g, '_')}.json`, doc)
    const { doc: loaded, refusal } = loadOutcome(p)
    if (refusal) continue
    drivenAccepted++
    let r = null
    let err = null
    try { r = resume(loaded, `run-${drivenAccepted}`) } catch (e) { err = e }
    if (err) {
      if (!isTypedEngineError(err)) escaped.push(`${row.id}: stopped UNTYPED — ${err.name}: ${err.message}`)
      continue
    }
    const spent = r.state.counters && r.state.counters[capKey]
    if (!(typeof spent === 'number' && spent >= cap)) {
      escaped.push(`${row.id}: the resume finished with ${capKey} = ${JSON.stringify(spent)}, below the ${cap} already spent`)
      continue
    }
    const granted = r.trace.find((e) => e.capKey === capKey && !e.exhausted)
    if (granted) escaped.push(`${row.id}: the resume was granted a fresh retry on an exhausted budget`)
  }
  assert.ok(drivenAccepted > 10, `precondition: the corpus must exercise many accepted resumes, drove ${drivenAccepted}`)
  assert.deepEqual(escaped, [], `documents that escaped the cap invariant:\n        ${escaped.join('\n        ')}`)
})

await test('E4.24/AC-C3-3 (cycle 3): the UNENFORCED half is declared, honest, and honest BY MEASUREMENT', () => {
  const rows = unenforcedRows()
  assert.ok(Array.isArray(RS.STATE_UNENFORCED),
    'engine/run-state.mjs exports no STATE_UNENFORCED — the boundary is stated in one direction only, so '
    + '"you did not validate X" has nothing to point at and the next cycle re-opens the depth question')
  assert.ok(rows.length > 0, 'the unenforced half is empty — every path the rule leaves open is then an omission, not a decision')
  assert.ok(Object.isFrozen(RS.STATE_UNENFORCED), 'the unenforced half must be frozen data, not a mutable note')

  const declared = new Set(declaredPaths())

  // The partition is asserted FIRST (feature §3.2's stated invariant), so a future row
  // that is neither form fails here rather than silently skipping clause (ii).
  const illFormed = rows.filter((r) => {
    if (!r || typeof r.path !== 'string') return true
    return declared.has(r.path) && r.clause !== 'R3'
  })
  assert.deepEqual(illFormed.map((r) => (r && r.path) || String(r)), [],
    'a row whose path IS type-enforced must record clause R3 (the value DOMAIN is open while the type is not); '
    + 'anything else makes the two tables contradict each other')

  // (i) the reason is machine-readable DATA on the row, with a clause from the rule.
  const faults = rows.map((r) => [r && r.path, unenforcedRowFault(r)]).filter(([, f]) => f !== null)
  assert.deepEqual(faults, [], `unenforced rows that do not carry a usable decision: ${faults.map(([p, f]) => `${p}: ${f}`).join(' | ')}`)

  // (ii) THE OVER-REJECTION GUARD, and the half that makes this a contract: for every
  // row with no type row of its own, a witness placed at that path must LOAD. If a
  // deliberately-open path silently became enforced, this reds. Scoped to undeclared
  // paths — a witness of 42 at a type-enforced path is correctly refused, so applying
  // (ii) there would go red on exactly the rows it exists to bless.
  const dir = tmpRoot()
  const overRejected = []
  let openRows = 0
  for (const r of rows) {
    if (declared.has(r.path)) continue
    openRows++
    const doc = unenforcedWitnessDoc(r.path, 42)
    assert.notDeepEqual(doc, goodDoc(), `${r.path}: the witness builder produced an unmodified document — clause (ii) would be vacuous`)
    const { refusal } = loadOutcome(writeDoc(dir, `open-${r.path.replace(/[^\w]/g, '_')}.json`, doc))
    if (refusal) overRejected.push(`${r.path}: declared UNENFORCED but refused — ${refusal.detail}`)
  }
  assert.ok(openRows > 0, 'precondition: the unenforced half must carry at least one genuinely open path')
  assert.deepEqual(overRejected, [], `rows the declaration calls open that the loader in fact refuses:\n        ${overRejected.join('\n        ')}`)

  // (iii) the stated reason is TRUE, not asserted: the measured executor consequence
  // of a witness at each unenforced path is benign or typed. For the R3 rows whose
  // TYPE is enforced this is the substantive half — it is what proves the fault is
  // FAULT-TYPED rather than the untyped crash the reviewer reported.
  const dishonest = []
  for (const r of rows) {
    const value = declared.has(r.path) ? 'no-such-value-in-any-domain' : 42
    const v = classify(unenforcedWitnessDoc(r.path, value), `unenforced-${r.path.replace(/[^\w]/g, '_')}`)
    if (v.bucket === 'REFUSED') continue
    if (v.bucket === 'BENIGN' || v.bucket === 'FAULT-TYPED') continue
    dishonest.push(`${r.path}: recorded ${r.clause} "${r.reason}" but a witness there classifies ${v.bucket}`
      + `${v.err ? ` — ${v.err.name}: ${v.err.message}` : ''}`)
  }
  assert.deepEqual(dishonest, [], `unenforced rows whose stated reason is contradicted by measurement:\n        ${dishonest.join('\n        ')}`)
})

await test('E4.25/AC-C3 (cycle 3): the reviewer\'s witness — pending: {} — is refused as a CONSEQUENCE of a row, naming the declared path', () => {
  const dir = tmpRoot()
  const rows = [
    ['pending: {} — the reported witness', { ...goodDoc(), pending: {} }, 'pending.step'],
    ['pending: { step: 42 } — the same row, one level of type', { ...goodDoc(), pending: { step: 42 } }, 'pending.step'],
    ['pending: [] — an array is not a nullable object', { ...goodDoc(), pending: [] }, 'pending'],
  ]
  for (const [why, doc, path] of rows) {
    const { doc: got, refusal } = loadOutcome(writeDoc(dir, `witness-${path}-${why.length}.json`, doc))
    assert.ok(refusal, `${why}: ACCEPTED (pending = ${JSON.stringify(got && got.pending)}) — the document reaches the executor, `
      + 'which dereferences state.pending.step at engine/flow.mjs:288 and throws a raw, unnamed Error one layer below the boundary that must refuse it')
    assert.equal(refusal.code, 'state-corrupt', `${why}: the refusal must keep the code every existing caller reads`)
    assert.ok(refusal instanceof RS.StateCorruptError, `${why}: the refusal must be the typed load-boundary error`)
    assert.match(refusal.detail, new RegExp(`field "${path.replace('.', '\\.')}" is `),
      `${why}: the refusal must name the declared path it derives from, not the witness shape: ${refusal.detail}`)
  }
  // No branch may mention the witness. A special case for `{}` satisfies the three
  // rows above and still leaves the class open, which is the whole of AC-C3 point 2.
  const src = engineSrc('run-state.mjs')
  assert.ok(!/pending\s*[=!]==?\s*\{\s*\}|Object\.keys\(\s*\w*pending/.test(src),
    'the refusal is implemented as a hand-written branch about `pending`, not as a row of the declaration')
})

await test('E4.26/AC-C3-5 (cycle 3): a resume that cannot proceed stops TYPED — the failure CLASS, not only the witness', () => {
  const sp = spec()
  const rows = [
    ['pending: { step: "nope" } — well-typed, right shape, unresolvable', { ...goodDoc(), step: 'gate_plan', status: 'delegating', pending: { step: 'nope', roles: [], request: {} } }],
    ['step: "bogus" — a field cycle 2 already type-checks, pending not involved at all', { ...goodDoc(), step: 'bogus' }],
  ]
  for (const [why, doc] of rows) {
    let err = null
    try {
      runFlow(sp, { state: doc, outcomes: probing(mainLine()), persist: () => {}, statePath: SCRATCH_STATE, maxSteps: 4 })
    } catch (e) { err = e }
    assert.ok(err, `${why}: the resume did not stop at all`)
    // Class and code only. The message string is asserted in E4.33(i) as a
    // PRESERVATION property and deliberately never here: a message assertion is green
    // at b6377f6 and would let the "revert to a bare Error, keep the text" mutant live.
    assert.ok(typeof FLOW.StepResolutionError === 'function',
      `${why}: engine/flow.mjs exports no typed error for an unresolvable step id, so the resume escapes as ${err.name}: ${err.message}`)
    assert.ok(err instanceof FLOW.StepResolutionError, `${why}: the stop is ${err.name}, not the typed StepResolutionError`)
    assert.equal(err.code, 'no-such-step', `${why}: the typed stop must carry a stable machine-readable code`)
    assert.notEqual(err.constructor, Error, `${why}: a bare Error carries no identity a caller can branch on`)
  }
})

await test('E4.27/AC-C3-6 (cycle 3): no over-rejection — every document a real run persists still loads, and the cycle-3 boundary forms with it', () => {
  const dir = tmpRoot()
  const docs = acceptanceCorpus()
  assert.ok(docs.length > 3, 'precondition: the corpus must span several persisted hops')
  docs.forEach((s, i) => {
    const { refusal } = loadOutcome(writeDoc(dir, `c3-corpus-${i}.json`, s))
    assert.ok(!refusal, `a document a real run persisted was refused by the deeper contract: ${refusal && refusal.detail}`)
  })
  // The boundary forms this cycle measured. Each is a shape the rule deliberately
  // admits, so a broader check must be a decision rather than a drift.
  const g = goodDoc()
  const rows = [
    ['a delegating document with NO roles and NO request resumes correctly (M4)', { ...g, step: 'gate_plan', status: 'delegating', pending: { step: 'gate_plan' } }],
    ['pending carries junk beside step — nested key sets stay OPEN', { ...g, status: 'delegating', pending: { step: 'gate_plan', junk: 1 } }],
    ['halt: {} on a halted document is pass-through only (M6)', { ...g, status: 'halted', halt: {} }],
    ['halt internals are unenforced', { ...g, status: 'halted', halt: { reason: 42, step: [], detail: {} } }],
    ['a status outside {running,delegating,halted} is a value DOMAIN, not a type (M5)', { ...g, status: 'bogus' }],
    ['a step id the spec does not carry is the document\'s agreement with a spec, not a document property', { ...g, step: 'bogus' }],
    ['history elements are still not element-checked', { ...g, history: [{}, { anything: 1 }] }],
    ['counter KEY names are still not validated', { ...g, counters: { 'not-a-declared-cap-key': 1 } }],
  ]
  rows.forEach(([why, doc], i) => {
    const { refusal } = loadOutcome(writeDoc(dir, `c3-boundary-${i}.json`, doc))
    assert.ok(!refusal, `over-rejection — ${why}: ${refusal && refusal.detail}`)
  })
})

await test('E4.28/AC-C3-4 (cycle 3): the contract is reachable from the PR — it is stated in a git-tracked file on the diff surface, not in a gitignored artifact', () => {
  const file = 'engine/run-state.mjs'
  assert.ok(!file.startsWith('.autoflow/'), 'a contract stated only in a gitignored artifact is invisible to a reviewer by construction')
  let tracked = true
  try { execFileSync('git', ['ls-files', '--error-unmatch', file], { cwd: root, stdio: 'ignore' }) } catch { tracked = false }
  assert.ok(tracked, `${file} is not git-tracked, so the contract never appears on a reviewed diff`)

  const src = engineSrc('run-state.mjs')
  assert.ok(/STATE_UNENFORCED/.test(src), `${file} does not state the unenforced half, so the boundary is stated in one direction only`)
  // Every clause a row cites must be resolvable by a reviewer reading THIS file: the
  // row says "R2" and the file must say what R2 is. A clause id with no statement
  // beside it is the prose-versus-data split the declaration exists to end.
  const cited = [...new Set(unenforcedRows().map((r) => r && r.clause).filter(Boolean))].sort()
  assert.ok(cited.length > 0, 'no clause is cited by any row — the rows record no rule at all')
  for (const clause of cited) {
    assert.match(src, new RegExp(`^\\s*//.*\\b${clause}\\b`, 'm'),
      `${file} cites clause ${clause} on a row but never states what ${clause} is`)
  }
})

await test('E4.29/AC-C3-2 (cycle 3): the write side inherits the new depth through the SAME pass — nothing can be written that cannot be read back', () => {
  const dir = tmpRoot()
  const path = join(dir, 'run-4.json')
  const bad = { ...goodDoc(), pending: {} }
  let write = null
  assert.throws(() => RS.saveState(path, bad), (e) => { write = e; return true },
    'saveState persisted a document its own loader refuses — the deeper contract landed at the read boundary only')
  const read = loadOutcome(writeDoc(dir, 'r.json', bad))
  assert.ok(read.refusal, 'precondition: the reader must refuse the witness')
  assert.equal(write.code, read.refusal.code, 'the two directions must agree on the CODE (not on the detail — verification §3.2)')
  // Ordering, exactly as E4.15 pins it one level up: a check placed one line late
  // leaves run-4.json.tmp behind and regresses the atomicity property.
  assert.deepEqual(readdirSync(dir).filter((f) => f.endsWith('.tmp')), [], 'the refused save left a temp file in the state root')

  // The write side must not over-reject either: every path the declaration calls open
  // must still SAVE, or a real run stops being able to persist its own output.
  const refusedOpen = []
  for (const r of unenforcedRows()) {
    if (declaredPaths().includes(r.path)) continue
    try { RS.saveState(join(dir, `open-${r.path.replace(/[^\w]/g, '_')}.json`), unenforcedWitnessDoc(r.path, 42)) } catch (e) { refusedOpen.push(`${r.path}: ${e.detail || e.message}`) }
  }
  assert.deepEqual(refusedOpen, [], `the write side refuses paths the declaration calls open:\n        ${refusedOpen.join('\n        ')}`)
})

await test('E4.30/AC-C3-1 (cycle 3): the nested refusal reports the DOTTED path and the expected type — the message format extends, it does not change', () => {
  const dir = tmpRoot()
  // PROSE_SOURCED, transcribed from .autoflow/issue-4-feature-design.md §4.3.
  // Deliberately NOT read off RS.STATE_FIELDS.pending.shape.step.expected: their
  // AGREEMENT is the assertion, not its premise (verification §3.4, applied at depth).
  const NESTED_PHRASE = 'field "pending.step" is undefined — expected a string'
  const { refusal } = loadOutcome(writeDoc(dir, 'nested-message.json', { ...goodDoc(), pending: {} }))
  assert.ok(refusal, 'pending: {} was accepted, so no message exists to check')
  assert.ok(refusal.detail.includes(NESTED_PHRASE),
    `the nested refusal does not use the design's sentence at depth: ${refusal.detail}`)
  assert.match(refusal.message, /run state is corrupt — /, 'the outer message envelope must be unchanged')
  // The E4.20 property must hold at depth too: a type is named, the untrusted value
  // never is.
  const marker = 'UNTRUSTED-7b2e40-VALUE'
  const echo = loadOutcome(writeDoc(dir, 'nested-echo.json', { ...goodDoc(), pending: { step: { [marker]: marker } } }))
  assert.ok(echo.refusal, 'a wrong-typed nested value was accepted')
  assert.ok(!echo.refusal.message.includes(marker), `the nested refusal echoes the untrusted value: ${echo.refusal.detail}`)
})

await test('E4.31/AC-C3-2 (cycle 3): the declaration-level mutation battery — each mutant is killed by a live assertion, demonstrated by applying it to the INPUTS', () => {
  assert.ok(Array.isArray(RS.STATE_UNENFORCED) && RS.STATE_UNENFORCED.length > 0,
    'precondition: the battery needs the unenforced half to exist before a mutation of it can be shown to kill')
  const reads = extractStateReads([engineSrc('flow.mjs'), engineSrc('escalate.mjs')])
  const declared = declaredPaths()
  const open = unenforcedPaths()
  assert.deepEqual(uncoveredReads(reads, declared, open), [],
    'precondition: the unmutated declaration must cover the engine\'s directly-dereferenced read set')

  const kills = [
    ['emptying STATE_UNENFORCED', () => uncoveredReads(reads, declared, [])],
    ['dropping every nested `shape` row', () => uncoveredReads(reads, declared.filter((p) => !p.includes('.')), open)],
    ['an engine edit that starts dereferencing a NEW nested path',
      () => uncoveredReads(extractStateReads([`${engineSrc('flow.mjs')}\nconst probe = state.pending.newlyRead\n`, engineSrc('escalate.mjs')]), declared, open)],
  ]
  for (const [mutant, run] of kills) {
    const uncovered = run()
    assert.ok(uncovered.length > 0, `mutant survives — ${mutant} left the coverage assertion green`)
  }
  // The row-honesty predicate kills its own mutant.
  const emptyReason = { ...RS.STATE_UNENFORCED[0], reason: '   ' }
  assert.ok(unenforcedRowFault(emptyReason) !== null, 'mutant survives — an unenforced row with an empty reason is accepted as a decision')
  const badClause = { ...RS.STATE_UNENFORCED[0], clause: 'R9' }
  assert.ok(unenforcedRowFault(badClause) !== null, 'mutant survives — a row citing a clause the rule does not define is accepted')

  // Stated limit, not overclaimed: mutants INSIDE the loader (dropping the `shape`
  // recursion, recursing when value === null, dropping the nested .sort(),
  // substituting describeType at depth, reverting StepResolutionError to a bare
  // Error) cannot be applied here without editing engine/**, which is outside this
  // file's scope. They are killed by the polarity of E4.25 / E4.27 / E4.11 / E4.30 /
  // E4.26 respectively, each of which fails against exactly one of them.
})

await test('E4.32/AC-C3-3 (cycle 3): the declaration is TOTAL over the engine\'s directly-dereferenced read set', () => {
  const reads = extractStateReads([engineSrc('flow.mjs'), engineSrc('escalate.mjs')])
  assert.ok(reads.length > 8, `precondition: the extractor must find the engine's read set, found [${reads.join(', ')}]`)
  assert.ok(!reads.includes('mjs'), 'the extractor matched the ./run-state.mjs import specifier — import lines must be excluded')
  assert.ok(reads.includes('pending.step'), 'precondition: the extractor must see the depth-2 read this cycle is about')
  assert.ok(!reads.includes('history.length'), 'an Array intrinsic must normalise to its parent — no witness can be placed at it')

  const uncovered = uncoveredReads(reads, declaredPaths(), unenforcedPaths())
  assert.deepEqual(uncovered, [],
    `the engine reads paths the contract records no decision about: ${uncovered.join(', ')} — `
    + 'each is either enforced by a row or recorded as deliberately open, and this case is what re-asks '
    + 'the depth question automatically whenever the engine\'s read set moves')

  // The guarantee, stated exactly. An ALIASED read escapes any state.* extractor —
  // engine/escalate.mjs binds `const last = state.history[...]` and then reads
  // `last.capKey`. That row is carried by hand in STATE_UNENFORCED, and this case
  // cannot derive it. A hook claiming the stronger property would be the unfalsifiable
  // prose the exported declaration exists to replace.
  assert.ok(unenforcedPaths().some((p) => p.startsWith('history')),
    'the aliased history[] read that no extractor can see must be recorded by hand')
})

await test('E4.33(i)/AC-C3-5 (cycle 3): the typed lookup PRESERVES the message text — asserted here, never in E4.26', () => {
  const sp = spec()
  // Quarantined on purpose. E4.26 asserts class + code and would let the mutant
  // "revert to a bare Error, keep the text" live if it also asserted the string;
  // this case asserts the string and would let the mutant live if it were merged
  // into E4.26. The pair kills it; either alone does not.
  for (const [stepId, doc] of [
    ['nope', { ...goodDoc(), step: 'gate_plan', status: 'delegating', pending: { step: 'nope' } }],
    ['bogus', { ...goodDoc(), step: 'bogus' }],
  ]) {
    let err = null
    try { runFlow(sp, { state: doc, outcomes: probing(mainLine()), persist: () => {}, statePath: SCRATCH_STATE, maxSteps: 4 }) } catch (e) { err = e }
    assert.ok(err, `${stepId}: the resume did not stop`)
    assert.ok(typeof FLOW.StepResolutionError === 'function' && err instanceof FLOW.StepResolutionError,
      `${stepId}: the stop is not the typed error, so there is no preservation property to check (${err.name})`)
    assert.equal(err.message, `no such step: ${stepId}`, `${stepId}: the operator-facing text changed with the class`)
  }
})

// The pre-change behaviour of every accepted run, CAPTURED at b6377f6 and authored
// into the RED commit. [MUST] It is never re-derived by running the post-change code:
// a self-comparison is green under any behaviour change, which would make E4.33(ii)
// decorative and leave the executor change with no non-regression evidence at all.
// Pinned as a digest of the full trace rather than as the trace itself: the corpus is
// every hop a real run persists, so the literal would be tens of kilobytes of data in
// a file whose other fixtures are all a handful of lines. The readable pins beside it
// carry the diagnosis when the digest moves.
const PRE_CHANGE_TRACE_SHA256 = '12002f694dfa8650e68513e431be67ed712fe9a75080d405609714d2db326cfa'
const PRE_CHANGE_TRACE_DOCS = 59
const PRE_CHANGE_TRACE_ENDS = ['escalate/halted/escalate', 'handoff/running/null', 'validate/halted/null']

function corpusTrace() {
  const sp = spec()
  return acceptanceCorpus().map((doc) => {
    let r = null
    let err = null
    try { r = runFlow(sp, { state: JSON.parse(JSON.stringify(doc)), outcomes: mainLine(), persist: () => {}, statePath: SCRATCH_STATE, maxSteps: 80 }) } catch (e) { err = e }
    if (err) return { error: `${err.name}: ${err.message}` }
    return {
      events: r.events.map((e) => e.kind).join(','),
      transitions: r.trace.map((t) => `${t.from}:${t.resolvedOutcome || t.outcome}->${t.to}`).join(','),
      step: r.state.step, status: r.state.status, terminal: r.state.terminal,
      counters: r.state.counters,
    }
  })
}

await test('E4.33(ii)/AC-C3-5 (cycle 3): the typed lookup is behaviour-NEUTRAL on every accepted run, against a baseline captured before the change', () => {
  const trace = corpusTrace()
  assert.equal(trace.length, PRE_CHANGE_TRACE_DOCS, 'the acceptance corpus itself moved, so the baseline no longer describes it')
  assert.deepEqual([...new Set(trace.map((t) => `${t.step}/${t.status}/${t.terminal}`))].sort(), PRE_CHANGE_TRACE_ENDS,
    'an accepted run ends somewhere the pre-change tree never ended')
  assert.deepEqual(trace.filter((t) => t.error), [], `an accepted run now throws: ${JSON.stringify(trace.filter((t) => t.error))}`)
  assert.equal(createHash('sha256').update(JSON.stringify(trace)).digest('hex'), PRE_CHANGE_TRACE_SHA256,
    'an accepted run changed behaviour — the executor edit was supposed to change only the CLASS of a failure, '
    + 'and the event sequence, transition list, final state and counters of every corpus resume were captured at b6377f6 to prove it')
})

await test('E4.33(iii)/AC-C3-6 (cycle 3): the added rejection surface is ENUMERATED, not merely bounded', () => {
  const refused = classifiedCorpus().filter((r) => r.bucket === 'REFUSED')
  assert.equal(refused.length, REFUSED_EXPECTED, `the rejection surface moved off its pin (${countLine()})`)
  // Every refusal that names a NESTED path must derive from the ONE row the change
  // adds. Measured composition of the seven: the six non-string `pending.step`
  // witnesses, plus `pending: {}` itself, whose refusal is attributed to `pending.step`
  // because that is the row it violates. `pending.step: 'x'` is a string and is
  // deliberately NOT among them — it stays accepted and is answered at the point of use.
  const nested = refused
    .map((r) => [r.id, /field "([^"]+)" is /.exec(r.refusal.detail || '')])
    .filter(([, m]) => m && m[1].includes('.'))
  assert.deepEqual([...new Set(nested.map(([, m]) => m[1]))].filter((p) => p !== 'pending.step'), [],
    'the change refuses at a nested path other than the one row it adds')
  assert.equal(nested.length, REFUSED_MOVED,
    `exactly ${REFUSED_MOVED} generated rows may newly be refused, and every one must derive from the pending.step row — got `
    + `${nested.length}: ${nested.map(([id]) => id).join(', ')}`)
})

await test('E4.34/AC-C3-1 (cycle 3): the write side mirrors the VERSION check too — the round-trip property holds over the whole document, not over eight of its nine keys', () => {
  const dir = tmpRoot()
  const path = join(dir, 'version.json')
  // Measured on a clean tree at b6377f6, and the reason this case exists: saveState
  // ACCEPTS and writes { ...good, version: 2 }, while loadState on the very same file
  // throws StateVersionError. So engine/run-state.mjs:74-76's "nothing can be written
  // that cannot be read back" is false as shipped — `version` is admitted by a branch
  // at :118 that sits OUTSIDE the declaration schemaFault() walks, and the write side
  // has no mirror of it. This case pins the resolution: the write side refuses it.
  // The alternative resolution — merely RECORDING the asymmetry in the declaration —
  // is rejected here on purpose: it documents the hole rather than closing it, and
  // AC-C3 point 5's invariant is discharged by what the boundary refuses, not by what
  // it describes.
  let write = null
  assert.throws(() => RS.saveState(path, { ...goodDoc(), version: RS.STATE_VERSION + 1 }),
    (e) => { write = e; return true },
    'saveState persisted a document that its own loadState refuses with StateVersionError — '
    + 'the "nothing can be written that cannot be read back" property does not hold over `version`')
  assert.equal(write.code, 'state-version', 'the two directions must report the same code for the same defect')
  assert.deepEqual(readdirSync(dir), [], 'the refused save must run before the temp write, exactly as the field pass does')

  // and it must not over-reject: the current version still writes and still reads back.
  RS.saveState(path, goodDoc())
  assert.deepEqual(RS.loadState(path), goodDoc())
})


// ================================================================================
// GROUP 5 — the non-interactive escalate protocol (AC5)
// ================================================================================

await test('E5.1/AC5: STOP_PROTOCOL is the audited two-step order', () => {
  assert.deepEqual(ESC.STOP_PROTOCOL, ['persist', 'notify'],
    'the third step is `return`; the process exit is engine/cli.mjs\'s, not the core protocol\'s')
})

await test('E5.1/AC5: every DERIVED escalate-reaching path runs persist → notify and ends terminal', () => {
  const sp = spec()
  const rows = RT.edges(sp).filter((e) => e.target === 'escalate')
  assert.ok(rows.length > 0, 'the escalate set is derived from the declaration — no count is authored anywhere')
  for (const row of rows) {
    const rsp = specForEdge(sp, row.step, row.outcome)
    const plan = edgePlan(rsp, row.step, row.outcome)
    const r = runFlow(rsp, {
      start: row.step, outcomes: oneShot(row.step, plan.feed), seedCounters: plan.seed,
      maxSeverity: 'Low',
    })
    assert.equal(r.state.step, 'escalate', `${row.step}:${row.outcome} did not reach escalate`)
    const order = []
    const out = ESC.escalate(r.state, {
      statePath: SCRATCH_STATE,
      persist: () => order.push('persist'),
      notify: () => order.push('notify'),
    })
    assert.deepEqual(order, ESC.STOP_PROTOCOL, `${row.step}:${row.outcome} — the protocol ran out of order`)
    assert.equal(out.terminal, 'escalate')
  }
})

await test('E5.1/AC5: a halt path runs the same protocol', () => {
  const sp = spec()
  const r = runFlow(sp, { start: 'validate', outcomes: oneShot('validate', 'incomplete') })
  assert.equal(r.event.kind, 'halt')
  const order = []
  const out = ESC.escalate(r.state, {
    statePath: SCRATCH_STATE,
    persist: () => order.push('persist'),
    notify: () => order.push('notify'),
  })
  assert.deepEqual(order, ESC.STOP_PROTOCOL)
  assert.equal(out.exitCode, ESC.EXIT_CODES.escalate)
})

await test('E5.2/AC5: no interactive prompt exists anywhere under engine/**', () => {
  for (const [name, src] of engineSources()) {
    for (const tok of ['node:readline', 'process.stdin', 'prompt(', 'question(']) {
      assert.ok(!src.includes(tok), `engine/${name} references ${tok} — AC5 forbids a dialog`)
    }
  }
})

await test('E5.3(a)/AC5: process.exit appears in exactly one engine module, and it is engine/cli.mjs', () => {
  const holders = engineSources().filter(([, src]) => /process\.exit\s*\(/.test(src)).map(([f]) => f)
  assert.deepEqual(holders, ['cli.mjs'],
    'the scan is directory-derived, so ANY later module reintroducing an exit fails this case')
})

await test('E5.3(b)/AC5: EXIT_CODES is the declared mapping and escalate() returns the matching code', () => {
  assert.deepEqual(ESC.EXIT_CODES, { escalate: 2, end: 0, close: 0 })
  for (const terminal of Object.keys(ESC.EXIT_CODES)) {
    const state = { version: RS.STATE_VERSION, issue: '#4', step: terminal, counters: {}, history: [], pending: null, status: 'halted', terminal, halt: null }
    const out = ESC.escalate(state, { statePath: SCRATCH_STATE, persist: () => {}, notify: () => {} })
    assert.equal(out.exitCode, ESC.EXIT_CODES[terminal], `${terminal} must map to ${ESC.EXIT_CODES[terminal]}`)
  }
})

// The CLI child cases. `engine/cli.mjs <statePath>` loads the state, drives advance()
// to a terminal and runs escalate(). A state already sitting on a reserved sentinel
// needs no effects port, so the child is deterministic and offline.
function runCli(statePath) {
  const res = { status: 0, stdout: '', stderr: '' }
  try {
    res.stdout = execFileSync(process.execPath, [join(root, 'engine', 'cli.mjs'), statePath],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
  } catch (e) {
    res.status = e.status
    res.stdout = String(e.stdout || '')
    res.stderr = String(e.stderr || '')
    return res
  }
  return res
}

function seedTerminalState(dir, terminal) {
  const path = join(dir, `run-4-${terminal}.json`)
  writeFileSync(path, JSON.stringify({
    version: RS.STATE_VERSION, issue: '#4', step: terminal, counters: { 'gate_plan.retry': 3 },
    history: [], pending: null, status: 'running', terminal: null, halt: null,
  }))
  return path
}

await test('E5.3(c)/AC5: engine/cli.mjs spawned as a child exits 2 on escalate and 0 on end', () => {
  const dir = tmpRoot()
  const esc = runCli(seedTerminalState(dir, 'escalate'))
  assert.equal(esc.status, 2, 'a non-interactive escalate must be observable to a caller as a non-zero exit')
  const end = runCli(seedTerminalState(dir, 'end'))
  assert.equal(end.status, 0)
})

await test('E5.3(e)/AC5: the CLI keeps DRIVING after a transition — it does not stop at the first hop', () => {
  const sp = spec()
  const dir = tmpRoot()
  const path = join(dir, 'run-4-driving.json')
  // A state pending on a gate step. The CLI supplies no delegation output, so
  // computeVerdict() sees no scores and fails closed — one real transition, to
  // gate_plan's declared `fail` target. The CLI carries NO_EFFECTS and an empty
  // artifacts map, so the SUCCESSOR step cannot be served: a CLI that keeps driving
  // reaches it and the engine refuses there (the CLI has no error boundary, by
  // design — feature design §3 makes it a ≤15-line entry), while a CLI that breaks
  // after the first hop instead reports an orderly escalate. The successor's typed
  // refusal on stderr is therefore the witness that the loop iterated.
  const successor = mget(stepOf(sp, 'gate_plan').next, 'fail')
  writeFileSync(path, JSON.stringify({
    version: RS.STATE_VERSION, issue: '#4', step: 'gate_plan', counters: {}, history: [],
    pending: { step: 'gate_plan', roles: ['evaluator'], request: { step: 'gate_plan', roles: ['evaluator'] } },
    status: 'delegating', terminal: null, halt: null,
  }))
  const res = runCli(path)
  assert.notEqual(res.status, ESC.EXIT_CODES.escalate,
    'the CLI reported an orderly escalate after one hop — its drive loop never iterated')
  assert.match(res.stderr, /missing-slot|MissingSlotError/,
    `the CLI must have reached ${successor} and been refused there`)

  // The hop it did make is on record, so "it kept driving" is not confused with
  // "it never started".
  const after = JSON.parse(readFileSync(path, 'utf8'))
  assert.equal(after.history.length, 1, 'the first transition must have been persisted')
  assert.deepEqual(
    { from: after.history[0].from, outcome: after.history[0].outcome, to: after.history[0].to },
    { from: 'gate_plan', outcome: 'fail', to: successor },
  )
})

await test('E5.3(d)/AC5: the CLI actually RAN persist and notify — not merely a hard-coded exit code', () => {
  const dir = tmpRoot()
  const path = seedTerminalState(dir, 'escalate')
  const res = runCli(path)
  assert.equal(res.status, 2)
  const after = JSON.parse(readFileSync(path, 'utf8'))
  assert.equal(after.status, 'halted', 'persist step 1 did not run — the state file was not rewritten')
  assert.equal(after.terminal, 'escalate')
  assert.deepEqual(after.counters, { 'gate_plan.retry': 3 }, 'the persisted run context must survive the stop')
  const lines = res.stderr.split('\n').filter((l) => l.trim() !== '')
  assert.equal(lines.length, 1, `notify must emit exactly one line on stderr, got ${lines.length}`)
  const rec = JSON.parse(lines[0])
  assert.equal(rec.issue, '#4')
  assert.equal(rec.terminal, 'escalate')
  assert.equal(rec.statePath, path)
  assert.ok(!res.stdout.includes('{'), 'a stdout write would corrupt a caller parsing the harness ok/FAIL lines')
})

await test('E5.3(f)/AC4 (cycle 2): a CLI resume from a wrong-typed document fails at the LOAD boundary, not later at a wiring error', () => {
  const dir = tmpRoot()
  const path = join(dir, 'run-4-corrupt.json')
  // `preflight` is pinned because the pre-refusal failure differs by step (preflight →
  // effects-not-wired, gate_plan → missing-slot). The discriminator is that the failure
  // moves EARLIER, to the loader — "stderr does not name TypeError" would be satisfied
  // without any fix at all, since engine/cli.mjs:29 hardwires artifacts: {} and
  // NO_EFFECTS and no reachable step gets as far as [...state.history].
  writeFileSync(path, JSON.stringify({ ...goodDoc(), history: null }))
  const res = runCli(path)
  assert.match(res.stderr, /state-corrupt|StateCorruptError/,
    'the child reported a downstream wiring error instead of the corrupt document that caused it')
  assert.ok(!/effects-not-wired/.test(res.stderr),
    'the child reached the executor, so the document was accepted at the load boundary')
  // A load failure is not a terminal, so it is not routed through escalate() and carries
  // no declared exit code — node's default 1. Pinned so a future re-route through
  // escalate() (exit 2) fails loudly; it has no discriminating power by construction,
  // since both the corrupt-state child and the effects-not-wired child exit 1.
  assert.equal(res.status, 1)
})

await test('E5.3(g)/AC-C3-5 (cycle 3): a CLI resume that cannot resolve its step stops TYPED, and the reviewer\'s witness stops at the LOAD boundary', () => {
  const dir = tmpRoot()
  // Constraints, measured rather than assumed (engine/cli.mjs:20-38 has no try/catch):
  // (i) exit != 0 is asserted, never a DISTINCT exit code — both the corrupt-state
  // child and the effects-not-wired child exit 1, which is why E5.3(f) already
  // discriminates on stderr; (ii) no catch may be added to cli.mjs to make this case
  // easier, since that would move the exit-code surface E5.3(f) pins.
  const rows = [
    ['M1 pending: {} — post-change this never reaches the executor at all', { ...goodDoc(), pending: {} }, /state-corrupt|StateCorruptError/],
    ['M2 pending: { step: "nope" } — well-typed, unresolvable', { ...goodDoc(), step: 'gate_plan', status: 'delegating', pending: { step: 'nope' } }, /StepResolutionError|no-such-step/],
    ['M3 step: "bogus" — pending not involved at all', { ...goodDoc(), step: 'bogus' }, /StepResolutionError|no-such-step/],
  ]
  rows.forEach(([why, doc, wanted], i) => {
    const path = join(dir, `cli-c3-${i}.json`)
    writeFileSync(path, JSON.stringify(doc))
    const res = runCli(path)
    assert.notEqual(res.status, 0, `${why}: the child exited 0 — the run was allowed to proceed`)
    assert.match(res.stderr, wanted, `${why}: the child reported neither the typed stop nor the refusal that caused it`)
    assert.ok(!/effects-not-wired/.test(res.stderr), `${why}: the child died at a wiring error, so it had already been let past the failure under test`)
  })
})

await test('E5.4/AC5: notify receives a JSON-serializable RECORD, not a formatted string', () => {
  const sp = spec()
  const r = runFlow(sp, { start: 'diagnose', outcomes: oneShot('diagnose', 'non-code-lever') })
  assert.equal(r.state.step, 'escalate')
  let rec = null
  ESC.escalate(r.state, { statePath: SCRATCH_STATE, persist: () => {}, notify: (x) => { rec = x } })
  assert.equal(typeof rec, 'object', 'a formatted string would make the transport non-substitutable')
  assert.deepEqual(Object.keys(rec).sort(),
    ['capKey', 'issue', 'reason', 'statePath', 'step', 'terminal'],
    'the key set is closed — capKey included, because it is the field that says WHICH budget ran out')
  assert.equal(JSON.parse(JSON.stringify(rec)).terminal, 'escalate')
  assert.equal(rec.step, r.state.step)
  assert.equal(rec.capKey, null, 'this escalate consumed no budget, so no cap may be blamed for it')
  assert.match(rec.reason, /escalate/, 'the operator-facing reason must name where the run stopped')
})

await test('E5.4/AC5: the notify record names the exhausted budget on a cap-exhaustion escalate', () => {
  const sp = spec()
  // Derived: every engine-counted cap key whose exhaustion lands on `escalate`. The
  // record's `capKey` is what tells an operator which budget ran out; a constant null
  // makes every exhaustion look alike.
  const keys = engineCapKeys().filter((k) => expectedExhaustion(sp, k).target === 'escalate')
  assert.ok(keys.length > 0, 'derived witness set must not be empty')
  for (const capKey of keys) {
    const [step, outcome] = edgeRowsFor(capKey)[0].split(':')
    const r = runFlow(sp, { start: step, outcomes: oneShot(step, outcome), seedCounters: { [capKey]: RT.capValue(sp, capKey) } })
    assert.equal(r.state.step, 'escalate', `${capKey}: precondition — the exhaustion reaches escalate`)
    let rec = null
    ESC.escalate(r.state, { statePath: SCRATCH_STATE, persist: () => {}, notify: (x) => { rec = x } })
    assert.equal(rec.capKey, capKey, `${capKey}: the record must name the budget that ran out`)
    assert.equal(rec.terminal, 'escalate')
  }
})

await test('E5.4/AC5: the notify record carries the halt\'s own reason and step, not a fixed string', () => {
  const sp = spec()
  // Two structurally different halts must produce two different reasons, so the field
  // cannot be a constant and cannot be derived from the terminal alone.
  const seen = new Set()
  const halts = [
    ['validate', oneShot('validate', 'incomplete'), undefined],
    ['handoff', oneShot('handoff', 'review-findings'), 'Low'],
  ]
  for (const [step, outcomes, maxSeverity] of halts) {
    const r = runFlow(sp, { start: step, outcomes, maxSeverity })
    assert.equal(r.event.kind, 'halt', `${step}: precondition — the scenario halts`)
    let rec = null
    ESC.escalate(r.state, { statePath: SCRATCH_STATE, persist: () => {}, notify: (x) => { rec = x } })
    assert.equal(rec.reason, r.state.halt.reason, `${step}: the record must carry the halt's own reason`)
    assert.equal(rec.step, r.state.halt.step, `${step}: the record must name the step that halted`)
    assert.ok(rec.reason.includes(step), `${step}: the reason must identify where the run stopped`)
    seen.add(rec.reason)
  }
  assert.equal(seen.size, halts.length, 'two different halts produced the same reason — the field is a constant')
})

await test('E5.4b/AC5: handoff\'s undeclared outcome halts rather than inventing an edge', () => {
  const sp = spec()
  const prose = RT.PROSE_SOURCED.find((p) => p.where === 'handoff' && p.what === 'missing-outcome')
  assert.ok(prose, 'the missing outcome is recorded in PROSE_SOURCED — a future declaration must fail this case loudly')
  assert.ok(!mhas(stepOf(sp, 'handoff').next, 'review-block-unresolved'),
    'precondition: the declaration still has no outcome for label-present & max_severity < Medium')
  const r = runFlow(sp, {
    start: 'handoff', outcomes: oneShot('handoff', 'review-findings'), maxSeverity: 'Low',
  })
  assert.equal(r.event.kind, 'halt')
  assert.equal(r.event.detail, 'handoff:missing-outcome')
  assert.deepEqual(r.state.history, [], 'no history entry — no edge was invented')
})

// ================================================================================
// GROUP 6 — handoff: mechanical AND LLM-bearing (E1.6, composes groups 3 + 4)
// ================================================================================

await test('E1.6/AC1: handoff raises an ingest delegation, persists, and re-enters the SAME handler on the result', () => {
  const sp = spec()
  assert.equal(stepOf(sp, 'handoff').kind, 'mechanical')
  assert.deepEqual(stepOf(sp, 'handoff').agents, ['ingest'], 'the only mechanical step that also declares agents:')
  const dir = tmpRoot()
  const writes = []
  const r = runFlow(sp, {
    start: 'handoff', outcomes: oneShot('handoff', 'review-findings'), maxSeverity: 'Medium',
    statePath: join(dir, 'run-4.json'), persist: (p, s) => writes.push(s),
  })
  const delegate = r.events.find((e) => e.kind === 'delegate')
  assert.ok(delegate, 'handoff must emit a normal delegate event, not a mid-function suspension')
  assert.deepEqual(delegate.request.roles, ['ingest'])
  const declared = new Set(mget(sp.roles, 'ingest').input)
  for (const k of Object.keys(delegate.request.perRole.ingest.input)) {
    assert.ok(declared.has(k), `the ingest frame carries "${k}", which spec/roles/ingest.yaml does not declare`)
  }
  assert.ok(writes.length >= 2, 'the delegate and the following transition must both persist')
  assert.equal(r.trace.length, 1)
  assert.equal(r.trace[0].from, 'handoff')
  assert.equal(r.trace[0].outcome, 'review-findings')
  assert.equal(r.trace[0].to, mget(stepOf(sp, 'handoff').next, 'review-findings'))
})

await test('E1.6/AC1: on re-entry the earlier ordered checks are RE-EVALUATED — purity plus check-then-act', () => {
  const sp = spec()
  // Round 1 yields the ingest delegation; round 2's effect record reports an env
  // failure, which §6.1 orders BEFORE the classification. Re-evaluation is the
  // contract (handlers are pure, effects are check-then-act idempotent), so the
  // env failure must win over the already-classified findings.
  const r = runFlow(sp, {
    start: 'handoff', outcomes: oneShot('handoff', 'review-findings'), maxSeverity: 'Medium',
    effectSeq: {
      handoff: [
        { envFailure: false, ciGreen: true, prOpen: true, reviewComments: ['c'], reviewBlockPresent: true },
        { envFailure: true, ciGreen: true, prOpen: true, reviewComments: ['c'], reviewBlockPresent: true },
      ],
    },
  })
  assert.ok(r.events.some((e) => e.kind === 'delegate'), 'round 1 must delegate to ingest')
  assert.equal(r.trace[0].outcome, 'env-failure',
    'a resumed continuation would skip the ordered checks; a re-entered pure handler cannot')
})

// ================================================================================

for (const d of tmpRoots) { try { rmSync(d, { recursive: true, force: true }) } catch { /* best effort */ } }

await test('E6.5 proxy: the M1 suite runs offline in under 5 s (its own bound, per the precedent runner)', () => {
  const elapsed = Date.now() - started
  assert.ok(elapsed < 5000, `suite took ${elapsed} ms`)
})

const elapsedMs = Date.now() - started
console.log(
  failures
    ? `\n${failures} of ${cases} flow-engine test(s) FAILED  (${elapsedMs} ms)`
    : `\nall ${cases} flow-engine tests passed  (${elapsedMs} ms)`,
)
process.exit(failures ? 1 : 0)
