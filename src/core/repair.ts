/**
 * Deterministic JSON repair.
 *
 * The pipeline is deliberately boring: normalize (trim + optional markdown
 * fence), parse, and — only when parsing fails — apply a bounded sequence of
 * textual strategies (escape raw control characters, remove trailing commas,
 * close a truncated string/container). Once the text parses, declared required
 * fields are completed with `null` placeholders. No strategy invents a value:
 * `null` is a placeholder that the result reports, not data.
 *
 * If the caller supplies a schema, the repaired value must validate against
 * the supported subset (`type`, `properties`, `required`,
 * `additionalProperties`, `items`, `enum`, `const`). A value that still
 * violates the schema is rejected with `E_JSON_SCHEMA_VIOLATION`; the original
 * broken text is never reported as success.
 *
 * @module dsh-provider-params/core/repair
 */
import { ProviderParamsError } from './errors.js'
import { deepEqual, isPlainObject, type JsonValue } from './json.js'

/** A JSON Schema document restricted to the supported subset. */
export type JsonSchema = boolean | Record<string, unknown>

/** One boolean per deterministic text/completion strategy. */
export interface RepairStrategies {
  escapeRepair: boolean
  trailingComma: boolean
  truncationClosure: boolean
  fieldCompletion: boolean
}

/** Options for {@link repairJson}. */
export interface RepairOptions {
  /** Optional schema used for completion and final validation (shape-checked at runtime). */
  schema?: JsonValue
  /** Override individual strategies. */
  strategies?: Partial<RepairStrategies>
  /** Bounded number of scan/apply passes; 1..64. Default 8. */
  maxSteps?: number
}

/** One concrete edit applied to the input. */
export interface RepairAction {
  op: 'extract' | 'escape' | 'strip' | 'close' | 'fill'
  path: string
  before: string
  after: string
}

/** One structured failure. */
export interface RepairError {
  code: string
  message: string
}

/** Result of one repair attempt. */
export interface RepairResult {
  ok: boolean
  /** Repaired JSON text, or `null` when the input was rejected. */
  repaired: string | null
  /** Parsed value when parsing succeeded; `null` otherwise. */
  value: JsonValue | null
  /** Every edit, in application order. */
  actions: RepairAction[]
  /** Strategy names actually applied, de-duplicated. */
  strategies: string[]
  /** Whether truncation closure was applied. */
  truncated: boolean
  /** Whether a schema with constraints was validated. */
  validated: boolean
  /** Paths whose value is a `null` completion placeholder. */
  placeholders: string[]
  /** Structured failure, or `null`. */
  error: RepairError | null
}

const SCALAR_TYPES = ['string', 'number', 'integer', 'boolean', 'null'] as const
const CONSTRAINT_KEYWORDS = ['type', 'properties', 'required', 'additionalProperties', 'items', 'enum', 'const']
const ANNOTATION_KEYWORDS = ['description', 'title', 'default', 'examples']

const CONTROL_ESCAPES = new Map<string, string>([
  ['\b', '\\b'],
  ['\t', '\\t'],
  ['\n', '\\n'],
  ['\f', '\\f'],
  ['\r', '\\r'],
])

interface Scan {
  inString: boolean
  escapedAtEnd: boolean
  stack: string[]
  controlChars: Array<{ index: number; char: string }>
  trailingCommas: number[]
  mismatch: boolean
}

interface ValidationTask {
  node: JsonSchema
  value: unknown
  path: string
  required: boolean
}

interface Violation {
  path: string
  message: string
  /** True when this is a `null` placeholder at a required property. */
  placeholder?: boolean
}

function pointer(base: string, key: string): string {
  return `${base}/${key.replace(/~/gu, '~0').replace(/\//gu, '~1')}`
}

/**
 * Extract the payload from a markdown fence, mirroring the family helper:
 * a ```` ```json ```` (or bare ```` ``` ````) block wins, otherwise the
 * trimmed text is returned unchanged. A JSON container takes precedence over
 * fences inside its string values, even when that container needs repair.
 */
export function extractJsonFromText(text: string): string {
  const trimmed = String(text).trim()
  if (looksLikeJsonText(trimmed)) return trimmed
  const match = /```(?:json)?\s*\n?([\s\S]*?)\n?```/u.exec(trimmed)
  return match !== null && match[1] !== undefined ? match[1].trim() : trimmed
}

