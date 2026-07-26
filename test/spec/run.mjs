// SPDX-FileCopyrightText: 2026 Munsik-Park
// SPDX-License-Identifier: Elastic-2.0
// Spec-simulator suite (issue #2) — declaration lint (AC1), synthetic-flow
// simulation (AC2), digest replay (AC3), CI wiring (AC4).
//
// Run: node test/spec/run.mjs      (stdlib only; no package.json, no framework)
//
// Written from the acceptance criteria and the verification design
// (.autoflow/issue-2-verification-design.md), NOT from the implementation. The
// engine modules under engine/** are the subject; this file is the harness and
// owns the simulator driver (feature design §1.7 — the AC2 mocks are
// verification scaffolding, not engine code).
//
// Idiom: test/workflows/run.mjs — hand-rolled test(name, fn), `ok`/`FAIL` output
// lines, a `failures` counter, process.exit(failures ? 1 : 0). Difference: the
// engine modules are ordinary ESM and are imported directly rather than
// AsyncFunction-wrapped (that wrap exists there only for Workflow scripts with
// injected globals).
//
// Missing-module posture: engine/** is loaded through loadEngine(), which yields
// a throwing proxy when the module is absent. Every case then fails individually
// (Red) instead of the suite aborting at import time with zero case lines.
import assert from 'node:assert/strict'
import { readFileSync, readdirSync, existsSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

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

const SL = await loadEngine('spec-load.mjs')
const RT = await loadEngine('routing.mjs')
const GATE = await loadEngine('gate.mjs')
const LINT = await loadEngine('lint.mjs')
const REPLAY = await loadEngine('replay.mjs')

// ---- shared helpers -----------------------------------------------------------

// The SpecModel uses Maps (feature design §1.3). These accessors tolerate a Map
// or a plain object so the assertions test behavior, not container choice.
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
    agents: st.agents ? [...st.agents] : st.agents,
    loop: st.loop ? { ...st.loop, participants: st.loop.participants ? [...st.loop.participants] : undefined } : undefined,
    next: new Map(mkeys(st.next).map((k) => [k, mget(st.next, k)])),
  }
}

// Deep-enough clone so the negative lint cases inject violations without
// mutating spec/ (feature design D10 — lint(spec) is pure and takes parsed input).
function cloneSpec(sp) {
  return {
    steps: new Map(mkeys(sp.steps).map((id) => [id, cloneStep(mget(sp.steps, id))])),
    roles: new Map(mkeys(sp.roles).map((id) => [id, { ...mget(sp.roles, id) }])),
    binding: JSON.parse(JSON.stringify(sp.binding)),
    criteria: new Set(sp.criteria ? [...sp.criteria] : []),
  }
}

const codes = (findings, code) => findings.filter((f) => f.code === code)

// The declaration rule for a bounded step (feature design §1.4 / D1), derived
// here INDEPENDENTLY of the engine so CAP_EDGES/CAP_LOOPS can be asserted
// against it rather than being their own oracle (D12).
function boundedStepsOf(sp) {
  return mkeys(sp.steps)
    .filter((id) => {
      const st = stepOf(sp, id)
      return !!st.loop || mhas(st.next, 'cap-exhausted')
    })
    .sort()
}

const MEASURED_BOUNDED = ['architect', 'audit', 'gate_hypothesis', 'gate_plan', 'gate_quality', 'handoff', 'refine', 'verify']
const MEASURED_CAP_KEYS = [
  'architect.loop', 'audit.retry', 'gate_hypothesis.retry', 'gate_plan.retry',
  'gate_quality.retry', 'handoff.env-retry', 'handoff.review-response',
  'refine.retry', 'verify.round-trips',
].sort()

const readRepo = (rel) => readFileSync(join(root, rel), 'utf8')

// ================================================================================
// PARSER — the YAML subset is a first-class verification subject (§3)
// ================================================================================

const P = (text, path = 'synthetic.yaml') => SL.parseYamlSubset(text, path)

await test('parser 1: block map + block sequence (diagnose.yaml:3-6 shape)', () => {
  const v = P('step: diagnose\nagents:\n  - analyzer-structure\n  - analyzer-issue\n')
  assert.deepEqual(v, { step: 'diagnose', agents: ['analyzer-structure', 'analyzer-issue'] })
})

await test('parser 2: flow sequence (requires: [issue, cycle-state])', () => {
  const v = P('requires: [issue, cycle-state]\n')
  assert.deepEqual(v, { requires: ['issue', 'cycle-state'] })
})

await test('parser 3: flow map (bindings/claude.yaml:5-10 shape)', () => {
  const v = P('dev: { provider: claude, model: opus, effort: high }\n')
  assert.deepEqual(v, { dev: { provider: 'claude', model: 'opus', effort: 'high' } })
})

await test('parser 4: trailing comment after a value is stripped', () => {
  const v = P('criteria: security            # the project-specific security checklist\n')
  assert.deepEqual(v, { criteria: 'security' })
})

await test('parser 5: multi-line plain scalar folds onto continuation lines', () => {
  const v = P('done-when: both isolated analyses complete and necessity is scored against the\n           actual structure; bug issues additionally carry hypotheses\n')
  assert.equal(
    v['done-when'],
    'both isolated analyses complete and necessity is scored against the actual structure; bug issues additionally carry hypotheses',
  )
})

await test('parser 6: comment-only continuation line inside a folded region is dropped, not folded', () => {
  const v = P('next:\n  ac-contradiction: verify    # satisfiable subset implemented; the recorded\n                              # contradiction is what verify adjudicates\n')
  assert.deepEqual(v, { next: { 'ac-contradiction': 'verify' } })
})

await test('parser 7: booleans and integers are typed', () => {
  const v = P('isolated: true\nescalate: false\narchitect.loop: 6\n')
  assert.deepEqual(v, { isolated: true, escalate: false, 'architect.loop': 6 })
  assert.equal(typeof v.isolated, 'boolean')
  assert.equal(typeof v['architect.loop'], 'number')
})

await test('parser 8: dotted keys stay literal key strings (never nested objects)', () => {
  const v = P('caps:\n  gate_hypothesis.retry: 2\n  handoff.review-response: 7\n')
  assert.deepEqual(v, { caps: { 'gate_hypothesis.retry': 2, 'handoff.review-response': 7 } })
  assert.equal(v.caps.gate_hypothesis, undefined, 'dotted key must not be expanded')
})

await test('parser 9: value beginning with "." and value containing "{}"', () => {
  const v = P('gate-computation: .claude/hooks/check-autoflow-gate.sh\nledger: .autoflow/issue-{N}-ledger.md\n')
  assert.deepEqual(v, {
    'gate-computation': '.claude/hooks/check-autoflow-gate.sh',
    ledger: '.autoflow/issue-{N}-ledger.md',
  })
})

await test('parser 10: a block sequence whose entries are nested block maps parses as an array of objects', () => {
  // No spec/**/*.yaml uses this shape today, so the branch is only reachable
  // synthetically; it is part of the declared subset ("block sequences", nested by
  // indentation — spec-load.mjs:10) and a silent mis-parse of it would be exactly
  // the failure mode the strict parser exists to prevent.
  const v = P('checks:\n  -\n    id: a\n    cap: 6\n  -\n    id: b\n    cap: 7\n')
  assert.deepEqual(v, { checks: [{ id: 'a', cap: 6 }, { id: 'b', cap: 7 }] })
})

// Strict-subset guard [MUST] — a construct outside the subset throws, never guesses.
//
// Fourth column: a fragment the report must name. "Fail-loud is the only safe posture"
// (verification design :169-173) is a claim about the *diagnosis*, not merely about the
// exit status — a parser that rejects the input while naming a different construct has
// not told the operator which line of their declaration is outside the subset. Without
// this column the table asserts only "something threw carrying that number", which several
// distinct guards satisfy identically, so an individual guard could be removed and the
// generic fallback at the end of the root block would absorb the case unnoticed.
// Each fragment names the *construct* the case feeds, derived from the subset list
// (verification design :155-173) — not transcribed from a message the engine happens to
// emit for some other reason.
const REJECTIONS = [
  ['anchor / alias', 'base: &a\n  x: 1\nother: *a\n', 1, 'anchors and aliases'],
  ['block scalar', 'desc: |\n  a literal block\n', 1, 'block scalars'],
  ['quoted key', '"step": diagnose\n', 1, 'quoted keys'],
  ['multi-document marker', '---\nstep: a\n---\nstep: b\n', 1, 'multi-document markers'],
  ['tab indentation', 'next:\n\tpass: green\n', 2, 'tab indentation'],
  ['nested flow collection', 'x: [a, [b, c]]\n', 1, 'nested flow collections'],
  // The guard is stated over the whole class — "any construct outside this list …
  // throws" (verification design :169) — not over the six named examples, so the
  // remaining rejection sites carry a case each. Synthetic inputs: no spec/**/*.yaml
  // can reach them (a spec file that did would fail to load).
  ['unterminated flow collection', 'requires: [issue, cycle-state\n', 1, 'unterminated flow collection'],
  ['flow-map entry with no ":"', 'dev: { provider claude, model opus }\n', 1, 'not a flow-map entry'],
  ['continuation line after a flow collection', 'requires: [issue, cycle-state]\n  folded-tail\n', 2, 'continuation line after a flow collection'],
  ['a line inside a mapping that is not a key', 'step: diagnose\nnot a key line\n', 2, 'not a key line'],
  ['unexpected indentation after the root block', '  step: diagnose\nnext: green\n', 2, 'unexpected indentation'],
]
for (const [label, text, line, fragment] of REJECTIONS) {
  await test(`parser strict-subset: ${label} throws naming the construct and the offending line`, () => {
    let thrown = null
    try { P(text, 'reject.yaml') } catch (e) { thrown = e }
    assert.ok(thrown, `expected a throw for ${label}, got a parsed value`)
    // Tightened from `thrown.line === line || <the message contains the digits>`: the
    // disjunct let a throw whose message merely happened to contain the digit pass even
    // when the reported line was wrong. The structured field is the contract.
    assert.equal(thrown.line, line, `throw must report the offending line ${line}; got: ${thrown.message}`)
    assert.ok(
      String(thrown.message).includes(fragment),
      `throw must name the rejected construct (${fragment}); got: ${thrown.message}`,
    )
  })
}

