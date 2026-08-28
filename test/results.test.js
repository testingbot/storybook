import { test, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'

import {
  approvableStories,
  approveStory,
  baselinePath,
  lastRunPath,
  markApproved,
  readImageDataUrl,
  readLastRun,
  resultPath,
  writeLastRun,
} from '../dist/index.js'

const require = createRequire(import.meta.url)
const { TB_EVENTS, CHANNEL_AUTH } = require('../src/constants.cjs')
const { getOrCreateNonce } = require('../src/server/channelAuth.cjs')
const { registerResultsHandlers } = require('../src/server/results.cjs')
const { guardChannel } = require('../src/server/channelAuth.cjs')

/** TB-259: baselines, approval and the images the panel reads. */

let root
let cwd

/** A one pixel PNG is enough: nothing here decodes, it only moves bytes. */
const PIXEL = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
)

function makeRun (overrides = {}) {
  return {
    ok: false,
    cancelled: false,
    totals: { new: 0, passed: 1, diff: 2, failed: 0 },
    stories: [
      { storyId: 'button--primary', target: 'chrome_latest_win10', outcome: 'diff', diffPixelRatio: 0.04, diffPath: 'x' },
      { storyId: 'button--secondary', target: 'chrome_latest_win10', outcome: 'diff', diffPixelRatio: 0.02, diffPath: 'y' },
      { storyId: 'badge--neutral', target: 'chrome_latest_win10', outcome: 'passed', diffPixelRatio: 0 },
    ],
    targets: [{ key: 'chrome_latest_win10', label: 'chrome latest on WIN10', sessionId: 'abc123' }],
    baselineDir: path.join(root, '.testingbot', 'baselines'),
    ...overrides,
  }
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'tb-results-'))
  cwd = process.cwd()
})

afterEach(() => {
  process.chdir(cwd)
  fs.rmSync(root, { recursive: true, force: true })
})

test('the last run survives a manager reload', () => {
  const run = makeRun()

  writeLastRun(root, run)

  assert.equal(fs.existsSync(lastRunPath(root)), true)
  assert.deepEqual(readLastRun(root).result.stories, run.stories)
  assert.ok(readLastRun(root).finishedAt)
})

test('a missing or unreadable last run reads as "nothing to review", not as an error', () => {
  assert.equal(readLastRun(root), null)

  fs.mkdirSync(path.dirname(lastRunPath(root)), { recursive: true })
  fs.writeFileSync(lastRunPath(root), '{ this is not json')
  assert.equal(readLastRun(root), null)

  fs.writeFileSync(lastRunPath(root), JSON.stringify({ version: 999, result: makeRun() }))
  assert.equal(readLastRun(root), null)
})

test('approving copies this run to the baseline and drops the stale diff', () => {
  fs.mkdirSync(path.dirname(resultPath(root, 'chrome', 'button--primary', 'actual')), { recursive: true })
  fs.writeFileSync(resultPath(root, 'chrome', 'button--primary', 'actual'), PIXEL)
  fs.writeFileSync(resultPath(root, 'chrome', 'button--primary', 'diff'), PIXEL)

  const outcome = approveStory(root, 'button--primary', 'chrome')

  assert.equal(outcome.approved, true)
  assert.deepEqual(fs.readFileSync(baselinePath(root, 'chrome', 'button--primary')), PIXEL)
  // Leaving it would show a red overlay next to a story that was just accepted.
  assert.equal(fs.existsSync(resultPath(root, 'chrome', 'button--primary', 'diff')), false)
})

test('approving a story with no screenshot from this run fails loudly', () => {
  const outcome = approveStory(root, 'button--primary', 'chrome')

  assert.equal(outcome.approved, false)
  assert.match(outcome.message, /Run it again/)
  assert.equal(fs.existsSync(baselinePath(root, 'chrome', 'button--primary')), false)
})

test('approval cannot escape the results directory', () => {
  // A story id is user data that ends up in a path. If it were trusted, an
  // approval could write anywhere on the machine the Storybook process can.
  const escape = '../../../../etc/passwd'

  approveStory(root, escape, '../../elsewhere')

  const written = baselinePath(root, '../../elsewhere', escape)

  assert.equal(written.startsWith(path.join(root, '.testingbot', 'baselines')), true)
  assert.equal(written.includes('..'), false)
})

test('only changed stories are approvable in bulk', () => {
  const approvable = approvableStories(makeRun())

  assert.deepEqual(approvable.map((s) => s.storyId), ['button--primary', 'button--secondary'])
})

test('approval rewrites the stored run so the panel stops showing a diff', () => {
  writeLastRun(root, makeRun())

  const result = markApproved(root, [
    { storyId: 'button--primary', target: 'chrome_latest_win10', approved: true },
    { storyId: 'button--secondary', target: 'chrome_latest_win10', approved: false },
  ])

  assert.deepEqual(result.totals, { new: 0, passed: 2, diff: 1, failed: 0 })

  const approved = result.stories.find((s) => s.storyId === 'button--primary')
  assert.equal(approved.outcome, 'passed')
  assert.equal(approved.diffPixelRatio, 0)
  assert.equal('diffPath' in approved, false)

  // The rewrite is persisted, not just returned.
  assert.equal(readLastRun(root).result.totals.diff, 1)
  // Still not ok, because one story is still different.
  assert.equal(result.ok, false)
})

