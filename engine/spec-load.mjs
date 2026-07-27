// SPDX-FileCopyrightText: 2026 Munsik-Park
// SPDX-License-Identifier: Elastic-2.0
// engine/spec-load.mjs — YAML-subset parser + spec model loader (issue #2, §1.2/§1.3).
//
// The repo is stdlib-only (no package.json, no YAML parser anywhere), so the
// declaration layer is parsed by a strict subset parser that supports exactly the
// constructs spec/**/*.yaml uses and THROWS on anything else: a silent mis-parse of
// the contract would make every downstream check vacuous.
//
// Supported: block maps (nested by indentation), block sequences, flow sequences,
// flow maps, plain scalars folded onto more-indented continuation lines, `#`
// comments (stripped BEFORE folding — DCR-9), dotted keys as literal key strings,
// boolean / integer typing.
// Rejected with the offending line number: anchors/aliases, block scalars, quoted
// keys, multi-document markers, tabs, nested flow collections.
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

export class SpecParseError extends Error {
  constructor(message, sourcePath, line) {
    super(`${sourcePath}:${line}: ${message}`)
    this.name = 'SpecParseError'
    this.sourcePath = sourcePath
    this.line = line
  }
}

const KEY = /^([A-Za-z0-9_.-]+):(?:[ ](.*))?$/
const BLOCK_SCALAR = /^[|>][-+]?$/

// A `#` opens a comment when it starts the line or follows whitespace. Stripping
// happens before continuation folding, so a comment-only line indented under a
// value is dropped rather than folded into it (green.yaml:11, handoff.yaml:11-12).
function stripComment(line) {
  for (let i = 0; i < line.length; i++) {
    if (line[i] === '#' && (i === 0 || line[i - 1] === ' ')) return line.slice(0, i)
  }
  return line
}

function typed(s) {
  if (s === 'true') return true
  if (s === 'false') return false
  if (/^-?\d+$/.test(s)) return Number(s)
  return s
}

export function parseYamlSubset(text, sourcePath = '<inline>') {
  const raw = String(text).split('\n')
  for (let i = 0; i < raw.length; i++) {
    if (raw[i].includes('\t')) throw new SpecParseError('tab indentation is outside the YAML subset', sourcePath, i + 1)
  }

  const items = []
  for (let i = 0; i < raw.length; i++) {
    const stripped = stripComment(raw[i])
    const body = stripped.trim()
    if (!body) continue
    if (body === '---' || body === '...') {
      throw new SpecParseError('multi-document markers are outside the YAML subset', sourcePath, i + 1)
    }
    if (body.startsWith('"') || body.startsWith("'")) {
      throw new SpecParseError('quoted keys are outside the YAML subset', sourcePath, i + 1)
    }
    items.push({ indent: stripped.length - stripped.trimStart().length, text: body, line: i + 1 })
  }
  if (!items.length) return {}

  let p = 0
  const bad = (msg, line) => new SpecParseError(msg, sourcePath, line)

  function flow(rest, line) {
    const open = rest[0]
    const close = open === '[' ? ']' : '}'
    if (!rest.endsWith(close)) throw bad('an unterminated flow collection is outside the YAML subset', line)
    const inner = rest.slice(1, -1)
    if (/[[\]{}]/.test(inner)) throw bad('nested flow collections are outside the YAML subset', line)
    const parts = inner.split(',').map((s) => s.trim()).filter((s) => s !== '')
    if (open === '[') return parts.map(typed)
    const out = {}
    for (const part of parts) {
      const at = part.indexOf(':')
      if (at < 0) throw bad(`"${part}" is not a flow-map entry`, line)
      out[part.slice(0, at).trim()] = typed(part.slice(at + 1).trim())
    }
    return out
  }

  function scalarValue(rest, indent, line) {
    if (BLOCK_SCALAR.test(rest)) throw bad('block scalars are outside the YAML subset', line)
    if (rest.startsWith('&') || rest.startsWith('*')) {
      throw bad('anchors and aliases are outside the YAML subset', line)
    }
    if (rest.startsWith('[') || rest.startsWith('{')) {
      const v = flow(rest, line)
      if (p < items.length && items[p].indent > indent) {
        throw bad('a continuation line after a flow collection is outside the YAML subset', items[p].line)
      }
      return v
    }
    let folded = rest
    while (p < items.length && items[p].indent > indent) {
      folded += ` ${items[p].text}`
      p++
    }
    return typed(folded)
  }

  function block(indent) {
    return items[p].text === '-' || items[p].text.startsWith('- ') ? sequence(indent) : mapping(indent)
  }

  // Shared by mapping()/sequence(): an empty `rest` after the key/dash means the
  // value is a nested block (or absent); otherwise it's a scalar on the same line.
  function valueFor(rest, indent, line) {
    if (rest === '') return p < items.length && items[p].indent > indent ? block(items[p].indent) : null
    return scalarValue(rest, indent, line)
  }

  function mapping(indent) {
    const obj = {}
    while (p < items.length && items[p].indent === indent) {
      const it = items[p]
      if (it.text === '-' || it.text.startsWith('- ')) break
      const m = KEY.exec(it.text)
      if (!m) throw bad(`"${it.text}" is outside the YAML subset`, it.line)
      const rest = (m[2] || '').trim()
      p++
      obj[m[1]] = valueFor(rest, indent, it.line)
    }
    return obj
  }

  function sequence(indent) {
    const arr = []
    while (p < items.length && items[p].indent === indent && (items[p].text === '-' || items[p].text.startsWith('- '))) {
      const it = items[p]
      p++
      const rest = it.text.slice(1).trim()
      arr.push(valueFor(rest, indent, it.line))
    }
    return arr
  }

  const value = block(items[0].indent)
  if (p < items.length) throw bad('unexpected indentation', items[p].line)
  return value
}

