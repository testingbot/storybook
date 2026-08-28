import { mergeLocalPortCapabilities } from './local-ports.js'
import type { TunnelInfo, TunnelProvider } from './types.js'

/**
 * A tunnel this process did not start and must not stop.
 *
 * In CI the tunnel is normally already up before the CLI runs, started by
 * testingbot/testingbot-tunnel-action, which runs the container with
 * --network=host and blocks until it reports ready. Starting a second one from
 * here would spend another parallel session from the customer's plan and would
 * simply fail once the account limit is reached. So the CLI takes the
 * identifier and reports the same capability the real manager would.
 *
 * stop() is deliberately a no-op. Whoever started the tunnel owns its lifetime,
 * and tearing down a tunnel that the rest of the job still needs would break
 * every step after this one.
 */
export class ExternalTunnel implements TunnelProvider {
  #identifier: string

  constructor (tunnelIdentifier: string) {
    this.#identifier = tunnelIdentifier
  }

  async ensureStarted (devServerUrl: string, { alsoProxy = [] }: { alsoProxy?: string[] } = {}): Promise<TunnelInfo> {
    return {
      tunnelIdentifier: this.#identifier,
      devServerUrl,
      capability: {
        tunnelIdentifier: this.#identifier,
        ...mergeLocalPortCapabilities([devServerUrl, ...alsoProxy]),
      },
    }
  }

  async stop (): Promise<void> {
    // See above. Not ours to close.
  }
}
