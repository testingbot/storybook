import type { TargetSpec } from './types.js'

/**
 * A minimal W3C WebDriver client, used for one thing: real iOS devices.
 *
 * Playwright cannot drive browsers on real iOS. This is not a limitation of the
 * TestingBot endpoint that might be lifted later; Playwright has no iOS device
 * backend at all. Mobile Safari on a physical iPhone is reachable only through
 * a WebDriver session against hub.testingbot.com, which is a different protocol
 * from the one the rest of this runner speaks. TB-260 says not to conflate the
 * two paths, and this file is that separation.
 *
 * It is hand-rolled rather than taking webdriverio because the surface actually
 * needed is six endpoints, and webdriverio brings a dependency tree larger than
 * this entire addon for a code path most users never touch. Capability shape is
 * copied from the working reference, real-devices/storybook-real-device.mjs in
 * the example repo: `appium:deviceName` at the top level, everything TestingBot
 * cares about under `tb:options`, and `realDevice: true`.
 */

const HUB_URL = 'https://hub.testingbot.com/wd/hub'
const NEW_SESSION_TIMEOUT_MS = 300_000
const COMMAND_TIMEOUT_MS = 120_000

/** The W3C element identifier. It really is this string, and it is not optional. */
const ELEMENT_KEY = 'element-6066-11e4-a52e-4f735466cecf'

export class WebDriverError extends Error {
  constructor (message: string) {
    super(message)
    this.name = 'WebDriverError'
  }
}

type Json = Record<string, unknown>

export class WebDriverSession {
  #sessionId: string
  #hub: string

  private constructor (sessionId: string, hub: string) {
    this.#sessionId = sessionId
    this.#hub = hub
  }

  get sessionId (): string {
    return this.#sessionId
  }

  /**
   * Opens a session. `capabilities` is the alwaysMatch payload, already built
   * by buildDeviceCapabilities.
   *
   * The timeout is deliberately long. A real device is physically allocated,
   * unlocked and handed over, which takes considerably longer than booting a
   * VM, and a short timeout here reads as "the grid is broken" when it means
   * "the phone is still being prepared".
   */
  static async create (capabilities: Json, { hub = HUB_URL }: { hub?: string } = {}): Promise<WebDriverSession> {
    const body = await request(hub, 'POST', '/session', { capabilities: { alwaysMatch: capabilities } }, NEW_SESSION_TIMEOUT_MS)
    const value = body.value as { sessionId?: unknown } | undefined
    // Some hubs answer with the session id at the top level, some inside value.
    const sessionId = (typeof value?.sessionId === 'string' && value.sessionId) ||
      (typeof body.sessionId === 'string' ? body.sessionId : null)

    if (!sessionId) {
      throw new WebDriverError('The device session started but returned no session id.')
    }

    return new WebDriverSession(sessionId, hub)
  }

  async #send (method: string, path: string, payload?: Json): Promise<unknown> {
    const body = await request(this.#hub, method, `/session/${this.#sessionId}${path}`, payload, COMMAND_TIMEOUT_MS)

    return body.value
  }

  async navigate (url: string): Promise<void> {
    await this.#send('POST', '/url', { url })
  }

  /**
   * Runs a script in the page and returns its value. `args` are passed through
   * as the script's arguments, which is how the settle poller gets its selector
   * without string-building a script per call.
   */
  async execute (script: string, args: unknown[] = []): Promise<unknown> {
    return this.#send('POST', '/execute/sync', { script, args })
  }

  /** Returns the element id, or null when nothing matches. Never throws for "not found". */
  async findElement (selector: string): Promise<string | null> {
    try {
      const value = await this.#send('POST', '/element', { using: 'css selector', value: selector }) as Json

      const id = value?.[ELEMENT_KEY]

      return typeof id === 'string' ? id : null
    } catch {
      return null
    }
  }

