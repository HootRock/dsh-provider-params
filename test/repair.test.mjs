import test from 'node:test'
import assert from 'node:assert/strict'
import { repairJson } from '../lib/core/repair.js'

test('escape repair turns a raw control character inside a string into an escape', () => {
  const result = repairJson('{"note":"line1\nline2"}')
  assert.equal(result.ok, true)
  assert.deepEqual(result.value, { note: 'line1\nline2' })
  assert.ok(result.strategies.includes('escapeRepair'))
  assert.equal(result.actions[0].op, 'escape')
  assert.equal(result.actions[0].before, '\n')
  assert.equal(result.actions[0].after, '\\n')
  assert.ok(result.repaired.includes('\\n'))
})

test('trailing commas are removed from objects and arrays', () => {
  const result = repairJson('{"a":[1,2,],"b":3,}')
  assert.equal(result.ok, true)
  assert.deepEqual(result.value, { a: [1, 2], b: 3 })
  assert.ok(result.strategies.includes('trailingComma'))
  assert.equal(result.actions.filter((action) => action.op === 'strip').length, 2)
  assert.equal(JSON.parse(result.repaired).a.length, 2)
})

test('truncation closure closes an unterminated string and container', () => {
  const stringCut = repairJson('{"a":1,"b":"unterminated')
  assert.equal(stringCut.ok, true)
  assert.equal(stringCut.truncated, true)
  assert.deepEqual(stringCut.value, { a: 1, b: 'unterminated' })
  assert.ok(stringCut.strategies.includes('truncationClosure'))
  assert.equal(stringCut.actions.at(-1).op, 'close')

  const containerCut = repairJson('{"items":[1,2')
  assert.equal(containerCut.ok, true)
  assert.deepEqual(containerCut.value, { items: [1, 2] })
  assert.equal(containerCut.actions.at(-1).after, ']}')
})

test('required fields are completed with null placeholders, not invented values', () => {
  const result = repairJson('{"a":"x"}', {
    schema: {
      type: 'object',
      required: ['a', 'b'],
      properties: { a: { type: 'string' }, b: { type: 'number' } },
    },
  })
  assert.equal(result.ok, true)
  assert.deepEqual(result.value, { a: 'x', b: null })
  assert.equal(result.validated, true)
  assert.deepEqual(result.placeholders, ['#/b'])
  assert.ok(result.strategies.includes('fieldCompletion'))
  assert.deepEqual(result.actions, [{ op: 'fill', path: '#/b', before: '', after: 'null' }])
})

test('field completion does not create a missing parent object', () => {
  const result = repairJson('{}', {
    schema: {
      type: 'object',
      required: ['outer'],
      properties: {
        outer: {
          type: 'object',
          required: ['inner'],
          properties: { inner: { type: 'string' } },
        },
      },
    },
  })
  assert.equal(result.ok, true)
  assert.deepEqual(result.value, { outer: null })
  assert.deepEqual(result.placeholders, ['#/outer'])
  assert.equal(result.actions.length, 1)
})

test('all four repairs are idempotent', () => {
  const cases = [
    { name: 'trailing comma', text: '{"a":1,}', options: {} },
    { name: 'escape', text: '{"note":"a\nb"}', options: {} },
    { name: 'truncation', text: '{"a":[1,2', options: {} },
    {
      name: 'field completion',
      text: '{"a":"x"}',
      options: {
        schema: {
          type: 'object',
          required: ['a', 'b'],
          properties: { a: { type: 'string' }, b: { type: 'number' } },
        },
      },
    },
  ]
  for (const entry of cases) {
    const first = repairJson(entry.text, entry.options)
    assert.equal(first.ok, true, entry.name)
    assert.ok(first.actions.length > 0, entry.name)
    const second = repairJson(first.repaired, entry.options)
    assert.equal(second.ok, true, entry.name)
    assert.equal(second.repaired, first.repaired, entry.name)
    assert.deepEqual(second.actions, [], entry.name)
    assert.deepEqual(second.strategies, [], entry.name)
  }
})

test('a fenced JSON block is extracted before repair', () => {
  const result = repairJson('Here is the payload:\n```json\n{"a":1,}\n```\nThanks')
  assert.equal(result.ok, true)
  assert.deepEqual(result.value, { a: 1 })
  assert.equal(result.actions[0].op, 'extract')
  assert.ok(result.strategies.includes('extractFence'))
  assert.ok(result.strategies.includes('trailingComma'))
})

test('unrepairable text returns a structured error instead of throwing', () => {
  const result = repairJson('{"a":]')
  assert.equal(result.ok, false)
  assert.equal(result.repaired, null)
  assert.equal(result.error.code, 'E_JSON_UNREPAIRABLE')
  assert.deepEqual(result.actions, [])
})

test('a value that still violates the schema is rejected', () => {
  const result = repairJson('{"a":"x","extra":1}', {
    schema: {
      type: 'object',
      additionalProperties: false,
      properties: { a: { type: 'string' } },
    },
  })
  assert.equal(result.ok, false)
  assert.equal(result.repaired, null)
  assert.equal(result.error.code, 'E_JSON_SCHEMA_VIOLATION')
  assert.match(result.error.message, /extra/)
  assert.deepEqual(result.value, { a: 'x', extra: 1 })
})

test('unsupported schema keywords and invalid options fail loud', () => {
  assert.throws(
    () => repairJson('{}', { schema: { oneOf: [{ type: 'object' }, { type: 'null' }] } }),
    (error) => error.code === 'E_JSON_SCHEMA_UNSUPPORTED',
  )
  assert.throws(
    () => repairJson('{}', { maxSteps: 0 }),
    (error) => error.code === 'E_JSON_INVALID_INPUT',
  )
  assert.throws(
    () => repairJson('{}', { strategies: { magic: true } }),
    (error) => error.code === 'E_JSON_INVALID_INPUT',
  )
})

test('already valid JSON is returned unchanged with no actions', () => {
  const text = '{\n  "a": 1\n}'
  const result = repairJson(text)
  assert.equal(result.ok, true)
  assert.equal(result.repaired, text)
  assert.deepEqual(result.actions, [])
  assert.deepEqual(result.strategies, [])
  assert.equal(result.validated, false)
})


test('valid JSON containing a fenced snippet keeps the outer container and all fields', () => {
  for (const value of [
    { note: '```{} ```', amount: 10 },
    [{ note: '```[]```', amount: 10 }],
    { note: '```json\n{"example":true}\n```', amount: 10 },
  ]) {
    const text = JSON.stringify(value)
    const result = repairJson(text)
    assert.equal(result.ok, true)
    assert.deepEqual(result.value, value)
    assert.equal(result.repaired, text)
    assert.deepEqual(result.actions, [])
    assert.deepEqual(result.strategies, [])
  }
})


test('repairing a JSON container does not extract a fence inside one of its strings', () => {
  const result = repairJson('{"note":"```{} ```","amount":10,}')
  assert.equal(result.ok, true)
  assert.deepEqual(result.value, { note: '```{} ```', amount: 10 })
  assert.deepEqual(result.strategies, ['trailingComma'])
  assert.ok(result.actions.every((action) => action.op !== 'extract'))
})
