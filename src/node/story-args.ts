/**
 * Storybook's `&args=` URL encoding, reimplemented.
 *
 * TB-353. A story can ask to be screenshotted with different args than its
 * default, and the way to say that to Storybook is the same URL parameter its
 * own toolbar writes.
 *
 * Storybook exports `buildArgsParam` from `storybook/internal/router`, and this
 * is a copy of it rather than a call to it. Two reasons. It is a deep import
 * into an internal path, which is exactly the kind of thing that moves between
 * majors and would break the runner in a way nothing here would catch until a
 * user hit it. And it drags a manager-side module, its memoiser and its
 * deprecation logger into the Node runner for forty lines of string work.
 *
 * The copy is kept honest by test/story-args.test.js, which runs both against
 * the same inputs and asserts they agree. If Storybook changes the encoding,
 * that test fails rather than the encoding silently drifting.
 */

/** Storybook's own: anything outside this is dropped rather than escaped. */
const SAFE = /^[a-zA-Z0-9 _-]*$/
const NUMBER = /^-?[0-9]+(\.[0-9]+)?$/
const HEX = /^#([a-f0-9]{3,4}|[a-f0-9]{6}|[a-f0-9]{8})$/i
const COLOR = /^(rgba?|hsla?)\(([0-9]{1,3}),\s?([0-9]{1,3})%?,\s?([0-9]{1,3})%?,?\s?([0-9](\.[0-9]{1,2})?)?\)$/i

function isPlainObject (value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value) && !(value instanceof Date)
}

/**
 * Whether Storybook would accept this pair in a URL.
 *
 * The restriction is deliberate on their side: args travel in a URL that
 * anything can construct, so only a character set that cannot carry a payload
 * is allowed through. A rejected arg is reported to the caller rather than
 * escaped, because escaping it would send Storybook something it will refuse
 * anyway and the story would render with its default instead of the value the
 * config asked for.
 */
export function isEncodableArg (key: string, value: unknown): boolean {
  if (!key || !SAFE.test(key)) return false

  if (value === null || value === undefined || value instanceof Date) return true
  if (typeof value === 'number' || typeof value === 'boolean') return true
  if (typeof value === 'string') {
    return SAFE.test(value) || NUMBER.test(value) || HEX.test(value) || COLOR.test(value)
  }
  if (Array.isArray(value)) return value.every((item) => isEncodableArg(key, item))
  if (isPlainObject(value)) return Object.entries(value).every(([k, v]) => isEncodableArg(k, v))

  return false
}

/** The `!`-prefixed forms Storybook uses for values a URL cannot hold literally. */
function encodeScalar (value: unknown): string {
  if (value === undefined) return '!undefined'
  if (value === null) return '!null'
  if (typeof value === 'boolean') return `!${value}`
  if (value instanceof Date) return `!date(${value.toISOString()})`
  if (typeof value === 'string') {
    if (HEX.test(value)) return `!hex(${value.slice(1)})`
    if (COLOR.test(value)) return `!${value.replace(/[\s%]/g, '')}`

    // The only character in the safe set that a URL cannot carry as itself.
    return value.replace(/ /g, '+')
  }

  return String(value)
}

/** `obj.key` and `arr[0]`, which is what Storybook's stringifier emits. */
function flatten (prefix: string, value: unknown, out: string[]): void {
  if (Array.isArray(value)) {
    value.forEach((item, index) => flatten(`${prefix}[${index}]`, item, out))

    return
  }

  if (isPlainObject(value)) {
    for (const [key, item] of Object.entries(value)) flatten(`${prefix}.${key}`, item, out)

    return
  }

  out.push(`${prefix}:${encodeScalar(value)}`)
}

/**
 * Returns the value of Storybook's `args` query parameter, and the keys that
 * were left out of it.
 *
 * Rejected keys are returned rather than logged here so the runner can put them
 * where the developer will see them, next to the story they belong to.
 */
export function buildArgsParam (args: Record<string, unknown>): { param: string; rejected: string[] } {
  const parts: string[] = []
  const rejected: string[] = []

  for (const [key, value] of Object.entries(args)) {
    if (!isEncodableArg(key, value)) {
      rejected.push(key)
      continue
    }

    flatten(key, value, parts)
  }

  return { param: parts.join(';'), rejected }
}
