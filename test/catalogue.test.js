import { test, afterEach } from 'node:test'
import { createRequire } from 'node:module'
import assert from 'node:assert/strict'

import { toCatalogue, VERSION_ALIASES } from '../dist/index.js'

/**
 * TB-257, the picker's data. Everything here is pure: the shape below is copied
 * from real responses of https://api.testingbot.com/v1/browsers, which is what
 * makes these assertions worth anything.
 */

const RAW = [
  { selenium_name: 'chrome', name: 'googlechrome', platform: 'WIN11', browser_id: 1, version: '150' },
  { selenium_name: 'chrome', name: 'googlechrome', platform: 'WIN11', browser_id: 2, version: '99' },
  { selenium_name: 'chrome', name: 'googlechrome', platform: 'WIN11', browser_id: 3, version: '100' },
  { selenium_name: 'MicrosoftEdge', name: 'microsoftedge', platform: 'WIN10', browser_id: 4, version: '149' },
  { selenium_name: 'FF82', name: 'firefox', platform: 'WIN8_1', browser_id: 5, version: '82', long_version: '82.0' },
  { selenium_name: 'safari', name: 'safari', platform: 'SEQUOIA', browser_id: 6, version: '18' },
  // Playwright cannot drive any of these over the TestingBot endpoint.
  { selenium_name: 'iexplore', name: 'iexplore', platform: 'WIN10', browser_id: 7, version: '11' },
  { selenium_name: 'opera', name: 'opera', platform: 'WIN10', browser_id: 8, version: '12' },
  { selenium_name: 'electron', name: 'electron', platform: 'LINUX', browser_id: 9, version: '20' },
  // Device entries carry the platform version in `version`.
  { selenium_name: 'chrome', name: 'chrome', platform: 'ANDROID', browser_id: 10, version: '16.0', deviceName: 'Pixel 9', platformName: 'Android' },
  { selenium_name: 'chrome', name: 'chrome', platform: 'ANDROID', browser_id: 11, version: '15.0', deviceName: 'Pixel 9', platformName: 'Android' },
  { selenium_name: 'Chrome', name: 'chrome', platform: 'ANDROID', browser_id: 12, version: '15.0', deviceName: 'Galaxy Tab S9', platformName: 'Android' },
  { selenium_name: 'safari', name: 'safari', platform: 'BIGSUR', browser_id: 13, version: '14.2', deviceName: 'iPhone 11', platformName: 'iOS' },
]

test('only browsers Playwright can drive survive the filter', () => {
  const { browsers } = toCatalogue(RAW)
  const names = [...new Set(browsers.map((b) => b.browserName))].sort()

  assert.deepEqual(names, ['chrome', 'edge', 'firefox', 'safari'])
})

test('TestingBot Selenium names are translated to Playwright browser names', () => {
  const { browsers } = toCatalogue(RAW)

  // "googlechrome" as a Playwright browserName starts a session that never
  // completes its handshake, so this translation is load-bearing.
  assert.ok(browsers.some((b) => b.browserName === 'chrome' && b.platform === 'WIN11'))
  assert.ok(browsers.some((b) => b.browserName === 'edge' && b.platform === 'WIN10'))
  assert.equal(browsers.some((b) => b.browserName === 'googlechrome'), false)
})

test('versions are sorted numerically, newest first, behind the aliases', () => {
  const { browsers } = toCatalogue(RAW)
  const chrome = browsers.find((b) => b.browserName === 'chrome' && b.platform === 'WIN11')

  assert.deepEqual(chrome.versions, [...VERSION_ALIASES, '150', '100', '99'])
})

test('firefox and safari carry the reason they cannot be used', () => {
  const { browsers } = toCatalogue(RAW)
  const firefox = browsers.find((b) => b.browserName === 'firefox')
  const safari = browsers.find((b) => b.browserName === 'safari' && !b.deviceName)
  const chrome = browsers.find((b) => b.browserName === 'chrome')

  assert.match(firefox.blocked, /TB-272/)
  assert.match(safari.blocked, /TB-272/)
  assert.equal(chrome.blocked, null)
})