// ---- spec model ----------------------------------------------------------------

function toStep(raw, source) {
  const step = { id: raw.step, source }
  if (raw.kind !== undefined) step.kind = raw.kind
  if (raw['applies-to'] !== undefined) step.appliesTo = raw['applies-to']
  step.requires = raw.requires || []
  step.produces = raw.produces || []
  step.agents = raw.agents || []
  if (raw.loop) {
    step.loop = {
      kind: raw.loop.kind,
      participants: raw.loop.participants || [],
      until: raw.loop.until,
      carry: raw.loop.carry,
      isolated: raw.loop.isolated,
    }
  }
  if (raw.verdict !== undefined) step.verdict = raw.verdict
  if (raw.criteria !== undefined) step.criteria = raw.criteria
  if (raw['done-when'] !== undefined) step.doneWhen = raw['done-when']
  step.next = new Map(Object.entries(raw.next || {}))
  return step
}

function toRole(raw, source) {
  const role = { id: raw.role, mission: raw.mission, source }
  if (raw.session !== undefined) role.session = raw.session
  role.input = raw.input || []
  role.output = { format: raw.output ? raw.output.format : undefined, mustContain: (raw.output && raw.output.must_contain) || [] }
  role.context = raw.context || {}
  return role
}

const yamlFiles = (dir) => readdirSync(dir).filter((f) => f.endsWith('.yaml')).sort()

export function loadSpec(rootDir = process.cwd()) {
  const steps = new Map()
  const stepDir = join(rootDir, 'spec', 'steps')
  for (const f of yamlFiles(stepDir)) {
    const rel = `spec/steps/${f}`
    const raw = parseYamlSubset(readFileSync(join(stepDir, f), 'utf8'), rel)
    steps.set(raw.step, toStep(raw, rel))
  }

  const roles = new Map()
  const roleDir = join(rootDir, 'spec', 'roles')
  for (const f of yamlFiles(roleDir)) {
    const rel = `spec/roles/${f}`
    const raw = parseYamlSubset(readFileSync(join(roleDir, f), 'utf8'), rel)
    roles.set(raw.role, toRole(raw, rel))
  }

  const bindingRel = 'spec/bindings/claude.yaml'
  const raw = parseYamlSubset(readFileSync(join(rootDir, bindingRel), 'utf8'), bindingRel)
  const binding = {
    runner: raw.runner,
    roles: raw.roles || {},
    steps: raw.steps || {},
    caps: raw.caps || {},
    mechanisms: raw.mechanisms || {},
  }

  // The criteria layer is deliberately empty (spec/criteria/README.md) — only the
  // names that exist are modelled; nothing in this cycle resolves against them.
  const criteria = new Set(yamlFiles(join(rootDir, 'spec', 'criteria')).map((f) => f.replace(/\.yaml$/, '')))

  return { steps, roles, binding, criteria }
}
