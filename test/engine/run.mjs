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

// The cycle's BASE commit — this branch's merge base with the default branch, not
// HEAD. "What this cycle changed" has to be measured against the point the cycle
// started from: measured against HEAD it empties the moment the cycle commits, which
// would silently vacate both the reuse byte-compares (E2.3/E3.5) and the cap-literal
// scan (E2.4) exactly when the code they guard arrives.
const BASE = execFileSync('git', ['merge-base', 'HEAD', 'main'], { cwd: root, encoding: 'utf8' }).trim()

// The engine modules this cycle ADDS, derived rather than listed: the modules that
// already existed at BASE are separately asserted byte-identical to BASE (E2.3, E3.5),
// so a literal inside one of them is not this cycle's subject.
const baseEngineFiles = new Set(
  execFileSync('git', ['ls-tree', '--name-only', BASE, 'engine/'], { cwd: root, encoding: 'utf8' })
    .trim().split('\n').map((p) => p.replace(/^engine\//, '')),
)
const newEngineSources = () => engineSources().filter(([f]) => !baseEngineFiles.has(f))

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
  assert.equal(readRepo('engine/gate.mjs'), gitShow(`${BASE}:engine/gate.mjs`),
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

await test('E2.3/AC2 structural: engine/routing.mjs is byte-identical to the cycle base (reused, not reimplemented)', () => {
  assert.equal(readRepo('engine/routing.mjs'), gitShow(`${BASE}:engine/routing.mjs`),
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
