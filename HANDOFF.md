# Handoff — biasflow: harness-independent runner for the AutoFlow contract

**Read this first.** This repo is where the runner gets built. The session that
wrote this handoff worked in `Munsik-Park/autoflow`; its session memory does
not follow to this directory, so this document is the full context transfer.

## Repo situation

- `Munsik-Park/biasflow` (public) is a **full-history mirror** of
  `Munsik-Park/autoflow`, split on 2026-07-26. Reason: autoflow's `main` is a
  deploy repo (marketplace plugin at `plugin/autoflow` + thin-root layer from
  `setup/manifest.json`) — the runner and `spec/` are not merge candidates
  there, ever.
- Remote layout in the working clone (`~/work/connev-llm/biasflow`):
  `origin` = biasflow; `upstream` = autoflow, **fetch-only** (push URL is
  deliberately disabled). Methodology updates flow in via
  `git fetch upstream && git merge upstream/main`. Nothing flows back.
- `Munsik-Park/autoflow#37` is the same spec branch opened as a **review-only
  draft PR** in the old repo; it is never merged there. Close it once review
  value is exhausted. In biasflow, merging the spec branch into `main` is
  allowed and normal.
- The work branch: `dev/2026-07-26-declarative-spec` (HEAD `e5717b1` at
  handoff time).

## What exists on the branch

| Artifact | What it is |
| --- | --- |
| `spec/README.md` | 3-layer contract (declaration / criteria / binding) + the 10 portable invariants — design-rationale Decisions 1–9 restated as runner-independent obligations |
| `spec/steps/` (16) · `spec/roles/` (6) | hand-written declarations; isolation is expressed as each role's `input` list |
| `spec/criteria/` | deliberately empty — format decided when a second domain exists |
| `spec/bindings/claude.yaml` | the current Claude Code runner written down as an overlay (models, cap values, mechanisms) |
| `spec/validation-issue-35.md` | trace of the #35 canary cycle against the declarations; findings F1–F4 |
| `spec/runner-architecture.md` | the runner design: 6 components, invariant mapping, M0–M3 migration, plus the two decision sections below |

## Settled decisions (do not re-open without a new verified fact)

1. **Target = harness-independent runner** (user decision, 2026-07-26): an
   external program owns routing and the six mechanical steps; LLM calls go
   through bindings (claude API / openai-compatible / claude-code delegation).
   Binding-only swap was rejected as partial.
2. **No teammates** (user decision, 2026-07-26, commit `e5717b1`): Agent Teams
   is not used in the new structure. Its reason to exist — multi-party
   deliberation — is served by isolated deliberation, which the engine drives
   between ephemeral per-role sessions. Roles communicate only through
   persisted artifacts. Teammate-lifecycle rules of the old runner do not
   carry over; the role separation (test designs from acceptance criteria,
   not from the implementation) does.
3. **Verification = behavioral equivalence only** (user decision, 2026-07-26,
   commit `e5717b1`): the methodology and models are already validated by 13
   terminal cycles (`docs/cycle-digest.jsonl`); this work converts the
   execution structure (interactive-in-Claude → external non-interactive).
   Output *quality* is out of scope until a model actually changes (M3).
4. **Criteria are repo/org-scoped, never per-issue**; the criteria layer stays
   outside the declaration (carried over from the previous discussion,
   settled).
5. **Loose conventions over detailed design**: every field invented now
   constrains a future domain that does not exist yet. The previous
   discussion's recorded failure mode: producing detailed schemas when a
   one-line convention was asked for, and overstating findings before the
   data supported them. Mark numbers *measured* or *modeled*; do not build on
   an unmarked number.

## Rejected hypotheses (carried from the previous handoff — need new evidence to re-open)

