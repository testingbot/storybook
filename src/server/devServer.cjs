'use strict'

/**
 * Where Storybook is actually serving.
 *
 * Storybook hands the preset an options bag; `localAddress` is the URL it
 * prints on startup and already reflects the port it settled on, which is not
 * always the one that was asked for. Reading it rather than assuming 6006 is
 * the whole reason TB-253 exists: the tunnel has to be told about the real
 * port, and a hardcoded default silently produces a session that cannot reach
 * anything.
 *
 * Verified against storybook@10.5.10: options carries localAddress
 * ("http://localhost:6017/"), networkAddress and port.
 */

function getDevServerUrl (options) {
  if (!options || typeof options !== 'object') return null

  const address = options.localAddress

  if (typeof address === 'string' && address) {
    return address.replace(/\/$/, '')
  }

  const port = Number(options.port)

  if (Number.isInteger(port) && port > 0) {
    return `http://localhost:${port}`
  }

  return null
}

/**
 * The address Storybook prints as "On your network", which is
 * `http://<first non-internal IPv4>:<port>/`.
 *
 * This is the only URL in the options bag a real device could ever open, and
 * TB-260 turns on it. See src/node/device-url.ts for why, and for the cases
 * where it is not usable either.
 */
function getNetworkAddress (options) {
  if (!options || typeof options !== 'object') return null

  const address = options.networkAddress

  return typeof address === 'string' && address ? address : null
}

module.exports = { getDevServerUrl, getNetworkAddress }
