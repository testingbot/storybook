import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'

import { resolveWidths, variantsFor, toTargets, DEFAULT_VIEWPORT } from '../dist/index.js'

const require = createRequire(import.meta.url)
const { normaliseConfig, normaliseWidths } = require('../src/server/projectConfig.cjs')

/**
 * TB-354. Widths are a multiplier on the whole run and a rename of every
 * baseline folder they touch, so the two things worth pinning down are what
 * they do when present and what they leave alone when absent.
 */

const BROWSER = { browserName: 'chrome', browserVersion: 'latest', platform: 'WIN11' }
const DEVICE = { deviceName: 'iPhone 17', platformName: 'iOS', platformVersion: '26.0' }

function browserTarget (config = {}) {
  return toTargets({ browsers: [BROWSER], devices: [], ...config })[0]
}

test('no widths means one capture and the key a project already has on disk', () => {
  const config = { browsers: [BROWSER], devices: [] }
  const variants = variantsFor(browserTarget(), config)

  assert.equal(resolveWidths(config), null)
  assert.equal(variants.length, 1)
  // The whole point of the null case. Any suffix here orphans every baseline
  // written before this feature existed.
  assert.equal(variants[0].key, 'chrome_latest_win11')
  assert.deepEqual(variants[0].viewport, DEFAULT_VIEWPORT)
})

test('an empty or unusable widths list is the same as no widths at all', () => {
  for (const widths of [[], ['wide'], [0], [99999], [null]]) {
    const config = { browsers: [BROWSER], devices: [], widths }

    assert.equal(resolveWidths(config), null, `${JSON.stringify(widths)} should resolve to null`)
    assert.equal(variantsFor(browserTarget(), config)[0].key, 'chrome_latest_win11')
  }
})

test('each width is its own baseline folder, its own label and its own viewport', () => {
  const config = { browsers: [BROWSER], devices: [], widths: [1280, 375] }
  const variants = variantsFor(browserTarget(), config)

  assert.deepEqual(variants.map((v) => v.key), [
    'chrome_latest_win11_375',
    'chrome_latest_win11_1280',
  ])
  assert.deepEqual(variants.map((v) => v.label), [
    'chrome latest on WIN11 at 375px',
    'chrome latest on WIN11 at 1280px',
  ])
  assert.deepEqual(variants.map((v) => v.viewport), [
    { width: 375, height: DEFAULT_VIEWPORT.height },
    { width: 1280, height: DEFAULT_VIEWPORT.height },
  ])
})

test('widths are sorted and deduplicated, so the same set always writes the same keys', () => {
  // Otherwise reordering the array in the config file would look like a
  // different run, and a duplicate would capture the same width twice and bill
  // for it.
  assert.deepEqual(resolveWidths({ widths: [1280, 375, 1280, 375.4] }), [375, 1280])
})

test('the configured viewport supplies the height, and only the height', () => {
  const config = {
    browsers: [BROWSER],
    devices: [],
    viewport: { width: 1600, height: 900 },
    widths: [375],
  }
  const [variant] = variantsFor(browserTarget(), config)

  assert.deepEqual(variant.viewport, { width: 375, height: 900 })
})

test('a real device ignores widths and keeps the key it already had', () => {
  const target = toTargets({ browsers: [], devices: [DEVICE] }).at(-1)
  const variants = variantsFor(target, { browsers: [], devices: [DEVICE], widths: [375, 1280] })

  assert.equal(variants.length, 1, 'a phone has the screen it has')
  assert.equal(variants[0].key, 'iphone-17_ios_26.0')
  assert.equal(variants[0].viewport, null, 'null means do not touch the screen')
})

test('the config layer keeps widths only when something usable is left', () => {
  assert.deepEqual(normaliseWidths([1280, 375, 375, 'x', 10, '800']), [375, 800, 1280])
  assert.equal(normaliseWidths([]), null)
  assert.equal(normaliseWidths('375'), null)

  // Absent, not defaulted. A key that appears in .testingbot.json after a Save
  // would change the baseline names of a project that never asked for it.
  assert.equal('widths' in normaliseConfig({}).config, false)
  assert.equal('widths' in normaliseConfig({ widths: [] }).config, false)
  assert.deepEqual(normaliseConfig({ widths: [1280, 375] }).config.widths, [375, 1280])
})
