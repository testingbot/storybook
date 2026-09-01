import { test, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PNG } from 'pngjs'

import { runOnGrid, toDeviceSpec } from '../dist/index.js'

/**
 * The real iOS path, driven against a fake WebDriver hub.
 *
 * Everything the runner does on a device goes over HTTP to the grid, so the
 * whole path is reachable offline by answering those requests: the animation
 * freeze, the settle poll, the render-error probe, the element screenshot, and
 * what happens to the rest of the run when one device never starts.
 *
 * The one thing a fake cannot tell you is whether a real phone agrees. That is
 * what the kitchen-sink example is for.
 */

const ELEMENT_KEY = 'element-6066-11e4-a52e-4f735466cecf'

const STORIES = {
  'button--primary': { id: 'button--primary', title: 'Button', name: 'Primary', type: 'story' },
  'button--secondary': { id: 'button--secondary', title: 'Button', name: 'Secondary', type: 'story' },
}

function png (colour) {
  const image = new PNG({ width: 8, height: 8 })

  image.data.fill(colour)

  return PNG.sync.write(image)
}

/**
 * A hub that answers for one device and refuses the other.
 *
 * `refuse` is matched against `deviceName`, so a test can decide which target
 * fails without reaching into the runner. Every script the runner sends is
 * recorded, because what it asks the device to do is the behaviour under test.
 */
function fakeHub ({ refuse = null, renderError = false, parameters = {}, allowedGlobals = null, missingElements = [] } = {}) {
  const original = globalThis.fetch
  const scripts = []
  const urls = []
  const calls = []
  const sessions = new Set()
  let next = 0

  globalThis.fetch = async (url, init = {}) => {
    const target = String(url)
    const json = (value, status = 200) =>
      new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } })

    if (target.includes('/index.json')) return json({ v: 5, entries: STORIES })

    // The account API is allowed to be unreachable: getAccountLimits falls back
    // to one session at a time rather than failing the run.
    if (!target.includes('/wd/hub')) throw new Error(`unexpected fetch to ${target}`)

    const path = target.split('/wd/hub')[1]
    const body = init.body ? JSON.parse(init.body) : {}

    calls.push({ path: path.replace(/^\/session\/[^/]+/, ''), body })

    if (path === '/session') {
      const deviceName = body.capabilities?.alwaysMatch?.['appium:deviceName']

      if (deviceName === refuse) {
        return json({ value: { error: 'session not created', message: 'No devices are available.' } }, 500)
      }

      next += 1
      const sessionId = `session-${next}`
      sessions.add(sessionId)

      return json({ value: { sessionId } })
    }

    if (init.method === 'DELETE') return json({ value: null })

    if (path.endsWith('/timeouts')) return json({ value: null })

    if (path.endsWith('/url')) {
      urls.push(body.url)

      return json({ value: null })
    }

    // The story store read. Its script hands its answer to a callback, which
    // the grid returns as the command's value.
    // The envelope the extract script builds: what it found, and which globals
    // the project declares. Null all the way out is "no store to read".
    if (path.endsWith('/execute/async')) {
      return json({ value: { value: parameters === null ? null : { parameters, allowedGlobals } } })
    }

    if (path.endsWith('/execute/sync')) {
      scripts.push(body.script)

      if (body.script.includes('sb-show-errordisplay')) {
        return json({ value: renderError ? 'The story failed to render: boom' : null })
      }

      // The freeze, the annotations and the settle poll all just need to say
      // they worked. The settle poll is the one that must answer true, or the
      // runner waits out its timeout.
      return json({ value: true })
    }

    if (path.endsWith('/element')) {
      return missingElements.includes(body.value)
        ? json({ value: { error: 'no such element', message: `Unable to locate ${body.value}` } }, 404)
        : json({ value: { [ELEMENT_KEY]: 'story-root' } })
    }

    if (path.endsWith('/screenshot')) return json({ value: png(255).toString('base64') })

    throw new Error(`unexpected ${init.method ?? 'GET'} ${path}`)
  }

  return { scripts, urls, calls, sessions, restore: () => { globalThis.fetch = original } }
}

let hub = null
let projectRoot = null