await test('parser DCR-9: comment-only lines under a next: value never enter the routing target', () => {
  const sp = spec()
  assert.equal(mget(stepOf(sp, 'green').next, 'ac-contradiction'), 'verify')
  assert.equal(mget(stepOf(sp, 'handoff').next, 'review-findings'), 'diagnose')
  for (const id of mkeys(sp.steps)) {
    for (const o of mkeys(stepOf(sp, id).next)) {
      assert.ok(!String(mget(stepOf(sp, id).next, o)).includes('#'), `${id}:${o} target absorbed a comment`)
    }
  }
})

// ================================================================================
// LINT — AC1
// ================================================================================

await test('AC1.1: no next-target-unresolved finding on the real tree', () => {
  assert.deepEqual(codes(LINT.lint(spec()), 'next-target-unresolved'), [])
})

await test('AC1.2: no agent-undeclared finding on the real tree', () => {
  assert.deepEqual(codes(LINT.lint(spec()), 'agent-undeclared'), [])
})

await test('AC1.3: no gate-incomplete finding on the real tree', () => {
  assert.deepEqual(codes(LINT.lint(spec()), 'gate-incomplete'), [])
})

await test('AC1.4: no cap-missing / cap-orphan finding on the real tree (0 findings, both directions)', () => {
  const f = LINT.lint(spec())
  assert.deepEqual(codes(f, 'cap-missing'), [])
  assert.deepEqual(codes(f, 'cap-orphan'), [])
  assert.deepEqual(f, [], 'the whole lint is expected to be clean today')
})

await test('AC1.1 negative: a dangling next target yields exactly one finding naming step/outcome/target', () => {
  const sp = cloneSpec(spec())
  mget(sp.steps, 'red').next.set('x', 'nosuchstep')
  const f = codes(LINT.lint(sp), 'next-target-unresolved')
  assert.equal(f.length, 1)
  const blob = JSON.stringify(f[0])
  for (const t of ['red', 'x', 'nosuchstep']) assert.ok(blob.includes(t), `finding must name ${t}: ${blob}`)
})

await test('AC1.2 negative: an unknown agents role yields exactly one finding', () => {
  const sp = cloneSpec(spec())
  mget(sp.steps, 'green').agents = ['nosuchrole']
  const f = codes(LINT.lint(sp), 'agent-undeclared')
  assert.equal(f.length, 1)
  assert.ok(JSON.stringify(f[0]).includes('nosuchrole'))
})

await test('AC1.2 negative: an unknown loop.participants role yields a finding (same referential obligation)', () => {
  const sp = cloneSpec(spec())
  mget(sp.steps, 'architect').loop.participants = ['dev', 'nosuchrole']
  const f = codes(LINT.lint(sp), 'agent-undeclared')
  assert.equal(f.length, 1, 'a linter checking only `agents` silently exempts the two deliberation steps')
  assert.ok(JSON.stringify(f[0]).includes('nosuchrole'))
})

await test('AC1.3 negative: a gate missing criteria yields a finding', () => {
  const sp = cloneSpec(spec())
  delete mget(sp.steps, 'gate_plan').criteria
  const f = codes(LINT.lint(sp), 'gate-incomplete')
  assert.equal(f.length, 1)
  assert.ok(JSON.stringify(f[0]).includes('gate_plan'))
})

await test('AC1.3 negative: a gate whose agents omits evaluator yields a finding', () => {
  const sp = cloneSpec(spec())
  mget(sp.steps, 'audit').agents = ['dev']
  const f = LINT.lint(sp).filter((x) => x.code === 'gate-incomplete' || x.code === 'agent-undeclared')
  assert.ok(codes(f, 'gate-incomplete').length >= 1, 'missing evaluator must be reported per missing part')
  assert.ok(JSON.stringify(f).includes('audit'))
})

await test('AC1.3 negative: an EMPTY criteria string is a finding, not a satisfied gate', () => {
  const sp = cloneSpec(spec())
  mget(sp.steps, 'gate_plan').criteria = ''
  const f = codes(LINT.lint(sp), 'gate-incomplete')
  assert.equal(f.length, 1)
  assert.equal(f[0].where, 'gate_plan.criteria')
  assert.equal(f[0].expected, 'a non-empty criteria name')
  assert.equal(f[0].actual, '', 'the finding reports the offending value, distinguishing "" from "absent"')
})

// AC1.3's third obligation: naming `evaluator` is not enough — the referenced role
// must itself declare `session: fresh` (invariant 2; feature design §1.4). A gate
// whose evaluator is reused is not a gate, so the reference check and the property
// check are separate negatives.
const GATE_STEPS = ['audit', 'gate_hypothesis', 'gate_plan', 'gate_quality']

await test('AC1.3: the four kind:gate steps are the ones the evaluator invariant applies to', () => {
  const sp = spec()
  const gates = mkeys(sp.steps).filter((id) => stepOf(sp, id).kind === 'gate').sort()
  assert.deepEqual(gates, GATE_STEPS)
  assert.equal(mget(sp.roles, 'evaluator').session, 'fresh', 'invariant 2 holds on the real tree')
})

await test('AC1.3 negative: an evaluator role declaring session other than fresh yields one gate-incomplete per gate', () => {
  const sp = cloneSpec(spec())
  mget(sp.roles, 'evaluator').session = 'persistent'
  const f = codes(LINT.lint(sp), 'gate-incomplete')
  assert.equal(f.length, GATE_STEPS.length, 'a reused evaluator invalidates every gate, not just one')
  assert.deepEqual(f.map((x) => x.step).sort(), GATE_STEPS)
  for (const hit of f) {
    assert.equal(hit.severity, 'error')
    assert.equal(hit.where, `${hit.step}.agents.evaluator`)
    assert.equal(hit.expected, 'session: fresh')
    assert.equal(hit.actual, 'persistent', 'the finding must report the offending session value')
  }
})

await test('AC1.3 negative: a gate naming evaluator while the role is undeclared is reported, not treated as satisfied', () => {
  const sp = cloneSpec(spec())
  sp.roles.delete('evaluator')
  const f = codes(LINT.lint(sp), 'gate-incomplete')
  assert.equal(f.length, GATE_STEPS.length)
  for (const hit of f) assert.equal(hit.actual, 'role absent')
})

await test('AC1.4 negative: a bounded step owning no cap key yields one cap-missing finding', () => {
  const sp = cloneSpec(spec())
  delete sp.binding.caps['audit.retry']
  const f = codes(LINT.lint(sp), 'cap-missing')
  assert.equal(f.length, 1)
  assert.ok(JSON.stringify(f[0]).includes('audit'))
})

await test('AC1.4 negative: a cap key naming a non-existent step yields one cap-orphan finding', () => {
  const sp = cloneSpec(spec())
  sp.binding.caps['nosuchstep.retry'] = 2
  const f = codes(LINT.lint(sp), 'cap-orphan')
  assert.equal(f.length, 1)
  assert.ok(JSON.stringify(f[0]).includes('nosuchstep'))
})

// Lint, both cap directions (verification design §7 "Lint, both cap directions (4)")
await test('AC1.4 direction A: the bounded-step set derived from the declarations equals the measured 8', () => {
  assert.deepEqual(boundedStepsOf(spec()), MEASURED_BOUNDED)
})

await test('AC1.4 direction A: every bounded step owns ≥ 1 "<step>." cap key in the binding', () => {
  const sp = spec()
  const keys = Object.keys(sp.binding.caps)
  assert.deepEqual(keys.slice().sort(), MEASURED_CAP_KEYS)
  for (const id of boundedStepsOf(sp)) {
    const owned = keys.filter((k) => k.startsWith(`${id}.`))
    assert.ok(owned.length >= 1, `bounded step ${id} owns no cap key`)
    for (const k of owned) assert.ok(Number.isInteger(sp.binding.caps[k]) && sp.binding.caps[k] >= 1, `${k} is not an integer ≥ 1`)
  }
})

await test('AC1.4 direction A negative: a synthetic bounded step with no cap key → one cap-missing', () => {
  const sp = cloneSpec(spec())
  mget(sp.steps, 'integrate').next.set('cap-exhausted', 'escalate')
  const f = codes(LINT.lint(sp), 'cap-missing')
  assert.equal(f.length, 1)
  assert.ok(JSON.stringify(f[0]).includes('integrate'))
})

await test('AC1.4 direction B negative: a cap key naming a declared but UNBOUNDED step → one cap-orphan', () => {
  const sp = cloneSpec(spec())
  sp.binding.caps['integrate.retry'] = 2
  const f = codes(LINT.lint(sp), 'cap-orphan')
  assert.equal(f.length, 1, 'a cap bound to an unbounded step is dead overlay (§1.6 check 5)')
  assert.ok(JSON.stringify(f[0]).includes('integrate'))
})

