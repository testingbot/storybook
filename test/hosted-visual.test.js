import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'

import {
  buildSnapshotOptions,
  buildSnapshotArguments,
  buildSnapshotScript,
  isValidVisualName,
  mapSnapshotResponse,
  visualMode,
  visualNameFor,
} from '../dist/index.js'

const require = createRequire(import.meta.url)
const { normaliseConfig } = require('../src/server/projectConfig.cjs')

/**
 * TB-303, hosted visual mode.
 *
 * The response shapes below are not invented. They were captured from the live
 * grid on 2026-08-27 by running two snapshots of the same name in one WebDriver
 * session: the first returned {"match":true,"pixelDifference":0} with no run,
 * the second {"match":false,"pixelDifference":34757,"visualId":19742,
 * "runId":3378551,"url":"https://testingbot.com/members/visual/19742/runs/3378551"}.
 * Both readings of hub this file depends on are therefore observed, not inferred.
 *
 * The mapping is the whole risk here. Everything else is a string sent to a
 * service we do not run, but a wrong mapping turns a broken comparison into a
 * green run, which is the one failure a visual testing tool must not have.
 */

const base = { storyId: 'button--primary', target: 'iphone-15' }

test('a compare failure is a failure, not a visual difference', () => {
  // hub reports both as match: false. Only the error field separates them, and
  // getting this wrong sends someone to review a diff that does not exist while
  // a broken compare service looks like a design regression.
  const result = mapSnapshotResponse(
    { match: false, error: 'Failed to compare after 4 attempts: Error: connect ECONNREFUSED' },
    base,
  )

  assert.equal(result.outcome, 'failed')
  assert.match(result.message, /Visual comparison failed on TestingBot/)
  assert.match(result.message, /ECONNREFUSED/)
})

test('a genuine difference is a diff, and keeps its pixel count and link', () => {
  const result = mapSnapshotResponse(
    {
      match: false,
      pixelDifference: 2020,
      visualId: 7,
      runId: 42,
      url: 'https://testingbot.com/members/visual/7/runs/42',
    },
    base,
  )

  assert.equal(result.outcome, 'diff')
  assert.equal(result.pixelDifference, 2020)
  assert.equal(result.url, 'https://testingbot.com/members/visual/7/runs/42')
  // A count of pixels is not a fraction of them, and hub gives no dimensions to
  // divide by, so it must not arrive as diffPixelRatio.
  assert.equal(result.diffPixelRatio, undefined)
})

test('a match is a pass', () => {
  const result = mapSnapshotResponse(
    { match: true, pixelDifference: 0, visualId: 7, runId: 43, url: 'https://testingbot.com/members/visual/7/runs/43' },
    base,
  )

  assert.equal(result.outcome, 'passed')
  assert.equal(result.pixelDifference, 0)
})

test('a first snapshot is a new baseline, not a pass', () => {
  // Verbatim from the live grid: a first snapshot really does come back with a
  // match and no run id. Reporting that as passed would hide the one run where
  // a wrong screenshot becomes the truth.
  const result = mapSnapshotResponse({ match: true, pixelDifference: 0 }, base)

  assert.equal(result.outcome, 'new')
  assert.match(result.message, /New baseline/)
})

test('a response with no verdict fails loudly', () => {
  // This is the ws-hub shape from TB-304: a bare sessionId, no match field.
  // Treating a missing verdict as anything but a failure is exactly the bug
  // that keeps hosted mode off desktop browsers.
  for (const raw of [{ sessionId: 'abc' }, {}, null, undefined, 'nope']) {
    const result = mapSnapshotResponse(raw, base)
    assert.equal(result.outcome, 'failed', `${JSON.stringify(raw)} must not be treated as a result`)
  }
})

test('the snapshot name is the story id alone', () => {
  // Not <target>/<story>. hub looks baselines up by name and then selects by
  // test environment, so putting the target in the name bypasses that matching
  // and silently reduces the service to the local model.
  assert.equal(visualNameFor('button--primary'), 'button--primary')
  assert.ok(!visualNameFor('button--primary').includes('iphone'))
})

test('story ids hub would reject are caught before the session is spent', () => {
  assert.ok(isValidVisualName('button--primary'))
  assert.ok(isValidVisualName('components-badge--warning'))
  assert.ok(!isValidVisualName('button/primary'))
  assert.ok(!isValidVisualName(''))
  assert.ok(!isValidVisualName('a'.repeat(129)))
})

test('the snapshot command crops to the story root unless fullPage is set', () => {
  const cropped = buildSnapshotOptions({ maxDiffPixelRatio: 0.001 }, '#storybook-root')
  assert.equal(cropped.selector, '#storybook-root')
  assert.equal(cropped.fullPage, undefined)

  const full = buildSnapshotOptions({ fullPage: true }, '#storybook-root')
  assert.equal(full.fullPage, true)
  assert.equal(full.selector, undefined)
})

test('hostedVisual options are passed through, unknown ones are not', () => {
  const options = buildSnapshotOptions(
    {
      hostedVisual: {
        threshold: 0.3,
        ignoreSelectors: ['.clock'],
        disableFreeze: true,
        somethingHubDoesNotKnow: true,
      },
    },
    '#storybook-root',
  )

  assert.equal(options.threshold, 0.3)
  assert.deepEqual(options.ignoreSelectors, ['.clock'])
  assert.equal(options.disableFreeze, true)
  // hub's sanitizeOptions would drop it anyway; not sending it keeps the
  // command honest about what it is asking for.
  assert.equal(options.somethingHubDoesNotKnow, undefined)
})

test('the script is the shape hub dispatches on', () => {
  const script = buildSnapshotScript('button--primary', { selector: '#storybook-root' })

  assert.match(script, /^tb:visual\.snapshot=/)
  const payload = JSON.parse(script.replace('tb:visual.snapshot=', ''))
  assert.equal(payload.name, 'button--primary')
  assert.deepEqual(payload.options, { selector: '#storybook-root' })
})

test('local is the default and a typo does not silently disable comparison', () => {
  assert.equal(visualMode({}), 'local')
  assert.equal(visualMode({ visual: 'hosted' }), 'hosted')
  assert.equal(visualMode({ visual: 'Hosted' }), 'local')
  assert.equal(visualMode({ visual: 'remote' }), 'local')

  // And the config reader pins it, so a typo in .testingbot.json cannot reach
  // the runner as an unrecognised mode.
  assert.equal(normaliseConfig({}).config.visual, 'local')
  assert.equal(normaliseConfig({ visual: 'hosted' }).config.visual, 'hosted')
  assert.equal(normaliseConfig({ visual: 'nonsense' }).config.visual, 'local')
})

test('both transports carry the same snapshot payload', () => {
  // WebDriver wraps it in an execute script and Playwright sends it as custom
  // command arguments, but hub's visual service sees one object either way.
  // Building it twice is how the two drivers would drift apart.
  const options = { selector: '#storybook-root' }

  assert.deepEqual(buildSnapshotArguments('button--primary', options), {
    name: 'button--primary',
    options,
  })
  assert.equal(
    buildSnapshotScript('button--primary', options),
    `tb:visual.snapshot=${JSON.stringify(buildSnapshotArguments('button--primary', options))}`,
  )
})
