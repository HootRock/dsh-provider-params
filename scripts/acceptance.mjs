/**
 * Regenerate ACCEPTANCE.csv from real local checks.
 *
 * Every row is public/synthetic and not counted toward any customer claim.
 * The evidence hash covers the check summary plus the quickstart stdout, so a
 * changed sample or a changed result invalidates the recorded evidence.
 */
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import { mapParams, listVendors } from '../lib/core/mapping.js'
import { PARAMS, vendorIds } from '../lib/core/rosetta.js'
import { repairJson } from '../lib/core/repair.js'

const root = process.cwd()
const ids = vendorIds()

let pairs = 0
for (const from of ids) {
  for (const to of ids) {
    const result = mapParams(from, to, { temperature: 0.4, top_p: 0.8, max_tokens: 128 })
    if (result.dropped.length > 0 || result.unknown.length > 0) throw new Error(`pair ${from}->${to} was not clean`)
    pairs += 1
  }
}

const repairCases = [
  repairJson('{"a":1,}'),
  repairJson('{"note":"line1\nline2"}'),
  repairJson('{"items":[1,2'),
  repairJson('{"a":"x"}', {
    schema: {
      type: 'object',
      required: ['a', 'b'],
      properties: { a: { type: 'string' }, b: { type: 'number' } },
    },
  }),
]
for (const result of repairCases) if (!result.ok) throw new Error('repair case failed')
const strategies = new Set(repairCases.flatMap((result) => result.strategies))
const placeholders = repairCases[3].placeholders

const request = JSON.parse(readFileSync('samples/quickstart/input/params-request.json', 'utf8'))
const expectedMap = JSON.parse(readFileSync('samples/quickstart/expected/params-mapped.json', 'utf8'))
const broken = readFileSync('samples/quickstart/input/broken-tool-output.json', 'utf8')
const expectedRepair = JSON.parse(readFileSync('samples/quickstart/expected/json-repaired.json', 'utf8'))
const actualMap = mapParams(request.from, request.to, request.params)
const actualRepair = repairJson(broken)
const goldens = [JSON.stringify(actualMap) === JSON.stringify(expectedMap), JSON.stringify(actualRepair) === JSON.stringify(expectedRepair)]
if (goldens.some((ok) => !ok)) throw new Error('quickstart golden mismatch')

const sampleOutput = execFileSync(process.execPath, ['samples/quickstart/run.mjs'], { cwd: root, encoding: 'utf8' })

const checks = [
  { req_id: 'PP-A01', metric: 'vendors listed', threshold: 11, actual: listVendors().count },
  { req_id: 'PP-A02', metric: 'canonical field count', threshold: 13, actual: PARAMS.length },
  { req_id: 'PP-A03', metric: 'vendor-pair mappings clean', threshold: 121, actual: pairs },
  { req_id: 'PP-A04', metric: 'deterministic repair strategies', threshold: 4, actual: strategies.size },
  { req_id: 'PP-A05', metric: 'quickstart goldens match', threshold: 2, actual: goldens.filter(Boolean).length },
  { req_id: 'PP-A06', metric: 'null placeholders reported', threshold: 1, actual: placeholders.length },
]
for (const check of checks) {
  if (check.actual !== check.threshold) throw new Error(`${check.req_id}: expected ${check.threshold}, got ${check.actual}`)
}

const evidence = createHash('sha256')
  .update(JSON.stringify({ checks, sampleOutput }))
  .digest('hex')

const lines = [
  'req_id,metric,threshold,actual,script,evidence_sha256,pass,source,counted',
  ...checks.map(
    (check) =>
      `${check.req_id},${check.metric},${check.threshold},${check.actual},scripts/acceptance.mjs,${evidence},true,public/synthetic,false`,
  ),
]
writeFileSync('ACCEPTANCE.csv', `${lines.join('\n')}\n`)
console.log(`acceptance ok: ${checks.length}/${checks.length} public/synthetic checks, 4 repair strategies`)