afterEach(() => {
  hub?.restore()
  hub = null

  if (projectRoot) rmSync(projectRoot, { recursive: true, force: true })
  projectRoot = null
})

/** Collected by `run` so a test can assert on what the developer was told. */
let notices = []

function run (config, extra = {}) {
  projectRoot = mkdtempSync(join(tmpdir(), 'tb-device-'))
  notices = []

  return runOnGrid({
    onProgress: (event) => { if (event.phase === 'notice') notices.push(event.message) },
    credentials: { key: 'k', secret: 's', source: 'test' },
    config: { browsers: [], maxDiffPixelRatio: 0.001, ...config },
    devServerUrl: 'http://localhost:6006',
    deviceUrl: 'http://192.168.1.10:6006',
    signal: new AbortController().signal,
    projectRoot,
    tunnelManager: {
      async ensureStarted () { return { capability: { tunnelIdentifier: 'ours', localHttpPorts: [6006] } } },
      async stop () {},
    },
    ...extra,
  })
}

test('a device is told to freeze its animations before anything is measured', async () => {
  hub = fakeHub()

  const result = await run({ devices: [toDeviceSpec('iPhone 15', 'iOS', '18.0')] })

  const freeze = hub.scripts.findIndex((script) => script.includes('animation-duration: 1ms'))
  const shot = hub.scripts.findIndex((script) => script.includes('sb-show-errordisplay'))

  assert.ok(freeze >= 0, 'the animation freeze was never sent')
  // Order is the point. Freezing after the settle wait would let a spinner be
  // caught mid-turn, which is the 1.7% diff this exists to stop.
  assert.ok(freeze < shot, 'animations were frozen after the story had already settled')
  assert.equal(result.totals.new, 2)
})

test('a story that throws is reported as such, not as a screenshot timeout', async () => {
  hub = fakeHub({ renderError: true })

  const result = await run({ devices: [toDeviceSpec('iPhone 15', 'iOS', '18.0')] })

  assert.equal(result.totals.failed, 2)
  assert.equal(result.totals.new, 0)
  assert.match(result.stories[0].message, /The story failed to render: boom/)
  // No screenshot was taken, so no baseline was written for a story that never
  // rendered. A baseline of Storybook's error screen would then pass forever.
  assert.ok(!hub.scripts.some((script) => script.includes('screenshot')))
})

test('one device that never starts does not throw away the device that did', async () => {
  hub = fakeHub({ refuse: 'iPhone 14' })

  const result = await run({
    devices: [
      toDeviceSpec('iPhone 14', 'iOS', '17.0'),
      toDeviceSpec('iPhone 15', 'iOS', '18.0'),
    ],
  })

  assert.equal(result.skipped.length, 1)
  assert.match(result.skipped[0].label, /iPhone 14/)
  assert.match(result.skipped[0].reason, /No devices are available/)

  // The working device still ran and still wrote its baseline.
  assert.equal(result.stories.length, 2)
  assert.equal(result.stories[0].target, 'iphone-15_ios_18.0')
  assert.equal(result.totals.new, 2)

  // And the run is still red, because it covered fewer targets than asked.
  assert.equal(result.ok, false)
})

test('the session is closed even when the device fails mid-run', async () => {
  hub = fakeHub({ renderError: true })

  await run({ devices: [toDeviceSpec('iPhone 15', 'iOS', '18.0')] })

  assert.equal(hub.sessions.size, 1)
})

/** TB-353: per-story parameters, read from the device and acted on. */

test('a story that asks to be skipped is not screenshotted, and is said out loud', async () => {
  hub = fakeHub({ parameters: { 'button--secondary': { skip: true } } })

  const result = await run({ devices: [toDeviceSpec('iPhone 15', 'iOS', '18.0')] })

  assert.equal(result.stories.length, 1)
  assert.equal(result.stories[0].storyId, 'button--primary')

  // Silently running one story fewer than the index says is the failure this
  // exists to avoid, so the skip has to reach the developer.
  assert.ok(notices.some((notice) => notice.includes('button--secondary') && notice.includes('skip')))
})