/** Whether repair should attempt this text: only `{`/`[` roots. */
export function looksLikeJsonText(text: string): boolean {
  return /^[\[{]/u.test(String(text))
}

/**
 * Normalize and shape-check a schema. Unsupported keywords fail loud rather
 * than validating nothing.
 */
function normalizeSchema(schema: JsonValue | undefined): JsonSchema | undefined {
  if (schema === undefined) return undefined
  const seen = new Set<object>()
  const walk = (node: unknown, path: string): JsonSchema => {
    if (typeof node === 'boolean') return node
    if (!isPlainObject(node)) {
      throw new ProviderParamsError(
        'E_JSON_SCHEMA_INVALID',
        `${path} must be a schema object or boolean`,
        'pass a JSON Schema such as {"type":"object","properties":{...}}',
      )
    }
    if (seen.has(node)) {
      throw new ProviderParamsError('E_JSON_SCHEMA_INVALID', `${path} is circular`, 'remove the circular reference')
    }
    seen.add(node)
    for (const key of Object.keys(node)) {
      if (CONSTRAINT_KEYWORDS.includes(key) || ANNOTATION_KEYWORDS.includes(key)) continue
      throw new ProviderParamsError(
        'E_JSON_SCHEMA_UNSUPPORTED',
        `${path}.${key} is not supported by json.repair`,
        'use only type/properties/required/additionalProperties/items/enum/const',
      )
    }
    if (node.type !== undefined) {
      if (typeof node.type !== 'string' || (!SCALAR_TYPES.includes(node.type as (typeof SCALAR_TYPES)[number]) && node.type !== 'object' && node.type !== 'array')) {
        throw new ProviderParamsError(
          'E_JSON_SCHEMA_INVALID',
          `${path}.type must be string/number/integer/boolean/null/object/array`,
          'fix the declared type',
        )
      }
    }
    if (node.properties !== undefined) {
      if (!isPlainObject(node.properties)) {
        throw new ProviderParamsError('E_JSON_SCHEMA_INVALID', `${path}.properties must be an object`, 'fix properties')
      }
      for (const [key, value] of Object.entries(node.properties)) walk(value, `${path}.properties.${key}`)
    }
    if (node.required !== undefined) {
      if (!Array.isArray(node.required) || node.required.some((key) => typeof key !== 'string')) {
        throw new ProviderParamsError('E_JSON_SCHEMA_INVALID', `${path}.required must be an array of strings`, 'fix required')
      }
    }
    if (node.additionalProperties !== undefined && typeof node.additionalProperties !== 'boolean') {
      throw new ProviderParamsError(
        'E_JSON_SCHEMA_INVALID',
        `${path}.additionalProperties must be a boolean`,
        'fix additionalProperties',
      )
    }
    if (node.items !== undefined) walk(node.items, `${path}.items`)
    if (node.enum !== undefined && !Array.isArray(node.enum)) {
      throw new ProviderParamsError('E_JSON_SCHEMA_INVALID', `${path}.enum must be an array`, 'fix enum')
    }
    seen.delete(node)
    return node
  }
  return walk(schema, '#')
}

function hasConstraints(schema: JsonSchema | undefined): boolean {
  if (schema === undefined) return false
  if (typeof schema === 'boolean') return schema === false
  return Object.keys(schema).some((key) => CONSTRAINT_KEYWORDS.includes(key))
}

function resolveStrategies(raw: Partial<RepairStrategies> | undefined): RepairStrategies {
  const defaults: RepairStrategies = {
    escapeRepair: true,
    trailingComma: true,
    truncationClosure: true,
    fieldCompletion: true,
  }
  if (raw === undefined) return defaults
  const merged = { ...defaults }
  for (const [key, value] of Object.entries(raw)) {
    if (!Object.hasOwn(defaults, key)) {
      throw new ProviderParamsError('E_JSON_INVALID_INPUT', `unknown strategy "${key}"`, 'use the documented strategy names')
    }
    if (value === undefined) continue
    if (typeof value !== 'boolean') {
      throw new ProviderParamsError('E_JSON_INVALID_INPUT', `strategy "${key}" must be a boolean`, 'pass true or false')
    }
    merged[key as keyof RepairStrategies] = value
  }
  return merged
}

function resolveMaxSteps(raw: number | undefined): number {
  const maxSteps = raw ?? 8
  if (!Number.isInteger(maxSteps) || maxSteps < 1 || maxSteps > 64) {
    throw new ProviderParamsError('E_JSON_INVALID_INPUT', 'maxSteps must be an integer between 1 and 64', 'pass 1..64')
  }
  return maxSteps
}

/** One structural scan: string state, open containers, bad controls, trailing commas. */
function analyzeJsonText(text: string): Scan {
  let inString = false
  let escaped = false
  const stack: string[] = []
  const controlChars: Array<{ index: number; char: string }> = []
  const trailingCommas: number[] = []
  let mismatch = false
  for (let index = 0; index < text.length; index++) {
    const char = text[index] as string
    if (inString) {
      if (escaped) {
        escaped = false
        if (char < ' ') controlChars.push({ index, char })
      } else if (char === '\\') {
        escaped = true
      } else if (char === '"') {
        inString = false
      } else if (char < ' ') {
        controlChars.push({ index, char })
      }
      continue
    }
    if (char === '"') {
      inString = true
    } else if (char === '{' || char === '[') {
      stack.push(char)
    } else if (char === '}' || char === ']') {
      const open = stack.at(-1)
      const matching = char === '}' ? '{' : '['
      if (open === matching) {
        stack.pop()
        let cursor = index - 1
        while (cursor >= 0 && ' \t\r\n'.includes(text[cursor] as string)) cursor--
        if (cursor >= 0 && text[cursor] === ',') trailingCommas.push(cursor)
      } else {
        mismatch = true
      }
    }
  }
  return { inString, escapedAtEnd: escaped && inString, stack, controlChars, trailingCommas, mismatch }
}

function applyReplacements(text: string, replacements: Array<{ index: number; length: number; after: string }>): string {
  const sorted = [...replacements].sort((a, b) => b.index - a.index)
  let result = text
  for (const { index, length, after } of sorted) {
    result = result.slice(0, index) + after + result.slice(index + length)
  }
  return result
}

function pushStrategy(list: string[], name: string): void {
  if (!list.includes(name)) list.push(name)
}

function applyTextStrategies(
  text: string,
  strategies: RepairStrategies,
  maxSteps: number,
): { text: string; actions: RepairAction[]; strategies: string[]; truncated: boolean } {
  let current = text
  const actions: RepairAction[] = []
  const applied: string[] = []
  let truncated = false
  let steps = maxSteps
  let changed = true
  while (changed && steps > 0) {
    changed = false
    steps -= 1
    const scan = analyzeJsonText(current)
    const replacements: Array<{ index: number; length: number; after: string }> = []

    if (strategies.escapeRepair && scan.controlChars.length > 0) {
      for (const { index, char } of scan.controlChars) {
        const escape = CONTROL_ESCAPES.get(char) ?? `\\u${char.charCodeAt(0).toString(16).padStart(4, '0')}`
        replacements.push({ index, length: 1, after: escape })
        actions.push({ op: 'escape', path: `text@${index}`, before: char, after: escape })
      }
      pushStrategy(applied, 'escapeRepair')
      changed = true
    }

    if (strategies.trailingComma && scan.trailingCommas.length > 0) {
      for (const index of scan.trailingCommas) {
        replacements.push({ index, length: 1, after: '' })
        actions.push({ op: 'strip', path: `text@${index}`, before: ',', after: '' })
      }
      pushStrategy(applied, 'trailingComma')
      changed = true
    }

    if (replacements.length > 0) current = applyReplacements(current, replacements)

    if (strategies.truncationClosure && (scan.inString || scan.stack.length > 0) && !scan.mismatch) {
      let suffix = scan.inString ? `${scan.escapedAtEnd ? '\\' : ''}"` : ''
      for (let depth = scan.stack.length - 1; depth >= 0; depth--) {
        suffix += scan.stack[depth] === '{' ? '}' : ']'
      }
      current = `${current}${suffix}`
      actions.push({ op: 'close', path: 'text@end', before: '', after: suffix })
      pushStrategy(applied, 'truncationClosure')
      truncated = true
      changed = true
    }
  }
  return { text: current, actions, strategies: applied, truncated }
}

/**
 * Fill every missing required property on an object that already exists with
 * `null`. Missing parents are never created and no value is fabricated.
 */
function fillRequiredFields(value: unknown, schema: JsonSchema | undefined, actions: RepairAction[]): void {
  if (schema === undefined || schema === true || schema === false) return
  const stack: ValidationTask[] = [{ node: schema, value, path: '#', required: false }]
  for (let task = stack.pop(); task !== undefined; task = stack.pop()) {
    const { node, value: current, path } = task
    if (typeof node === 'boolean') continue
    if (isPlainObject(current)) {
      const required = Array.isArray(node.required)
        ? (node.required as unknown[]).filter((key): key is string => typeof key === 'string')
        : []
      for (const key of required) {
        if (!Object.hasOwn(current, key)) {
          // defineProperty (not assignment) keeps a hostile "__proto__" schema
          // key from walking the prototype chain instead of adding a field.
          Object.defineProperty(current, key, { value: null, enumerable: true, configurable: true, writable: true })
          actions.push({ op: 'fill', path: pointer(path, key), before: '', after: 'null' })
        }
      }
      const properties = isPlainObject(node.properties) ? node.properties : {}
      for (const [key, sub] of Object.entries(properties)) {
        if (Object.hasOwn(current, key)) {
          stack.push({ node: sub as JsonSchema, value: current[key], path: pointer(path, key), required: required.includes(key) })
        }
      }
      continue
    }
    if (Array.isArray(current) && node.items !== undefined) {
      for (let index = 0; index < current.length; index++) {
        stack.push({ node: node.items as JsonSchema, value: current[index], path: `${path}/${index}`, required: false })
      }
    }
  }
}

function matchesType(type: string, value: unknown): boolean {
  switch (type) {
    case 'string': return typeof value === 'string'
    case 'number': return typeof value === 'number' && Number.isFinite(value)
    case 'integer': return typeof value === 'number' && Number.isFinite(value) && Number.isInteger(value)
    case 'boolean': return typeof value === 'boolean'
    case 'null': return value === null
    case 'object': return isPlainObject(value)
    case 'array': return Array.isArray(value)
    default: return false
  }
}

/** Validate one value against the supported schema subset. */
function validateValue(schema: JsonSchema, value: unknown): Violation[] {
  const violations: Violation[] = []
  const stack: ValidationTask[] = [{ node: schema, value, path: '#', required: false }]
  for (let task = stack.pop(); task !== undefined; task = stack.pop()) {
    const { node, value: current, path, required } = task
    if (typeof node === 'boolean') {
      if (!node) violations.push({ path, message: 'schema false rejects every value' })
      continue
    }
    const type = typeof node.type === 'string' ? node.type : undefined
    if (type !== undefined && !matchesType(type, current)) {
      violations.push({
        path,
        message: `must be a ${type}`,
        ...(current === null && required && type !== 'null' ? { placeholder: true } : {}),
      })
      continue
    }
    if (Array.isArray(node.enum) && !node.enum.some((entry) => deepEqual(entry, current))) {
      violations.push({ path, message: 'does not match any enum value' })
    }
    if (Object.hasOwn(node, 'const') && !deepEqual(node.const, current)) {
      violations.push({ path, message: 'must equal the declared const' })
    }
    if (isPlainObject(current)) {
      const requiredKeys = Array.isArray(node.required)
        ? (node.required as unknown[]).filter((key): key is string => typeof key === 'string')
        : []
      for (const key of requiredKeys) {
        if (!Object.hasOwn(current, key)) {
          violations.push({ path: pointer(path, key), message: 'missing required property' })
        }
      }
      const properties = isPlainObject(node.properties) ? node.properties : {}
      for (const [key, sub] of Object.entries(properties)) {
        if (Object.hasOwn(current, key)) {
          stack.push({ node: sub as JsonSchema, value: current[key], path: pointer(path, key), required: requiredKeys.includes(key) })
        }
      }
      if (node.additionalProperties === false) {
        for (const key of Object.keys(current)) {
          if (!Object.hasOwn(properties, key)) {
            violations.push({ path: pointer(path, key), message: 'is not a declared property (additionalProperties: false)' })
          }
        }
      }
    }
    if (Array.isArray(current) && node.items !== undefined) {
      for (let index = 0; index < current.length; index++) {
        stack.push({ node: node.items as JsonSchema, value: current[index], path: `${path}/${index}`, required: false })
      }
    }
  }
  return violations
}

function failure(
  code: string,
  message: string,
  extra: Partial<RepairResult> = {},
): RepairResult {
  return {
    ok: false,
    repaired: null,
    value: null,
    actions: [],
    strategies: [],
    truncated: false,
    validated: false,
    placeholders: [],
    error: { code, message },
    ...extra,
  }
}

/**
 * Repair one JSON text deterministically.
 *
 * @param text - the raw text (a markdown fence is accepted).
 * @param options - optional schema, strategy switches, and pass budget.
 * @returns the repair result; failures are structured, never thrown for bad
 *   JSON. Invalid options/schema throw {@link ProviderParamsError}.
 */
export function repairJson(text: string, options: RepairOptions = {}): RepairResult {
  if (typeof text !== 'string') {
    throw new ProviderParamsError('E_JSON_INVALID_INPUT', 'text must be a string', 'pass the broken JSON as a string')
  }
  const schema = normalizeSchema(options.schema)
  const strategies = resolveStrategies(options.strategies)
  const maxSteps = resolveMaxSteps(options.maxSteps)

  const actions: RepairAction[] = []
  const applied: string[] = []
  let truncated = false
  let current = text.trim()
  if (current.length === 0) {
    return failure('E_JSON_EMPTY', 'the input is empty')
  }

  const extracted = extractJsonFromText(current)
  if (extracted !== current) {
    actions.push({ op: 'extract', path: '$', before: '```json', after: '' })
    pushStrategy(applied, 'extractFence')
    current = extracted
  }
  if (!looksLikeJsonText(current)) {
    return failure('E_JSON_NOT_CONTAINER', 'the text does not start with { or [', { actions, strategies: applied })
  }

  let parsed = parseJsonText(current)
  if (!parsed.ok) {
    const pass = applyTextStrategies(current, strategies, maxSteps)
    if (pass.strategies.length === 0) {
      return failure('E_JSON_UNREPAIRABLE', `cannot parse JSON: ${parsed.error.message}`, {
        actions,
        strategies: applied,
      })
    }
    current = pass.text
    actions.push(...pass.actions)
    for (const name of pass.strategies) pushStrategy(applied, name)
    truncated = pass.truncated
    parsed = parseJsonText(current)
    if (!parsed.ok) {
      return failure('E_JSON_UNREPAIRABLE', `cannot parse JSON after repair: ${parsed.error.message}`, {
        actions,
        strategies: applied,
        truncated,
      })
    }
  }

  const value = parsed.value
  if (strategies.fieldCompletion) {
    const beforeFill = actions.length
    fillRequiredFields(value, schema, actions)
    if (actions.length > beforeFill) pushStrategy(applied, 'fieldCompletion')
  }

  const validated = hasConstraints(schema)
  const placeholders: string[] = []
  if (validated && schema !== undefined) {
    const violations = validateValue(schema, value)
    const real: Violation[] = []
    for (const violation of violations) {
      if (violation.placeholder === true) {
        placeholders.push(violation.path)
        continue
      }
      real.push(violation)
    }
    if (real.length > 0) {
      return failure('E_JSON_SCHEMA_VIOLATION', real.map((violation) => `${violation.path} ${violation.message}`).join('; '), {
        value,
        actions,
        strategies: applied,
        truncated,
        validated,
        placeholders,
      })
    }
  }

  return {
    ok: true,
    repaired: actions.length > 0 ? JSON.stringify(value, null, 2) : current,
    value,
    actions,
    strategies: applied,
    truncated,
    validated,
    placeholders,
    error: null,
  }
}

function parseJsonText(text: string): { ok: true; value: JsonValue } | { ok: false; error: { message: string } } {
  try {
    return { ok: true, value: JSON.parse(text) as JsonValue }
  } catch (error) {
    return { ok: false, error: { message: error instanceof Error ? error.message : String(error) } }
  }
}
