'use strict'

const { TB_EVENTS } = require('../constants.cjs')
const { loadRuntime } = require('./esm.cjs')

/**
 * Serves the browser and device picker its options.
 *
 * Cached for the life of the Storybook process. The list is roughly 5,300
 * entries on the wire and changes at the pace TestingBot adds browsers, which
 * is not the pace a developer opens a panel. Re-fetching on every panel mount
 * would put a network round trip in front of the UI for no gain.
 *
 * A failure is cached only as a failure to *this* attempt: the next request
 * retries, so a laptop that was offline when the panel first opened recovers
 * without restarting Storybook.
 */

let cached = null
let inFlight = null

function resetCatalogueCache () {
  cached = null
  inFlight = null
}

async function getCatalogue () {
  if (cached) return cached
  if (inFlight) return inFlight

  inFlight = (async () => {
    const { fetchCatalogue } = await loadRuntime()
    const catalogue = await fetchCatalogue()

    cached = catalogue
    return catalogue
  })()

  try {
    return await inFlight
  } finally {
    inFlight = null
  }
}

function registerCatalogueHandlers (channel) {
  channel.on(TB_EVENTS.GET_CATALOGUE, async () => {
    try {
      const catalogue = await getCatalogue()

      channel.emit(TB_EVENTS.CATALOGUE_LOADED, { catalogue, error: null })
    } catch (error) {
      // The picker degrades to whatever is already in .testingbot.json rather
      // than disappearing, so this is a message, not a dead panel.
      channel.emit(TB_EVENTS.CATALOGUE_LOADED, {
        catalogue: null,
        error:
          `Could not load the TestingBot browser list: ${error.message} ` +
          'You can still run against the browsers already in your config.',
      })
    }
  })
}

module.exports = { registerCatalogueHandlers, getCatalogue, resetCatalogueCache }
