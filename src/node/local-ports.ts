import type { LocalPortCapability } from './types.js'

/**
 * Port derivation for the localHttpPorts capability.
 *
 * TestingBot Tunnel proxies a fixed set of ports into the cloud VM without
 * being asked. The authoritative list is `exports.ports` in
 * vm/lib/tunnellocalproxies.js:12. Storybook's default port, 6006, is not in
 * it, so a tunnel on its own is not enough: the session starts and every
 * page.goto fails with a timeout that looks exactly like a broken tunnel.
 *
 * Verified in the example repo: a healthy tunnel without localHttpPorts failed
 * net::ERR_TIMED_OUT on 22 of 22 tests.
 */

/** Mirrors vm/lib/tunnellocalproxies.js:12 */
export const DEFAULT_TUNNEL_PORTS: number[] = [443, 80, 8080, 3030, 3000, 3001, 3400]

/**
 * Derives the tb:options fragment needed to reach `devServerUrl` through a
 * tunnel. Returns an empty object when the port is already proxied, so we never
 * ask for something the grid gives us anyway.
 *
 * Never hardcodes 6006: Storybook picks another port when 6006 is taken, and
 * that is the case TB-253 calls out.
 */
export function getLocalPortCapability (devServerUrl: string | null | undefined): LocalPortCapability {
  let url: URL

  try {
    url = new URL(devServerUrl as string)
  } catch {
    return {}
  }

  const isHttps = url.protocol === 'https:'

  if (!isHttps && url.protocol !== 'http:') {
    return {}
  }

  const port = Number(url.port || (isHttps ? 443 : 80))

  if (!Number.isInteger(port) || DEFAULT_TUNNEL_PORTS.includes(port)) {
    return {}
  }

  return isHttps ? { localHttpsPorts: [port] } : { localHttpPorts: [port] }
}

/**
 * Merges the port capability for several URLs.
 *
 * Device targets can open a different URL from desktop targets (see
 * device-url.ts), and a tunnel is asked for its proxied ports once, not once
 * per target, so the two have to be combined before the tunnel starts.
 */
export function mergeLocalPortCapabilities (urls: (string | null | undefined)[]): LocalPortCapability {
  const http = new Set<number>()
  const https = new Set<number>()

  for (const url of urls) {
    const capability = getLocalPortCapability(url)

    for (const port of capability.localHttpPorts ?? []) http.add(port)
    for (const port of capability.localHttpsPorts ?? []) https.add(port)
  }

  return {
    ...(http.size ? { localHttpPorts: [...http].sort((a, b) => a - b) } : {}),
    ...(https.size ? { localHttpsPorts: [...https].sort((a, b) => a - b) } : {}),
  }
}
