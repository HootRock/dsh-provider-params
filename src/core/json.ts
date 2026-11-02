/**
 * Small JSON value helpers shared by mapping and repair.
 *
 * The type mirrors `@deepseek-ai/dsh-util-values`' `JsonValue` exactly, so the
 * pure core can describe lossless JSON without importing a Cordis package.
 *
 * @module dsh-provider-params/core/json
 */

/** A lossless JSON value. */
export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue }

/** A JSON object (never an array). */
export type JsonObject = { [key: string]: JsonValue }

/** Whether a value is a plain object (not an array, class instance, or null). */
export function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  const proto = Object.getPrototypeOf(value)
  return proto === Object.prototype || proto === null
}

/** Iterative deep equality for JSON-like values. */
export function deepEqual(left: unknown, right: unknown): boolean {
  const stack: Array<[unknown, unknown]> = [[left, right]]
  for (let task = stack.pop(); task !== undefined; task = stack.pop()) {
    const [a, b] = task
    if (Object.is(a, b)) continue
    if (Array.isArray(a) && Array.isArray(b)) {
      if (a.length !== b.length) return false
      for (let index = 0; index < a.length; index++) stack.push([a[index], b[index]])
      continue
    }
    if (isPlainObject(a) && isPlainObject(b)) {
      const aKeys = Object.keys(a)
      if (aKeys.length !== Object.keys(b).length) return false
      for (const key of aKeys) {
        if (!Object.hasOwn(b, key)) return false
        stack.push([a[key], b[key]])
      }
      continue
    }
    return false
  }
  return true
}
