import { test, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'

import {
  applyScope,
  buildDeviceCapabilities,
  deviceDriverFor,
  mergeLocalPortCapabilities,
  resolveDeviceUrl,
  runOnGrid,
  toDeviceSpec,
  toTargets,
} from '../dist/index.js'

/**
 * TB-260: real devices.
 *
 * The thing under test is mostly one decision. Real devices cannot resolve the
 * literal hostname "localhost" (support/tunnel/faq.html.erb, "Can I use
 * localhost with the tunnel?"), and Storybook serves on exactly that, so
 * something has to supply a different URL or say plainly that it cannot.
 */

test('a device is pointed at the network address, not at localhost', () => {
  const target = resolveDeviceUrl({ networkAddress: 'http://192.168.1.24:6006/' })

  assert.equal(target.reachable, true)
  assert.equal(target.url, 'http://192.168.1.24:6006')
  assert.equal(target.source, 'network')
})

test('Storybook\'s ?path= is dropped from the device URL', () => {
  // Storybook appends it to the network address when an initial path was
  // requested. It selects a story in the manager, and a device opens
  // iframe.html, so carrying it over would be noise at best.
  const target = resolveDeviceUrl({ networkAddress: 'http://192.168.1.24:6006/?path=/story/button--primary' })

  assert.equal(target.url, 'http://192.168.1.24:6006')
})

test('the addresses a device cannot use are refused with a reason, not silently accepted', () => {
  // 0.0.0.0 is Storybook's fallback when the machine has no non-internal IPv4.
  for (const address of ['http://0.0.0.0:6006/', 'http://localhost:6006/', 'http://127.0.0.1:6006/', 'http://[::1]:6006/']) {
    const target = resolveDeviceUrl({ networkAddress: address })

    assert.equal(target.reachable, false, address)
    assert.equal(target.url, null)
    assert.match(target.reason, /cannot resolve "localhost"|network address/)
    // The reason has to name the escape hatch, or it is just a dead end.
    assert.match(target.reason, /deviceUrl/)
  }
})

test('a missing or unparseable network address is reported rather than guessed at', () => {
  assert.equal(resolveDeviceUrl({}).reachable, false)
  assert.equal(resolveDeviceUrl({ networkAddress: 'not a url' }).reachable, false)
})

test('a configured deviceUrl wins over anything derived', () => {
  const target = resolveDeviceUrl({
    configuredUrl: 'https://storybook.example.com/',
    networkAddress: 'http://192.168.1.24:6006/',
  })

  assert.equal(target.url, 'https://storybook.example.com')
  assert.equal(target.source, 'config')

  // It also wins when nothing could have been derived, which is the published
  // static build case.
  assert.equal(
    resolveDeviceUrl({ configuredUrl: 'https://storybook.example.com', networkAddress: 'http://0.0.0.0:6006/' }).reachable,
    true,
  )
})

test('iOS goes to WebDriver and Android stays on Playwright', () => {
  // Not a preference. Playwright has no iOS device backend at all, so routing
  // an iPhone through the connect path would start a session that can never
  // complete its handshake.
  assert.equal(deviceDriverFor({ platformName: 'iOS' }), 'webdriver')
  assert.equal(deviceDriverFor({ platformName: 'ios' }), 'webdriver')
  assert.equal(deviceDriverFor({ platformName: 'Android' }), 'playwright')
  assert.equal(deviceDriverFor({}), 'playwright')
})

test('the catalogue records which browser a device platform actually runs', () => {
  assert.equal(toDeviceSpec('iPhone 15', 'iOS', '18.0').browserName, 'safari')
  assert.equal(toDeviceSpec('Pixel 9', 'Android', '16.0').browserName, 'chrome')
})

test('device capabilities put the device name where Appium expects it', () => {
  const capabilities = buildDeviceCapabilities(toDeviceSpec('iPhone 15', 'iOS', '18.0'), {
    label: 'Storybook: iPhone 15',
    build: 'storybook-1',
    credentials: { key: 'k', secret: 's' },
    tunnel: { tunnelIdentifier: 't', localHttpPorts: [6006] },
  })

  // Wrong placement here is silent: the session starts on some other device.
  assert.equal(capabilities['appium:deviceName'], 'iPhone 15')
  assert.equal(capabilities.platformName, 'iOS')
  // The OS version travels as browserVersion, which is what the catalogue stores.
  assert.equal(capabilities.browserVersion, '18.0')
  assert.equal(capabilities.browserName, 'safari')
  assert.equal(capabilities['tb:options'].realDevice, true)
  assert.equal(capabilities['tb:options'].tunnelIdentifier, 't')
  assert.deepEqual(capabilities['tb:options'].localHttpPorts, [6006])
  // deviceName must not also be left at the top level or inside tb:options.
  assert.equal(capabilities.deviceName, undefined)
  assert.equal(capabilities['tb:options'].deviceName, undefined)
})

test('a config cannot point a device session at another account', () => {
  const capabilities = buildDeviceCapabilities(
    { deviceName: 'iPhone 15', platformName: 'iOS', key: 'theirs', secret: 'theirs', tunnelIdentifier: 'theirs' },
    {
      label: 'x',
      build: 'b',
      credentials: { key: 'ours', secret: 'ours' },
      tunnel: { tunnelIdentifier: 'ours' },
    },
  )

  assert.equal(capabilities['tb:options'].key, 'ours')
  assert.equal(capabilities['tb:options'].secret, 'ours')
  assert.equal(capabilities['tb:options'].tunnelIdentifier, 'ours')
})

test('the tunnel is asked for every port the run needs, once', () => {
  // Desktop targets open the local URL and devices open the device URL. With a
  // configured deviceUrl those can be different ports, and a tunnel is started
  // once.
  assert.deepEqual(
    mergeLocalPortCapabilities(['http://localhost:6006', 'http://192.168.1.24:6006']),
    { localHttpPorts: [6006] },
  )
  assert.deepEqual(
    mergeLocalPortCapabilities(['http://localhost:6006', 'http://localhost:7007', null]),
    { localHttpPorts: [6006, 7007] },
  )
  // Ports the tunnel already proxies are never asked for.
  assert.deepEqual(mergeLocalPortCapabilities(['http://localhost:3000']), {})
})

/** The runner's backstop, for the CLI and for a hand-edited config file. */

const STORIES = { 'button--primary': { id: 'button--primary', title: 'Button', name: 'Primary', type: 'story' } }

function fakeIndexServer () {
  const original = globalThis.fetch

  globalThis.fetch = async (url) => {
    if (String(url).includes('/index.json')) {
      return new Response(JSON.stringify({ v: 5, entries: STORIES }), {
        headers: { 'content-type': 'application/json' },
      })
    }

    throw new Error(`unexpected fetch to ${url}`)
  }

  return () => { globalThis.fetch = original }
}

let restoreFetch = null

afterEach(() => {
  restoreFetch?.()
  restoreFetch = null
})

const neverStarts = {
  ensureStarted () { throw new Error('the tunnel must not be started for a run that cannot happen') },
  async stop () {},
}

test('a run of devices alone with nowhere to point fails before a session is paid for', async () => {
  restoreFetch = fakeIndexServer()

  await assert.rejects(
    runOnGrid({
      credentials: { key: 'k', secret: 's', source: 'test' },
      config: { browsers: [], devices: [toDeviceSpec('iPhone 15', 'iOS', '18.0')], maxDiffPixelRatio: 0.001 },
      devServerUrl: 'http://localhost:6006',
      deviceUrl: null,
      signal: new AbortController().signal,
      tunnelManager: neverStarts,
    }),
    (error) => {
      assert.equal(error.code, 'NO_DEVICE_URL')
      assert.match(error.message, /cannot resolve "localhost"/)
      assert.match(error.message, /deviceUrl/)

      return true
    },
  )
})

test('scoping is unchanged by the device split', () => {
  // The device work reorders how targets are chosen, and the story selection
  // runs against the same index either way. This is the guard on that.
  const stories = [
    { id: 'button--primary', title: 'Button', name: 'Primary' },
    { id: 'button--secondary', title: 'Button', name: 'Secondary' },
    { id: 'badge--neutral', title: 'Badge', name: 'Neutral' },
  ]

  assert.equal(applyScope(stories, 'component', 'button--primary').length, 2)
})

/** The channel query the picker gates on. */

const require_ = createRequire(import.meta.url)
const { TB_EVENTS, CHANNEL_AUTH } = require_('../src/constants.cjs')
const { getOrCreateNonce, guardChannel } = require_('../src/server/channelAuth.cjs')
const { registerDeviceHandlers } = require_('../src/server/devices.cjs')

function makeChannel () {
  const listeners = new Map()
  const emitted = []

  return {
    on (event, handler) { listeners.set(event, handler) },
    emit (event, payload) { emitted.push({ event, payload }) },
    send (event, payload = {}) {
      return listeners.get(event)({ ...payload, [CHANNEL_AUTH.PAYLOAD_KEY]: getOrCreateNonce() })
    },
    forge (event, payload = {}) { return listeners.get(event)({ ...payload }) },
    last (event) { return emitted.filter((e) => e.event === event).at(-1)?.payload },
  }
}

function wiredDevices (addonOptions) {
  const channel = makeChannel()

  registerDeviceHandlers(guardChannel(channel, getOrCreateNonce()), addonOptions)

  return channel
}

test('the panel is told the device URL before it draws the picker', async () => {
  const channel = wiredDevices({ networkAddress: 'http://192.168.1.24:6006/' })

  await channel.send(TB_EVENTS.GET_DEVICE_TARGET)

  const payload = channel.last(TB_EVENTS.DEVICE_TARGET_LOADED)

  assert.equal(payload.reachable, true)
  assert.equal(payload.url, 'http://192.168.1.24:6006')
})

test('an unreachable Storybook disables devices with the reason attached', async () => {
  const channel = wiredDevices({ networkAddress: 'http://0.0.0.0:6006/' })

  await channel.send(TB_EVENTS.GET_DEVICE_TARGET)

  const payload = channel.last(TB_EVENTS.DEVICE_TARGET_LOADED)

  assert.equal(payload.reachable, false)
  assert.ok(payload.reason)
})

test('the device query is behind the nonce guard', async () => {
  const channel = wiredDevices({ networkAddress: 'http://192.168.1.24:6006/' })

  await channel.forge(TB_EVENTS.GET_DEVICE_TARGET)

  assert.equal(channel.last(TB_EVENTS.DEVICE_TARGET_LOADED), undefined)
})

test('a device with nowhere to point is skipped, and the browsers still run', async () => {
  restoreFetch = fakeIndexServer()

  const events = []
  const stop = new Error('stop before any session is opened')

  // The tunnel is the last thing that happens before sessions are paid for, so
  // stopping there shows what the run had decided without opening one.
  const tunnelManager = {
    async ensureStarted () { throw stop },
    async stop () {},
  }

  await assert.rejects(runOnGrid({
    credentials: { key: 'k', secret: 's', source: 'test' },
    config: {
      browsers: [{ browserName: 'chrome', browserVersion: 'latest', platform: 'WIN10' }],
      devices: [toDeviceSpec('iPhone 15', 'iOS', '18.0')],
      maxDiffPixelRatio: 0.001,
    },
    devServerUrl: 'http://localhost:6006',
    deviceUrl: null,
    signal: new AbortController().signal,
    onProgress: (event) => events.push(event),
    tunnelManager,
  }))

  const skipped = events.filter((event) => event.phase === 'target-skipped')

  // Reported, not swallowed. A run that quietly covered fewer targets than
  // asked would show green for a device nobody tested.
  assert.equal(skipped.length, 1)
  assert.match(skipped[0].label, /iPhone 15/)
  assert.ok(skipped[0].reason)

  // And the browser was not skipped with it.
  assert.equal(events.some((event) => event.phase === 'stories'), true)
})

test('hosted mode runs browser targets alongside devices', async () => {
  restoreFetch = fakeIndexServer()

  const events = []
  const stop = new Error('stop before any session is opened')
  const tunnelManager = {
    async ensureStarted () { throw stop },
    async stop () {},
  }

  await assert.rejects(runOnGrid({
    credentials: { key: 'k', secret: 's', source: 'test' },
    config: {
      browsers: [{ browserName: 'chrome', browserVersion: 'latest', platform: 'WIN10' }],
      devices: [toDeviceSpec('iPhone 15', 'iOS', '18.0')],
      maxDiffPixelRatio: 0.001,
      visual: 'hosted',
    },
    devServerUrl: 'http://localhost:6006',
    deviceUrl: 'http://192.168.1.24:6006',
    signal: new AbortController().signal,
    onProgress: (event) => events.push(event),
    tunnelManager,
  }))

  // Browsers used to be refused here: a Playwright session could send the
  // command but the grid could not capture a desktop session to compare it
  // against. TB-306 fixed that on the grid, verified end to end against the
  // live grid, so neither target is skipped any more.
  const skipped = events.filter((event) => event.phase === 'target-skipped')
  assert.deepEqual(skipped, [])
  assert.equal(events.some((event) => event.phase === 'stories'), true)
})

test('hosted mode with only browsers is a normal run, not a refusal', async () => {
  restoreFetch = fakeIndexServer()

  const events = []
  const stop = new Error('stop before any session is opened')
  const tunnelManager = {
    async ensureStarted () { throw stop },
    async stop () {},
  }

  // The only failure left is the stubbed tunnel. A browser-only hosted run is
  // configuration a user is allowed to have.
  await assert.rejects(
    runOnGrid({
      credentials: { key: 'k', secret: 's', source: 'test' },
      config: {
        browsers: [{ browserName: 'chrome', browserVersion: 'latest', platform: 'WIN10' }],
        devices: [],
        maxDiffPixelRatio: 0.001,
        visual: 'hosted',
      },
      devServerUrl: 'http://localhost:6006',
      deviceUrl: 'http://192.168.1.24:6006',
      signal: new AbortController().signal,
      onProgress: (event) => events.push(event),
      tunnelManager,
    }),
    (error) => {
      assert.equal(error.code, undefined)
      return true
    },
  )

  assert.deepEqual(events.filter((event) => event.phase === 'target-skipped'), [])
})

test('the tunnel is told to proxy the device URL as well as the local one', async () => {
  restoreFetch = fakeIndexServer()

  const asked = []
  const stop = new Error('stop before any session is opened')

  const tunnelManager = {
    async ensureStarted (devServerUrl, options) {
      asked.push({ devServerUrl, alsoProxy: options?.alsoProxy ?? [] })
      throw stop
    },
    async stop () {},
  }

  await assert.rejects(runOnGrid({
    credentials: { key: 'k', secret: 's', source: 'test' },
    config: { browsers: [], devices: [toDeviceSpec('Pixel 9', 'Android', '16.0')], maxDiffPixelRatio: 0.001 },
    devServerUrl: 'http://localhost:6006',
    // A different port on purpose: with a configured deviceUrl the two are not
    // the same, and a tunnel that only proxies one of them times out on the
    // other in a way that looks like a dead grid.
    deviceUrl: 'http://192.168.1.24:7007',
    signal: new AbortController().signal,
    tunnelManager,
  }))

  assert.equal(asked.length, 1)
  assert.equal(asked[0].devServerUrl, 'http://localhost:6006')
  assert.deepEqual(asked[0].alsoProxy, ['http://192.168.1.24:7007'])
})

test('a simulator and the phone of the same name get separate baselines', () => {
  // Whether a screenshot came off a desktop GPU or off the phone is exactly
  // the kind of thing the key is supposed to separate, and sharing one
  // baseline set between them would mean permanent false diffs.
  const [real, simulated] = toTargets({
    browsers: [],
    devices: [
      toDeviceSpec('iPhone 15', 'iOS', '18.0'),
      toDeviceSpec('iPhone 15', 'iOS', '18.0', false),
    ],
    maxDiffPixelRatio: 0.001,
  })

  assert.notEqual(real.key, simulated.key)
  assert.equal(real.key, 'iphone-15_ios_18.0')
  assert.equal(simulated.key, 'iphone-15_ios_18.0_simulator')
  assert.match(simulated.label, /simulator/)
  // Only the simulator is marked, so keys written before simulators were
  // offered still point at the baselines they already have.
  assert.equal(real.label, 'iPhone 15 iOS 18.0')
})

test('a non-physical Android target is called an emulator', () => {
  const [target] = toTargets({
    browsers: [],
    devices: [toDeviceSpec('Pixel 9', 'Android', '16.0', false)],
    maxDiffPixelRatio: 0.001,
  })

  assert.equal(target.key, 'pixel-9_android_16.0_emulator')
  assert.match(target.label, /emulator/)
})
