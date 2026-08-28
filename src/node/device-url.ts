/**
 * Which URL a real device can actually open.
 *
 * TB-260's blocker, and it is not a small one: mobile simulators, emulators and
 * physical devices cannot resolve the literal hostname `localhost`
 * (web/app/views/support/tunnel/faq.html.erb, "Can I use localhost with the
 * tunnel?"). The tunnel does not fix this. Every desktop target in this addon
 * uses Storybook's `localAddress`, which is exactly the URL a device cannot
 * use, so devices need a different one.
 *
 * The documented workaround is an /etc/hosts entry plus a made-up hostname.
 * That is not something a Storybook panel can ask a developer to do, and TB-260
 * says so explicitly.
 *
 * What is used instead: Storybook's own `networkAddress`, which is
 * `http://<first non-internal IPv4>:<port>/` (core-server/utils/server-address.ts,
 * `getServerAddresses`). Three reasons this is the right answer and not a
 * workaround dressed up as one:
 *
 *  1. An IP address is not a hostname, so nothing has to resolve it. The
 *     restriction in the FAQ is specifically about resolving `localhost`.
 *  2. Storybook already binds to every interface. `app.listen({ port, host })`
 *     is called with `host` undefined unless the developer passed `--host`.
 *  3. Storybook's own host-validation middleware allowlists exactly two hosts,
 *     the `localAddress` host and the `networkAddress` host, so requests
 *     arriving with this Host header are accepted rather than rejected as a
 *     DNS-rebinding attempt.
 *
 * The tunnel then proxies from the developer's machine, which trivially reaches
 * its own LAN address.
 *
 * Two cases have no answer, and both are reported rather than papered over:
 * a machine with no non-internal IPv4 (Storybook falls back to `0.0.0.0`), and
 * a developer who ran `storybook dev --host localhost`. In both, device targets
 * are disabled in the panel with the reason shown. A `deviceUrl` in the config
 * overrides everything, which is the escape hatch for a published Storybook.
 */

export type DeviceReachability =
  | { reachable: true; url: string; source: 'config' | 'network' }
  | { reachable: false; url: null; reason: string }

const HOSTS_HINT =
  'You can also set "deviceUrl" in .testingbot.json to a Storybook a device can open, ' +
  'such as a published static build.'

function isUsableHost (host: string): boolean {
  if (!host) return false

  const lower = host.toLowerCase()

  // The one hostname the FAQ rules out, plus the addresses that mean "no
  // interface" or "this device itself" and would send the request nowhere.
  if (lower === 'localhost' || lower.endsWith('.localhost')) return false
  if (lower === '0.0.0.0' || lower === '::' || lower === '[::]') return false
  if (lower === '127.0.0.1' || lower.startsWith('127.')) return false
  if (lower === '::1' || lower === '[::1]') return false

  return true
}

function normalise (url: string): string {
  return url.replace(/\/$/, '')
}

/**
 * Decides the URL device targets should open.
 *
 * `configuredUrl` wins unconditionally. It is the developer stating where their
 * Storybook is, and they know things this function cannot, such as whether a
 * staging host is up.
 */
export function resolveDeviceUrl ({
  configuredUrl = null,
  networkAddress = null,
}: {
  configuredUrl?: string | null
  networkAddress?: string | null
}): DeviceReachability {
  if (typeof configuredUrl === 'string' && configuredUrl.trim()) {
    return { reachable: true, url: normalise(configuredUrl.trim()), source: 'config' }
  }

  if (typeof networkAddress !== 'string' || !networkAddress) {
    return {
      reachable: false,
      url: null,
      reason:
        'Storybook did not report a network address, so there is no URL a real device could open. ' +
        HOSTS_HINT,
    }
  }

  let parsed: URL

  try {
    parsed = new URL(networkAddress)
  } catch {
    return {
      reachable: false,
      url: null,
      reason: `Storybook reported "${networkAddress}" as its network address, which is not a URL. ${HOSTS_HINT}`,
    }
  }

  if (!isUsableHost(parsed.hostname)) {
    return {
      reachable: false,
      url: null,
      reason:
        `Storybook is only serving on ${parsed.hostname}, which a real device cannot reach. ` +
        'Real devices cannot resolve "localhost", and a loopback address points at the device itself. ' +
        'Start Storybook without --host so it also listens on your machine\'s network address. ' +
        HOSTS_HINT,
    }
  }

  // Search params are dropped: Storybook puts ?path= on the network address
  // when an initial path was requested, and that is a manager concern.
  return { reachable: true, url: normalise(`${parsed.protocol}//${parsed.host}${parsed.pathname}`), source: 'network' }
}

/** Which driver a device target needs. See webdriver.ts for why iOS is separate. */
export function deviceDriverFor (spec: { platformName?: unknown }): 'playwright' | 'webdriver' {
  return String(spec.platformName ?? '').toLowerCase() === 'ios' ? 'webdriver' : 'playwright'
}
