/**
 * One recoverable failure with a stable machine code and one next action.
 *
 * The message format follows the family convention:
 * `<what is wrong>（E_<domain>_<reason>）｜下一步：<one action>`.
 * Codes are part of the public contract: callers may branch on `code`; the
 * human sentence is not stable and must not be parsed.
 */
export class ProviderParamsError extends Error {
  /** Stable `E_*` code. */
  readonly code: string
  /** One concrete next action for the person reading the error. */
  readonly next: string

  constructor(code: string, message: string, next: string) {
    super(`${message}（${code}）｜下一步：${next}`)
    this.name = 'ProviderParamsError'
    this.code = code
    this.next = next
  }
}