  async screenshot (elementId: string | null): Promise<Buffer> {
    const path = elementId ? `/element/${elementId}/screenshot` : '/screenshot'
    const value = await this.#send('GET', path)

    if (typeof value !== 'string' || !value) {
      throw new WebDriverError('The device returned an empty screenshot.')
    }

    return Buffer.from(value, 'base64')
  }

  /**
   * TestingBot's custom commands over WebDriver, the same executor the
   * Playwright path uses through page.evaluate (see session.ts). Best effort:
   * losing a name or a status label in the dashboard is cosmetic, and failing a
   * screenshot run over it would not be.
   */
  async annotate (action: string, args: Json = {}): Promise<void> {
    try {
      await this.execute(`testingbot_executor: ${JSON.stringify({ action, arguments: args })}`)
    } catch {
      // Deliberately swallowed. See above.
    }
  }

  async close (): Promise<void> {
    try {
      await this.#send('DELETE', '')
    } catch {
      // A session that cannot be deleted has already gone, or the grid will
      // reap it. Either way there is nothing useful to do here, and throwing
      // would mask whatever real error sent us into teardown.
    }
  }
}

async function request (
  hub: string,
  method: string,
  path: string,
  payload: Json | undefined,
  timeoutMs: number,
): Promise<Json> {
  let response: Response

  try {
    response = await fetch(`${hub}${path}`, {
      method,
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: payload === undefined ? undefined : JSON.stringify(payload),
      signal: AbortSignal.timeout(timeoutMs),
    })
  } catch (error) {
    throw new WebDriverError(`${method} ${path} failed: ${(error as Error).message}`)
  }

  const text = await response.text()

  let body: Json

  try {
    body = JSON.parse(text) as Json
  } catch {
    throw new WebDriverError(
      `The grid answered ${method} ${path} with ${response.status} and a non-JSON body: ${text.slice(0, 200)}`,
    )
  }

  // W3C errors arrive as a 4xx/5xx with { value: { error, message } }. The
  // message is the part worth surfacing; the stacktrace is the grid's, not the
  // developer's, and only makes the panel unreadable.
  const value = body.value as { error?: unknown; message?: unknown } | undefined

  if (!response.ok || (value && typeof value === 'object' && typeof value.error === 'string')) {
    const message = typeof value?.message === 'string' ? value.message.split('\n')[0] : text.slice(0, 200)

    throw new WebDriverError(`${method} ${path}: ${message}`)
  }

  return body
}

/**
 * Builds the capabilities for a real device WebDriver session.
 *
 * Note the two differences from the Playwright path, both of which are silent
 * when wrong. The device name is `appium:deviceName` and belongs at the top
 * level, not in `tb:options`; and the OS version travels as `browserVersion`,
 * which is what the catalogue already stores for device entries.
 *
 * Credentials and the tunnel capability go in last and unconditionally, exactly
 * as in targets.ts, so no config file can point a device run at another
 * account.
 */
export function buildDeviceCapabilities (
  spec: TargetSpec,
  {
    label,
    build,
    credentials,
    tunnel,
  }: {
    label: string
    build: string
    credentials: { key: string; secret: string }
    tunnel: Record<string, unknown>
  },
): Json {
  const {
    deviceName,
    platformName,
    platformVersion,
    browserName,
    'tb:options': userOptions,
    ...rest
  } = spec

  return {
    browserName: String(browserName ?? 'safari'),
    platformName: String(platformName ?? 'iOS'),
    ...(platformVersion === undefined ? {} : { browserVersion: String(platformVersion) }),
    ...(deviceName === undefined ? {} : { 'appium:deviceName': String(deviceName) }),
    'tb:options': {
      name: label,
      build,
      realDevice: true,
      ...rest,
      ...(isPlainObject(userOptions) ? userOptions : {}),
      ...tunnel,
      key: credentials.key,
      secret: credentials.secret,
    },
  }
}

function isPlainObject (value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
