/**
 * Pure mapping between vendor request shapes.
 *
 * `params.map` accepts a request fragment written in the source vendor's wire
 * names (or in canonical names, which are vendor-neutral) and returns the
 * target vendor's fragment together with an explicit account of every value
 * that was renamed, dropped, clamped, or left for the caller to supply.
 *
 * Three rules keep the answer honest:
 *   1. A parameter with no target equivalent is dropped and listed — never
 *      silently renamed to a plausible-looking field.
 *   2. A target-required field that the input does not carry is reported as
 *      `added` with no value. The mapper never invents a token budget.
 *   3. A documented numeric clamp is applied and reported in `adjusted`;
 *      other out-of-range values are left untouched because this table does
 *      not claim a range the vendor does not document.
 *
 * @module dsh-provider-params/core/mapping
 */
import { ProviderParamsError } from './errors.js'
import { deepEqual, isPlainObject, type JsonObject, type JsonValue } from './json.js'
import {
  PARAMS,
  TABLE,
  describeParam,
  resolveVendor,
  vendorIds,
  type Clamp,
  type ParamCell,
} from './rosetta.js'

/** A JSON parameter object. */
export type ParamObject = JsonObject

/** One input parameter the target cannot accept. */
export interface DroppedParam {
  param: string
  from_wire: string
  reason: string
}

/** One target-required parameter missing from the input. No value is invented. */
export interface AddedParam {
  param: string
  wire_name: string
  reason: string
}

/** One value changed by a documented clamp. */
export interface AdjustedParam {
  param: string
  wire_name: string
  from: number
  to: number
  rule: string
}

/** One input key this table does not recognize. */
export interface UnknownParam {
  param: string
  reason: string
}

/** Result of one `params.map` call. */
export interface MapParamsResult {
  from: string
  to: string
  mapped: ParamObject
  dropped: DroppedParam[]
  added: AddedParam[]
  adjusted: AdjustedParam[]
  unknown: UnknownParam[]
}

/** Options for {@link mapParams}. */
export interface MapParamsOptions {
  /** Reject unknown input keys instead of listing them. Default `false`. */
  strict?: boolean
}

/** One endpoint in a vendor comparison. */
export interface CompareEndpoint {
  name: string
  supported: boolean
  required: boolean
  /** Documented range as `"min..max"`, or `""`. */
  range: string
  notes: string
}

/** One semantic-difference row. */
export interface CompareRow {
  param: string
  from: CompareEndpoint
  to: CompareEndpoint
  relation: 'same' | 'renamed' | 'removed' | 'added' | 'absent'
  notes: string
}

/** Result of one `params.compare` call. */
export interface CompareResult {
  from: string
  to: string
  rows: CompareRow[]
  summary: {
    same: number
    renamed: number
    removed: number
    added: number
    absent: number
  }
}

/** One field in a vendor listing. */
export interface VendorField {
  param: string
  wire_name: string
  supported: boolean
  required: boolean
  range: string
  notes: string
}

/** One vendor and its fields. */
export interface VendorInfo {
  id: string
  name: string
  api_style: string
  source: string
  total: number
  supported: number
  fields: VendorField[]
}

/** Result of one `params.vendors` call. */
export interface VendorsResult {
  count: number
  params: string[]
  vendors: VendorInfo[]
}

/** Human-readable clamp text used by compare/vendors. */
function clampText(clamp: Clamp | undefined): string {
  return clamp === undefined ? '' : `${clamp.min}..${clamp.max}`
}

/**
 * Flatten the one nested container this table knows about: Google's
 * `generationConfig`. Arrays (including `messages`) are never flattened.
 */
function flattenInput(params: ParamObject): Array<[string, JsonValue]> {
  const entries: Array<[string, JsonValue]> = []
  for (const [key, value] of Object.entries(params)) {
    if (key === 'generationConfig' && isPlainObject(value)) {
      for (const [inner, innerValue] of Object.entries(value)) entries.push([`${key}.${inner}`, innerValue as JsonValue])
      continue
    }
    entries.push([key, value])
  }
  return entries
}

