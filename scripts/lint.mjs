/**
 * Package metadata and guard lint.
 *
 * The version assertion is intentionally hard-coded: a release bump must edit
 * both package.json and this file, so a stale README/version cannot ship.
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import path from 'node:path'

const root = process.cwd()
const failures = []
const pkg = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'))

if (pkg.name !== 'dsh-provider-params') failures.push('name must be dsh-provider-params')
if (pkg.version !== '0.1.0') failures.push(`version must be 0.1.0, found ${pkg.version}`)
if (pkg.license !== 'Apache-2.0') failures.push('license must be Apache-2.0')
if (pkg.type !== 'module') failures.push('type must be module')
if (pkg.main !== './lib/plugin/index.js') failures.push('main must point at lib/plugin/index.js')
if (pkg.dsh?.bundle?.patch !== './cordis.patch.yml') failures.push('dsh.bundle.patch must be cordis.patch.yml')
if (pkg.engines?.dsh !== '>=0.2.1-rc.3 <0.4.0') failures.push('engines.dsh must match the family range')
if (typeof pkg.engines?.node !== 'string' || !pkg.engines.node.includes('24.9')) failures.push('engines.node must require 24.9+')
if (pkg.peerDependencies?.['@deepseek-ai/dsh-tools'] === undefined) failures.push('peerDependencies must declare @deepseek-ai/dsh-tools')
if (pkg.peerDependenciesMeta?.['@deepseek-ai/dsh-tools']?.optional !== true) failures.push('@deepseek-ai/dsh-tools must be an optional peer')

const requiredFiles = ['lib', 'cordis.patch.yml', 'README.md', 'README-zh.md', 'samples']
for (const entry of requiredFiles) {
  if (!Array.isArray(pkg.files) || !pkg.files.includes(entry)) failures.push(`files[] must include ${entry}`)
}

const demo = pkg.dsh?.demo
if (demo === undefined) {
  failures.push('dsh.demo is required')
} else {
  for (const key of ['prompt', 'expect', 'screenshot', 'reads', 'writes', 'network', 'external']) {
    if (demo[key] === undefined) failures.push(`dsh.demo.${key} is required`)
  }
  if (demo.network !== false) failures.push('dsh.demo.network must be false')
  if (!Array.isArray(demo.external) || demo.external.length !== 0) failures.push('dsh.demo.external must be []')
  if (!Array.isArray(demo.reads) || demo.reads.length === 0) failures.push('dsh.demo.reads must name the sample inputs')
  if (demo.screenshot && !existsSync(path.join(root, demo.screenshot))) failures.push('dsh.demo.screenshot is missing')
  if (demo.expect && !existsSync(path.join(root, demo.expect))) failures.push('dsh.demo.expect is missing')
}

const patch = readFileSync(path.join(root, 'cordis.patch.yml'), 'utf8')
if (!patch.includes('dsh-provider-params')) failures.push('cordis.patch.yml must name the package')

const samples = path.join(root, 'samples', 'quickstart')
if (!existsSync(path.join(samples, 'input', 'params-request.json'))) failures.push('missing params quickstart input')
if (!existsSync(path.join(samples, 'input', 'broken-tool-output.json'))) failures.push('missing JSON repair quickstart input')
const expectedDir = path.join(samples, 'expected')
if (!existsSync(expectedDir) || readdirSync(expectedDir).length === 0) failures.push('quickstart expected/ is empty')

const readmeZh = readFileSync(path.join(root, 'README-zh.md'), 'utf8')
if (!readmeZh.includes(pkg.version)) failures.push('README-zh.md must state the package version')
if (demo?.prompt && !readmeZh.includes(demo.prompt)) failures.push('README-zh.md must repeat dsh.demo.prompt verbatim')
for (const heading of ['## 一句话', '## 适合 / 不适合', '## 输入', '## 输出', '## 示例', '## 权限', '## FAQ', '## 版本']) {
  if (!readmeZh.includes(heading)) failures.push(`README-zh.md is missing the "${heading}" block`)
}
for (const line of ['读：', '写：', '联网：', '外部系统：']) {
  if (!readmeZh.includes(line)) failures.push(`README-zh.md permission block is missing ${line}`)
}

const trouble = readFileSync(path.join(root, 'TROUBLESHOOTING.md'), 'utf8')
for (const label of ['症状', '原因', '动作']) {
  if (!trouble.includes(label)) failures.push(`TROUBLESHOOTING.md must document ${label} for each error`)
}

const coreDir = path.join(root, 'src', 'core')
for (const entry of readdirSync(coreDir, { withFileTypes: true })) {
  if (!entry.isFile() || !entry.name.endsWith('.ts')) continue
  const source = readFileSync(path.join(coreDir, entry.name), 'utf8')
  if (/\bctx\./.test(source)) failures.push(`src/core/${entry.name} must not touch Cordis context`)
  if (/from\s+['"]@deepseek-ai\//.test(source) || /import\s*\(\s*['"]@deepseek-ai\//.test(source)) {
    failures.push(`src/core/${entry.name} must stay dependency-free`)
  }
}

function walk(dir) {
  const files = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) files.push(...walk(full))
    else files.push(full)
  }
  return files
}

const NETWORK = /(^|[^\w.])(fetch\s*\(|axios|http\.request|https\.request|net\.connect|new WebSocket|undici)/
for (const file of walk(path.join(root, 'src'))) {
  const source = readFileSync(file, 'utf8')
  if (NETWORK.test(source)) failures.push(`${path.relative(root, file)} contains a network call but dsh.demo.network is false`)
}

const libMain = path.join(root, 'lib', 'plugin', 'index.js')
if (!existsSync(libMain) || statSync(libMain).size === 0) failures.push('lib/plugin/index.js is missing; run the build')

if (failures.length > 0) {
  console.error(failures.join('\n'))
  process.exit(1)
}
console.log('lint ok')