test('approving the last difference turns the run green', () => {
  writeLastRun(root, makeRun())

  const result = markApproved(root, [
    { storyId: 'button--primary', target: 'chrome_latest_win10', approved: true },
    { storyId: 'button--secondary', target: 'chrome_latest_win10', approved: true },
  ])

  assert.equal(result.ok, true)
  assert.equal(result.totals.diff, 0)
})

test('a cancelled run stays not ok even when every difference is approved', () => {
  writeLastRun(root, makeRun({ cancelled: true }))

  const result = markApproved(root, [
    { storyId: 'button--primary', target: 'chrome_latest_win10', approved: true },
    { storyId: 'button--secondary', target: 'chrome_latest_win10', approved: true },
  ])

  // It made no statement about the stories it never reached.
  assert.equal(result.ok, false)
})

test('images come back as data URLs, and a missing one is null rather than a throw', () => {
  fs.mkdirSync(path.dirname(baselinePath(root, 'chrome', 'button--primary')), { recursive: true })
  fs.writeFileSync(baselinePath(root, 'chrome', 'button--primary'), PIXEL)

  const dataUrl = readImageDataUrl(root, 'button--primary', 'chrome', 'baseline')

  assert.equal(dataUrl, `data:image/png;base64,${PIXEL.toString('base64')}`)
  assert.equal(readImageDataUrl(root, 'button--primary', 'chrome', 'diff'), null)
})

/** A stand-in for Storybook's channel, matching the one in channel.test.js. */
function makeChannel () {
  const listeners = new Map()
  const emitted = []

  return {
    on (event, handler) { listeners.set(event, handler) },
    emit (event, payload) { emitted.push({ event, payload }) },
    send (event, payload = {}) {
      const handler = listeners.get(event)
      if (!handler) throw new Error(`no handler for ${event}`)
      return handler({ ...payload, [CHANNEL_AUTH.PAYLOAD_KEY]: getOrCreateNonce() })
    },
    forge (event, payload = {}) {
      const handler = listeners.get(event)
      if (!handler) throw new Error(`no handler for ${event}`)
      return handler({ ...payload })
    },
    last (event) { return emitted.filter((e) => e.event === event).at(-1)?.payload },
  }
}

function wiredResults () {
  const channel = makeChannel()

  registerResultsHandlers(guardChannel(channel, getOrCreateNonce()))
  process.chdir(root)

  return channel
}

test('the panel is told there is nothing to review rather than shown an error', async () => {
  const channel = wiredResults()

  await channel.send(TB_EVENTS.GET_RESULTS)

  assert.deepEqual(channel.last(TB_EVENTS.RESULTS_LOADED), {
    result: null,
    finishedAt: null,
    error: null,
  })
})

test('an image request without a valid kind is refused', async () => {
  const channel = wiredResults()

  await channel.send(TB_EVENTS.GET_IMAGE, { storyId: 'a', target: 'b', kind: 'passwd' })

  const payload = channel.last(TB_EVENTS.IMAGE_LOADED)

  assert.equal(payload.dataUrl, null)
  assert.match(payload.error, /valid kind/)
})

test('the results handlers are behind the nonce guard', async () => {
  const channel = wiredResults()

  await channel.forge(TB_EVENTS.APPROVE, { all: true })

  // Dropped, not answered: a forged event gets no reply at all.
  assert.equal(channel.last(TB_EVENTS.APPROVED), undefined)
})

test('approve all covers exactly the changed stories in the run on disk', async () => {
  const channel = wiredResults()

  for (const storyId of ['button--primary', 'button--secondary', 'badge--neutral']) {
    fs.mkdirSync(path.dirname(resultPath(root, 'chrome_latest_win10', storyId, 'actual')), { recursive: true })
    fs.writeFileSync(resultPath(root, 'chrome_latest_win10', storyId, 'actual'), PIXEL)
  }

  writeLastRun(root, makeRun())

  await channel.send(TB_EVENTS.APPROVE, { all: true })

  const payload = channel.last(TB_EVENTS.APPROVED)

  assert.equal(payload.success, true)
  assert.deepEqual(payload.outcomes.map((o) => o.storyId), ['button--primary', 'button--secondary'])
  // The passing story was left alone.
  assert.equal(fs.existsSync(baselinePath(root, 'chrome_latest_win10', 'badge--neutral')), false)
  assert.equal(payload.result.totals.diff, 0)
})

test('approving with no run to approve says so', async () => {
  const channel = wiredResults()

  await channel.send(TB_EVENTS.APPROVE, { all: true })

  assert.match(channel.last(TB_EVENTS.APPROVED).error, /no run to approve/)
})
