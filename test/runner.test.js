import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { PNG } from 'pngjs'

import {
  selectStories,
  applyScope,
  toTargets,
  buildCapabilities,
  buildAndroidCapabilities,
  buildWsEndpoint,
  browserTypeFor,
  compareImages,
  resolveConcurrency,
  baselinePath,
  resultPath,
} from '../dist/index.js'

const require = createRequire(import.meta.url)
const { getDevServerUrl } = require('../src/server/devServer.cjs')

/** TB-256. Everything here is pure, so none of it touches the grid. */

const STORIES = [
  { id: 'components-button--primary', title: 'Components/Button', name: 'Primary' },
  { id: 'components-button--secondary', title: 'Components/Button', name: 'Secondary' },
  { id: 'pages-home--default', title: 'Pages/Home', name: 'Default' },
]

test('a single story id narrows the run to exactly that story', () => {
  const picked = selectStories(STORIES, { storyId: 'pages-home--default' })

  assert.deepEqual(picked.map((s) => s.id), ['pages-home--default'])
})

test('include and exclude are globs over ids and titles, and exclude wins', () => {
  const included = selectStories(STORIES, { include: ['components-*'] })
  assert.deepEqual(included.map((s) => s.id), [
    'components-button--primary',
    'components-button--secondary',
  ])

  const both = selectStories(STORIES, { include: ['components-*'], exclude: ['*--secondary'] })
  assert.deepEqual(both.map((s) => s.id), ['components-button--primary'])

  const byTitle = selectStories(STORIES, { include: ['Pages/*'] })
  assert.deepEqual(byTitle.map((s) => s.id), ['pages-home--default'])
})

test('no include means every story, and glob metacharacters are not injectable', () => {
  assert.equal(selectStories(STORIES).length, 3)
  // A literal dot must not behave as "any character".
  assert.equal(selectStories(STORIES, { include: ['components.button--primary'] }).length, 0)
})

test('baseline keys separate every environment that renders differently', () => {
  const targets = toTargets({
    browsers: [
      { browserName: 'chrome', browserVersion: 'latest', platform: 'WIN10' },
      { browserName: 'safari', browserVersion: '17', platform: 'MONTEREY' },
      // Same browser, different timezone: dates and currency render
      // differently, so this must not share a baseline set with the first.
      { browserName: 'chrome', browserVersion: 'latest', platform: 'WIN10', timeZone: 'Asia/Tokyo' },
    ],
    devices: [{ deviceName: 'iPhone 15', platformName: 'iOS', platformVersion: '17.0' }],
  })

  const keys = targets.map((t) => t.key)

  assert.equal(new Set(keys).size, keys.length, 'every target has a distinct baseline folder')
  assert.equal(keys[0], 'chrome_latest_win10')
  assert.equal(keys[2], 'chrome_latest_win10_timeZone-asia-tokyo')
  assert.equal(keys[3], 'iphone-15_ios_17.0')
  assert.equal(targets[3].kind, 'device')
})

test('only browserName and browserVersion are top level; everything else is tb:options', () => {
  // A tunnelIdentifier at the top level is silently ignored by the grid, and
  // the run then fails as timeouts rather than as a configuration error.
  const [target] = toTargets({
    browsers: [{ browserName: 'chrome', browserVersion: 'latest', platform: 'WIN10', timeZone: 'Asia/Tokyo' }],
  })

  const capabilities = buildCapabilities(target, {
    credentials: { key: 'real-key', secret: 'real-secret', source: 'env' },
    tunnel: { tunnelIdentifier: 'ours', localHttpPorts: [6006] },
    build: 'storybook-run',
  })

  assert.deepEqual(Object.keys(capabilities).sort(), ['browserName', 'browserVersion', 'tb:options'])
  assert.equal(capabilities.browserName, 'chrome')
  assert.equal(capabilities['tb:options'].platform, 'WIN10')
  assert.equal(capabilities['tb:options'].timeZone, 'Asia/Tokyo')
  assert.equal(capabilities['tb:options'].tunnelIdentifier, 'ours')
  assert.deepEqual(capabilities['tb:options'].localHttpPorts, [6006])
})

