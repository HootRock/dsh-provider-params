import test from 'node:test'
import assert from 'node:assert/strict'
import { compareVendors, listVendors, mapParams } from '../lib/core/mapping.js'
import { PARAMS, VENDORS, describeParam, vendorIds } from '../lib/core/rosetta.js'

const VENDOR_IDS = ['openai', 'ernie', 'qwen', 'anthropic', 'google', 'deepseek', 'mistral', 'cohere', 'xai', 'groq', 'azure']

function setPath(target, path, value) {
  const parts = path.split('.')
  let cursor = target
  for (const part of parts.slice(0, -1)) {
    cursor[part] ??= {}
    cursor = cursor[part]
  }
  cursor[parts.at(-1)] = value
}

function getPath(source, path) {
  return path.split('.').reduce((value, part) => value?.[part], source)
}

test('the table has 11 vendors in stable order and 13 canonical fields each', () => {
  assert.equal(VENDORS.length, 11)
  assert.deepEqual(vendorIds(), VENDOR_IDS)
  assert.equal(PARAMS.length, 13)
  for (const vendor of VENDOR_IDS) {
    for (const param of PARAMS) {
      const cell = describeParam(param, vendor)
      assert.ok(cell, `missing ${param}/${vendor}`)
      assert.equal(typeof cell.supported, 'boolean')
      if (cell.supported) assert.equal(typeof cell.name, 'string')
      else assert.equal(cell.name, null)
    }
  }
})

test('every vendor pair maps the shared temperature/top_p/max_tokens request', () => {
  const values = { temperature: 0.4, top_p: 0.8, max_tokens: 128 }
  for (const from of VENDOR_IDS) {
    for (const to of VENDOR_IDS) {
      const result = mapParams(from, to, values)
      assert.deepEqual(result.unknown, [], `${from}->${to} unknown`)
      assert.deepEqual(result.dropped, [], `${from}->${to} dropped`)
      assert.deepEqual(result.added, [], `${from}->${to} added`)
      assert.deepEqual(result.adjusted, [], `${from}->${to} adjusted`)
      for (const [param, value] of Object.entries(values)) {
        const targetCell = describeParam(param, to)
        assert.equal(getPath(result.mapped, targetCell.name), value, `${from}->${to} ${param}`)
      }
    }
  }
})

test('every vendor can be a source using its own wire names', () => {
  for (const from of VENDOR_IDS) {
    const input = {}
    for (const [param, value] of Object.entries({ temperature: 0.4, top_p: 0.8, max_tokens: 128 })) {
      const cell = describeParam(param, from)
      assert.equal(cell.supported, true)
      setPath(input, cell.name, value)
    }
    const result = mapParams(from, 'openai', input)
    assert.deepEqual(result.mapped, { temperature: 0.4, top_p: 0.8, max_tokens: 128 }, from)
  }
})

test('stop is renamed for Anthropic and unsupported fields are dropped', () => {
  const result = mapParams('openai', 'anthropic', {
    stop: ['END'],
    frequency_penalty: 0.2,
    presence_penalty: 0.1,
    n: 2,
  })
  assert.deepEqual(result.mapped.stop_sequences, ['END'])
  assert.equal(Object.hasOwn(result.mapped, 'frequency_penalty'), false)
  assert.deepEqual(result.dropped.map((entry) => entry.param).sort(), ['frequency_penalty', 'n', 'presence_penalty'])
  assert.ok(result.dropped.every((entry) => entry.reason.includes('anthropic')))
})

test('a target-required field is reported as added and no value is invented', () => {
  const result = mapParams('openai', 'anthropic', { temperature: 0.5 })
  assert.deepEqual(result.added, [
    {
      param: 'max_tokens',
      wire_name: 'max_tokens',
      reason: 'required by anthropic; no value was invented, supply one',
    },
  ])
  assert.equal(Object.hasOwn(result.mapped, 'max_tokens'), false)
})

test('out-of-range values clamp only where the table documents a range', () => {
  const high = mapParams('openai', 'ernie', { temperature: 1.9 })
  assert.equal(high.mapped.temperature, 1)
  assert.deepEqual(high.adjusted, [
    { param: 'temperature', wire_name: 'temperature', from: 1.9, to: 1, rule: 'clamp 0.01..1' },
  ])

  const low = mapParams('openai', 'ernie', { temperature: 0 })
  assert.equal(low.mapped.temperature, 0.01)
  assert.equal(low.adjusted[0].rule, 'clamp 0.01..1')

  // DeepSeek documents 0..2 but the source table states no boundary we can
  // enforce, so the value is passed through and nothing is claimed.
  const passthrough = mapParams('openai', 'deepseek', { temperature: 1.9 })
  assert.equal(passthrough.mapped.temperature, 1.9)
  assert.deepEqual(passthrough.adjusted, [])
})

