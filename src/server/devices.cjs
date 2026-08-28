'use strict'

const { TB_EVENTS } = require('../constants.cjs')
const { getNetworkAddress } = require('./devServer.cjs')
const { loadRuntime } = require('./esm.cjs')
const { readConfig } = require('./projectConfig.cjs')

/**
 * Whether real devices can reach this Storybook at all, and where they should
 * point if they can.
 *
 * TB-260 requires the answer before the UI is drawn, not after a run has been
 * paid for: device options must be hidden or clearly disabled when the current
 * Storybook is unreachable from a device, with an explanation. So this is a
 * channel query the panel makes on mount, exactly like the credentials check.
 *
 * The decision itself lives in src/node/device-url.ts, because the runner and
 * the CLI need the same answer and neither of them can call into this file.
 */

async function resolveDeviceTarget (addonOptions) {
  const { resolveDeviceUrl } = await loadRuntime()
  const { config } = readConfig(addonOptions)

  return resolveDeviceUrl({
    configuredUrl: typeof config.deviceUrl === 'string' ? config.deviceUrl : null,
    networkAddress: getNetworkAddress(addonOptions),
  })
}

function registerDeviceHandlers (channel, addonOptions) {
  channel.on(TB_EVENTS.GET_DEVICE_TARGET, async () => {
    try {
      const target = await resolveDeviceTarget(addonOptions)

      channel.emit(TB_EVENTS.DEVICE_TARGET_LOADED, { ...target, error: null })
    } catch (error) {
      // A failure to work this out is not a reason to break the panel, but it
      // is a reason to keep devices switched off: offering them here would sell
      // a session that cannot load a single story.
      channel.emit(TB_EVENTS.DEVICE_TARGET_LOADED, {
        reachable: false,
        url: null,
        reason: `Could not work out whether a device can reach this Storybook: ${error.message}`,
        error: null,
      })
    }
  })
}

module.exports = { registerDeviceHandlers, resolveDeviceTarget }
