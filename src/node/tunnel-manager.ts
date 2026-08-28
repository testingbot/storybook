import { randomUUID } from 'node:crypto'
import { createRequire } from 'node:module'
import type { ChildProcess } from 'node:child_process'

import { mergeLocalPortCapabilities } from './local-ports.js'
import { toTunnelError, TunnelError } from './tunnel-errors.js'
import type {
  Credentials,
  Logger,
  TunnelInfo,
  TunnelProgress,
  TunnelState,
} from './types.js'

/** The launcher is CommonJS and ships no types, so describe what we use. */
type Launcher = {
  checkJava: () => Promise<{ version: number | null }>
  downloadAsync: (options: Record<string, unknown>) => Promise<string>
  startTunnelAsync: (options: Record<string, unknown>, jarLocation?: string) => Promise<TunnelProcess>
}

/** The launcher decorates the child process with its own close helper. */
type TunnelProcess = ChildProcess & { close?: (cb?: () => void) => void }

type TunnelManagerOptions = {
  credentials?: Credentials | null
  logger?: Logger
  jarPath?: string | null
}

// process.removeListener's signature is (...args: any[]) => void, so the stored
// handler has to be assignable to that exact shape.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type SignalRegistration = [NodeJS.Signals | 'uncaughtException', (...args: any[]) => void]

const require = createRequire(import.meta.url)
const launcher = require('testingbot-tunnel-launcher') as Launcher

/** The grid refuses a third concurrent tunnel on this plan. */
const MAX_ACCOUNT_TUNNELS = 2

/**
 * Owns one TestingBot Tunnel for the lifetime of one Storybook dev process.
 *
 * Written against testingbot-tunnel-launcher@1.1.19, which fixed the three
 * traps this class used to work around: launcher-only options are no longer
 * forwarded to the jar, credentials are redacted from argv and output, and each
 * tunnel gets its own mkdtemp ready directory instead of one shared path.
 *
 * Still true, and still shaping this file: teardown must wait for the child to
 * really exit and must be safe to call twice, because a leaked tunnel keeps
 * consuming a parallel session the customer has paid for.
 */
export class TunnelManager {
  #state: TunnelState = 'idle'
  #startPromise: Promise<TunnelInfo> | null = null
  #stopPromise: Promise<void> | null = null
  #tunnel: TunnelProcess | null = null
  #identifier: string | null = null
  #devServerUrl: string | null = null
  #extraUrls: string[] = []
  #options: { credentials?: Credentials | null; jarPath: string | null }
  #log: Logger
  #signalHandlers: SignalRegistration[] = []

  constructor ({ credentials, logger = console, jarPath = null }: TunnelManagerOptions = {}) {
    this.#options = { credentials, jarPath }
    this.#log = logger
  }

  get state (): TunnelState {
    return this.#state
  }

  get tunnelIdentifier (): string | null {
    return this.#identifier
  }

  /**
   * Lazy start. TB-253 weighs eager against lazy: eager on `storybook dev`
   * spends a tunnel on every session including the ones that never run a test,
   * which is most of them. Lazy pays a one-off wait on the first run instead,
   * and the caller renders that wait as progress.
   *
   * Concurrent callers share one start rather than racing, because the launcher
   * cannot hold two tunnels in one process.
   */
  async ensureStarted (
    devServerUrl: string,
    {
      onProgress,
      alsoProxy = [],
    }: { onProgress?: (progress: TunnelProgress) => void; alsoProxy?: string[] } = {},
  ): Promise<TunnelInfo> {
    // The extra URLs are part of the tunnel's identity, not a detail of it. A
    // tunnel started for browsers only does not proxy the port a device target
    // needs, so reusing it would produce timeouts that look like a dead grid.
    const wanted = [devServerUrl, ...alsoProxy].join(' ')
    const current = [this.#devServerUrl ?? '', ...this.#extraUrls].join(' ')

    if (this.#state === 'ready' && current === wanted) {
      return this.#describe()
    }

    if (this.#state === 'ready' && current !== wanted) {
      // The dev server moved (Storybook restarted on a different port). The old
      // tunnel proxies the wrong port, so it is useless; replace it.
      await this.stop()
    }

    if (this.#startPromise) return this.#startPromise

    this.#extraUrls = alsoProxy
    this.#startPromise = this.#start(devServerUrl, onProgress).finally(() => {
      this.#startPromise = null
    })

    return this.#startPromise
  }