/** Canonical id for a canonical name or a source-vendor wire name. */
function sourceIndex(fromVendor: string): Map<string, string> {
  const index = new Map<string, string>()
  for (const param of PARAMS) {
    index.set(param, param)
    const cell = describeParam(param, fromVendor)
    if (cell !== undefined && cell.supported && cell.name !== null) index.set(cell.name, param)
  }
  return index
}

/** Set one possibly dotted wire name on the target object. */
function setTargetValue(target: ParamObject, wireName: string, value: JsonValue, param: string): void {
  const parts = wireName.split('.')
  let cursor = target
  for (let index = 0; index < parts.length - 1; index++) {
    const part = parts[index] as string
    const next = cursor[part]
    if (next === undefined) {
      const child: JsonObject = {}
      cursor[part] = child
      cursor = child
      continue
    }
    if (!isPlainObject(next)) {
      throw new ProviderParamsError(
        'E_PARAMS_TARGET_COLLISION',
        `cannot place "${wireName}" for "${param}": "${part}" is already a non-object value`,
        'rename the conflicting input field or map it separately',
      )
    }
    cursor = next
  }
  const leaf = parts[parts.length - 1] as string
  if (Object.hasOwn(cursor, leaf)) {
    throw new ProviderParamsError(
      'E_PARAMS_TARGET_COLLISION',
      `two parameters map to "${wireName}"`,
      'map the conflicting parameters in separate calls',
    )
  }
  Object.defineProperty(cursor, leaf, { value, enumerable: true, configurable: true, writable: true })
}

/**
 * Map one request fragment from `fromId` to `toId`.
 *
 * @param fromId - source vendor id (case-insensitive).
 * @param toId - target vendor id (case-insensitive).
 * @param params - source wire names, canonical names, or a nested Google
 *   `generationConfig` object.
 * @param options - `{ strict }`; strict rejects unknown keys.
 * @returns the target fragment plus dropped/added/adjusted/unknown lists.
 * @throws {ProviderParamsError} for an unknown vendor, an invalid params
 *   value, a conflicting duplicate, or strict unknown keys.
 */
export function mapParams(
  fromId: string,
  toId: string,
  params: ParamObject,
  options: MapParamsOptions = {},
): MapParamsResult {
  const from = resolveVendor(fromId)
  const to = resolveVendor(toId)
  if (!isPlainObject(params)) {
    throw new ProviderParamsError(
      'E_PARAMS_INVALID_INPUT',
      'params must be a plain object',
      'pass a JSON object such as {"temperature":0.2}',
    )
  }

  const index = sourceIndex(from.id)
  const resolved = new Map<string, { value: JsonValue; sourceKey: string }>()
  const unknown: UnknownParam[] = []

  for (const [key, value] of flattenInput(params)) {
    const canonical = index.get(key)
    if (canonical === undefined) {
      unknown.push({
        param: key,
        reason: `not a canonical parameter or ${from.id} wire field`,
      })
      continue
    }
    const previous = resolved.get(canonical)
    if (previous !== undefined) {
      if (!deepEqual(previous.value, value)) {
        throw new ProviderParamsError(
          'E_PARAMS_CONFLICT',
          `"${canonical}" is supplied twice with different values ("${previous.sourceKey}" and "${key}")`,
          `keep exactly one of those spellings`,
        )
      }
      continue
    }
    resolved.set(canonical, { value, sourceKey: key })
  }

  if (options.strict === true && unknown.length > 0) {
    throw new ProviderParamsError(
      'E_PARAMS_UNKNOWN_PARAM',
      `unknown parameter${unknown.length === 1 ? '' : 's'}: ${unknown.map((entry) => entry.param).join(', ')}`,
      `remove them or call with strict=false to receive them in the "unknown" list`,
    )
  }

  const mapped: ParamObject = {}
  const dropped: DroppedParam[] = []
  const added: AddedParam[] = []
  const adjusted: AdjustedParam[] = []

  for (const param of PARAMS) {
    const entry = resolved.get(param)
    if (entry === undefined) continue
    const sourceCell: ParamCell | undefined = describeParam(param, from.id)
    const targetCell: ParamCell | undefined = describeParam(param, to.id)
    if (targetCell === undefined || !targetCell.supported || targetCell.name === null) {
      dropped.push({
        param,
        from_wire: sourceCell?.name ?? param,
        reason: `not supported by ${to.id}${targetCell?.notes === undefined ? '' : ` (${targetCell.notes})`}`,
      })
      continue
    }
    let value: JsonValue = entry.value
    if (targetCell.clamp !== undefined && typeof value === 'number' && Number.isFinite(value)) {
      const clamped = Math.max(targetCell.clamp.min, Math.min(targetCell.clamp.max, value))
      if (clamped !== value) {
        adjusted.push({
          param,
          wire_name: targetCell.name,
          from: value,
          to: clamped,
          rule: `clamp ${clampText(targetCell.clamp)}`,
        })
        value = clamped
      }
    }
    setTargetValue(mapped, targetCell.name, value, param)
  }

  for (const param of PARAMS) {
    if (resolved.has(param)) continue
    const targetCell = describeParam(param, to.id)
    if (targetCell === undefined || targetCell.required !== true || targetCell.name === null) continue
    added.push({
      param,
      wire_name: targetCell.name,
      reason: `required by ${to.id}; no value was invented, supply one`,
    })
  }

  return { from: from.id, to: to.id, mapped, dropped, added, adjusted, unknown }
}