await test('AC1 tree properties: no colon-in-value and no "#" inside a quoted value under spec/', () => {
  spec() // the properties are only meaningful against a tree the parser accepted
  const files = []
  for (const d of ['spec/steps', 'spec/roles', 'spec/bindings']) {
    for (const f of readdirSync(join(root, d))) if (f.endsWith('.yaml')) files.push(join(d, f))
  }
  assert.equal(files.length, 23, 'expected 16 steps + 6 roles + 1 binding')
  for (const rel of files) {
    const text = readRepo(rel)
    text.split('\n').forEach((line, i) => {
      const body = line.replace(/\s+#.*$/, '').trim()
      const m = body.match(/^([A-Za-z0-9_.-]+):\s+(\S.*)$/)
      // A flow map legitimately carries colons; a PLAIN scalar value must not.
      if (m && !m[2].startsWith('{') && !m[2].startsWith('[')) {
        assert.ok(!/:\s/.test(m[2]), `${rel}:${i + 1} colon-in-value is outside the parser subset`)
      }
      assert.ok(!/"[^"]*#/.test(body), `${rel}:${i + 1} "#" inside a quoted value is outside the parser subset`)
    })
  }
})

// ================================================================================
// GATE CALCULATOR — O-3 equivalence (AC2.1 / AC2.3 calculator side)
// ================================================================================

const HOOK = '.claude/hooks/check-autoflow-gate.sh'

// The differential oracle (ledger L15): the hook's `check_scores` jq program is
// EXTRACTED FROM THE HOOK SOURCE at run time and executed by the real jq binary,
// so equivalence is measured against the enforced implementation rather than
// against a transcription of it. The extraction is deliberately literal — it
// slices the program between the `jq --arg phase "$phase_key" '` opener and the
// next `'`, and fails loudly if the shape ever changes.
function hookScoresProgram() {
  const src = readRepo(HOOK)
  const fn = src.indexOf('check_scores() {')
  assert.ok(fn > 0, `${HOOK} no longer defines check_scores()`)
  const opener = `jq --arg phase "$phase_key" '`
  const a = src.indexOf(opener, fn)
  assert.ok(a > 0, `${HOOK} check_scores() no longer invokes jq in the expected form`)
  const s = a + opener.length
  const e = src.indexOf("'", s)
  assert.ok(e > s, `${HOOK} check_scores() jq program is not single-quote delimited`)
  const prog = src.slice(s, e)
  assert.ok(prog.includes('evaluation not run') && prog.includes('automatic rework'), 'extracted program does not look like check_scores')
  return prog
}

function hookVerdict(scores) {
  const state = JSON.stringify({ phases: { g: { scores } } })
  const out = execFileSync('jq', ['--arg', 'phase', 'g', hookScoresProgram()], { input: state, encoding: 'utf8' })
  return JSON.parse(out)
}

// D19's rounding case needs a synthetic item count: with integer scores a raw
// average in [7.45, 7.5) is unreachable at every real gate size (n=3/5/10), so
// n=20 is used and labelled a calculator-contract case, not a reachable state.
// 149 = 9×8 + 11×7 (avg 7.45 → 7.5 → PASS); 148 = 8×8 + 12×7 (avg 7.4 → FAIL).
function synthetic20(sum) {
  const eights = sum - 20 * 7
  const s = {}
  for (let i = 0; i < 20; i++) s[`i${String(i).padStart(2, '0')}`] = i < eights ? 8 : 7
  return s
}

const HOOK_FIELDS = ['pass', 'avg', 'min', 'security', 'reason']
const project = (v) => Object.fromEntries(HOOK_FIELDS.map((k) => [k, v[k]]))

await test('gate 1: all items ≥ 7 and avg ≥ 7.5 → pass', () => {
  const v = GATE.computeVerdict({ a: 9, b: 8 })
  assert.equal(v.pass, true)
  assert.equal(v.avg, 8.5)
  assert.equal(v.reason, 'PASS')
})

await test('gate 2: one item < 7 → fail with the min reason', () => {
  const v = GATE.computeVerdict({ a: 6, b: 9, c: 9 })
  assert.equal(v.pass, false)
  assert.equal(v.min, 6)
  assert.match(v.reason, /^lowest score 6/)
})

await test('gate 3: every item ≥ 7 but avg < 7.5 → fail with the avg reason ([7,7,7,8] → 7.25)', () => {
  const v = GATE.computeVerdict({ a: 7, b: 7, c: 7, d: 8 })
  assert.equal(v.pass, false)
  assert.equal(v.avg, 7.3, 'the hook rounds add/length*10|round/10, so 7.25 → 7.3')
  assert.match(v.reason, /^average /)
})

await test('gate 4: security 3 → immediate block, with the security reason (AC2.3)', () => {
  const v = GATE.computeVerdict({ security: 3, a: 9, b: 9, c: 9 })
  assert.equal(v.pass, false)
  assert.equal(v.security, 3)
  assert.match(v.reason, /^security score 3/)
})

await test('gate 5: security 4 is not blocked by the security branch (AC2.3)', () => {
  const v = GATE.computeVerdict({ security: 4, a: 9, b: 9, c: 9 })
  assert.equal(v.security, 4)
  assert.ok(!/^security score/.test(v.reason), 'security 4 must not take the security branch')
  assert.match(v.reason, /^lowest score 4/)
})

await test('gate 6: precedence — security 2 with another item at 5 → the security reason wins', () => {
  const v = GATE.computeVerdict({ security: 2, a: 5, b: 9 })
  assert.match(v.reason, /^security score 2/, 'security is tested before min (check-autoflow-gate.sh:479-482)')
})

await test('gate 7: precedence — min 6 with avg 9 → the min reason, not the avg reason', () => {
  const v = GATE.computeVerdict({ a: 6, b: 10, c: 10, d: 10 })
  assert.match(v.reason, /^lowest score 6/)
})

await test('gate 8: rounding contract (D19) — n=20 sum=149 → 7.45 rounds up to 7.5 → PASS; sum=148 → FAIL', () => {
  const up = GATE.computeVerdict(synthetic20(149))
  assert.equal(up.avg, 7.5)
  assert.equal(up.pass, true, 'round-half-away-from-zero at 74.5 must flip FAIL→PASS')
  const down = GATE.computeVerdict(synthetic20(148))
  assert.equal(down.avg, 7.4)
  assert.equal(down.pass, false)
})

await test('gate 9: empty scores → fail-closed "evaluation not run" with the hook companion fields and below7 []', () => {
  const v = GATE.computeVerdict({})
  assert.deepEqual(project(v), { pass: false, avg: 0, min: 0, security: null, reason: 'evaluation not run' })
  assert.deepEqual(v.below7, [])
})

await test('gate 10: object-shaped {score: n} and bare-number scores are both accepted; 보안 aliases security', () => {
  assert.deepEqual(project(GATE.computeVerdict({ a: { score: 8 }, b: 9 })), project(GATE.computeVerdict({ a: 8, b: 9 })))
  const v = GATE.computeVerdict({ 보안: 3, x: 9 })
  assert.equal(v.security, 3)
  assert.match(v.reason, /^security score 3/)
})

await test('gate 11: below7 (D17) is a sorted key list — [] when all ≥ 7, populated for a mixed set fed in reverse key order', () => {
  assert.deepEqual(GATE.computeVerdict({ a: 7, b: 9 }).below7, [])
  assert.deepEqual(GATE.computeVerdict({ zz: 6, aa: 5, mm: 9 }).below7, ['aa', 'zz'])
  assert.deepEqual(GATE.computeVerdict({ b: 6, a: 6 }).below7, ['a', 'b'])
})

await test('gate 12: below7 is additive — the verdict carries exactly the hook fields plus below7, and pass/reason are unaffected', () => {
  const v = GATE.computeVerdict({ a: 6, b: 9 })
  assert.deepEqual(Object.keys(v).sort(), [...HOOK_FIELDS, 'below7'].sort())
  assert.deepEqual(project(v), project(GATE.computeVerdict({ a: 6, b: 9 })))
})

await test('gate thresholds (DCR-5c): THRESHOLDS is the injectable default, and an injected set changes the verdict', () => {
  assert.deepEqual(
    { securityMax: GATE.THRESHOLDS.securityMax, itemMin: GATE.THRESHOLDS.itemMin, avgMin: GATE.THRESHOLDS.avgMin },
    { securityMax: 3, itemMin: 7, avgMin: 7.5 },
  )
  const strict = GATE.computeVerdict({ a: 8, b: 8 }, { securityMax: 3, itemMin: 9, avgMin: 7.5 })
  assert.equal(strict.pass, false, 'thresholds must be a parameter, not a hard-coded constant')
})

// ---- L15: differential equivalence against the executed hook oracle -------------

const DIFFERENTIAL = [
  ['pass, two items', { a: 9, b: 8 }],
  ['min branch', { a: 6, b: 9, c: 9 }],
  ['avg branch, all items ≥ 7', { a: 7, b: 7, c: 7, d: 8 }],
  ['security 3 block', { security: 3, a: 9, b: 9, c: 9 }],
  ['security 4 no block', { security: 4, a: 9, b: 9, c: 9 }],
  ['precedence security over min', { security: 2, a: 5, b: 9 }],
  ['min over avg', { a: 6, b: 10, c: 10, d: 10 }],
  ['object-shaped score', { a: { score: 8 }, b: 9 }],
  ['보안 alias', { 보안: 3, x: 9 }],
  ['empty scores', {}],
  ['3-item gate with a repeating average', { hypothesis_diversity: 9, verification_sufficiency: 10, verdict_evidence: 9 }],
  ['rounding boundary n=20 sum=149', synthetic20(149)],
]
for (const [label, scores] of DIFFERENTIAL) {
  await test(`O-3 differential (L15): ${label} — engine/gate.mjs === executed check_scores`, () => {
    assert.deepEqual(project(GATE.computeVerdict(scores)), hookVerdict(scores))
  })
}

await test('O-3 differential (L15): every recorded gate item set in the corpus matches the executed hook', () => {
  const lines = readRepo('docs/cycle-digest.jsonl').trim().split('\n')
  let compared = 0
  for (const line of lines) {
    for (const g of Object.values(JSON.parse(line).gates)) {
      if (!g.items) continue
      assert.deepEqual(project(GATE.computeVerdict(g.items)), hookVerdict(g.items))
      compared++
    }
  }
  assert.equal(compared, 64, 'expected 64 pass-shaped gate objects across the 13 records')
})

// ================================================================================
// ROUTING / SIMULATION — AC2
// ================================================================================

// The simulator driver lives in the harness (feature design §1.7): the mock role
// outputs are verification scaffolding, not engine code. `counters` is created
// empty inside every call and never hoisted (D22 / R16) — simulate() is a pure
// function of (spec, {start, outcomes}).
const LOOP = '@loop-reentry' // sentinel: the step re-runs internally (CAP_LOOPS)
const TRAVERSED = new Set()

// Exhaustion target per bounded unit (feature design §1.4 table / D13). The
// counter's OWNING step supplies the target, which is what makes the shared
// gate_plan.retry resolve to gate_plan's cap-exhausted rather than verify's.
function exhaustionTarget(sp, capKey) {
  const owner = capKey.split('.')[0]
  const nx = stepOf(sp, owner).next
  if (mhas(nx, 'cap-exhausted')) return { outcome: 'cap-exhausted', target: mget(nx, 'cap-exhausted'), source: 'declaration' }
  if (owner === 'architect') return { outcome: 'escalate', target: mget(nx, 'escalate'), source: 'declaration' }
  if (owner === 'verify') return { outcome: 'undecidable', target: mget(nx, 'undecidable'), source: 'prose:CLAUDE.md > Flow Control > Human escalation' }
  throw new Error(`no exhaustion target is defined for cap key ${capKey}`)
}

function simulate(sp, { start = 'preflight', outcomes, maxSteps = 400 }) {
  const counters = {} // [MUST] per-call, never module-scoped (D22 / R16)
  const trace = []
  let cur = start
  let terminal = null
  for (let i = 0; i < maxSteps; i++) {
    if (RT.RESERVED.has(cur)) { terminal = cur; break }
    const outcome = outcomes(cur, { counters, trace })
    if (outcome == null) { terminal = cur; break } // modelled no-transition (O-6)
    if (outcome === LOOP) {
      const capKey = RT.capKeyForLoop(cur)
      if (!capKey) throw new Error(`${cur} declares no bounded loop`)
      const cap = RT.capValue(sp, capKey)
      const prior = counters[capKey] || 0
      if (prior >= cap) {
        const ex = exhaustionTarget(sp, capKey)
        trace.push({ from: cur, outcome: LOOP, to: ex.target, exhausted: true, capKey, resolvedOutcome: ex.outcome })
        cur = ex.target
      } else {
        counters[capKey] = prior + 1
        trace.push({ from: cur, outcome: LOOP, to: cur, capKey })
      }
      continue
    }
    const capKey = RT.capKeyFor(cur, outcome)
    if (capKey) {
      const cap = RT.capValue(sp, capKey)
      const prior = counters[capKey] || 0
      if (prior >= cap) {
        const ex = exhaustionTarget(sp, capKey)
        TRAVERSED.add(`${cur}:${outcome}`)
        trace.push({ from: cur, outcome, to: ex.target, exhausted: true, capKey, resolvedOutcome: ex.outcome })
        cur = ex.target
        continue
      }
      counters[capKey] = prior + 1
    }
    const { target } = RT.resolve(sp, cur, outcome)
    TRAVERSED.add(`${cur}:${outcome}`)
    trace.push(capKey ? { from: cur, outcome, to: target, capKey } : { from: cur, outcome, to: target })
    cur = target
  }
  return { trace, counters, terminal }
}

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

for (const [step, outcome, target] of EDGES_EXPECTED) {
  await test(`AC2.0 edge ${step}:${outcome} → ${target}`, () => {
    const r = simulate(spec(), { start: step, outcomes: oneShot(step, outcome) })
    assert.equal(r.trace.length, 1, `expected exactly one hop, got ${JSON.stringify(r.trace)}`)
    assert.deepEqual(
      { from: r.trace[0].from, outcome: r.trace[0].outcome, to: r.trace[0].to },
      { from: step, outcome, to: target },
    )
  })
}

// ---- R1: AC2.1 gate FAIL → retry, driven through the real calculator -----------

const FAILING_SCORES = { a: 6, b: 9, c: 9 }
const GATE_FAIL_EDGE = [['audit', 'green'], ['gate_hypothesis', 'diagnose'], ['gate_plan', 'architect'], ['gate_quality', 'red']]
for (const [gate, target] of GATE_FAIL_EDGE) {
  await test(`R1/AC2.1 ${gate}: a score set with one item < 7 → computeVerdict fail → ${target}`, () => {
    const decide = () => (GATE.computeVerdict(FAILING_SCORES).pass ? 'pass' : 'fail')
    const r = simulate(spec(), { start: gate, outcomes: oneShot(gate, decide()) })
    assert.equal(r.trace[0].to, target)
  })
}

// ---- R2: AC2.2 boundary triple per gate step declaring cap-exhausted -----------

// Return paths that bring the walk back to the gate under test, so the triple is
// driven by real traversals rather than by seeding a counter from outside.
const BACK_TO_GATE = {
  gate_hypothesis: { diagnose: 'code-change-needed-bug' },
  gate_plan: { architect: 'converged' },
  audit: {},
  gate_quality: { audit: 'pass' },
}

function driveGateFails(sp, gate, times) {
  let hits = 0
  const overrides = {
    ...BACK_TO_GATE[gate],
    [gate]: () => (hits < times ? ((hits += 1), 'fail') : null),
  }
  return simulate(sp, { start: gate, outcomes: mainLine(overrides) })
}

for (const gate of ['gate_hypothesis', 'gate_plan', 'audit', 'gate_quality']) {
  const capKey = `${gate}.retry`
  for (const offset of [-2, -1, 0]) {
    await test(`R2/AC2.2 ${gate} (cap N=${capKey}): prior=N${offset} → the declared fail edge / exhaustion`, () => {
      const sp = spec()
      const N = sp.binding.caps[capKey]
      assert.ok(Number.isInteger(N), `${capKey} must be read from the binding, never a literal`)
      const prior = N + offset
      if (prior < 0) { assert.ok(true, `N=${N} has no prior=${prior} state; the triple degenerates`); return }
      const r = driveGateFails(sp, gate, prior + 1)
      const hops = r.trace.filter((t) => t.from === gate && t.outcome === 'fail')
      assert.equal(hops.length, prior + 1)
      const last = hops[hops.length - 1]
      if (prior < N) {
        assert.ok(!last.exhausted, `traversal ${prior + 1} of ${N} must take the declared fail edge`)
        assert.equal(last.to, mget(stepOf(sp, gate).next, 'fail'))
      } else {
        assert.ok(last.exhausted, `traversal N+1 must resolve to the exhaustion target`)
        assert.equal(last.resolvedOutcome, 'cap-exhausted')
        assert.equal(last.to, 'escalate')
      }
    })
  }
}

// ---- R3: AC2.2 for verify — a SHARED-budget triple (D20) -----------------------

function driveVerify(sp, branches) {
  // branches: an array of 'test-issue' / 'impl-issue' in traversal order
  let i = 0
  const overrides = {
    verify: () => (i < branches.length ? branches[i++] : null),
    red: 'red-confirmed',
    green: 'done',
  }
  return simulate(sp, { start: 'verify', outcomes: mainLine(overrides) })
}

for (const prior of [1, 2, 3]) {
  await test(`R3/AC2.2 verify (verify.round-trips shared across both cause branches): prior=${prior}`, () => {
    const sp = spec()
    const N = sp.binding.caps['verify.round-trips']
    const branches = []
    for (let k = 0; k < prior; k++) branches.push(k % 2 === 0 ? 'test-issue' : 'impl-issue')
    branches.push('test-issue')
    const r = driveVerify(sp, branches)
    const hops = r.trace.filter((t) => t.from === 'verify' && t.outcome !== 'pass')
    const last = hops[hops.length - 1]
    if (prior < N) {
      assert.ok(!last.exhausted, `summed traversal ${prior + 1} of ${N} must take its own cause branch`)
      assert.equal(last.to, 'red')
    } else {
      assert.ok(last.exhausted)
      assert.equal(last.resolvedOutcome, 'undecidable', 'verify declares no cap-exhausted; D13 names undecidable')
      assert.equal(last.to, 'escalate')
      const row = RT.PROSE_SOURCED.find((p) => p.where === 'verify' && p.what === 'exhaustion-target')
      assert.ok(row && String(row.source).startsWith('prose:'), 'verify exhaustion target must be marked prose-sourced')
    }
  })
}

// ---- R4: AC2.2 for the shared, cross-step gate_plan.retry ----------------------

function driveDesignContradiction(sp, times) {
  let i = 0
  const overrides = {
    verify: () => (i < times ? ((i += 1), 'design-contradiction') : null),
    architect: 'converged',
    gate_plan: 'pass',
    dispatch: 'assigned',
    red: 'red-confirmed',
    green: 'done',
  }
  return simulate(sp, { start: 'verify', outcomes: mainLine(overrides) })
}

await test('R4: verify:design-contradiction increments the gate_plan.retry cap key, not a verify-scoped counter', () => {
  const r = driveDesignContradiction(spec(), 1)
  assert.deepEqual(Object.keys(r.counters), ['gate_plan.retry'])
  assert.equal(r.counters['gate_plan.retry'], 1)
  assert.equal(RT.capKeyFor('verify', 'design-contradiction'), 'gate_plan.retry')
})

await test("R4: exhausting the shared budget from verify resolves to gate_plan's cap-exhausted → escalate", () => {
  const sp = spec()
  const N = sp.binding.caps['gate_plan.retry']
  const r = driveDesignContradiction(sp, N + 1)
  const hops = r.trace.filter((t) => t.outcome === 'design-contradiction')
  const last = hops[hops.length - 1]
  assert.ok(last.exhausted)
  assert.equal(last.capKey, 'gate_plan.retry')
  assert.equal(last.resolvedOutcome, 'cap-exhausted')
  assert.equal(last.to, 'escalate', "the counter's owning step supplies the target (D13)")
})

// ---- R5: refine — the one non-escalate exhaustion target -----------------------

function driveRefineLoop(sp, times) {
  let i = 0
  return simulate(sp, { start: 'refine', outcomes: mainLine({ refine: () => (i < times ? ((i += 1), LOOP) : null) }) })
}

await test('R5/AC2.2 refine (refine.retry): re-entries 1…N resolve as internal retries', () => {
  const sp = spec()
  const N = sp.binding.caps['refine.retry']
  const r = driveRefineLoop(sp, N)
  const hops = r.trace.filter((t) => t.from === 'refine')
  assert.equal(hops.length, N)
  assert.ok(hops.every((h) => !h.exhausted && h.to === 'refine'))
  assert.equal(r.counters['refine.retry'], N)
})

await test('R5/AC2.2 refine: exhaustion resolves to refine\'s own cap-exhausted → validate, NOT escalate', () => {
  const sp = spec()
  const N = sp.binding.caps['refine.retry']
  const r = driveRefineLoop(sp, N + 1)
  const last = r.trace.filter((t) => t.from === 'refine').pop()
  assert.ok(last.exhausted)
  assert.equal(last.resolvedOutcome, 'cap-exhausted')
  assert.equal(last.to, 'validate', 'a hard-coded escalate would pass every other exhaustion case')
})

// ---- R6: CAP_LOOPS boundary cases (D11) ----------------------------------------

function driveArchitectLoop(sp, times) {
  let i = 0
  return simulate(sp, { start: 'architect', outcomes: mainLine({ architect: () => (i < times ? ((i += 1), LOOP) : null) }) })
}

await test('R6: architect.loop — the Nth re-entry still continues the deliberation', () => {
  const sp = spec()
  const N = sp.binding.caps['architect.loop']
  const r = driveArchitectLoop(sp, N)
  const hops = r.trace.filter((t) => t.from === 'architect')
  assert.equal(hops.length, N)
  assert.ok(hops.every((h) => !h.exhausted && h.to === 'architect'))
})

await test('R6: architect.loop — the (N+1)th re-entry takes next.escalate (the loop.until escape)', () => {
  const sp = spec()
  const N = sp.binding.caps['architect.loop']
  const r = driveArchitectLoop(sp, N + 1)
  const last = r.trace.filter((t) => t.from === 'architect').pop()
  assert.ok(last.exhausted)
  assert.equal(last.resolvedOutcome, 'escalate')
  assert.equal(last.to, 'escalate')
  assert.equal(r.terminal, 'escalate')
})

await test('R6: refine.retry is counted through the STEP-keyed CAP_LOOPS lookup', () => {
  assert.equal(RT.capKeyForLoop('refine'), 'refine.retry')
  assert.equal(RT.capKeyForLoop('architect'), 'architect.loop')
  assert.equal(RT.capKeyFor('refine', 'green-reconfirmed'), null, 'refine closes no cycle — it is a loop bound, not an edge bound')
  assert.equal(RT.capKeyFor('architect', 'converged'), null)
})

await test('R6: capKeyForLoop resolves to no cap key for a step that declares no loop bound', () => {
  // D1/D11 (feature design :130, :169): a step is bounded iff it declares a `loop:` block
  // or a `cap-exhausted` outcome, and CAP_LOOPS keys only the *loop*-bounded steps. A step
  // outside that table must resolve to no loop cap key — under D20 the counters map is keyed
  // by cap key, so a non-loop step resolving to one would silently draw down that step's
  // budget. Asserted here on capKeyForLoop alone: its miss arm is byte-identical to
  // capKeyFor's, and the sibling assertions above (`capKeyFor(...) === null`) cannot
  // discriminate this one.
  const sp = spec()
  const loopBounded = new Set(Object.keys(RT.CAP_LOOPS))
  assert.deepEqual([...loopBounded].sort(), ['architect', 'refine'])
  for (const id of mkeys(sp.steps)) {
    if (loopBounded.has(id)) continue
    assert.equal(RT.capKeyForLoop(id), null, `${id} declares no loop bound — it must resolve to no loop cap key`)
  }
  // Named explicitly so the property is not vacuous if CAP_LOOPS ever grows:
  assert.equal(RT.capKeyForLoop('diagnose'), null)
  assert.equal(RT.capKeyForLoop('gate_plan'), null, 'gate_plan is edge-bounded, not loop-bounded')
})

await test('R6: the loop counters are distinct from every CAP_EDGES counter', () => {
  const loopKeys = new Set(Object.values(RT.CAP_LOOPS).map((v) => (typeof v === 'string' ? v : v.capKey)))
  const edgeKeys = new Set(Object.values(RT.CAP_EDGES).map((v) => (typeof v === 'string' ? v : v.capKey)))
  for (const k of loopKeys) assert.ok(!edgeKeys.has(k), `${k} appears in both tables`)
  assert.deepEqual([...loopKeys].sort(), ['architect.loop', 'refine.retry'])
})

// ---- R7 / R8: handoff's two budgets --------------------------------------------

function driveHandoff(sp, plan) {
  // plan: a function returning the handoff outcome for visit n (1-based), or null
  let visit = 0
  return simulate(sp, {
    start: 'handoff',
    maxSteps: 800,
    outcomes: mainLine({ handoff: () => plan(++visit), diagnose: 'code-change-needed-feat' }),
  })
}

for (const prior of [5, 6, 7]) {
  await test(`R7/AC2.6 handoff.review-response: traversal ${prior + 1} of the 7-budget`, () => {
    const sp = spec()
    const N = sp.binding.caps['handoff.review-response']
    const r = driveHandoff(sp, (v) => (v <= prior + 1 ? 'review-findings' : null))
    const hops = r.trace.filter((t) => t.outcome === 'review-findings')
    assert.equal(hops.length, prior + 1)
    const last = hops[hops.length - 1]
    if (prior < N) {
      assert.ok(!last.exhausted)
      assert.equal(last.to, 'diagnose')
    } else {
      assert.ok(last.exhausted)
      assert.equal(last.resolvedOutcome, 'cap-exhausted')
      assert.equal(last.to, 'escalate')
    }
  })
}

await test('R8/AC2.6: exhausting handoff.env-retry leaves handoff.review-response at its full budget', () => {
  const sp = spec()
  const env = sp.binding.caps['handoff.env-retry']
  let envSeen = 0
  let rf = 0
  const r = driveHandoff(sp, () => {
    if (envSeen < env) { envSeen += 1; return 'env-failure' }
    if (rf < 1) { rf += 1; return 'review-findings' }
    return null
  })
  assert.equal(r.counters['handoff.env-retry'], env)
  assert.equal(r.counters['handoff.review-response'], 1)
  const firstReview = r.trace.filter((t) => t.outcome === 'review-findings')[0]
  assert.ok(!firstReview.exhausted, 'a spent env-retry budget must not consume the review-response budget')
})

await test('R8/AC2.6: a spent review-response budget leaves handoff.env-retry intact (distinct cap keys, D20)', () => {
  const sp = spec()
  const N = sp.binding.caps['handoff.review-response']
  let rf = 0
  const r = driveHandoff(sp, () => (rf < N ? ((rf += 1), 'review-findings') : 'env-failure'))
  assert.equal(r.counters['handoff.review-response'], N)
  const env = r.trace.filter((t) => t.outcome === 'env-failure')[0]
  assert.ok(!env.exhausted)
  assert.equal(env.to, 'handoff')
})

// ---- R9: AC2.5 handoff review-triage takes the PAIR (max_severity, label) ------

const SEVERITY_ORDER = ['None', 'Low', 'Medium', 'High']
const TRIAGE_SOURCE = 'prose:CLAUDE.md > Flow Control > HANDOFF rows'
// Mock provenance table (feature design §1.7): the mapping has no declarative
// source, so every row carries its `source` and the harness asserts it.
function triage(maxSeverity, label) {
  if (label === 'cleared') return { outcome: 'review-clean', source: TRIAGE_SOURCE }
  if (SEVERITY_ORDER.indexOf(maxSeverity) >= SEVERITY_ORDER.indexOf('Medium')) {
    return { outcome: 'review-findings', source: TRIAGE_SOURCE }
  }
  // label present ∧ max_severity < Medium: no declared outcome (O-6) — re-run the
  // review, and explicitly "Does not consume the 7-attempt cap".
  return { outcome: null, source: TRIAGE_SOURCE }
}

const TRIAGE_MATRIX = [
  ['Medium', 'present', 'review-findings', 'diagnose'],
  ['High', 'present', 'review-findings', 'diagnose'],
  ['Low', 'present', null, null],
  ['None', 'cleared', 'review-clean', 'end'],
  ['Low', 'cleared', 'review-clean', 'end'],
]
for (const [sev, label, outcome, target] of TRIAGE_MATRIX) {
  await test(`R9/AC2.5 handoff triage (${sev}, label ${label}) → ${outcome === null ? 'no transition' : outcome}`, () => {
    const t = triage(sev, label)
    assert.equal(t.outcome, outcome)
    assert.ok(String(t.source).startsWith('prose:'), 'the severity→outcome mapping is prose-sourced (DCR-5b)')
    const r = simulate(spec(), { start: 'handoff', outcomes: oneShot('handoff', t.outcome) })
    if (outcome === null) {
      assert.equal(r.trace.length, 0, 'the label-present & <Medium case is modelled as no transition')
      assert.equal(r.counters['handoff.review-response'] || 0, 0, 'it must not consume the 7-attempt cap')
      assert.equal(r.terminal, 'handoff')
    } else {
      assert.equal(r.trace[0].to, target)
    }
  })
}

// ---- R10: AC2.4 verify arbitration verdicts ------------------------------------

const ARBITRATION_SOURCE = 'prose:spec/steps/verify.yaml'
const ARBITRATION = [
  ['test-issue', 'red'],
  ['impl-issue', 'green'],
  ['design-contradiction', 'architect'],
  ['undecidable', 'escalate'],
]
for (const [verdict, target] of ARBITRATION) {
  await test(`R10/AC2.4 arbitration verdict "${verdict}" selects the identically-named verify outcome → ${target}`, () => {
    // The arbitration is not a step: the mechanism exists only as a comment.
    assert.match(readRepo('spec/steps/verify.yaml'), /fresh evaluator arbitration/, ARBITRATION_SOURCE)
    const r = simulate(spec(), { start: 'verify', outcomes: oneShot('verify', verdict) })
    assert.equal(r.trace[0].to, target)
  })
}

await test('R10/AC2.4 the non-deadlock path: verify pass → refine', () => {
  const r = simulate(spec(), { start: 'verify', outcomes: oneShot('verify', 'pass') })
  assert.equal(r.trace[0].to, 'refine')
})

// ---- R11: AC2.3 routing side ----------------------------------------------------

await test('R11/AC2.3: a security-3 score set blocks at the gate and takes the declared fail edge', () => {
  const v = GATE.computeVerdict({ security: 3, feasibility: 9, dependencies: 9, scope: 9, test_plan: 9 })
  assert.equal(v.pass, false)
  assert.match(v.reason, /^security score 3/)
  const r = simulate(spec(), { start: 'gate_plan', outcomes: oneShot('gate_plan', v.pass ? 'pass' : 'fail') })
  assert.equal(r.trace[0].to, 'architect')
})

// ---- R13 / R14: the tables are asserted, not trusted ----------------------------

const capKeyOf = (row) => (typeof row === 'string' ? row : row.capKey)
const tableKeys = () => [
  ...Object.values(RT.CAP_EDGES).map(capKeyOf),
  ...Object.values(RT.CAP_LOOPS).map(capKeyOf),
]

await test('R13/D12: CAP_EDGES ∪ CAP_LOOPS maps onto the binding\'s 9 cap keys exactly', () => {
  const sp = spec()
  assert.deepEqual([...new Set(tableKeys())].sort(), Object.keys(sp.binding.caps).sort())
  assert.deepEqual([...new Set(tableKeys())].sort(), MEASURED_CAP_KEYS)
})

await test('R13/D12: every bounded step appears as a CAP_EDGES step or a CAP_LOOPS key', () => {
  const sp = spec()
  const edgeSteps = Object.keys(RT.CAP_EDGES).map((k) => k.split(':')[0])
  const covered = new Set([...edgeSteps, ...Object.keys(RT.CAP_LOOPS)])
  for (const id of boundedStepsOf(sp)) assert.ok(covered.has(id), `bounded step ${id} is claimed by no table row`)
})

await test('R13/D12 negative: a synthetic bounded step claimed by no row is detected', () => {
  const sp = cloneSpec(spec())
  mget(sp.steps, 'integrate').next.set('cap-exhausted', 'escalate')
  const edgeSteps = Object.keys(RT.CAP_EDGES).map((k) => k.split(':')[0])
  const covered = new Set([...edgeSteps, ...Object.keys(RT.CAP_LOOPS)])
  const uncovered = boundedStepsOf(sp).filter((id) => !covered.has(id))
  assert.deepEqual(uncovered, ['integrate'], 'the table must not be its own oracle')
})

await test('R14/D15: PROSE_SOURCED is exactly the two declared prose dependencies', () => {
  assert.deepEqual(RT.PROSE_SOURCED, [
    { where: 'verify', what: 'exhaustion-target', value: 'undecidable', source: 'prose:CLAUDE.md > Flow Control > Human escalation' },
    { where: 'handoff', what: 'missing-outcome', value: 'label-present & max_severity < Medium → re-review, no cap consumption', source: 'prose:CLAUDE.md > Flow Control > HANDOFF rows' },
  ])
})

// ---- R15: shared budgets under cap-key keying (D20) -----------------------------

for (const fourth of ['test-issue', 'impl-issue']) {
  await test(`R15a: 2×test-issue + 1×impl-issue exhausts verify.round-trips — the 4th (${fourth}) → undecidable → escalate`, () => {
    const sp = spec()
    const r = driveVerify(sp, ['test-issue', 'test-issue', 'impl-issue', fourth])
    const hops = r.trace.filter((t) => t.from === 'verify')
    assert.equal(hops.length, 4)
    assert.ok(hops.slice(0, 3).every((h) => !h.exhausted), 'per-branch keying would allow 6 traversals')
    assert.equal(r.counters['verify.round-trips'], sp.binding.caps['verify.round-trips'])
    assert.ok(hops[3].exhausted)
    assert.equal(hops[3].resolvedOutcome, 'undecidable')
    assert.equal(hops[3].to, 'escalate')
  })
}

function driveGatePlanShared(sp, sequence) {
  // sequence entries: 'gate_plan' (a gate_plan:fail traversal) or 'verify' (a
  // verify:design-contradiction traversal) — one shared cap key across two steps.
  let i = 0
  const overrides = {
    gate_plan: () => {
      if (i >= sequence.length) return null
      if (sequence[i] === 'gate_plan') { i += 1; return 'fail' }
      return 'pass' // walk on toward verify, where the next sequence entry is consumed
    },
    verify: () => {
      if (i >= sequence.length) return null
      if (sequence[i] === 'verify') { i += 1; return 'design-contradiction' }
      return 'pass'
    },
    architect: () => (i < sequence.length ? 'converged' : null),
    dispatch: 'assigned',
    red: 'red-confirmed',
    green: 'done',
  }
  return simulate(sp, { start: sequence[0] === 'verify' ? 'verify' : 'gate_plan', outcomes: mainLine(overrides), maxSteps: 800 })
}

for (const fourth of ['gate_plan', 'verify']) {
  await test(`R15b: 2×gate_plan:fail + 1×verify:design-contradiction exhausts gate_plan.retry — the 4th (via ${fourth}) → escalate`, () => {
    const sp = spec()
    const r = driveGatePlanShared(sp, ['gate_plan', 'gate_plan', 'verify', fourth])
    const hops = r.trace.filter((t) => t.capKey === 'gate_plan.retry')
    assert.equal(hops.length, 4, `expected 4 bounded traversals, got ${JSON.stringify(r.trace)}`)
    assert.ok(hops.slice(0, 3).every((h) => !h.exhausted), 'the budget is shared ACROSS the two steps')
    assert.ok(hops[3].exhausted)
    assert.equal(hops[3].resolvedOutcome, 'cap-exhausted')
    assert.equal(hops[3].to, 'escalate')
  })
}

await test('R15c: counter keys are cap keys — no "step:outcome" string ever appears as a counter key', () => {
  const sp = spec()
  const declared = new Set(Object.keys(sp.binding.caps))
  const runs = [
    driveVerify(sp, ['test-issue', 'impl-issue']),
    driveGateFails(sp, 'gate_plan', 2),
    driveHandoff(sp, (v) => (v <= 2 ? 'review-findings' : null)),
    driveArchitectLoop(sp, 2),
  ]
  for (const r of runs) {
    for (const k of Object.keys(r.counters)) {
      assert.ok(!k.includes(':'), `counter key "${k}" is keyed by the lookup input, not the cap key`)
      assert.ok(declared.has(k), `counter key "${k}" is not one of the binding's declared caps`)
    }
  }
})

// ---- R16: counter isolation per simulate() run ----------------------------------

await test('R16/D22: counters are created fresh per simulate() call — two runs do not accumulate', () => {
  const sp = spec()
  const a = driveVerify(sp, ['test-issue'])
  const b = driveVerify(sp, ['test-issue'])
  assert.equal(a.counters['verify.round-trips'], 1)
  assert.equal(b.counters['verify.round-trips'], 1, 'a leaked budget would reroute a coverage-matrix edge to exhaustion')
  const c = driveVerify(sp, ['test-issue', 'test-issue', 'test-issue', 'test-issue'])
  assert.ok(c.trace.filter((t) => t.from === 'verify').pop().exhausted)
  const d = driveVerify(sp, ['test-issue'])
  assert.ok(!d.trace[0].exhausted)
})

// ---- direct-call cases on routing.mjs (U-3 reuse discharge) ---------------------

await test('U-3 direct call: RESERVED is exactly {end, escalate, close}', () => {
  assert.deepEqual([...RT.RESERVED].sort(), ['close', 'end', 'escalate'])
})

await test('U-3 direct call: edges(spec) returns one row per declared next key, each with step/outcome/target/reserved', () => {
  const rows = RT.edges(spec())
  assert.equal(rows.length, 44)
  for (const r of rows) {
    assert.equal(typeof r.step, 'string')
    assert.equal(typeof r.outcome, 'string')
    assert.equal(typeof r.target, 'string')
    assert.equal(r.reserved, RT.RESERVED.has(r.target))
  }
})

await test('U-3 direct call: resolve() throws on an undeclared outcome', () => {
  assert.throws(() => RT.resolve(spec(), 'red', 'no-such-outcome'))
  assert.deepEqual(RT.resolve(spec(), 'red', 'red-confirmed'), { target: 'green', reserved: false })
})

await test('U-3 direct call: resolve() throws on an undeclared STEP, naming it', () => {
  // The step arm and the outcome arm are separate guards: a resolve() that returned
  // undefined for an unknown step would make every simulator hop silently vacuous.
  assert.throws(() => RT.resolve(spec(), 'no-such-step', 'pass'), /no-such-step/)
  assert.throws(() => RT.resolve(spec(), '', 'pass'))
})

await test('U-3 direct call: reachable() and backEdges() operate on the spec model alone', () => {
  const sp = spec()
  const from = RT.reachable(sp, 'deliver')
  assert.ok(from.has('integrate') && from.has('handoff'))
  for (const r of RT.RESERVED) assert.ok(!from.has(r), 'sentinels are excluded from the forward closure')
  const be = RT.backEdges(sp)
  assert.ok(be.has('handoff:review-findings'), 'handoff:review-findings closes the main line')
})

// ---- R12: AC2.0 coverage-set equality (must run after every routing case) -------

await test('R12/AC2.0: the traversed (step, outcome) set EQUALS the set derived from spec/steps/*.yaml', () => {
  const derived = RT.edges(spec()).map((e) => `${e.step}:${e.outcome}`).sort()
  assert.equal(derived.length, 44, 'target derived at run time, never hard-coded')
  const traversed = [...TRAVERSED].sort()
  assert.deepEqual(traversed, derived)
})

// ================================================================================
// REPLAY — AC3
// ================================================================================

const DIGEST = 'docs/cycle-digest.jsonl'
const digestText = () => readRepo(DIGEST)
const parsed = () => REPLAY.parseDigest(digestText())
const round1 = (x) => Math.round(x * 10) / 10

// Deep-equal identity of a finding set uses the design's own sort key
// (severity, code, where) — the free-text `message` is deliberately not part of
// the comparison, while `findings.length` closes the "a new finding lands in
// neither assertion" hole D18 rejects.
const idOf = (f) => ({ severity: f.severity, code: f.code, where: f.where })
const sortIds = (fs) => fs.map(idOf).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)))

