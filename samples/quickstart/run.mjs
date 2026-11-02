/**
 * Quickstart runner: reads the two checked-in inputs, calls the built core,
 * and prints the exact objects stored under `expected/`.
 *
 *   node samples/quickstart/run.mjs
 */
import { readFileSync } from 'node:fs'
import { mapParams } from '../../lib/core/mapping.js'
import { repairJson } from '../../lib/core/repair.js'

const input = (name) => new URL(`./input/${name}`, import.meta.url)
const request = JSON.parse(readFileSync(input('params-request.json'), 'utf8'))
const broken = readFileSync(input('broken-tool-output.json'), 'utf8')

const mapped = mapParams(request.from, request.to, request.params)
const repaired = repairJson(broken)

console.log('== params.map ==')
console.log(JSON.stringify(mapped, null, 2))
console.log('== json.repair ==')
console.log(JSON.stringify(repaired, null, 2))