test('Google wire names are nested under generationConfig', () => {
  const result = mapParams('openai', 'google', {
    temperature: 0.2,
    top_p: 0.9,
    max_tokens: 64,
    stop: ['x'],
    system: 'be terse',
  })
  assert.deepEqual(result.mapped.generationConfig, {
    temperature: 0.2,
    topP: 0.9,
    maxOutputTokens: 64,
    stopSequences: ['x'],
  })
  assert.equal(result.mapped.systemInstruction, 'be terse')
  assert.equal(Object.hasOwn(result.mapped, 'generationConfig.temperature'), false)
})

test('nested generationConfig input and source wire names are accepted', () => {
  const result = mapParams('google', 'openai', {
    generationConfig: { temperature: 0.3, topP: 0.7 },
    systemInstruction: 'be nice',
    contents: [{ role: 'user', parts: [{ text: 'hi' }] }],
  })
  assert.equal(result.mapped.temperature, 0.3)
  assert.equal(result.mapped.top_p, 0.7)
  assert.equal(result.mapped.system, 'be nice')
  assert.deepEqual(result.mapped.messages, [{ role: 'user', parts: [{ text: 'hi' }] }])
  assert.equal(Object.hasOwn(result.mapped, 'generationConfig'), false)
})

test('unknown parameters are listed, and strict mode rejects them', () => {
  const result = mapParams('openai', 'anthropic', { temperature: 0.5, foo: 1 })
  assert.equal(result.unknown.length, 1)
  assert.equal(result.unknown[0].param, 'foo')
  assert.match(result.unknown[0].reason, /not a canonical parameter or openai wire field/)

  assert.throws(
    () => mapParams('openai', 'anthropic', { foo: 1 }, { strict: true }),
    (error) => error.code === 'E_PARAMS_UNKNOWN_PARAM',
  )
})

test('conflicting duplicate spellings are rejected', () => {
  assert.throws(
    () => mapParams('google', 'openai', { temperature: 0.1, 'generationConfig.temperature': 0.2 }),
    (error) => error.code === 'E_PARAMS_CONFLICT',
  )
})

test('unknown vendors fail with a stable code', () => {
  assert.throws(() => mapParams('nope', 'openai', {}), (error) => error.code === 'E_PARAMS_UNKNOWN_VENDOR')
  assert.throws(() => compareVendors('openai', 'nope'), (error) => error.code === 'E_PARAMS_UNKNOWN_VENDOR')
  assert.throws(() => listVendors({ vendor: 'nope' }), (error) => error.code === 'E_PARAMS_UNKNOWN_VENDOR')
})

test('compare classifies same/renamed/removed/added rows', () => {
  const result = compareVendors('openai', 'anthropic')
  assert.deepEqual(result.summary, { same: 8, renamed: 1, removed: 3, added: 1, absent: 0 })
  const byParam = Object.fromEntries(result.rows.map((row) => [row.param, row]))
  assert.equal(byParam.model.relation, 'same')
  assert.equal(byParam.stop.relation, 'renamed')
  assert.equal(byParam.stop.to.name, 'stop_sequences')
  assert.equal(byParam.n.relation, 'removed')
  assert.equal(byParam.top_k.relation, 'added')
  assert.equal(byParam.temperature.to.range, '0..1')

  const identical = compareVendors('cohere', 'cohere')
  assert.deepEqual(identical.summary, { same: 13, renamed: 0, removed: 0, added: 0, absent: 0 })
})

test('vendors lists supported fields and can include unsupported ones', () => {
  const all = listVendors()
  assert.equal(all.count, 11)
  assert.equal(all.params.length, 13)

  const openai = listVendors({ vendor: 'OPENAI' }).vendors[0]
  assert.equal(openai.supported, 12)
  assert.equal(openai.fields.length, 12)
  assert.equal(openai.fields.some((field) => field.param === 'top_k'), false)

  const openaiAll = listVendors({ vendor: 'openai', include_unsupported: true }).vendors[0]
  assert.equal(openaiAll.fields.length, 13)
  assert.equal(openaiAll.fields.find((field) => field.param === 'top_k').supported, false)

  const cohere = listVendors({ vendor: 'cohere' }).vendors[0]
  assert.equal(cohere.supported, 13)
})