await test('AC3.1: the loader reads exactly 13 records and every record is replayed (count in = count out)', () => {
  const { records, findings } = parsed()
  assert.equal(digestText().trim().split('\n').length, 13, 'a truncation of the corpus must be loud')
  assert.equal(records.length, 13)
  assert.deepEqual(findings, [], 'the checked-in corpus parses cleanly')
  const replayed = REPLAY.replay(spec(), records)
  assert.ok(Array.isArray(replayed))
  const seen = new Set(replayed.filter((f) => f.where && String(f.where).startsWith('#')).map((f) => f.where))
  for (const w of seen) assert.ok(records.some((r) => r.issue === w), `finding names an unknown record ${w}`)
})

await test('AC3.7: every recorded gate avg is reproduced by the O-3 calculator at 1 dp (0 per-record findings)', () => {
  const { records } = parsed()
  let compared = 0
  for (const rec of records) {
    for (const [name, g] of Object.entries(rec.gates)) {
      if (!g.items) continue
      const v = GATE.computeVerdict(g.items)
      assert.equal(round1(v.avg), round1(g.avg), `${rec.issue}/${name}`)
      compared++
    }
  }
  assert.equal(compared, 64)
  const f = REPLAY.replay(spec(), records)
  assert.deepEqual(codes(f, 'avg-mismatch'), [], 'the 1-dp rule absorbs the 8 float-equality divergences')
})

