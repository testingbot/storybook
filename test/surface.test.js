import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)

/**
 * Storybook surface smoke tests.
 *
 * TB-254 requires pinning the verified Storybook version and re-verifying on
 * every major, because `experimental_serverChannel` and the test provider API
 * are experimental by name. These fail loudly if an export disappears, which is
 * the difference between a clear upgrade failure and a silently dead addon.
 */

const VERIFIED_STORYBOOK_VERSION = '10.5.10'

test('storybook exposes the addon surfaces this addon depends on', () => {
  const pkg = require('storybook/package.json')
  const exportMap = pkg.exports ?? {}

  assert.ok('./manager-api' in exportMap, 'storybook/manager-api export is missing')
  assert.ok('./internal/components' in exportMap, 'storybook/internal/components export is missing')

  if (pkg.version !== VERIFIED_STORYBOOK_VERSION) {
    console.warn(
      `[testingbot] Storybook is ${pkg.version}, but this addon was verified against ` +
      `${VERIFIED_STORYBOOK_VERSION}. Re-verify the experimental surfaces.`,
    )
  }
})

test('preset exports the three hooks Storybook will call', async () => {
  const preset = require('../preset.cjs')

  assert.equal(typeof preset.managerEntries, 'function')
  assert.equal(typeof preset.experimental_serverChannel, 'function')
  assert.equal(typeof preset.managerHead, 'function')
})

test('managerEntries does not register the manager bundle a second time', () => {
  const preset = require('../preset.cjs')
  const existing = ['/some/other/addon/manager.js']
  const result = preset.managerEntries(existing)

  // Storybook 10 auto-loads ./manager from the exports map. Appending it here
  // as well makes Storybook register the addon twice, which means two panels
  // and two runs per click. @percy/storybook@10.0.2 has this bug; we do not.
  assert.deepEqual(result, existing, 'managerEntries must not add the manager bundle')
  assert.ok(
    !result.some((e) => /@testingbot|dist\/manager\.js$/.test(e)),
    'the manager bundle must not be appended',
  )
})

test('managerEntries preserves other addons and tolerates no argument', () => {
  const preset = require('../preset.cjs')
  assert.deepEqual(preset.managerEntries(['/a.js', '/b.js']), ['/a.js', '/b.js'])
  assert.deepEqual(preset.managerEntries(), [])
})

test('the package still exposes ./manager, which is what registers the addon', () => {
  const pkg = require('../package.json')
  assert.equal(pkg.exports['./manager'], './dist/manager.js')
})

test('managerHead injects a stable nonce meta tag and preserves existing head', () => {
  const preset = require('../preset.cjs')
  const { CHANNEL_AUTH } = require('../src/constants.cjs')

  const head = preset.managerHead('<title>x</title>')
  assert.match(head, /<title>x<\/title>/)

  const match = head.match(new RegExp(`<meta name="${CHANNEL_AUTH.META_NAME}" content="([a-f0-9]{64})">`))
  assert.ok(match, `no nonce meta tag found in: ${head}`)

  // Same process must reuse the same nonce, or the manager's copy goes stale.
  assert.equal(preset.managerHead(''), `\n<meta name="${CHANNEL_AUTH.META_NAME}" content="${match[1]}">`)
})

test('experimental_serverChannel returns the channel it was given', async () => {
  const preset = require('../preset.cjs')
  const channel = { on () {}, emit () {} }

  // Storybook presets use a reducer pattern: returning anything else breaks the
  // channel for every other addon too.
  assert.equal(await preset.experimental_serverChannel(channel), channel)
})

test('the nonce guard rejects events without a valid nonce', () => {
  const { getOrCreateNonce, guardChannel } = require('../src/server/channelAuth.cjs')
  const { CHANNEL_AUTH } = require('../src/constants.cjs')

  const listeners = new Map()
  const channel = {
    on (event, handler) { listeners.set(event, handler) },
    emit () {},
  }

  const received = []
  guardChannel(channel, getOrCreateNonce()).on('evt', (payload) => received.push(payload))
  const fire = listeners.get('evt')

  fire({ value: 1 })
  fire({ value: 2, [CHANNEL_AUTH.PAYLOAD_KEY]: 'wrong' })
  assert.equal(received.length, 0, 'forged events must be dropped')

  fire({ value: 3, [CHANNEL_AUTH.PAYLOAD_KEY]: getOrCreateNonce() })
  assert.deepEqual(received, [{ value: 3 }], 'nonce must be stripped before the handler sees it')
})
