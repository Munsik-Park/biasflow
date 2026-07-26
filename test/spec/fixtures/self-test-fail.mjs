// SPDX-FileCopyrightText: 2026 Munsik-Park
// SPDX-License-Identifier: Elastic-2.0
// Harness self-test fixture (verification design §3 "Self-test of the harness").
//
// A suite whose assertions never run still prints `ok`, so "all tests passed" is
// not evidence unless the runner is shown to fail loudly. This fixture uses the
// SAME hand-rolled test()/failures/exit contract as test/spec/run.mjs and injects
// one deliberately false assertion; the parent case spawns it (D9 permits
// node:child_process under test/spec/**) and asserts exit 1 + a `FAIL` line.
// It is a separate entry file so the real suite is never re-entered recursively.
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

await test('fixture: an assertion that must fail', () => {
  assert.equal(1, 2, 'deliberate failure')
})

console.log(failures ? `\n${failures} test(s) FAILED` : '\nall fixture tests passed')
process.exit(failures ? 1 : 0)
