/**
 * The vendor parameter table: 11 vendors × 13 canonical request fields.
 *
 * The table is deliberately data, not control flow. A cell says how one
 * canonical parameter is spelled by one vendor, whether the vendor has an
 * equivalent at all, an optional documented clamp, and whether the field is
 * required by that vendor's request shape. Everything in this module is pure:
 * no I/O, no network, no Cordis context.
 *
 * This table was re-organized from the published `dsh-translate` table (the
 * same PerryLink-owned data, Apache-2.0) into a typed shape. The three
 * `ported` vendors (OpenAI, ERNIE, Qwen) come from GPT-Rosetta-Stone; the
 * `extended` rows follow each vendor's public API reference. A cell marked
 * `supported: false` has no equivalent and is dropped by `params.map` instead
 * of being guessed.
 *
 * @module dsh-provider-params/core/rosetta
 */
import { ProviderParamsError } from './errors.js'

/** Where a vendor row came from. */
export type VendorSource = 'ported' | 'extended'

/** One documented numeric range. */
export interface Clamp {
  readonly min: number
  readonly max: number
}

/** One vendor's spelling and semantics for one canonical parameter. */
export interface ParamCell {
  /** Wire name, or `null` when the vendor has no equivalent. */
  readonly name: string | null
  /** Whether this vendor accepts the parameter in some form. */
  readonly supported: boolean
  /** Documented range enforced by `params.map` (only where the source states one). */
  readonly clamp?: Clamp
  /** Whether the vendor's request shape requires the field. */
  readonly required?: boolean
  /** Human note about the semantic difference, when there is one. */
  readonly notes?: string
}

/** One vendor in display order. */
export interface VendorDescriptor {
  readonly id: string
  readonly name: string
  readonly apiStyle: string
  readonly source: VendorSource
}

/** The full table document. */
export interface RosettaTable {
  readonly vendors: readonly VendorDescriptor[]
  readonly params: readonly string[]
  readonly table: Readonly<Record<string, Readonly<Record<string, ParamCell>>>>
}

/** Vendors in display order. */
export const VENDORS: readonly VendorDescriptor[] = Object.freeze([
  { id: 'openai', name: 'OpenAI', apiStyle: 'openai', source: 'ported' },
  { id: 'ernie', name: 'Baidu ERNIE (Wenxin)', apiStyle: 'native', source: 'ported' },
  { id: 'qwen', name: 'Alibaba Qwen (DashScope)', apiStyle: 'native', source: 'ported' },
  { id: 'anthropic', name: 'Anthropic Claude', apiStyle: 'anthropic', source: 'extended' },
  { id: 'google', name: 'Google Gemini', apiStyle: 'gemini', source: 'extended' },
  { id: 'deepseek', name: 'DeepSeek', apiStyle: 'openai', source: 'extended' },
  { id: 'mistral', name: 'Mistral AI', apiStyle: 'openai', source: 'extended' },
  { id: 'cohere', name: 'Cohere', apiStyle: 'native', source: 'extended' },
  { id: 'xai', name: 'xAI Grok', apiStyle: 'openai', source: 'extended' },
  { id: 'groq', name: 'Groq', apiStyle: 'openai', source: 'extended' },
  { id: 'azure', name: 'Azure OpenAI', apiStyle: 'openai', source: 'extended' },
])

/** Canonical parameters in display order. */
export const PARAMS: readonly string[] = Object.freeze([
  'model',
  'messages',
  'system',
  'temperature',
  'top_p',
  'max_tokens',
  'stream',
  'stop',
  'n',
  'presence_penalty',
  'frequency_penalty',
  'top_k',
  'seed',
])

/**
 * Build one complete table row. Every vendor not named in `overrides` keeps
 * the canonical spelling and is supported.
 */
function row(
  defaultName: string,
  overrides: Readonly<Record<string, Partial<ParamCell>>> = {},
): Readonly<Record<string, ParamCell>> {
  const result: Record<string, ParamCell> = {}
  for (const vendor of VENDORS) {
    const override = overrides[vendor.id] ?? {}
    const name = override.name === undefined ? defaultName : override.name
    result[vendor.id] = {
      name,
      supported: override.supported === undefined ? name !== null : override.supported,
      ...(override.clamp === undefined ? {} : { clamp: override.clamp }),
      ...(override.required === undefined ? {} : { required: override.required }),
      ...(override.notes === undefined ? {} : { notes: override.notes }),
    }
  }
  return Object.freeze(result)
}

const noEquivalent = 'no equivalent'

