import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'

import { connectTestProvider, toStatuses } from '../dist/test-provider-core.js'

const require = createRequire(import.meta.url)
const { TB_EVENTS, STATUS_TYPE_ID, TEST_PROVIDER_ID } = require('../src/constants.cjs')

/**
 * TB-258, the Testing widget integration.
 *
 * The point of these is the mapping and the state machine, not React. A test
 * provider that reports the wrong provider state is worse than no test provider
 * at all: the widget would say a run succeeded when the tunnel never came up.
 */

function makeStores () {
  const statuses = []
  let unsets = 0
  let state = 'test-provider-state:pending'
  const runAll = []
  const clearAll = []

  return {
    statuses,
    get unsets () { return unsets },
    get state () { return state },
    fireRunAll: () => runAll.forEach((fn) => fn()),
    fireClearAll: () => clearAll.forEach((fn) => fn()),
    statusStore: {
      set: (next) => statuses.push(next),
      unset: () => { unsets += 1 },
    },
    providerStore: {
      setState: (next) => { state = next },
      onRunAll: (fn) => { runAll.push(fn) },
      onClearAll: (fn) => { clearAll.push(fn) },
    },
  }
}

function makeChannel () {
  const listeners = new Map()
  const sent = []

  return {
    sent,
    on: (event, listener) => { listeners.set(event, listener) },
    emit: (event, payload) => { sent.push({ event, payload }) },
    fire: (event, payload) => {
      const listener = listeners.get(event)
      assert.ok(listener, `nothing is listening for ${event}`)
      listener(payload)
    },
  }
}

test('Storybook still exposes the experimental test provider API', () => {
  // TB-258 asks for a smoke test that fails loudly if the export disappears,
  // because the alternative is an addon that silently stops appearing in the
  // widget after an upgrade and nobody notices for a release.
  const pkg = require('storybook/package.json')
  assert.ok('./manager-api' in (pkg.exports ?? {}))

  // Reading the built bundle rather than importing it: storybook/manager-api
  // expects a browser, so the export names are checked as text.
  const source = require('node:fs').readFileSync(require.resolve('storybook/manager-api'), 'utf8')

  for (const name of [
    'experimental_getStatusStore',
    'experimental_getTestProviderStore',
    'experimental_useTestProviderStore',
  ]) {
    assert.match(source, new RegExp(name), `storybook/manager-api no longer exports ${name}`)
  }
})

test('one story that ran on several targets produces one status, worst outcome wins', () => {
  const statuses = toStatuses([
    { storyId: 'button--primary', target: 'chrome', outcome: 'passed' },
    { storyId: 'button--primary', target: 'safari', outcome: 'diff', diffPixelRatio: 0.042 },
    { storyId: 'badge--neutral', target: 'chrome', outcome: 'passed' },
  ])

  assert.equal(statuses.length, 2)

  const button = statuses.find((status) => status.storyId === 'button--primary')
  assert.equal(button.value, 'status-value:error')
  assert.equal(button.typeId, STATUS_TYPE_ID)
  // Both targets have to be named. "Something differs" without saying where is
  // a status the developer cannot act on.
  assert.match(button.description, /chrome: matches baseline/)
  assert.match(button.description, /safari: 4\.200% of pixels differ/)

  assert.equal(statuses.find((status) => status.storyId === 'badge--neutral').value, 'status-value:success')
})

test('a first baseline is a warning, not a pass', () => {
  const [status] = toStatuses([{ storyId: 'a--b', target: 'chrome', outcome: 'new' }])

  assert.equal(status.value, 'status-value:warning')
  assert.match(status.description, /new baseline/)
})

test('a failed story outranks a diff', () => {
  const [status] = toStatuses([
    { storyId: 'a--b', target: 'chrome', outcome: 'diff', diffPixelRatio: 0.5 },
    { storyId: 'a--b', target: 'firefox', outcome: 'failed', message: 'session did not start' },
  ])

  assert.equal(status.value, 'status-value:error')
  assert.match(status.description, /session did not start/)
})

test('a run that finds differences still counts as a successful run', () => {
  const stores = makeStores()
  const channel = makeChannel()
  connectTestProvider(channel, stores.statusStore, stores.providerStore)

  channel.fire(TB_EVENTS.RUN_STARTED, {})
  assert.equal(stores.state, 'test-provider-state:running')
  assert.equal(stores.unsets, 1, 'the previous run\'s statuses must be cleared')

  channel.fire(TB_EVENTS.RUN_FINISHED, {
    ok: false,
    stories: [{ storyId: 'a--b', target: 'chrome', outcome: 'diff', diffPixelRatio: 0.2 }],
  })

  // crashed means the run could not execute. A story that looks different is
  // reported through the status, and marking the provider crashed for it would
  // make a real infrastructure failure indistinguishable from a design change.
  assert.equal(stores.state, 'test-provider-state:succeeded')
  assert.equal(stores.statuses.at(-1)[0].value, 'status-value:error')
})