test('args from a parameter reach the URL the device opens', async () => {
  hub = fakeHub({ parameters: { 'button--primary': { args: { label: 'Save changes', disabled: true } } } })

  await run({ devices: [toDeviceSpec('iPhone 15', 'iOS', '18.0')] })

  const opened = hub.urls.filter((url) => url.includes('id=button--primary'))

  assert.equal(opened.length, 1)
  assert.match(opened[0], /&args=label:Save\+changes;disabled:!true$/)
  // And the story without parameters is opened without an args parameter.
  assert.ok(hub.urls.some((url) => url.includes('id=button--secondary') && !url.includes('args=')))
})

test('an arg a URL cannot carry is reported instead of being smuggled through', async () => {
  hub = fakeHub({ parameters: { 'button--primary': { args: { html: '<script>x</script>' } } } })

  await run({ devices: [toDeviceSpec('iPhone 15', 'iOS', '18.0')] })

  assert.ok(hub.urls.every((url) => !url.includes('args=')))
  assert.ok(notices.some((notice) => notice.includes('html')))
})

test('waitForSelector that never appears fails the story rather than screenshotting the wrong state', async () => {
  hub = fakeHub({
    parameters: { 'button--primary': { waitForSelector: '.never', waitTimeout: 200 } },
    missingElements: ['.never'],
  })

  const result = await run({ devices: [toDeviceSpec('iPhone 15', 'iOS', '18.0')] })

  const failed = result.stories.find((story) => story.storyId === 'button--primary')

  assert.equal(failed.outcome, 'failed')
  assert.match(failed.message, /waitForSelector/)
  // The story that did not ask for one is unaffected.
  assert.equal(result.stories.find((story) => story.storyId === 'button--secondary').outcome, 'new')
})

test('a Storybook with no readable store runs as it always did, and says why once', async () => {
  hub = fakeHub({ parameters: null })

  const result = await run({
    devices: [
      toDeviceSpec('iPhone 15', 'iOS', '18.0'),
      // Both iPhones: Android is a Playwright target and would not come
      // through the WebDriver hub this test fakes.
      toDeviceSpec('iPhone 14', 'iOS', '17.0'),
    ],
  })

  assert.equal(result.totals.new, 4)
  // Two devices found the same thing. The developer is told once.
  const complaints = notices.filter((notice) => notice.includes('story store'))
  assert.equal(complaints.length, 1)
})

/**
 * Found on a real iPhone, not here: the W3C default script timeout is zero, and
 * Safari honours it, so /execute/async came back with "Timed out waiting for
 * asynchronous script result after 2 ms" and every per-story parameter was
 * silently ignored on iOS while working everywhere else.
 */
test('the script timeout is set before the first async script, or iOS refuses it', async () => {
  hub = fakeHub({ parameters: { 'button--secondary': { skip: true } } })

  await run({ devices: [toDeviceSpec('iPhone 15', 'iOS', '18.0')] })

  const timeouts = hub.calls.findIndex((call) => call.path === '/timeouts')
  const async = hub.calls.findIndex((call) => call.path === '/execute/async')

  assert.ok(timeouts >= 0, 'the script timeout was never set')
  assert.ok(timeouts < async, 'the script ran before the timeout that allows it to finish')
  assert.ok(hub.calls[timeouts].body.script > 0)

  // Once per session, not once per script.
  assert.equal(hub.calls.filter((call) => call.path === '/timeouts').length, 1)
})

/**
 * TB-354. Widths are desktop only, and a device that quietly captured at its
 * own size while the config asked for 375 would look like it had honoured it.
 */
test('a device ignores widths, keeps its own baseline key, and the developer is told', async () => {
  hub = fakeHub()

  const result = await run({
    devices: [toDeviceSpec('iPhone 15', 'iOS', '18.0')],
    widths: [375, 1280],
  })

  // Two stories, not four. The width did not multiply anything here.
  assert.equal(result.totals.new, 2)
  assert.ok(
    result.stories.every((story) => story.target === 'iphone-15_ios_18.0'),
    'a device baseline key must not gain a width suffix',
  )
  assert.ok(notices.some((notice) => /widths.*desktop browsers only/i.test(notice)))
})
