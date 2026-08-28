'use strict'

const path = require('node:path')
const { pathToFileURL } = require('node:url')

const { TB_EVENTS } = require('../constants.cjs')
const { resolveCredentials } = require('./credentials.cjs')
const { readConfig, normaliseConfig } = require('./projectConfig.cjs')
const { getDevServerUrl } = require('./devServer.cjs')
const { resolveDeviceTarget } = require('./devices.cjs')

/**
 * The run trigger.
 *
 * Two things guard it, and neither is optional:
 *
 *  1. The nonce, applied one level up in channelAuth.cjs. Without it any page
 *     the developer visits could reach this handler.
 *  2. The in-flight lock below. Every run consumes grid minutes and a parallel
 *     session, so a double-click or a repeated event must not start a second
 *     one. This is the same exposure @percy/storybook@10.0.2 flags as CWE-362
 *     in its snapshots.cjs.
 *
 * The lock is a plain boolean because the check and the set happen in the same
 * synchronous block, with no await between them. On Node's single-threaded
 * event loop that is genuinely race-free; a promise-based lock would not be
 * more correct, only harder to read.
 */

let inFlight = false
let currentRun = null

/**
 * The grid runner lives in the ESM half of the package, because it is shared
 * with the CLI in TB-261 and with anyone importing the package directly. This
 * file is CommonJS, so it reaches it through a dynamic import, and does so
 * lazily: requiring playwright-core at preset load time would add a second or
 * so to every `storybook dev` startup for a feature most sessions never use.
 *
 * The seam is still here, and the tests still drive the guard with a runner
 * they control.
 */
let runner = null

async function defaultRunner (args) {
  const entry = pathToFileURL(path.join(__dirname, '..', '..', 'dist', 'index.js')).href
  const { runOnGrid } = await import(entry)

  return runOnGrid(args)
}

function setRunner (nextRunner) {
  runner = nextRunner
}

function isRunning () {
  return inFlight
}

/** Exposed for tests, which must not leak lock state between cases. */
function resetRunState () {
  inFlight = false
  currentRun = null
}

function registerRunHandlers (channel, addonOptions) {
  channel.on(TB_EVENTS.RUN, async (payload = {}) => {
    if (inFlight) {
      // Refused, explicitly and visibly. Never queued: a developer who clicks
      // twice should be told the first run is still going, not silently billed
      // for a second one a minute later.
      channel.emit(TB_EVENTS.RUN_ERROR, {
        code: 'ALREADY_RUNNING',
        message:
          'A TestingBot run is already in progress. Wait for it to finish, or cancel it, ' +
          'before starting another.',
      })
      return
    }

    const credentials = resolveCredentials()
    if (!credentials) {
      channel.emit(TB_EVENTS.RUN_ERROR, {
        code: 'NO_CREDENTIALS',
        message:
          'No TestingBot credentials found. Add them in this panel, set TB_KEY and TB_SECRET, ' +
          'or create a ~/.testingbot file.',
      })
      return
    }

    const { config: fileConfig, error: configError } = readConfig(addonOptions)
    if (configError) {
      channel.emit(TB_EVENTS.RUN_ERROR, { code: 'BAD_CONFIG', message: configError })
      return
    }

    const config = withSelection(fileConfig, payload)

    const devServerUrl = getDevServerUrl(addonOptions)
    if (!devServerUrl) {
      channel.emit(TB_EVENTS.RUN_ERROR, {
        code: 'NO_DEV_SERVER',
        message:
          'Could not work out where Storybook is serving. This addon needs a running ' +
          '`storybook dev`; for a static build, use the CLI instead.',
      })
      return
    }

    // Claim the lock before the first await. Everything above this line is
    // synchronous, so no second event can slip in between the check and here.
    inFlight = true
    const controller = new AbortController()
    currentRun = controller

    /**
     * Where real devices should point, resolved once per run.
     *
     * Null is a legitimate answer, not a failure: it means no URL on this
     * machine is reachable from a device, and the runner skips device targets
     * and says so rather than burning a device session on a URL that cannot
     * resolve. See src/node/device-url.ts.
     */
    let deviceUrl = null

    if (config.devices.length > 0) {
      try {
        const target = await resolveDeviceTarget(addonOptions)

        deviceUrl = target.reachable ? target.url : null
      } catch {
        deviceUrl = null
      }
    }

    channel.emit(TB_EVENTS.RUN_STARTED, {
      scope: payload.scope || 'all',
      storyId: payload.storyId || null,
      browsers: config.browsers.length,
      devices: config.devices.length,
    })

    try {
      const result = await (runner || defaultRunner)({
        // Credentials are passed to the runner in-process. They are never put
        // on the channel, so they cannot reach the manager or devtools.
        credentials,
        config,
        devServerUrl,
        deviceUrl,
        scope: payload.scope || 'all',
        storyId: payload.storyId || null,
        signal: controller.signal,
        onProgress: (progress) => channel.emit(TB_EVENTS.RUN_PROGRESS, progress),
      })

      channel.emit(TB_EVENTS.RUN_FINISHED, result || { ok: true })
    } catch (error) {
      if (controller.signal.aborted) {
        channel.emit(TB_EVENTS.RUN_FINISHED, { ok: false, cancelled: true })
      } else {
        channel.emit(TB_EVENTS.RUN_ERROR, {
          code: error.code || 'RUN_FAILED',
          message: error.message || String(error),
        })
      }
    } finally {
      // Released in a finally so a thrown runner cannot wedge the addon into a
      // state where every later run is refused as "already running".
      inFlight = false
      currentRun = null
    }
  })

  channel.on(TB_EVENTS.CANCEL, () => {
    if (!currentRun) {
      channel.emit(TB_EVENTS.RUN_ERROR, {
        code: 'NOT_RUNNING',
        message: 'There is no TestingBot run to cancel.',
      })
      return
    }

    currentRun.abort()
  })
}

/**
 * Applies a one-off browser and device selection from the picker.
 *
 * TB-257 asks that a developer be able to pick two browsers and run without
 * touching a config file, so the selection travels with the run rather than
 * being written to .testingbot.json first. Nothing is persisted: the file stays
 * the project's committed default, and Save in the panel remains the deliberate
 * act that changes it.
 *
 * The selection goes through normaliseConfig, which is the same function the
 * file goes through. That is not a formality. It strips the reserved
 * capabilities, so a forged event carrying `key` and `secret` cannot redirect a
 * run to another account.
 */
function withSelection (config, payload) {
  const hasBrowsers = Array.isArray(payload.browsers) && payload.browsers.length > 0
  const hasDevices = Array.isArray(payload.devices)

  if (!hasBrowsers && !hasDevices) return config

  return normaliseConfig({
    ...config,
    browsers: hasBrowsers ? payload.browsers : config.browsers,
    devices: hasDevices ? payload.devices : config.devices,
  }).config
}

module.exports = { registerRunHandlers, setRunner, isRunning, resetRunState }