await test('AC3.7b/D21: the recorded below7 set is reproduced order-insensitively over all 64 gate objects', () => {
  const { records } = parsed()
  let compared = 0
  for (const rec of records) {
    for (const [name, g] of Object.entries(rec.gates)) {
      if (!g.items) continue
      assert.deepEqual(GATE.computeVerdict(g.items).below7.slice().sort(), g.below7.slice().sort(), `${rec.issue}/${name}`)
      compared++
    }
  }
  assert.equal(compared, 64)
  assert.deepEqual(codes(REPLAY.replay(spec(), records), 'below7-mismatch'), [])
})

await test('AC3.7/D4: the recorded pass is replayed against the HOOK formula — 0 findings today (coincidence, not equivalence)', () => {
  const { records } = parsed()
  for (const rec of records) {
    for (const [name, g] of Object.entries(rec.gates)) {
      if (!g.items) continue
      assert.equal(GATE.computeVerdict(g.items).pass, g.pass, `${rec.issue}/${name}`)
    }
  }
  assert.deepEqual(codes(REPLAY.replay(spec(), records), 'pass-mismatch'), [])
})

await test('AC3.8: #35\'s {"verdict":"skipped (feat issue)"} gate replays as not-applicable — no finding, no throw', () => {
  const { records } = parsed()
  const rec = records.find((r) => r.issue === '#35')
  assert.deepEqual(rec.gates.gate_hypothesis_cause, { verdict: 'skipped (feat issue)' })
  const f = REPLAY.replay(spec(), [rec])
  assert.deepEqual(f.filter((x) => String(x.where).includes('gate_hypothesis_cause')), [])
})

