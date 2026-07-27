// SPDX-FileCopyrightText: 2026 Munsik-Park
// SPDX-License-Identifier: Elastic-2.0
// Harness self-test fixture — the all-pass half of the exit-code contract
// (AC4.1: the suite's exit code is non-zero iff any case failed). Paired with
// self-test-fail.mjs so both directions of the contract are observed, not just
// the failing one.
import assert from 'node:assert/strict'

let failures = 0
async function test(name, fn) {
  try {
    await fn()
    console.log(`  ok    ${name}`)
  } catch (e) {
    failures++
    console.log(`  FAIL  ${name}\n        ${e.message}`)
  }
}

await test('fixture: an assertion that must pass', () => {
  assert.equal(1, 1)
})

console.log(failures ? `\n${failures} test(s) FAILED` : '\nall fixture tests passed')
process.exit(failures ? 1 : 0)
