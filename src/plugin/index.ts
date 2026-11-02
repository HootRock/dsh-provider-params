/**
 * Cordis plugin entry for dsh-provider-params.
 *
 * Registers four read-only tools on the `tools` service. No storage, no
 * network, no session writes.
 *
 * @module dsh-provider-params/plugin
 */
import type { Context } from '@deepseek-ai/cordis'
import { createTools } from './tools.js'

/** Stable plugin name used by the profile patch. */
export const name = 'dsh-provider-params'

/** The only hard service: the tool registry. */
export const inject = ['tools']

/** Register every tool once. */
export async function apply(ctx: Context): Promise<void> {
  for (const tool of createTools()) ctx.tools.register(tool)
}
