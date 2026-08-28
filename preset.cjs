'use strict'

const { getOrCreateNonce, guardChannel } = require('./src/server/channelAuth.cjs')
const { registerStatusHandlers } = require('./src/server/status.cjs')
const { registerCredentialHandlers } = require('./src/server/credentials.cjs')
const { registerProjectConfigHandlers } = require('./src/server/projectConfig.cjs')
const { registerRunHandlers } = require('./src/server/run.cjs')
const { registerCatalogueHandlers } = require('./src/server/catalogue.cjs')
const { registerResultsHandlers } = require('./src/server/results.cjs')
const { registerDeviceHandlers } = require('./src/server/devices.cjs')
const { CHANNEL_AUTH } = require('./src/constants.cjs')

/**
 * TestingBot Storybook addon, preset (CommonJS).
 *
 * Layout mirrors @percy/storybook@10.0.2, which is the proven shape for this
 * kind of addon: a CommonJS preset at the package root that registers the
 * manager bundle and bridges the manager UI to Node.
 *
 * Verified against storybook@10.5.10. `experimental_serverChannel` is
 * experimental by name and is applied at storybook/dist/core-server/index.js
 * :11984. Re-verify on every Storybook major; test/surface.test.js fails loudly
 * if the export disappears.
 */

// One nonce per Storybook process. Injected into the legitimate manager
// document via managerHead, and required on every state-mutating channel event
// via guardChannel, so a cross-origin page cannot forge a billable run.
const CHANNEL_NONCE = getOrCreateNonce()

/**
 * Storybook 10 already loads the manager bundle by itself, from the "./manager"
 * entry in this package's exports map. Adding it here as well registers the
 * addon twice and Storybook warns "was loaded twice, this could have bad
 * side-effects": two panels, two channel subscriptions, and two runs per click.
 *
 * Verified empirically against storybook@10.5.10: with this hook returning the
 * list unchanged, the manager bundle is still served and the panel still
 * registers, exactly once.
 *
 * Worth knowing: @percy/storybook@10.0.2 does append here on top of its own
 * "./manager" export, and does double-register on Storybook 10. That is a bug
 * we are deliberately not copying, most likely a leftover from Storybook 8,
 * which its peer range still allows.
 *
 * The hook is kept because it is the documented registration point: if a future
 * Storybook stops auto-loading "./manager", this is where it goes back.
 */
function managerEntries (entry = []) {
  return [...entry]
}

const experimental_serverChannel = async function serverChannel (channel, options) {
  // Every handler is registered through the guarded wrapper, so none of them
  // can be reached without the per-process nonce.
  const guarded = guardChannel(channel, CHANNEL_NONCE)

  registerStatusHandlers(guarded)
  registerCredentialHandlers(guarded)
  // Storybook merges addon options from .storybook/main.js into the options it
  // passes here, so config set that way needs no extra plumbing.
  registerProjectConfigHandlers(guarded, options)
  registerRunHandlers(guarded, options)
  registerCatalogueHandlers(guarded)
  registerResultsHandlers(guarded)
  registerDeviceHandlers(guarded, options)

  // Storybook presets use a reducer pattern: each preset's hook receives the
  // accumulated value and must return it. Returning undefined here breaks the
  // channel for every other addon, not just this one.
  return channel
}

function managerHead (head = '') {
  return `${head}\n<meta name="${CHANNEL_AUTH.META_NAME}" content="${CHANNEL_NONCE}">`
}

module.exports = { managerEntries, experimental_serverChannel, managerHead }