function endpoint(cell: ParamCell | undefined): CompareEndpoint {
  return {
    name: cell?.name ?? '',
    supported: cell?.supported ?? false,
    required: cell?.required ?? false,
    range: clampText(cell?.clamp),
    notes: cell?.notes ?? '',
  }
}

/**
 * Compare the parameter semantics of two vendors, one row per canonical field.
 *
 * @param fromId - first vendor id.
 * @param toId - second vendor id.
 * @returns the rows and a relation summary.
 */
export function compareVendors(fromId: string, toId: string): CompareResult {
  const from = resolveVendor(fromId)
  const to = resolveVendor(toId)
  const summary = { same: 0, renamed: 0, removed: 0, added: 0, absent: 0 }
  const rows: CompareRow[] = []
  for (const param of PARAMS) {
    const left = endpoint(describeParam(param, from.id))
    const right = endpoint(describeParam(param, to.id))
    let relation: CompareRow['relation']
    if (left.supported && right.supported) relation = left.name === right.name ? 'same' : 'renamed'
    else if (left.supported) relation = 'removed'
    else if (right.supported) relation = 'added'
    else relation = 'absent'
    summary[relation] += 1
    const notes = [right.notes, left.notes].filter((note) => note.length > 0).join(' · ')
    rows.push({ param, from: left, to: right, relation, notes })
  }
  return { from: from.id, to: to.id, rows, summary }
}

/**
 * List vendors and their fields.
 *
 * @param options - `{ vendor?, include_unsupported? }`. `vendor` filters to one
 *   id; unsupported fields are hidden unless `include_unsupported` is true.
 * @returns the vendors in display order.
 */
export function listVendors(options: { vendor?: string; include_unsupported?: boolean } = {}): VendorsResult {
  const includeUnsupported = options.include_unsupported === true
  const vendors = options.vendor === undefined
    ? vendorIds().map((id) => resolveVendor(id))
    : [resolveVendor(options.vendor)]

  const result: VendorInfo[] = vendors.map((vendor) => {
    const fields: VendorField[] = []
    let supported = 0
    for (const param of PARAMS) {
      const cell = describeParam(param, vendor.id)
      const isSupported = cell?.supported === true
      if (isSupported) supported += 1
      if (!isSupported && !includeUnsupported) continue
      fields.push({
        param,
        wire_name: cell?.name ?? '',
        supported: isSupported,
        required: cell?.required === true,
        range: clampText(cell?.clamp),
        notes: cell?.notes ?? '',
      })
    }
    return {
      id: vendor.id,
      name: vendor.name,
      api_style: vendor.apiStyle,
      source: vendor.source,
      total: PARAMS.length,
      supported,
      fields,
    }
  })

  return { count: result.length, params: [...PARAMS], vendors: result }
}

/** Export the table for callers that want the raw cells. */
export { TABLE }