await test('AC3.8: the emitter\'s {"verdict":"not-evaluated"} variant also replays as not-applicable', () => {
  const { records } = parsed()
  const rec = JSON.parse(JSON.stringify(records.find((r) => r.issue === '#1')))
  rec.gates.audit = { verdict: 'not-evaluated' }
  const f = REPLAY.replay(spec(), [rec])
  assert.deepEqual(f.filter((x) => String(x.where).includes('audit')), [])
})

await test('AC3.3: #25 architect.rounds 67 vs cap 6 is reported as an exact cap-exceeded tuple', () => {
  const f = REPLAY.replay(spec(), parsed().records)
  const hit = f.find((x) => x.code === 'cap-exceeded' && x.where === '#25')
  assert.ok(hit, `no cap-exceeded finding for #25 in ${JSON.stringify(f)}`)
  assert.equal(hit.metric, 'architect.rounds')
  assert.equal(hit.actual, 67)
  assert.equal(hit.expected, 6)
  assert.equal(hit.severity, 'error')
  assert.equal(hit.provenance, 'derived-by-grep', 'U-4: the field is a text-occurrence count over ledger prose')
  assert.equal(hit.escalate, false, 'DCR-7: the escalate:false observation is folded in as a field')
})

await test('AC3.4: #13 architect.rounds 10 vs cap 6 is reported as an exact cap-exceeded tuple', () => {
  const f = REPLAY.replay(spec(), parsed().records)
  const hit = f.find((x) => x.code === 'cap-exceeded' && x.where === '#13')
  assert.ok(hit)
  assert.equal(hit.metric, 'architect.rounds')
  assert.equal(hit.actual, 10)
  assert.equal(hit.expected, 6)
  assert.equal(hit.escalate, false)
})

