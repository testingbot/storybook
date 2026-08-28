'use strict'

const path = require('node:path')
const { pathToFileURL } = require('node:url')

/**
 * The bridge from the CommonJS half of this addon to the ESM half.
 *
 * Storybook loads presets with `require`, so everything under src/server is
 * CommonJS. The runner, the catalogue and the results store are ESM, because
 * they are also the public API of the package and are shared with the CLI in
 * TB-261. A dynamic import is the only way across, and it has to be lazy: these
 * modules pull in playwright-core, which costs about a second to load, and most
 * `storybook dev` sessions never run a test.
 *
 * The promise is cached rather than the module, so concurrent callers during
 * that first second share one import instead of racing.
 */

let runtime = null

function loadRuntime () {
  if (!runtime) {
    const entry = pathToFileURL(path.join(__dirname, '..', '..', 'dist', 'index.js')).href

    runtime = import(entry)
  }

  return runtime
}

/** Exposed for tests, which substitute a runtime rather than building dist. */
function setRuntime (next) {
  runtime = next === null ? null : Promise.resolve(next)
}

module.exports = { loadRuntime, setRuntime }