test('device names containing spaces survive grouping', () => {
  const { devices } = toCatalogue(RAW)
  const names = devices.map((d) => d.deviceName).sort((a, b) => a.localeCompare(b))

  // A composite key split on a space would have produced "Galaxy" and "Pixel".
  assert.deepEqual(names, ['Galaxy Tab S9', 'iPhone 11', 'Pixel 9'])

  const pixel = devices.find((d) => d.deviceName === 'Pixel 9')
  assert.deepEqual(pixel.platformVersions, ['16.0', '15.0'])
  assert.equal(pixel.platformName, 'Android')
})

test('platform codes are given human labels but keep their capability value', () => {
  const { browsers } = toCatalogue(RAW)
  const chrome = browsers.find((b) => b.browserName === 'chrome' && b.platform === 'WIN11')

  assert.equal(chrome.label, 'Chrome on Windows 11')
  // The label is for humans; the capability still has to be WIN11.
  assert.equal(chrome.platform, 'WIN11')
})

test('a response with nothing drivable is an error rather than an empty picker', () => {
  assert.throws(
    () => toCatalogue([{ name: 'iexplore', platform: 'WIN10', version: '11' }]),
    /none that Playwright can drive/,
  )
  assert.throws(() => toCatalogue({ error: 'type does not have a valid value' }), /did not return a list/)
})

/** The channel side: caching, and what the panel is told when the list is unreachable. */

const require_ = createRequire(import.meta.url)
const { TB_EVENTS, CHANNEL_AUTH } = require_('../src/constants.cjs')
const { getOrCreateNonce, guardChannel } = require_('../src/server/channelAuth.cjs')
const { setRuntime } = require_('../src/server/esm.cjs')
const { registerCatalogueHandlers, resetCatalogueCache } = require_('../src/server/catalogue.cjs')

function makeChannel () {
  const listeners = new Map()
  const emitted = []

  return {
    on (event, handler) { listeners.set(event, handler) },
    emit (event, payload) { emitted.push({ event, payload }) },
    send (event, payload = {}) {
      return listeners.get(event)({ ...payload, [CHANNEL_AUTH.PAYLOAD_KEY]: getOrCreateNonce() })
    },
    last (event) { return emitted.filter((e) => e.event === event).at(-1)?.payload },
  }
}

function wiredCatalogue (fetchCatalogue) {
  resetCatalogueCache()
  setRuntime({ fetchCatalogue })

  const channel = makeChannel()

  registerCatalogueHandlers(guardChannel(channel, getOrCreateNonce()))

  return channel
}

afterEach(() => {
  resetCatalogueCache()
  // Back to the real dist bundle, so later files are not affected.
  setRuntime(null)
})

test('the list is fetched once per Storybook process, not once per panel mount', async () => {
  let calls = 0
  const channel = wiredCatalogue(async () => {
    calls += 1
    return toCatalogue(RAW)
  })

  await channel.send(TB_EVENTS.GET_CATALOGUE)
  await channel.send(TB_EVENTS.GET_CATALOGUE)
  await channel.send(TB_EVENTS.GET_CATALOGUE)

  assert.equal(calls, 1)
  assert.ok(channel.last(TB_EVENTS.CATALOGUE_LOADED).catalogue.browsers.length > 0)
})

test('an unreachable list degrades the picker instead of breaking the panel', async () => {
  const channel = wiredCatalogue(async () => {
    throw new Error('getaddrinfo ENOTFOUND api.testingbot.com')
  })

  await channel.send(TB_EVENTS.GET_CATALOGUE)

  const payload = channel.last(TB_EVENTS.CATALOGUE_LOADED)

  assert.equal(payload.catalogue, null)
  assert.match(payload.error, /ENOTFOUND/)
  assert.match(payload.error, /browsers already in your config/)
})

test('a failure is not cached, so a laptop that comes back online recovers', async () => {
  let calls = 0
  const channel = wiredCatalogue(async () => {
    calls += 1
    if (calls === 1) throw new Error('offline')
    return toCatalogue(RAW)
  })

  await channel.send(TB_EVENTS.GET_CATALOGUE)
  assert.equal(channel.last(TB_EVENTS.CATALOGUE_LOADED).catalogue, null)

  await channel.send(TB_EVENTS.GET_CATALOGUE)
  assert.ok(channel.last(TB_EVENTS.CATALOGUE_LOADED).catalogue)
})
