import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { mapParams } from '../lib/core/mapping.js'
import { repairJson } from '../lib/core/repair.js'

const root = fileURLToPath(new URL('..', import.meta.url))
const read = (path) => readFileSync(`${root}/${path}`, 'utf8')

test('quickstart params sample matches its checked-in golden', () => {
  const request = JSON.parse(read('samples/quickstart/input/params-request.json'))
  const actual = mapParams(request.from, request.to, request.params)
  const expected = JSON.parse(read('samples/quickstart/expected/params-mapped.json'))
  assert.deepEqual(actual, expected)
})

test('quickstart broken JSON sample matches its checked-in golden', () => {
  const text = read('samples/quickstart/input/broken-tool-output.json')
  const actual = repairJson(text)
  const expected = JSON.parse(read('samples/quickstart/expected/json-repaired.json'))
  assert.deepEqual(actual, expected)
  assert.equal(actual.ok, true)
  assert.deepEqual(actual.strategies, ['escapeRepair', 'trailingComma'])
})

test('quickstart runner prints both real results', () => {
  const output = execFileSync(process.execPath, ['samples/quickstart/run.mjs'], { cwd: root, encoding: 'utf8' })
  assert.match(output, /== params\.map ==/)
  assert.match(output, /== json\.repair ==/)
  assert.match(output, /"stop_sequences"/)
  assert.match(output, /"strategies": \[\n\s+"escapeRepair",\n\s+"trailingComma"\n\s+\]/)
})
