# Manual verification scenarios — issue #2 (spec simulator)

The automated suite is `node test/spec/run.mjs`. The items below are the
verification design's untestable items (U-1 … U-5): each states why it is not a
machine check and what is done instead. They are itemized here so VALIDATE can
tick them; a delegated item does not block.

## U-1 — AC4.4 "follows the `test/workflows/run.mjs` mock-runtime idiom"

"Idiom" is a style judgment: no property distinguishes a conforming hand-rolled
runner from a non-conforming one. The mechanizable half is already automated
(stdlib-only imports → AC2.7 structural cases; the exit-code contract → AC4.1
self-test), so only the stylistic residue is manual.

Reviewer checklist against `test/spec/run.mjs`:

- [ ] `node:` builtin imports only — no bare specifier, no framework
- [ ] hand-rolled `test(name, fn)` that counts failures rather than throwing
- [ ] output lines are `  ok    <name>` / `  FAIL  <name>` + message
- [ ] a `failures` counter and a final summary line
- [ ] `process.exit(failures ? 1 : 0)`
- [ ] no `package.json` is added anywhere in the repo
- [ ] the engine modules are imported directly (no `AsyncFunction` wrap — that
      exists in `test/workflows/run.mjs` only for Workflow scripts with injected
      globals)

## U-2 — AC4.2 "runs in GitHub Actions"

Environment-dependent: it cannot be proven from inside a node process. The
in-repo proxy (AC4.3) asserts the workflow's trigger paths and its `run:` step.

- [ ] the `spec-simulator` check appears on this issue's own PR and is green
- [ ] enforcement level is ADVISORY (this repo's plan has no branch protection),
      so the green check is evidence for the reviewer, not a merge gate

## U-3 — non-goal "reusable by the M1 engine"

M1 does not exist, so reusability by an unwritten consumer is unfalsifiable. It
is discharged structurally instead: `engine/routing.mjs` and `engine/gate.mjs`
do no I/O, import no simulator code, and are exercised by direct-call cases with
plain data (the `U-3 direct call:` cases) *and* by the simulator driver — two
independent consumers today.

- [ ] review confirms neither module imports `test/**` or reads a file

## U-4 — "explain" the three known digest mismatches

The replay detects divergence; it cannot determine why a recorded number
diverges. Evidence supplied rather than a verdict: `architect.rounds` is
`grep -oiE 'rounds:?[0-9]+' … | tail -1` over ledger prose and
`review_autofix_cycles` is `grep -c 'review-autofix'`
(`scripts/handoff/emit-cycle-digest.sh:53,62`) — both are text-occurrence counts
over prose, not counters of the capped quantity, and `handoff.review-response`'s
cap is on *consecutive* attempts while the grep is a total. `#13` carries
`terminal_cycle: 1` with `rounds: 10`, so multi-cycle accumulation does not
explain it.

- [ ] every `cap-exceeded` finding carries `provenance: derived-by-grep`, so a
      reader does not conclude a cap was breached in execution
- [ ] the measurement-artifact hypothesis stays a reported hypothesis; nothing
      in this cycle rewrites `docs/cycle-digest.jsonl`

## U-5 — AC2 "runs in seconds"

Wall-clock on shared CI runners is not a stable assertion. The suite asserts a
loose local smoke bound (< 5 s) and CI is **not** gated on a tighter number.

- [ ] `time node test/spec/run.mjs` completes well inside the bound locally

## O-5 / O-6 — reported, not fixed (equivalence-only principle)

Locked by tests as *current behavior*, and recorded here so the reader does not
mistake the lock for an endorsement:

- **O-5** — the gate calculator detects the security item by the literal key
  `security` / `보안`. The `audit` gate records items named `authn_authz`,
  `input_validation`, … and never `security`, so "security ≤ 3 → immediate
  block" today applies to `gate_plan` and `gate_quality`, not to the security
  gate. Changing it is a separate issue.
- **O-6** — `CLAUDE.md` > Flow Control gives HANDOFF review-triage a case
  (`label present ∧ max_severity < Medium`) that `spec/steps/handoff.yaml`
  declares no outcome for. It is modelled as no transition with no counter
  increment and surfaced through `PROSE_SOURCED`; amending `spec/` is outside
  this issue's scope.