  async #start (devServerUrl: string, onProgress?: (progress: TunnelProgress) => void): Promise<TunnelInfo> {
    this.#state = 'starting'
    this.#devServerUrl = devServerUrl
    this.#identifier = `storybook-${process.pid}-${randomUUID().slice(0, 8)}`

    const portCapability = mergeLocalPortCapabilities([devServerUrl, ...this.#extraUrls])

    onProgress?.({ phase: 'starting', tunnelIdentifier: this.#identifier })

    try {
      await this.#preflight()
      await this.#checkTunnelCapacity()
      onProgress?.({ phase: 'launching', tunnelIdentifier: this.#identifier })

      this.#tunnel = await this.#launch()
      this.#state = 'ready'
      this.#registerTeardown()

      onProgress?.({ phase: 'ready', tunnelIdentifier: this.#identifier })

      this.#log.info?.(
        `TestingBot Tunnel ready (${this.#identifier}) for ${devServerUrl}` +
          (portCapability.localHttpPorts || portCapability.localHttpsPorts
            ? ''
            : ' using a port the tunnel proxies by default'),
      )

      return this.#describe()
    } catch (error) {
      this.#state = 'error'
      this.#tunnel = null
      throw await this.#classify(error)
    }
  }

  /**
   * Fail on a missing or too-old Java before spawning anything, so the message
   * says "install Java" instead of "spawn java ENOENT".
   */
  async #preflight (): Promise<void> {
    try {
      // checkJava() already parses and range-checks the version, rejecting on a
      // too-old Java. It resolves { version: null } with only a console.warn
      // when it cannot parse the output at all, so we harden that into a real
      // failure rather than letting the tunnel spawn and fail obscurely later.
      const { version } = await launcher.checkJava()
      if (version === null) {
        throw new Error(
          'Could not determine the installed Java version. TestingBot Tunnel needs Java 11 or newer.',
        )
      }
    } catch (error) {
      throw toTunnelError(error)
    }
  }

  /**
   * The capacity preflight is a time-of-check test, so two Storybooks starting
   * at once can both pass it and still have the second refused by the grid.
   * When the jar dies with a bare exit code, ask the API again before handing
   * the developer a meaningless "exit code 1".
   */
  async #classify (error: unknown): Promise<TunnelError> {
    const mapped = toTunnelError(error)
    if (mapped.code !== 'TUNNEL_FAILED') return mapped

    try {
      await this.#checkTunnelCapacity()
    } catch (capacityError) {
      if (capacityError instanceof TunnelError) return capacityError
    }

    return mapped
  }

  /**
   * The tunnel jar refuses to start when the account is at its tunnel limit, but
   * it reports that only on stderr as "You already have N tunnels active"; the
   * launcher does not promote that line to an error the way it does for
   * 401 Unauthorized and "minutes left", so the caller just sees exit code 1.
   *
   * Ask the API first so the developer gets the real reason, which TB-253
   * requires. This is advisory only: a failure to check must never block a
   * start that would otherwise succeed.
   */
  async #checkTunnelCapacity (): Promise<void> {
    const { credentials } = this.#options
    if (!credentials?.key || !credentials?.secret) return

    let list: unknown
    try {
      const auth = Buffer.from(`${credentials.key}:${credentials.secret}`).toString('base64')
      const response = await fetch('https://api.testingbot.com/v1/tunnel/list', {
        headers: { Authorization: `Basic ${auth}` },
        signal: AbortSignal.timeout(10_000),
      })
      if (!response.ok) return
      list = await response.json()
    } catch {
      return
    }

    if (!Array.isArray(list) || list.length < MAX_ACCOUNT_TUNNELS) return

    const orphans = (list as Array<{ identifier: string | null }>).filter((entry) => !entry.identifier).length
    const detail = orphans
      ? ` ${orphans} of them ${orphans === 1 ? 'has' : 'have'} no identifier, which usually means a leaked tunnel from a crashed run.`
      : ''

    throw new TunnelError(
      'CONCURRENCY_EXHAUSTED',
      `This TestingBot account already has ${list.length} tunnels running, which is the limit, so a new one would be refused.${detail} ` +
        'Close one at https://testingbot.com/members/tunnels and try again.',
    )
  }

  async #launch (): Promise<TunnelProcess> {
    const { credentials, jarPath } = this.#options

    // Minimal option set. As of launcher 1.1.19 the launcher-only options
    // (apiKey, apiSecret, verbose, tunnelVersion, timeout) are held back from
    // the jar by LAUNCHER_OPTIONS, and non-string values are stringified, so
    // the 1.1.18 traps that killed the tunnel with "Unrecognized option" are
    // gone. verbose stays off by default anyway: 1.1.19 redacts credentials
    // from its argv and output, but there is no reason for the addon to print
    // tunnel internals at all.
    const options: Record<string, unknown> = {
      tunnelIdentifier: this.#identifier,
      verbose: false,
    }

    if (credentials?.key) options.apiKey = credentials.key
    if (credentials?.secret) options.apiSecret = credentials.secret

    // A caller-supplied jar wins over the downloaded one, which is how we test
    // an unreleased tunnel build.
    const jarLocation = jarPath || (await launcher.downloadAsync(options))

    // No TMPDIR juggling any more: 1.1.19 gives every tunnel its own mkdtemp
    // ready directory (lib/tunnel-launcher.js:377) and removes it on teardown,
    // so concurrent starts no longer delete each other's readiness marker.
    return launcher.startTunnelAsync(options, jarLocation)
  }

  /** Only called once a tunnel is up, so the identifier and url are set. */
  #describe (): TunnelInfo {
    const tunnelIdentifier = this.#identifier
    const devServerUrl = this.#devServerUrl

    if (!tunnelIdentifier || !devServerUrl) {
      throw new TunnelError('TUNNEL_FAILED', 'Tunnel details were requested before the tunnel was started.')
    }

    return {
      tunnelIdentifier,
      devServerUrl,
      capability: {
        tunnelIdentifier,
        ...mergeLocalPortCapabilities([devServerUrl, ...this.#extraUrls]),
      },
    }
  }

  /**
   * Idempotent teardown that resolves only once the tunnel process is really
   * gone, so a caller can await it inside a signal handler and know the
   * customer's concurrency has been released.
   */
  async stop (): Promise<void> {
    if (this.#state === 'idle' || this.#state === 'closed') return
    if (this.#stopPromise) return this.#stopPromise

    this.#stopPromise = this.#doStop().finally(() => {
      this.#stopPromise = null
    })

    return this.#stopPromise
  }

  async #doStop (): Promise<void> {
    const tunnel = this.#tunnel
    this.#state = 'closing'

    if (!tunnel || tunnel.exitCode !== null || tunnel.signalCode !== null) {
      this.#finishStop()
      return
    }

    await new Promise<void>((resolve) => {
      const done = () => resolve()
      tunnel.once('exit', done)
      tunnel.once('close', done)

      try {
        if (tunnel.close) tunnel.close()
        else tunnel.kill('SIGINT')
      } catch {
        resolve()
      }

      // The tunnel normally deregisters within a second or two. If it does not,
      // stop waiting rather than hanging Storybook's own shutdown.
      setTimeout(() => {
        try {
          tunnel.kill('SIGKILL')
        } catch {}
        resolve()
      }, 10_000).unref?.()
    })

    this.#finishStop()
  }

  #finishStop (): void {
    this.#tunnel = null
    this.#state = 'closed'
    this.#unregisterTeardown()
  }

  /**
   * A tunnel that outlives Storybook keeps consuming a parallel session the
   * customer has paid for, so teardown is wired to every way this process can
   * end, not just the graceful one.
   */
  #registerTeardown (): void {
    if (this.#signalHandlers.length) return

    const onSignal = (signal: NodeJS.Signals) => async () => {
      try {
        await this.stop()
      } finally {
        process.removeListener(signal, handlerFor(signal))
        process.kill(process.pid, signal)
      }
    }

    const handlers = new Map<NodeJS.Signals, () => Promise<void>>()
    const handlerFor = (signal: NodeJS.Signals) => handlers.get(signal) as () => Promise<void>

    for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP'] as NodeJS.Signals[]) {
      const handler = onSignal(signal)
      handlers.set(signal, handler)
      process.once(signal, handler)
      this.#signalHandlers.push([signal, handler])
    }

    const onFatal = (error?: unknown) => {
      // Best effort: the process is going down anyway, and SIGINT to the child
      // is synchronous enough to land.
      try {
        this.#tunnel?.kill('SIGINT')
      } catch {}
      if (error) throw error
    }

    process.once('beforeExit', () => {
      this.stop().catch(() => {})
    })
    process.once('uncaughtException', onFatal)
    this.#signalHandlers.push(['uncaughtException', onFatal])
  }

  #unregisterTeardown (): void {
    for (const [event, handler] of this.#signalHandlers) {
      process.removeListener(event as NodeJS.Signals, handler)
    }
    this.#signalHandlers = []
  }
}

export { TunnelError }
