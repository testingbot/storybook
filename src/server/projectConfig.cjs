'use strict'

const fs = require('node:fs')
const path = require('node:path')

const { TB_EVENTS, CONFIG_FILE } = require('../constants.cjs')

/**
 * Project configuration: which browsers and devices to run against, which
 * stories to include, and how much pixel difference to tolerate.
 *
 * Two sources, because there are two consumers:
 *
 *   - `.testingbot.json` in the project root. Committable, reviewable, and the
 *     file the CLI in TB-261 reads. This is the base.
 *   - addon options in `.storybook/main.js`, which is Storybook's own
 *     convention and is passed straight to the preset. These override the file,
 *     so a project that never uses the CLI can keep everything in main.js.
 *
 * On keys we do not recognise: they are preserved, not dropped. The addon does
 * not own this file. TestingBot supports many documented `tb:options`
 * capabilities that matter for visual testing but that this addon has no
 * opinion about, and silently deleting a user's `timeZone` the next time they
 * press Save in the panel would be a nasty surprise. @percy/storybook takes the
 * same approach with `.percy.yml`: it rewrites only the `project:` block it
 * owns and leaves the rest of the file untouched.
 */

/**
 * Capabilities the addon computes and must therefore own. Config cannot set
 * these, because doing so would either break the run or point it at another
 * account or tunnel.
 *
 * This is deliberately a denylist rather than an allowlist. The addon only
 * needs to protect what it controls; everything else is the user's business,
 * and an allowlist would mean a new TestingBot capability is unusable until
 * this addon is updated.
 */
const RESERVED_CAPABILITIES = new Set([
  'key',
  'secret',
  'tunnelIdentifier',
  'localHttpPorts',
  'localHttpsPorts',
])

/**
 * Bounds for a viewport width. Narrower than a small phone or wider than any
 * monitor is a typo, and a typo here is expensive: every width multiplies the
 * whole run. Mirrored by MIN_WIDTH and MAX_WIDTH in src/node/targets.ts, which
 * is the last guard for a config that never came through this function.
 */
const MIN_WIDTH = 200
const MAX_WIDTH = 4096

const DEFAULT_CONFIG = {
  browsers: [{ browserName: 'chrome', browserVersion: 'latest', platform: 'WIN10' }],
  devices: [],
  include: [],
  exclude: [],
  /**
   * Deliberately tight, because the addon screenshots the story element rather
   * than the whole page and the denominator is therefore the component.
   *
   * Measured against the grid on 2026-08-26: two consecutive runs of 15 stories
   * on two browsers produced zero differing pixels in all 30 comparisons, so
   * run-to-run noise is not what this number absorbs. It exists for browser
   * version drift. A looser 0.02 was tried first and swallowed a CSS change
   * that visibly altered every button on the page.
   */
  maxDiffPixelRatio: 0.001,
  /**
   * Local comparison by default. Hosted mode delegates to TestingBot's visual
   * service and is opt-in, because it changes where baselines live: local ones
   * are files in the repository and show up in a pull request, hosted ones do
   * not. That is a decision for the project, not a default.
   */
  visual: 'local',
  /**
   * Docs pages are not captured unless asked for. Every captured page is a
   * paid grid session, and a docs page is mostly a composition of stories that
   * are already covered individually, so this catches regressions in the docs
   * template rather than in the components. Opt in, per TB-357.
   */
  captureDocs: false,
  captureAutodocs: false,
}

/**
 * Widths are normalised to a sorted, deduplicated list of whole numbers, and
 * omitted entirely when nothing usable is left.
 *
 * Omitted, not defaulted. An absent `widths` means one capture at the
 * configured viewport and baseline keys with no width in them, which is what
 * every project that predates this option already has on disk. Writing a
 * default here would rename all of them.
 */
function normaliseWidths (value) {
  if (!Array.isArray(value)) return null

  const usable = value
    .map(Number)
    .filter((width) => Number.isFinite(width) && width >= MIN_WIDTH && width <= MAX_WIDTH)
    .map(Math.round)

  const unique = [...new Set(usable)].sort((a, b) => a - b)

  return unique.length > 0 ? unique : null
}

function getConfigPath () {
  return path.join(process.cwd(), CONFIG_FILE)
}

