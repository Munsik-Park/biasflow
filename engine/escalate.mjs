// SPDX-FileCopyrightText: 2026 Munsik-Park
// SPDX-License-Identifier: Elastic-2.0
// engine/escalate.mjs — the non-interactive stop protocol (issue #4, feature design §9).
//
// Every terminal and every halt leaves through here, in one audited order:
// persist the run context, then notify. There is no third step inside the engine
// core and no dialog anywhere: `notify` receives a JSON-serializable RECORD, so the
// transport is substitutable, and the process-terminating call lives in cli.mjs.
import { RESERVED } from './routing.mjs'
import { saveState } from './run-state.mjs'

export const STOP_PROTOCOL = ['persist', 'notify']

export const EXIT_CODES = { escalate: 2, end: 0, close: 0 }

const defaultNotify = (record) => process.stderr.write(`${JSON.stringify(record)}\n`)

export function escalate(state, { statePath, persist = saveState, notify = defaultNotify } = {}) {
  // The middle clause is an embedder-API guard, not a path the shipped
  // advance()+cli.mjs loop takes (advance()'s RESERVED branch always sets
  // `terminal` before returning). It protects a direct escalate(state) call
  // on a state loaded from disk where that branch's write was skipped
  // (engine/flow.mjs's `advance()` terminal return; see its adjudication note)
  // — such a document reads `terminal: null` with `step` on a reserved value.
  const terminal = state.terminal || (RESERVED.has(state.step) ? state.step : 'escalate')
  const last = state.history && state.history.length ? state.history[state.history.length - 1] : null
  const reason = state.halt ? state.halt.reason : `the flow reached "${terminal}"`

  persist(statePath, { ...state, status: 'halted', terminal })
  notify({
    issue: state.issue,
    step: state.halt ? state.halt.step : state.step,
    reason,
    capKey: last && last.capKey ? last.capKey : null,
    terminal,
    statePath,
  })

  // The `??` fallback cannot fire under the current declarations — EXIT_CODES'
  // key set equals RESERVED (engine/routing.mjs), and `terminal` above is
  // always one of those keys or the literal 'escalate'. Kept as a guard
  // against the two constants drifting apart across future edits (they are
  // declared in separate modules with no shared source), so a divergence
  // fails safe to the escalate exit code instead of exiting `undefined`.
  return { terminal, reason, exitCode: EXIT_CODES[terminal] ?? EXIT_CODES.escalate }
}