await test('AC3.5: #30 regressions.review_autofix_cycles 9 vs cap 7 is reported as an exact cap-exceeded tuple', () => {
  const f = REPLAY.replay(spec(), parsed().records)
  const hit = f.find((x) => x.code === 'cap-exceeded' && x.where === '#30')
  assert.ok(hit)
  assert.equal(hit.metric, 'regressions.review_autofix_cycles')
  assert.equal(hit.actual, 9)
  assert.equal(hit.expected, 7)
  assert.equal(hit.provenance, 'derived-by-grep')
})

await test('AC3.6/D18: the COMPLETE finding set is exactly the 4 expected rows (single sorted deep-equal)', () => {
  const f = REPLAY.replay(spec(), parsed().records)
  assert.equal(f.length, 4, `expected exactly 4 findings, got ${JSON.stringify(f)}`)
  assert.deepEqual(sortIds(f), sortIds([
    { severity: 'error', code: 'cap-exceeded', where: '#25' },
    { severity: 'error', code: 'cap-exceeded', where: '#13' },
    { severity: 'error', code: 'cap-exceeded', where: '#30' },
    { severity: 'warn', code: 'avg-rounding-policy-divergence', where: 'corpus' },
  ]))
})

await test('AC3.6/DCR-2: the avg-rounding-policy-divergence warn is emitted exactly once, corpus-wide', () => {
  const f = REPLAY.replay(spec(), parsed().records)
  const warns = codes(f, 'avg-rounding-policy-divergence')
  assert.equal(warns.length, 1, 'per-record reporting of a known policy difference would bury the three real targets')
  assert.equal(warns[0].severity, 'warn')
  assert.equal(warns[0].where, 'corpus')
})

await test('AC3.2: the replay module exports no write API and references no fs write call', () => {
  const src = readRepo('engine/replay.mjs')
  for (const forbidden of ['writeFileSync', 'appendFileSync', 'writeFile(', 'createWriteStream', 'rmSync', 'renameSync']) {
    assert.ok(!src.includes(forbidden), `replay.mjs references ${forbidden} — report-only must be a property of the module`)
  }
  for (const name of Object.keys(REPLAY)) {
    assert.ok(!/^(write|save|fix|apply|reconcile|update)/i.test(name), `replay exports a mutation-shaped API: ${name}`)
  }
})

await test('AC3/DCR-4: the four constant regressions.* counters are never read by the replay', () => {
  const { records } = parsed()
  const mutated = JSON.parse(JSON.stringify(records))
  for (const r of mutated) Object.assign(r.regressions, { gate_plan: 99, verify: 99, audit: 99, gate_quality: 99 })
  assert.deepEqual(sortIds(REPLAY.replay(spec(), mutated)), sortIds(REPLAY.replay(spec(), records)),
    'the constants are hard-coded 0 in the emitter — replaying them would manufacture 13 false confirmations')
})

await test('AC3/D16: a malformed JSONL line yields a digest-unparseable finding carrying its 1-based line number', () => {
  const lines = digestText().trim().split('\n')
  lines.splice(6, 0, '{"issue":"#99", TRUNCATED')
  const { findings } = REPLAY.parseDigest(`${lines.join('\n')}\n`)
  const hit = findings.find((f) => f.code === 'digest-unparseable')
  assert.ok(hit, `expected a digest-unparseable finding, got ${JSON.stringify(findings)}`)
  const carries = hit.line === 7 || /(^|\D)7(\D|$)/.test(String(hit.where)) || /(^|\D)7(\D|$)/.test(String(hit.message))
  assert.ok(carries, `the finding must carry the 1-based line number 7: ${JSON.stringify(hit)}`)
})

await test('AC3/D16: parsing continues past a malformed line — the other 13 records still replay', () => {
  const lines = digestText().trim().split('\n')
  lines.splice(6, 0, '{"issue":"#99", TRUNCATED')
  const { records } = REPLAY.parseDigest(`${lines.join('\n')}\n`)
  assert.equal(records.length, 13, 'a throw would suppress the other records and invert "report, never reconcile"')
  assert.equal(REPLAY.replay(spec(), records).length, 4)
})

// ---- AC3.2 mismatch families, driven synthetically ------------------------------
//
// AC3.2's contract is "every mismatch reported as a finding, never silently
// reconciled". The checked-in 13-record corpus produces NONE of the three mismatch
// codes — AC3.7 / AC3.7b / AC3.7-D4 above assert their absence — so on the real
// corpus alone the three emitters are unobservable and the contract is discharged
// only structurally (no write API). These cases supply the positive direction with
// records built to the emitter's own pass-shape `{pass, avg, items, below7}`
// (scripts/handoff/emit-cycle-digest.sh:157-160), asserting the exact tuple the way
// AC3.3-AC3.5 do for cap-exceeded.
const synthRecord = (issue, gates) => ({
  issue,
  terminal_cycle: 1,
  date: '2026-01-01',
  mode: 'new-issue',
  gates,
  regressions: { gate_plan: 0, verify: 0, audit: 0, gate_quality: 0, review_autofix_cycles: 0 },
  architect: { rounds: 0, escalate: false },
})
// Every synthetic avg below is already at 1 dp, so the corpus-wide DCR-2 warn does
// not fire and the expected finding set of each case is exactly the mismatch(es).
const only = (rec) => REPLAY.replay(spec(), [rec])

await test('AC3.2 avg-mismatch: a recorded avg that does not reproduce at 1 dp is reported as an exact tuple', () => {
  const items = { feasibility: 8, dependencies: 8, scope: 8 }
  const rec = synthRecord('#901', { gate_plan: { pass: true, avg: 9.9, items, below7: [] } })
  const f = only(rec)
  assert.equal(f.length, 1, `expected exactly the avg-mismatch, got ${JSON.stringify(f)}`)
  assert.equal(f[0].code, 'avg-mismatch')
  assert.equal(f[0].severity, 'error')
  assert.equal(f[0].where, '#901')
  assert.equal(f[0].metric, 'gates.gate_plan.avg')
  assert.equal(f[0].actual, 9.9, 'the finding must carry the RECORDED value')
  assert.equal(round1(f[0].expected), round1(GATE.computeVerdict(items).avg), 'and the calculator value it failed to reproduce')
})

await test('AC3.2/DCR-2: a sub-1-dp avg difference is absorbed — the policy warn, never an avg-mismatch', () => {
  // The corpus shape: emit-cycle-digest.sh:158 writes the unrounded add/length.
  const rec = synthRecord('#902', {
    gate_hypothesis_cause: { pass: true, avg: 9.333333333333334, items: { a: 9, b: 10, c: 9 }, below7: [] },
  })
  const f = only(rec)
  assert.deepEqual(codes(f, 'avg-mismatch'), [], 'the 1-dp rule is what keeps the known policy difference out of the mismatch class')
  assert.deepEqual(sortIds(f), sortIds([{ severity: 'warn', code: 'avg-rounding-policy-divergence', where: 'corpus' }]))
})

await test('AC3.2 below7-mismatch: a recorded below7 set that does not reproduce is reported as an exact tuple', () => {
  const items = { feasibility: 6, dependencies: 5, scope: 9 }
  const v = GATE.computeVerdict(items)
  const rec = synthRecord('#903', { gate_plan: { pass: false, avg: v.avg, items, below7: ['feasibility'] } })
  const f = only(rec)
  assert.equal(f.length, 1, `expected exactly the below7-mismatch, got ${JSON.stringify(f)}`)
  assert.equal(f[0].code, 'below7-mismatch')
  assert.equal(f[0].severity, 'error')
  assert.equal(f[0].where, '#903')
  assert.equal(f[0].metric, 'gates.gate_plan.below7')
  assert.deepEqual(f[0].actual.slice().sort(), ['feasibility'])
  assert.deepEqual(f[0].expected.slice().sort(), ['dependencies', 'feasibility'], 'a dropped below-7 item is a real set difference')
})

await test('AC3.2/D21: a below7 recorded in the emitter\'s to_entries order is NOT a mismatch (order-insensitive)', () => {
  const items = { feasibility: 6, dependencies: 5, scope: 9 }
  const v = GATE.computeVerdict(items)
  assert.deepEqual(v.below7, ['dependencies', 'feasibility'], 'the calculator returns it sorted (§1.5)')
  const rec = synthRecord('#904', { gate_plan: { pass: false, avg: v.avg, items, below7: ['feasibility', 'dependencies'] } })
  assert.deepEqual(only(rec), [], 'raw-array comparison would turn insertion order into a spurious finding')
})

