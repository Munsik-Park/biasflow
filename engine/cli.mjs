// SPDX-FileCopyrightText: 2026 Munsik-Park
// SPDX-License-Identifier: Elastic-2.0
// engine/cli.mjs — the only process-terminating entry (issue #4, feature design §3/§9).
//
//   node engine/cli.mjs <statePath>
//
// Loads the run state, drives advance() until the flow stops, then runs the stop
// protocol and maps the terminal to an exit code. The engine core never exits the
// process: it is imported in-process by the test harness, where an exit would kill
// the runner and make the protocol unassertable.
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { advance } from './flow.mjs'
import { escalate } from './escalate.mjs'
import { NO_EFFECTS } from './mechanical.mjs'
import { loadSpec } from './spec-load.mjs'
import { loadState, saveState } from './run-state.mjs'

const statePath = process.argv[2]
if (!statePath) {
  process.stderr.write('usage: node engine/cli.mjs <statePath>\n')
  process.exit(64)
}

const spec = loadSpec(join(dirname(fileURLToPath(import.meta.url)), '..'))
const env = { effects: NO_EFFECTS, artifacts: {}, persist: saveState, statePath }

let state = loadState(statePath)
for (;;) {
  const { state: next, event } = advance(spec, state, env)
  state = next
  if (event.kind !== 'transition') break
}

process.exit(escalate(state, { statePath }).exitCode)