/** `TABLE[param][vendor]` — the public lookup surface. */
export const TABLE: Readonly<Record<string, Readonly<Record<string, ParamCell>>>> = Object.freeze({
  model: row('model', {
    azure: { notes: 'deployment name; the full model id lives in the request URL' },
  }),
  messages: row('messages', {
    google: { name: 'contents', notes: 'role "system" maps to systemInstruction instead' },
  }),
  system: row('system', {
    openai: { notes: 'sent as a message with role "system"' },
    ernie: { notes: 'sent as a message with role "system"' },
    qwen: { notes: 'sent as a message with role "system"' },
    anthropic: { notes: 'top-level field (string or blocks), not a message' },
    google: { name: 'systemInstruction', notes: 'top-level field; system_instruction is also accepted' },
    deepseek: { notes: 'sent as a message with role "system"' },
    mistral: { notes: 'sent as a message with role "system"' },
    cohere: { notes: 'sent as a message with role "system" (chat v2)' },
    xai: { notes: 'sent as a message with role "system"' },
    groq: { notes: 'sent as a message with role "system"' },
    azure: { notes: 'sent as a message with role "system"' },
  }),
  temperature: row('temperature', {
    ernie: { clamp: { min: 0.01, max: 1 } },
    anthropic: { clamp: { min: 0, max: 1 }, notes: 'range 0..1' },
    google: { name: 'generationConfig.temperature', notes: 'range 0..2' },
    deepseek: { notes: 'range 0..2' },
    cohere: { notes: 'range 0..5' },
    xai: { notes: 'range 0..2' },
  }),
  top_p: row('top_p', {
    cohere: { name: 'p' },
    ernie: { clamp: { min: 0, max: 1 } },
    anthropic: { notes: 'use with top_k instead of temperature' },
    google: { name: 'generationConfig.topP', notes: 'range 0..1' },
    deepseek: { notes: 'recommended to use together with temperature' },
  }),
  max_tokens: row('max_tokens', {
    ernie: { name: 'max_output_tokens' },
    google: { name: 'generationConfig.maxOutputTokens' },
    anthropic: { required: true, notes: 'REQUIRED for most Anthropic models' },
    openai: { notes: 'newer reasoning models prefer max_completion_tokens' },
    groq: { notes: 'max_completion_tokens is also accepted' },
  }),
  stream: row('stream', {
    google: { notes: 'API option (generateContent vs streamGenerateContent), not a body field' },
  }),
  stop: row('stop', {
    ernie: { name: null, notes: noEquivalent },
    qwen: { name: null, notes: noEquivalent },
    anthropic: { name: 'stop_sequences' },
    google: { name: 'generationConfig.stopSequences' },
    cohere: { name: 'stop_sequences' },
  }),
  n: row('n', {
    ernie: { name: null, notes: noEquivalent },
    qwen: { name: null, notes: noEquivalent },
    anthropic: { name: null, notes: noEquivalent },
    groq: { name: null, notes: noEquivalent },
    google: { name: 'generationConfig.candidateCount' },
    deepseek: { notes: 'single candidate for most models' },
  }),
  presence_penalty: row('presence_penalty', {
    ernie: { name: 'penalty_score' },
    anthropic: { name: null, notes: noEquivalent },
    google: { name: 'generationConfig.presencePenalty', notes: 'v1beta models only' },
    mistral: { notes: 'model-dependent' },
  }),
  frequency_penalty: row('frequency_penalty', {
    ernie: { name: null, notes: noEquivalent },
    qwen: { name: null, notes: noEquivalent },
    anthropic: { name: null, notes: noEquivalent },
    google: { name: 'generationConfig.frequencyPenalty', notes: 'v1beta models only' },
    mistral: { notes: 'model-dependent' },
  }),
  top_k: row('top_k', {
    openai: { name: null, notes: noEquivalent },
    ernie: { name: null, notes: noEquivalent },
    qwen: { name: null, notes: noEquivalent },
    anthropic: { name: 'top_k' },
    google: { name: 'generationConfig.topK' },
    deepseek: { name: null, notes: noEquivalent },
    mistral: { name: 'top_k', notes: 'some models' },
    cohere: { name: 'k' },
    xai: { name: null, notes: noEquivalent },
    groq: { name: null, notes: noEquivalent },
    azure: { name: null, notes: noEquivalent },
  }),
  seed: row('seed', {
    ernie: { name: null, notes: noEquivalent },
    google: { name: 'generationConfig.seed' },
    mistral: { name: 'random_seed' },
    anthropic: { notes: 'beta parameter' },
  }),
})

/** Vendor ids in display order. */
export function vendorIds(): string[] {
  return VENDORS.map((vendor) => vendor.id)
}

/** Canonical parameter ids in display order. */
export function paramList(): string[] {
  return [...PARAMS]
}

/** Look up one vendor (case-insensitive); `undefined` when unknown. */
export function describeVendor(id: string): VendorDescriptor | undefined {
  const needle = String(id).toLowerCase()
  return VENDORS.find((vendor) => vendor.id === needle)
}

/** Look up one vendor or fail with a stable code. */
export function resolveVendor(id: string): VendorDescriptor {
  const vendor = describeVendor(id)
  if (vendor === undefined) {
    throw new ProviderParamsError(
      'E_PARAMS_UNKNOWN_VENDOR',
      `unknown vendor "${id}"`,
      `use one of: ${vendorIds().join(', ')}`,
    )
  }
  return vendor
}

/** One cell, or `undefined` for an unknown param/vendor pair. */
export function describeParam(param: string, vendor: string): ParamCell | undefined {
  return TABLE[param]?.[String(vendor).toLowerCase()]
}

/** Whether a canonical parameter id exists in this table. */
export function isKnownParam(param: string): boolean {
  return Object.hasOwn(TABLE, param)
}

/** A frozen snapshot of the table (safe for callers to read). */
export function rosettaData(): RosettaTable {
  return Object.freeze({ vendors: VENDORS, params: PARAMS, table: TABLE })
}