function isPlainObject (value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Strip only the capabilities the addon owns, and report what was removed so
 * the caller can tell the user rather than silently ignoring it.
 */
function stripReserved (entry, removed) {
  const clean = {}

  for (const [key, value] of Object.entries(entry)) {
    if (RESERVED_CAPABILITIES.has(key)) {
      removed.push(key)
      continue
    }
    clean[key] = value
  }

  return clean
}

function normaliseBrowser (entry, removed) {
  const { browserName, browserVersion, platform, ...rest } = stripReserved(entry, removed)

  return {
    browserName: String(browserName || 'chrome'),
    browserVersion: String(browserVersion || 'latest'),
    platform: String(platform || 'WIN10'),
    // Everything else is passed through to tb:options untouched: build, name,
    // timeZone, geoCountryCode, screenResolution, recordLogs and so on.
    ...rest,
  }
}

function normaliseDevice (entry, removed) {
  const { deviceName, platformName, platformVersion, ...rest } = stripReserved(entry, removed)

  return {
    deviceName: String(deviceName || ''),
    platformName: String(platformName || ''),
    platformVersion: String(platformVersion || ''),
    realDevice: true,
    ...rest,
  }
}

/**
 * Normalise a config into something we are willing to act on, without
 * discarding anything the user meant to keep.
 *
 * Returns the config plus a list of reserved capabilities that were removed, so
 * the UI can say "the addon sets tunnelIdentifier itself" instead of appearing
 * to ignore the setting.
 */
function normaliseConfig (raw) {
  const removed = []

  if (!isPlainObject(raw)) {
    return { config: { ...DEFAULT_CONFIG }, removed }
  }

  const {
    browsers,
    devices,
    include,
    exclude,
    maxDiffPixelRatio,
    visual,
    widths,
    captureDocs,
    captureAutodocs,
    ...unknown
  } = raw

  const normalisedBrowsers = (Array.isArray(browsers) ? browsers : [])
    .filter(isPlainObject)
    .map((entry) => normaliseBrowser(entry, removed))

  const normalisedDevices = (Array.isArray(devices) ? devices : [])
    .filter(isPlainObject)
    .map((entry) => normaliseDevice(entry, removed))
    .filter((entry) => entry.deviceName && entry.platformName)

  const ratio = Number(maxDiffPixelRatio)
  const normalisedWidths = normaliseWidths(widths)

  return {
    config: {
      browsers: normalisedBrowsers.length ? normalisedBrowsers : [...DEFAULT_CONFIG.browsers],
      devices: normalisedDevices,
      include: (Array.isArray(include) ? include : []).map(String),
      exclude: (Array.isArray(exclude) ? exclude : []).map(String),
      maxDiffPixelRatio:
        Number.isFinite(ratio) && ratio >= 0 && ratio <= 1
          ? ratio
          : DEFAULT_CONFIG.maxDiffPixelRatio,
      // Validated rather than carried through, because an unrecognised value
      // here decides whether anything is compared locally at all. A typo must
      // fall back to the safe mode, not to no comparison.
      visual: visual === 'hosted' ? 'hosted' : 'local',
      // Only when there is something to say. See normaliseWidths.
      ...(normalisedWidths ? { widths: normalisedWidths } : {}),
      // Strictly true, never truthy. "captureDocs": "no" is a mistake that must
      // not read as yes and bill for every docs page in the project.
      captureDocs: captureDocs === true,
      captureAutodocs: captureAutodocs === true,
      // Keys this addon has no opinion about are carried through untouched, so
      // a Save from the panel never destroys something a human put here.
      ...unknown,
    },
    removed,
  }
}

/**
 * Addon options from .storybook/main.js override the file. Storybook passes
 * these to the preset hooks, so they arrive without any extra plumbing.
 */
function mergeOptions (fileConfig, addonOptions) {
  if (!isPlainObject(addonOptions)) return fileConfig

  // Storybook's own keys arrive in the same object as the addon's options, so
  // only the config-shaped ones are taken.
  const relevant = {}
  for (const key of [
    'browsers',
    'devices',
    'include',
    'exclude',
    'maxDiffPixelRatio',
    'deviceUrl',
    'visual',
    'hostedVisual',
    'widths',
    'captureDocs',
    'captureAutodocs',
  ]) {
    if (key in addonOptions) relevant[key] = addonOptions[key]
  }

  if (Object.keys(relevant).length === 0) return fileConfig

  const merged = normaliseConfig({ ...fileConfig, ...relevant }).config

  // A malformed override must not quietly cost the user their working file
  // config. normaliseConfig falls back to DEFAULT_CONFIG.browsers when an
  // override contains no usable entries, which would silently discard whatever
  // the file had. Keep the file's value in that case.
  if ('browsers' in relevant && merged.browsers === undefined) {
    merged.browsers = fileConfig.browsers
  }

  const overrodeBrowsersWithNothing =
    'browsers' in relevant &&
    (!Array.isArray(relevant.browsers) || relevant.browsers.filter(isPlainObject).length === 0)

  if (overrodeBrowsersWithNothing && Array.isArray(fileConfig.browsers)) {
    merged.browsers = fileConfig.browsers
  }

  return merged
}

function readConfig (addonOptions) {
  const configPath = getConfigPath()

  if (!fs.existsSync(configPath)) {
    return { config: mergeOptions({ ...DEFAULT_CONFIG }, addonOptions), exists: false, removed: [] }
  }

  try {
    const parsed = JSON.parse(fs.readFileSync(configPath, 'utf8'))
    const { config, removed } = normaliseConfig(parsed)
    return { config: mergeOptions(config, addonOptions), exists: true, removed }
  } catch (error) {
    // A malformed file must not take Storybook down, and must not silently look
    // like "no configuration" either.
    return {
      config: { ...DEFAULT_CONFIG },
      exists: true,
      removed: [],
      error: `${CONFIG_FILE} could not be parsed: ${error.message}`,
    }
  }
}

function writeConfig (raw) {
  const { config, removed } = normaliseConfig(raw)
  fs.writeFileSync(getConfigPath(), `${JSON.stringify(config, null, 2)}\n`, 'utf8')
  return { config, removed }
}

function registerProjectConfigHandlers (channel, addonOptions) {
  channel.on(TB_EVENTS.GET_CONFIG, () => {
    const { config, exists, error, removed } = readConfig(addonOptions)
    channel.emit(TB_EVENTS.CONFIG_LOADED, {
      config,
      exists,
      removed,
      error: error || null,
      path: CONFIG_FILE,
    })
  })

  channel.on(TB_EVENTS.SAVE_CONFIG, ({ config } = {}) => {
    try {
      const saved = writeConfig(config)
      channel.emit(TB_EVENTS.CONFIG_SAVED, {
        success: true,
        config: saved.config,
        removed: saved.removed,
      })
    } catch (error) {
      channel.emit(TB_EVENTS.CONFIG_SAVED, {
        success: false,
        error: `Could not write ${CONFIG_FILE}: ${error.message}`,
      })
    }
  })
}

module.exports = {
  DEFAULT_CONFIG,
  RESERVED_CAPABILITIES,
  getConfigPath,
  normaliseConfig,
  normaliseWidths,
  mergeOptions,
  readConfig,
  writeConfig,
  registerProjectConfigHandlers,
}