await test('AC3.2/DCR-3 pass-mismatch: the avg floor discriminates the hook oracle from the emitter formula', () => {
  // items all ≥ 7 → the emitter's `below7|length == 0` says pass; the hook's avg
  // floor (7.0 < 7.5) says fail. The corpus cannot produce this record; without it
  // "0 pass divergences today" is asserted against an emitter-equivalent oracle.
  const items = { feasibility: 7, dependencies: 7, scope: 7 }
  const v = GATE.computeVerdict(items)
  assert.equal(v.pass, false)
  assert.equal(v.below7.length, 0, 'the emitter formula would record pass:true here')
  const rec = synthRecord('#905', { gate_plan: { pass: true, avg: v.avg, items, below7: [] } })
  const f = only(rec)
  assert.equal(f.length, 1, `expected exactly the pass-mismatch, got ${JSON.stringify(f)}`)
  assert.equal(f[0].code, 'pass-mismatch')
  assert.equal(f[0].severity, 'error')
  assert.equal(f[0].where, '#905')
  assert.equal(f[0].metric, 'gates.gate_plan.pass')
  assert.equal(f[0].actual, true)
  assert.equal(f[0].expected, false)
})

await test('AC3.2/DCR-3 pass-mismatch: the security-block arm of the oracle also reaches the pass comparison', () => {
  const items = { command_injection: 9, fixture_data: 9, security: 3 }
  const v = GATE.computeVerdict(items)
  assert.equal(v.pass, false)
  assert.equal(v.security, 3, 'the security ≤ 3 rule takes precedence over the item and avg rules')
  // below7/avg are recorded faithfully here, so the pass field is the only divergence.
  const rec = synthRecord('#906', { audit: { pass: true, avg: v.avg, items, below7: v.below7 } })
  const f = only(rec)
  assert.equal(f.length, 1, `expected exactly the pass-mismatch, got ${JSON.stringify(f)}`)
  assert.equal(f[0].code, 'pass-mismatch')
  assert.equal(f[0].metric, 'gates.audit.pass')
  assert.equal(f[0].expected, false)
})

await test('AC3.2: a record diverging on all three fields yields all three findings — none masks another', () => {
  const items = { feasibility: 6, dependencies: 5, scope: 9 }
  const rec = synthRecord('#907', { gate_plan: { pass: true, avg: 9.9, items, below7: [] } })
  const f = only(rec)
  assert.deepEqual(
    f.map((x) => x.code).sort(),
    ['avg-mismatch', 'below7-mismatch', 'pass-mismatch'],
    'the three checks are independent; an early return would silently reconcile the rest',
  )
  for (const x of f) assert.equal(x.where, '#907')
})

await test('AC3.2 behavioral: replay() reconciles nothing — the input records are byte-identical afterwards', () => {
  const rec = synthRecord('#908', {
    gate_plan: { pass: true, avg: 9.9, items: { feasibility: 6, dependencies: 5, scope: 9 }, below7: [] },
  })
  const records = [rec, ...parsed().records]
  const before = JSON.stringify(records)
  const f = REPLAY.replay(spec(), records)
  assert.ok(f.length > 0)
  assert.equal(JSON.stringify(records), before, 'report-only must hold at runtime, not only as an absent write API')
})

// ================================================================================
// CI WIRING — AC4
// ================================================================================

const WF = '.github/workflows/spec-simulator.yml'
const wfText = () => readRepo(WF)
// The GitHub workflow schema is outside the strict YAML subset (quoted scalars,
// sequences of maps), so AC4.3's assertions are made against the file text —
// the parser is the contract's oracle, not GitHub's.
function wfSection(text, key) {
  const lines = text.split('\n')
  const start = lines.findIndex((l) => new RegExp(`^\\s{2,4}${key}:`).test(l))
  if (start < 0) return ''
  const indent = lines[start].match(/^\s*/)[0].length
  const out = []
  for (let i = start + 1; i < lines.length; i++) {
    if (lines[i].trim() && lines[i].match(/^\s*/)[0].length <= indent) break
    out.push(lines[i])
  }
  return out.join('\n')
}

await test('AC4.1/AC4.2 proxy: the spec-simulator workflow exists, carries the SPDX header and a name', () => {
  assert.ok(existsSync(join(root, WF)), `${WF} does not exist`)
  const t = wfText()
  assert.match(t, /SPDX-FileCopyrightText: 2026 Munsik-Park/)
  // Composed (not a contiguous literal) so REUSE's SPDX-tag scanner does not
  // parse this regex source as an SPDX License Expression itself.
  assert.match(t, new RegExp('SPDX-License-' + 'Identifier: Elastic-2\\.0'))
  assert.match(t, /^name: .+$/m)
  assert.match(t, /runs-on: ubuntu-latest/)
})

await test('AC4.3: on.pull_request.paths covers spec/**, the engine, the harness, the digest and the gate hook', () => {
  const t = wfText()
  const pr = t.slice(t.indexOf('pull_request:'), t.indexOf('push:') > 0 ? t.indexOf('push:') : undefined)
  for (const p of ['spec/**', 'engine/**', 'test/spec/**', 'docs/cycle-digest.jsonl', WF, HOOK]) {
    assert.ok(pr.includes(p), `pull_request path filter is missing ${p} — the lint would be dead on the exact changes it exists to catch`)
  }
})

await test('AC4.3: on.push (branches: [main]) applies the same path filter symmetrically', () => {
  const t = wfText()
  const push = t.slice(t.indexOf('push:'), t.indexOf('permissions:') > 0 ? t.indexOf('permissions:') : undefined)
  assert.match(push, /branches:\s*\[\s*main\s*\]/)
  for (const p of ['spec/**', 'engine/**', 'test/spec/**', 'docs/cycle-digest.jsonl', WF, HOOK]) {
    assert.ok(push.includes(p), `push path filter is missing ${p}`)
  }
})

await test('AC4.1: a run: step invokes the simulator entry with bare node and no npm install', () => {
  const t = wfText()
  assert.match(t, /run:\s*node test\/spec\/run\.mjs/)
  assert.ok(!/npm (ci|install)/.test(t), 'the repo is stdlib-only — no install step')
  assert.match(t, /uses: actions\/checkout@[0-9a-f]{40}/, 'actions must be pinned to a commit SHA')
  assert.match(t, /uses: actions\/setup-node@[0-9a-f]{40}/)
})

await test('L14a: the new workflow is registered in docs/maintained-docs.md', () => {
  assert.ok(readRepo('docs/maintained-docs.md').includes(WF),
    'every existing workflow carries a registry row; a new one must too')
})

await test('L14c: the new workflow passes the host-purity token denylist (.github/workflows/** is in scan scope)', () => {
  const tokens = readRepo('tests/fixtures/host-purity-tokens.txt')
    .split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('#'))
  const t = wfText()
  for (const tok of tokens) {
    assert.ok(!new RegExp(`(^|[^A-Za-z0-9_])(${tok})([^A-Za-z0-9_]|$)`, 'i').test(t), `service token "${tok}" appears in ${WF}`)
  }
})

// ================================================================================
// STRUCTURAL / NON-GOALS + HARNESS SELF-TEST
// ================================================================================

const engineSources = () =>
  readdirSync(join(root, 'engine')).filter((f) => f.endsWith('.mjs')).map((f) => [f, readRepo(join('engine', f))])

await test('AC2.7: no network / child_process module is imported anywhere in engine/**', () => {
  const files = engineSources()
  assert.ok(files.length >= 5, 'expected the five engine modules')
  for (const [name, src] of files) {
    for (const m of ['node:http', 'node:https', 'node:net', 'node:child_process', 'node:dgram', 'node:tls']) {
      assert.ok(!src.includes(m), `engine/${name} imports ${m}`)
    }
    assert.ok(!/\bfetch\s*\(/.test(src), `engine/${name} references fetch()`)
  }
})

await test('AC2.7/AC4.4 (mechanizable half): engine/** imports only node: builtins — no bare specifier', () => {
  for (const [name, src] of engineSources()) {
    for (const m of src.matchAll(/^\s*(?:import|export)[^'"]*from\s*['"]([^'"]+)['"]/gm)) {
      const spec_ = m[1]
      assert.ok(spec_.startsWith('node:') || spec_.startsWith('.') || spec_.startsWith('/'),
        `engine/${name} imports the bare specifier "${spec_}" — the repo has no package.json`)
    }
    assert.ok(!existsSync(join(root, 'package.json')), 'a package.json must not be introduced')
  }
})

await test('AC3.2 structural: replay.mjs is import-clean of any disk-writing helper', () => {
  const src = readRepo('engine/replay.mjs')
  const imports = [...src.matchAll(/^\s*import\s+([^;]+?)\s+from\s*['"]([^'"]+)['"]/gm)]
  for (const [, what, from] of imports) {
    if (from === 'node:fs' || from === 'node:fs/promises') {
      assert.ok(!/write|append|rm|unlink|rename/i.test(what), `replay.mjs imports a write helper: ${what}`)
    }
  }
})

await test('AC4.1 self-test: an injected failing case yields exit 1 and a FAIL line', () => {
  let status = 0
  let out = ''
  try {
    out = execFileSync(process.execPath, [join(here, 'fixtures', 'self-test-fail.mjs')], { encoding: 'utf8' })
  } catch (e) {
    status = e.status
    out = String(e.stdout || '')
  }
  assert.equal(status, 1, 'a harness that swallows a throw into a counter must still exit non-zero')
  assert.match(out, /FAIL/)
})

await test('AC4.1 self-test: an all-pass fixture yields exit 0 and no FAIL line', () => {
  const out = execFileSync(process.execPath, [join(here, 'fixtures', 'self-test-pass.mjs')], { encoding: 'utf8' })
  assert.ok(!out.includes('FAIL'))
  assert.match(out, /\bok\b/)
})

await test('U-5/AC2.7: the whole suite runs offline in under 5 s (loose smoke bound)', () => {
  const elapsed = Date.now() - started
  assert.ok(elapsed < 5000, `suite took ${elapsed} ms`)
})

const elapsedMs = Date.now() - started
console.log(
  failures
    ? `\n${failures} of ${cases} spec-simulator test(s) FAILED  (${elapsedMs} ms)`
    : `\nall ${cases} spec-simulator tests passed  (${elapsedMs} ms)`,
)
process.exit(failures ? 1 : 0)
