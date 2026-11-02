import test from 'node:test'
import assert from 'node:assert/strict'
import { createTools } from '../lib/plugin/tools.js'
import { apply } from '../lib/plugin/index.js'

function toolMap() {
  return Object.fromEntries(createTools().map((tool) => [tool.name, tool]))
}

test('createTools registers exactly the four stable tool names', () => {
  const names = createTools().map((tool) => tool.name)
  assert.deepEqual(names, ['params.map', 'params.compare', 'params.vendors', 'json.repair'])
})

test('params.map executes and renders the dropped/adjusted summary', async () => {
  const tools = toolMap()
  const result = await tools['params.map'].execute(
    { from: 'openai', to: 'anthropic', params: { temperature: 1.4, stop: ['END'], n: 2 } },
    {},
  )
  assert.deepEqual(result.mapped, { temperature: 1, stop_sequences: ['END'] })
  assert.deepEqual(result.adjusted, [
    { param: 'temperature', wire_name: 'temperature', from: 1.4, to: 1, rule: 'clamp 0..1' },
  ])
  assert.deepEqual(result.dropped.map((entry) => entry.param), ['n'])
  assert.deepEqual(result.added.map((entry) => entry.param), ['max_tokens'])

  const rendered = tools['params.map'].output.render({}, result)
  assert.equal(rendered[0].type, 'text')
  assert.match(rendered[0].text, /openai -> anthropic/)
  assert.match(rendered[0].text, /dropped=1/)
  assert.match(rendered[0].text, /adjusted=1/)
})

test('params.compare and params.vendors execute through the registry shape', async () => {
  const tools = toolMap()
  const compared = await tools['params.compare'].execute({ from: 'openai', to: 'ernie' }, {})
  assert.equal(compared.rows.length, 13)
  assert.equal(compared.summary.renamed >= 1, true)
  assert.match(tools['params.compare'].output.render({}, compared)[0].text, /params.compare openai -> ernie/)

  const listed = await tools['params.vendors'].execute({ vendor: 'cohere' }, {})
  assert.equal(listed.count, 1)
  assert.equal(listed.vendors[0].supported, 13)
  assert.match(tools['params.vendors'].output.render({}, listed)[0].text, /params.vendors: 1\/11 vendors/)
})

test('json.repair maps snake_case strategy switches and stays deterministic', async () => {
  const tools = toolMap()
  const disabled = await tools['json.repair'].execute(
    { text: '{"note":"line1\nline2"}', strategies: { escape_repair: false } },
    {},
  )
  assert.equal(disabled.ok, false)
  assert.equal(disabled.error.code, 'E_JSON_UNREPAIRABLE')

  const repaired = await tools['json.repair'].execute({ text: '{"note":"line1\nline2"}' }, {})
  assert.equal(repaired.ok, true)
  assert.equal(repaired.value.note, 'line1\nline2')
  assert.deepEqual(repaired.strategies, ['escapeRepair'])
  assert.match(tools['json.repair'].output.render({}, repaired)[0].text, /actions=1/)
})

test('json.repair completes required fields through the tool surface', async () => {
  const tools = toolMap()
  const result = await tools['json.repair'].execute(
    {
      text: '{"a":"x"}',
      schema: {
        type: 'object',
        required: ['a', 'b'],
        properties: { a: { type: 'string' }, b: { type: 'number' } },
      },
    },
    {},
  )
  assert.equal(result.ok, true)
  assert.deepEqual(result.placeholders, ['#/b'])
  assert.deepEqual(result.actions, [{ op: 'fill', path: '#/b', before: '', after: 'null' }])
})

test('the plugin apply registers all four tools on the tools service', async () => {
  const registered = []
  await apply({ tools: { register: (tool) => registered.push(tool.name) } })
  assert.deepEqual(registered, ['params.map', 'params.compare', 'params.vendors', 'json.repair'])
})
