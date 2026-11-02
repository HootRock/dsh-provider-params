/**
 * Release gate: metadata lint, typecheck, build, acceptance evidence, tests.
 *
 * This is the one command a release candidate must pass locally:
 *   node scripts/gate.mjs
 */
import { execFileSync } from 'node:child_process'
import { readFileSync, readdirSync } from 'node:fs'
import path from 'node:path'

const root = process.cwd()
const tsc = path.join(root, 'node_modules', 'typescript', 'bin', 'tsc')

function run(args, label) {
  try {
    execFileSync(process.execPath, args, { cwd: root, stdio: 'inherit' })
  } catch {
    console.error(`gate failed: ${label}`)
    process.exit(1)
  }
}

run(['scripts/lint.mjs'], 'lint')
run([tsc, '-p', 'tsconfig.json', '--noEmit'], 'typecheck')
run([tsc, '-p', 'tsconfig.json'], 'build')
run(['scripts/acceptance.mjs'], 'acceptance')

const testFiles = readdirSync(path.join(root, 'test'))
  .filter((file) => file.endsWith('.test.mjs'))
  .sort()
  .map((file) => path.join('test', file))
run(['--test', ...testFiles], 'tests')

const csv = readFileSync(path.join(root, 'ACCEPTANCE.csv'), 'utf8').trim().split('\n')
const header = csv.shift().split(',')
if (!header.includes('evidence_sha256')) {
  console.error('gate failed: ACCEPTANCE.csv header lacks evidence_sha256')
  process.exit(1)
}
const passAt = header.indexOf('pass')
const sourceAt = header.indexOf('source')
const countedAt = header.indexOf('counted')
for (const line of csv) {
  const cells = line.split(',')
  if (cells.length !== header.length || cells[passAt] !== 'true' || cells[sourceAt] !== 'public/synthetic' || cells[countedAt] !== 'false') {
    console.error(`gate failed: bad ACCEPTANCE row: ${line}`)
    process.exit(1)
  }
}

console.log(`gate ok: ${testFiles.length} test files, ${csv.length} acceptance rows (public/synthetic, not counted)`)