| Hypothesis | Why it failed |
| --- | --- |
| Cache misses drive cost | amortization measured 17.47 vs break-even 1.11 |
| Parallel sessions degrade cache | parallel workspaces had the highest amortization (49–58) |
| Subagents are only ~8% of usage | delegated tiers total 71.2%; the 8% came from a flawed aggregation |
| The gate hook blocking spawns is a bug | intentional — prevents GATE:PLAN bypass |
| Deliberation rounds accumulate prior context | only accepted content carries (`carry: accepted_only`); r2→r3 grew 2.0k |
| The orchestrator over-investigates | ~20% real investigation on manual review, not 56.7% |
| Reducing phase count would cut cost | cost concentrates in one phase (ARCHITECT deliberation, 52.9% — measured) |

Key measured figures: deliberation tier 52.9% / orchestrator 28.8% of cycle
cost; orchestrator context grows 704–722 tokens/turn independent of issue
difficulty (n=2 — "slope is constant" is a strong hypothesis, not a fact).

## Still deliberately undecided

- Criteria-layer file format and judgment rule (decide at second domain).
- Model-to-model score-scale transfer (decide at M3; a permissive-direction
  error passes bad work undetected — never inherit thresholds blind).
- Provider-adapter interface freeze (not before a second provider exists).
- Prompt bodies, token budgets, parallelism, round-count values (operator).
- Whether `diagnose` splits (validation finding F4 — wait for a cycle that
  exercises its other exits).

## Next work, in order

1. **Simulator** (first issue — draft below, user files it): T1 declaration
   lint + T2 synthetic-input flow simulation (forces every failure path no
   real cycle can) + digest-corpus replay (13 records as the regression
   oracle). No LLM, seconds, CI-runnable; follows the `test/workflows/run.mjs`
   mock-runtime idiom. Note the replay already has known targets: digest
   records show architect rounds 67 (#25) and 10 (#13) against a declared cap
   of 6, and 9 autofix attempts (#30) against a cap of 7 — each must be
   explained (aggregation semantics? pre-cap history?) or flagged, never
   silently normalized.
2. **M1 hybrid**: engine executes the six mechanical steps + routing; LLM
   steps delegated to the existing Claude Code runner as a subprocess.
   Deliberately include a regressing cycle (validation finding F2).
3. **M2 / M3** per `spec/runner-architecture.md`.

Working mode: this repo inherited AutoFlow's `CLAUDE.md` and gate hooks in
full, so a session here operates as an AutoFlow orchestrator — file an issue
and the cycle starts at PREFLIGHT. The clone is clean; nothing blocks the
Git Clean Check.

## First-issue draft (file manually — no auto issue creation)

**Title**: `[feat] spec simulator — declaration lint + synthetic-flow simulation + digest replay`

**Body**:

> **Goal.** Verify the `spec/` contract mechanically, with no LLM: the
> declarations are internally consistent, every routing edge (including all
> failure paths) behaves as declared, and the 13 recorded cycles replay
> correctly against the routing rules.
>
> **AC1 — declaration lint.** Every `next` target resolves to a declared step
> or a reserved word (`end` / `escalate` / `close`); every `agents` entry
> exists in `spec/roles/`; every gate declares `criteria` and an evaluator;
> every bounded edge has a cap value in `spec/bindings/claude.yaml`.
>
> **AC2 — synthetic-flow simulation.** With mock role outputs and synthetic
> score sets, every routing edge of every step is exercised, including:
> gate FAIL → retry, cap exhaustion → escalate, security ≤ 3 immediate block,
> verify deadlock → all four arbitration outcomes, handoff review-severity
> re-entry, autofix-cap pause. Runs in seconds, no network, no LLM.
>
> **AC3 — digest replay.** All 13 records of `docs/cycle-digest.jsonl` replay
> against the routing rules; every mismatch is reported as a finding, not
> silently reconciled. Known targets: architect rounds 67 (#25) / 10 (#13)
> vs cap 6; autofix 9 (#30) vs cap 7.
>
> **AC4 — CI.** Runs as a node test in GitHub Actions on every PR touching
> `spec/**` or the simulator, following the existing
> `test/workflows/run.mjs` mock-runtime idiom.
>
> **Non-goals.** No LLM calls (that is M3's minimal-qualification territory);
> no side-effect layer or sessions (that is M1). Code should be reusable by
> the M1 engine — the simulator's routing table and gate calculator are the
> engine's first two modules.