test('an Android device is asked for flat, because tb:options is not read there', () => {
  // Playwright reaches Android through _android.connect, and that endpoint only
  // reads top-level capabilities. The desktop shape connects anyway and hands
  // back some other device, so the mistake is invisible until someone looks at
  // the video.
  const [target] = toTargets({
    devices: [{ deviceName: 'Pixel 8', platformName: 'Android', platformVersion: '14.0' }],
  })

  const capabilities = buildAndroidCapabilities(target, {
    credentials: { key: 'real-key', secret: 'real-secret', source: 'env' },
    tunnel: { tunnelIdentifier: 'ours', localHttpPorts: [6006] },
    build: 'storybook-run',
  })

  assert.equal(capabilities['tb:options'], undefined)
  assert.equal(capabilities.deviceName, 'Pixel 8')
  assert.equal(capabilities.platformName, 'Android')
  assert.equal(capabilities.browserName, 'chrome')
  assert.equal(capabilities.realDevice, true)
  assert.equal(capabilities.tunnelIdentifier, 'ours')
  assert.deepEqual(capabilities.localHttpPorts, [6006])
  // The version moves: platformVersion is what the config and the catalogue
  // write, browserVersion is what this endpoint reads.
  assert.equal(capabilities.browserVersion, '14.0')
  assert.equal(capabilities.platformVersion, undefined)
})

test('an Android device cannot be pointed at another account or another tunnel', () => {
  const [target] = toTargets({
    devices: [{
      deviceName: 'Pixel 8',
      platformName: 'Android',
      key: 'attacker',
      'tb:options': { secret: 'attacker-secret', tunnelIdentifier: 'theirs' },
    }],
  })

  const capabilities = buildAndroidCapabilities(target, {
    credentials: { key: 'real-key', secret: 'real-secret', source: 'env' },
    tunnel: { tunnelIdentifier: 'ours', localHttpPorts: [6006] },
    build: 'storybook-run',
  })

  assert.equal(capabilities.key, 'real-key')
  assert.equal(capabilities.secret, 'real-secret')
  assert.equal(capabilities.tunnelIdentifier, 'ours')
})

test('config cannot redirect a run at another account or another tunnel', () => {
  const [target] = toTargets({
    browsers: [{
      browserName: 'chrome',
      platform: 'WIN10',
      // Both of these are refused by projectConfig first; this asserts the
      // second line of defence, in case a caller builds a target by hand.
      key: 'attacker',
      'tb:options': { secret: 'attacker-secret', tunnelIdentifier: 'theirs' },
    }],
  })

  const capabilities = buildCapabilities(target, {
    credentials: { key: 'real-key', secret: 'real-secret', source: 'env' },
    tunnel: { tunnelIdentifier: 'ours', localHttpPorts: [6006] },
    build: 'storybook-run',
  })

  assert.equal(capabilities['tb:options'].key, 'real-key')
  assert.equal(capabilities['tb:options'].secret, 'real-secret')
  assert.equal(capabilities['tb:options'].tunnelIdentifier, 'ours')

  const endpoint = buildWsEndpoint(capabilities)
  assert.ok(endpoint.startsWith('wss://cloud.testingbot.com/playwright?capabilities='))
  assert.equal(
    JSON.parse(decodeURIComponent(endpoint.split('capabilities=')[1]))['tb:options'].tunnelIdentifier,
    'ours',
  )
})

function png (width, height, paint) {
  const image = new PNG({ width, height })

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const i = (width * y + x) << 2
      const [r, g, b] = paint(x, y)
      image.data[i] = r
      image.data[i + 1] = g
      image.data[i + 2] = b
      image.data[i + 3] = 255
    }
  }

  return PNG.sync.write(image)
}

test('identical images match, and a real change is caught', () => {
  const white = png(40, 40, () => [255, 255, 255])
  const withBlock = png(40, 40, (x, y) => (x < 20 && y < 20 ? [0, 0, 0] : [255, 255, 255]))

  assert.equal(compareImages(white, white, 0.02).equal, true)

  const changed = compareImages(white, withBlock, 0.02)
  assert.equal(changed.equal, false)
  // A quarter of the image turned black.
  assert.ok(changed.diffPixelRatio > 0.2, `expected a large ratio, got ${changed.diffPixelRatio}`)
  assert.ok(Buffer.isBuffer(changed.diff))
})

