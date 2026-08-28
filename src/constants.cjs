'use strict'

/**
 * Identifiers and channel event names, loaded from constants.json.
 *
 * The JSON file is the single source of truth because this addon has two
 * runtimes: preset.cjs and the server handlers are CommonJS in Node, while the
 * manager bundle is ESM in the browser. JSON is the one format both can read
 * without a shim, so the event names cannot drift apart.
 *
 * Values are written out in full rather than composed from ADDON_ID, so that
 * grepping for an event name finds it.
 */

const constants = require('./constants.json')

module.exports = constants