test('a run that could not start crashes the provider', () => {
  const stores = makeStores()
  const channel = makeChannel()
  connectTestProvider(channel, stores.statusStore, stores.providerStore)

  channel.fire(TB_EVENTS.RUN_STARTED, {})
  channel.fire(TB_EVENTS.RUN_ERROR, { code: 'NO_CREDENTIALS', message: 'no credentials' })

  assert.equal(stores.state, 'test-provider-state:crashed')
})

test('statuses appear per story as the run progresses, not only at the end', () => {
  const stores = makeStores()
  const channel = makeChannel()
  connectTestProvider(channel, stores.statusStore, stores.providerStore)

  channel.fire(TB_EVENTS.RUN_STARTED, {})
  channel.fire(TB_EVENTS.RUN_PROGRESS, { phase: 'tunnel', message: 'starting' })
  assert.equal(stores.statuses.length, 0, 'tunnel progress is not a story result')

  channel.fire(TB_EVENTS.RUN_PROGRESS, {
    phase: 'story',
    index: 1,
    total: 2,
    result: { storyId: 'a--b', target: 'chrome', outcome: 'passed' },
  })

  assert.equal(stores.statuses.length, 1)
  assert.equal(stores.statuses[0][0].storyId, 'a--b')
})

test('the last run is restored on load without claiming anything just ran', () => {
  const stores = makeStores()
  const channel = makeChannel()
  connectTestProvider(channel, stores.statusStore, stores.providerStore)

  // The results request goes out on connect, so a page reload repaints the
  // sidebar instead of showing a clean slate that hides a red story.
  assert.ok(channel.sent.some((message) => message.event === TB_EVENTS.GET_RESULTS))

  channel.fire(TB_EVENTS.RESULTS_LOADED, {
    result: { ok: true, stories: [{ storyId: 'a--b', target: 'chrome', outcome: 'passed' }] },
    finishedAt: '2026-01-01T00:00:00.000Z',
    error: null,
  })

  assert.equal(stores.statuses.at(-1)[0].value, 'status-value:success')
  assert.equal(stores.state, 'test-provider-state:pending', 'restoring is not running')
})

test('an empty results payload leaves the sidebar alone', () => {
  const stores = makeStores()
  const channel = makeChannel()
  connectTestProvider(channel, stores.statusStore, stores.providerStore)

  channel.fire(TB_EVENTS.RESULTS_LOADED, { result: null, finishedAt: null, error: null })

  assert.equal(stores.statuses.length, 0)
})

test('Run All triggers a full run, with a nonce', () => {
  const stores = makeStores()
  const channel = makeChannel()
  connectTestProvider(channel, stores.statusStore, stores.providerStore)

  stores.fireRunAll()

  const run = channel.sent.find((message) => message.event === TB_EVENTS.RUN)
  assert.ok(run, 'Run All must reach the server handler')
  assert.equal(run.payload.scope, 'all')
  // Without the nonce key the server drops the event and the widget spins
  // forever. The value is null here because there is no manager document in
  // Node to read the meta tag from; in the browser it is the injected nonce.
  const { CHANNEL_AUTH } = require('../src/constants.cjs')
  assert.ok(CHANNEL_AUTH.PAYLOAD_KEY in run.payload)
})

test('Clear All clears our statuses', () => {
  const stores = makeStores()
  const channel = makeChannel()
  connectTestProvider(channel, stores.statusStore, stores.providerStore)

  channel.fire(TB_EVENTS.RUN_PROGRESS, {
    phase: 'story',
    result: { storyId: 'a--b', target: 'chrome', outcome: 'diff', diffPixelRatio: 0.1 },
  })

  const before = stores.unsets
  stores.fireClearAll()
  assert.equal(stores.unsets, before + 1)

  // And the buffer with it, or the next story result would resurrect the
  // status the user just cleared.
  channel.fire(TB_EVENTS.RUN_PROGRESS, {
    phase: 'story',
    result: { storyId: 'c--d', target: 'chrome', outcome: 'passed' },
  })
  assert.deepEqual(
    stores.statuses.at(-1).map((status) => status.storyId),
    ['c--d'],
  )
})

test('the provider and status ids are distinct and stable', () => {
  // The status type id is what Storybook keys sidebar icons by, and the
  // provider id is what the widget keys its row by. Reusing one string for both
  // works until Storybook decides otherwise, so they are separate on purpose.
  assert.equal(TEST_PROVIDER_ID, 'testingbot-storybook/test-provider')
  assert.equal(STATUS_TYPE_ID, 'testingbot-storybook')
})
