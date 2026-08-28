'use strict'

const { TB_EVENTS } = require('../constants.cjs')

/**
 * A single read-only handler so the scaffold has a real, end-to-end proven
 * bridge rather than one inferred from the presence of a meta tag.
 *
 * Deliberately reports nothing sensitive: no credentials, no account details.
 * The credential, project-config and run handlers are TB-255.
 */
function registerStatusHandlers (channel) {
  channel.on(TB_EVENTS.GET_STATUS, () => {
    channel.emit(TB_EVENTS.STATUS, {
      ready: true,
      addonVersion: require('../../package.json').version,
      node: process.versions.node,
    })
  })
}

module.exports = { registerStatusHandlers }
