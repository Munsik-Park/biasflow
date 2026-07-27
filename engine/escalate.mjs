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

  return { terminal, reason, exitCode: EXIT_CODES[terminal] ?? EXIT_CODES.escalate }
}