test('a difference inside the tolerance is not reported as a diff', () => {
  const plain = png(100, 100, () => [255, 255, 255])
  // 100 of 10000 pixels, so exactly 1%, under the 2% default.
  const speckled = png(100, 100, (x, y) => (y === 0 ? [0, 0, 0] : [255, 255, 255]))

  assert.equal(compareImages(plain, speckled, 0.02).equal, true)
  assert.equal(compareImages(plain, speckled, 0.005).equal, false)
})

test('a size change is reported as such rather than as 100 percent of pixels', () => {
  const short = png(40, 40, () => [255, 255, 255])
  const tall = png(40, 80, () => [255, 255, 255])
  const result = compareImages(short, tall, 0.02)

  assert.equal(result.equal, false)
  assert.deepEqual(result.sizeMismatch, { baseline: '40x40', actual: '40x80' })
})

test('concurrency respects the account limit and what it is already using', () => {
  const limits = { maxConcurrent: 5, maxConcurrentMobile: 2, currentVm: 0, currentPhysical: 0 }

  assert.equal(resolveConcurrency(limits, 2), 2, 'never more lanes than targets')
  assert.equal(resolveConcurrency(limits, 20), 5, 'never more than the plan allows')
  assert.equal(
    resolveConcurrency({ ...limits, currentVm: 4 }, 20), 1,
    'sessions running elsewhere count against the same limit',
  )
  assert.equal(
    resolveConcurrency({ ...limits, currentVm: 9 }, 20), 1,
    'a busy account runs slowly rather than not at all',
  )
})

test('baseline and result paths are separate trees and are safe to build from story ids', () => {
  const hostile = '../../etc/passwd'

  assert.ok(baselinePath('/project', 'chrome_win10', hostile).startsWith('/project/.testingbot/baselines/'))
  assert.ok(!baselinePath('/project', 'chrome_win10', hostile).includes('..'))
  assert.equal(
    baselinePath('/project', 'chrome_win10', 'components-button--primary'),
    '/project/.testingbot/baselines/chrome_win10/components-button--primary.png',
  )
  assert.equal(
    resultPath('/project', 'chrome_win10', 'components-button--primary', 'diff'),
    '/project/.testingbot/results/chrome_win10/components-button--primary.diff.png',
  )
})

test('the dev server URL comes from Storybook rather than assuming 6006', () => {
  assert.equal(getDevServerUrl({ localAddress: 'http://localhost:6017/' }), 'http://localhost:6017')
  assert.equal(getDevServerUrl({ port: 6019 }), 'http://localhost:6019')
  assert.equal(getDevServerUrl({}), null)
  assert.equal(getDevServerUrl(null), null)
})

test('the playwright client matches the grid browser, because a mismatch just hangs', () => {
  assert.equal(browserTypeFor({ browserName: 'chrome' }), 'chromium')
  assert.equal(browserTypeFor({ browserName: 'edge' }), 'chromium')
  assert.equal(browserTypeFor({ browserName: 'firefox' }), 'firefox')
  assert.equal(browserTypeFor({ browserName: 'webkit' }), 'webkit')
  assert.equal(browserTypeFor({ browserName: 'safari' }), 'webkit')
  assert.equal(browserTypeFor({}), 'chromium')
})

/** TB-257 run scopes. */

test('the component scope runs every story in the same component, and only those', () => {
  const scoped = applyScope(STORIES, 'component', 'components-button--primary')

  assert.deepEqual(scoped.map((s) => s.id), [
    'components-button--primary',
    'components-button--secondary',
  ])
})

test('the story scope runs exactly one story', () => {
  assert.deepEqual(
    applyScope(STORIES, 'story', 'components-button--primary').map((s) => s.id),
    ['components-button--primary'],
  )
})

test('everything means everything, with or without a story open', () => {
  assert.equal(applyScope(STORIES, 'all', 'components-button--primary').length, 3)
  assert.equal(applyScope(STORIES, 'all', null).length, 3)
})

test('a scope with no story open falls back to the whole index rather than nothing', () => {
  // The toolbar can be clicked on the docs page, where there is no story id.
  // Running nothing would look like a broken button.
  assert.equal(applyScope(STORIES, 'story', null).length, 3)
})

test('a story id that is not in the index selects nothing, so the run can say why', () => {
  assert.deepEqual(applyScope(STORIES, 'component', 'gone--missing'), [])
})
