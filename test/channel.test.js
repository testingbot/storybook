import { test, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const require = createRequire(import.meta.url)

const preset = require('../preset.cjs')
const { TB_EVENTS, CHANNEL_AUTH } = require('../src/constants.cjs')
const { getOrCreateNonce } = require('../src/server/channelAuth.cjs')
const { setRunner, resetRunState, isRunning } = require('../src/server/run.cjs')
const { clearSessionCredentials } = require('../src/server/credentials.cjs')

/**
 * TB-255 acceptance criteria, exercised through the real preset wiring rather
 * than by calling handlers directly, so the nonce guard is in the path.
 */

/** A stand-in for Storybook's channel that records what Node emits. */
function makeChannel () {
  const listeners = new Map()
  const emitted = []

  return {
    on (event, handler) { listeners.set(event, handler) },
    emit (event, payload) { emitted.push({ event, payload }) },
    emitted,
    /** Simulate the manager sending a properly nonced event. */
    send (event, payload = {}) {
      const handler = listeners.get(event)
      if (!handler) throw new Error(`no handler for ${event}`)
      return handler({ ...payload, [CHANNEL_AUTH.PAYLOAD_KEY]: getOrCreateNonce() })
    },
    /** Simulate a cross-origin page trying the same thing. */
    forge (event, payload = {}) {
      const handler = listeners.get(event)
      if (!handler) throw new Error(`no handler for ${event}`)
      return handler({ ...payload })
    },
    find (event) { return emitted.filter((e) => e.event === event) },
    last (event) { return this.find(event).at(-1)?.payload },
  }
}

/**
 * Storybook's own options bag, as verified against storybook@10.5.10: it
 * carries localAddress alongside any addon options from main.js. The run
 * handler needs it to know where the dev server is, so the default here is a
 * realistic one rather than an empty object.
 */
const STORYBOOK_OPTIONS = { localAddress: 'http://localhost:6006/', port: 6006 }

async function wired (options = STORYBOOK_OPTIONS) {
  const channel = makeChannel()
  await preset.experimental_serverChannel(channel, options)
  return channel
}

/**
 * Credential resolution prefers process.env over every other source, so setting
 * it here makes these tests independent of whether the machine running them
 * happens to have a .env or a ~/.testingbot file.
 */
const REAL_ENV = { key: process.env.TB_KEY, secret: process.env.TB_SECRET }

function useTestCredentials (key = 'test-key', secret = 'test-secret') {
  process.env.TB_KEY = key
  process.env.TB_SECRET = secret
}

beforeEach(() => {
  resetRunState()
  clearSessionCredentials()
  useTestCredentials()
})

afterEach(() => {
  if (REAL_ENV.key === undefined) delete process.env.TB_KEY
  else process.env.TB_KEY = REAL_ENV.key
  if (REAL_ENV.secret === undefined) delete process.env.TB_SECRET
  else process.env.TB_SECRET = REAL_ENV.secret
})

test('clicking run reaches a Node handler and starts work', async () => {
  const channel = await wired()

  let sawRunner = false
  setRunner(async ({ credentials, config, onProgress }) => {
    sawRunner = true
    assert.equal(credentials.key, 'test-key', 'the runner receives credentials in-process')
    assert.ok(Array.isArray(config.browsers))
    onProgress({ storyId: 'a', status: 'pass' })
    return { ok: true, stories: 1 }
  })

  await channel.send(TB_EVENTS.RUN, { scope: 'all' })

  assert.ok(sawRunner, 'the runner was invoked')
  assert.equal(channel.find(TB_EVENTS.RUN_STARTED).length, 1)
  assert.deepEqual(channel.last(TB_EVENTS.RUN_PROGRESS), { storyId: 'a', status: 'pass' })
  assert.deepEqual(channel.last(TB_EVENTS.RUN_FINISHED), { ok: true, stories: 1 })
})

test('a forged channel event is rejected', async () => {
  const channel = await wired()

  let ran = false
  setRunner(async () => { ran = true; return { ok: true } })

  await channel.forge(TB_EVENTS.RUN, { scope: 'all' })

  assert.equal(ran, false, 'a run without a valid nonce must not execute')
  assert.equal(channel.find(TB_EVENTS.RUN_STARTED).length, 0)
  assert.equal(channel.find(TB_EVENTS.RUN_FINISHED).length, 0)
})

test('a forged event cannot write credentials to .env', async () => {
  const channel = await wired()

  let verified = false
  await channel.forge(TB_EVENTS.SAVE_CREDENTIALS, { key: 'x', secret: 'y' })

  assert.equal(verified, false)
  assert.equal(channel.find(TB_EVENTS.CREDENTIALS_SAVED).length, 0, 'handler must not have run')
})

test('a second run while one is in flight is refused, not queued', async () => {
  const channel = await wired()

  let starts = 0
  let release
  const blocked = new Promise((resolve) => { release = resolve })

  setRunner(async () => {
    starts += 1
    await blocked
    return { ok: true }
  })

  const first = channel.send(TB_EVENTS.RUN, { scope: 'all' })
  assert.equal(isRunning(), true, 'the lock is claimed synchronously')

  // Second click while the first is still going.
  await channel.send(TB_EVENTS.RUN, { scope: 'all' })

  assert.equal(starts, 1, 'the runner must not be entered twice')
  const refusal = channel.last(TB_EVENTS.RUN_ERROR)
  assert.equal(refusal.code, 'ALREADY_RUNNING')
  assert.match(refusal.message, /already in progress/i)

  release()
  await first

  assert.equal(isRunning(), false, 'the lock is released when the run finishes')
})

test('the lock is released even when the runner throws', async () => {
  const channel = await wired()

  setRunner(async () => { throw new Error('grid exploded') })
  await channel.send(TB_EVENTS.RUN, {})

  assert.equal(isRunning(), false, 'a thrown runner must not wedge the addon')
  assert.match(channel.last(TB_EVENTS.RUN_ERROR).message, /grid exploded/)

  // And a later run still works.
  setRunner(async () => ({ ok: true }))
  await channel.send(TB_EVENTS.RUN, {})
  assert.deepEqual(channel.last(TB_EVENTS.RUN_FINISHED), { ok: true })
})

test('a run without credentials is refused with an actionable message', async () => {
  const channel = await wired()

  // credentials.cjs reads process.env, the project .env and ~/.testingbot, so
  // "no credentials anywhere" is only reachable if all three are neutralised.
  // Point cwd and HOME at an empty directory rather than skipping, otherwise
  // this path is never exercised on a developer machine.
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'tb-nocreds-'))
  const originalCwd = process.cwd()
  const originalHome = process.env.HOME

  delete process.env.TB_KEY
  delete process.env.TB_SECRET
  process.env.HOME = scratch
  process.chdir(scratch)

  try {
    const { resolveCredentials } = require('../src/server/credentials.cjs')
    assert.equal(resolveCredentials(), null, 'the scratch environment must have no credentials')

    await channel.send(TB_EVENTS.RUN, {})

    const error = channel.last(TB_EVENTS.RUN_ERROR)
    assert.equal(error.code, 'NO_CREDENTIALS')
    assert.match(error.message, /TB_KEY/)
    assert.match(error.message, /~\/.testingbot/)
  } finally {
    process.chdir(originalCwd)
    if (originalHome === undefined) delete process.env.HOME
    else process.env.HOME = originalHome
    fs.rmSync(scratch, { recursive: true, force: true })
  }
})

test('saving credentials writes .env without disturbing other keys', async () => {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'tb-env-'))
  const originalCwd = process.cwd()
  process.chdir(scratch)

  try {
    fs.writeFileSync(path.join(scratch, '.env'), 'EXISTING=keep-me\nTB_KEY=old\n')

    const { setKey, readEnvRaw, writeEnvRaw } = require('../src/server/env.cjs')
    let content = readEnvRaw()
    content = setKey(content, 'TB_KEY', 'new-key')
    content = setKey(content, 'TB_SECRET', 'new-secret')
    writeEnvRaw(content)

    const written = fs.readFileSync(path.join(scratch, '.env'), 'utf8')
    assert.match(written, /EXISTING=keep-me/, 'unrelated keys must survive')
    assert.match(written, /TB_KEY=new-key/)
    assert.match(written, /TB_SECRET=new-secret/)
    assert.ok(!written.includes('TB_KEY=old'), 'the old value must be replaced, not duplicated')

    // The file now holds a secret, so it should not be world readable.
    const mode = fs.statSync(path.join(scratch, '.env')).mode & 0o777
    assert.equal(mode, 0o600, `expected .env to be 0600, got ${mode.toString(8)}`)
  } finally {
    process.chdir(originalCwd)
    fs.rmSync(scratch, { recursive: true, force: true })
  }
})

test('config round-trips through disk and strips unknown keys', async () => {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'tb-config-'))
  const originalCwd = process.cwd()
  process.chdir(scratch)

  try {
    const channel = await wired()

    await channel.send(TB_EVENTS.SAVE_CONFIG, {
      config: {
        browsers: [{ browserName: 'safari', browserVersion: 'latest', platform: 'MOJAVE' }],
        maxDiffPixelRatio: 0.05,
        someTeamSetting: 'keep me',
      },
    })

    assert.equal(channel.last(TB_EVENTS.CONFIG_SAVED).success, true)

    await channel.send(TB_EVENTS.GET_CONFIG, {})
    const { config } = channel.last(TB_EVENTS.CONFIG_LOADED)

    assert.equal(config.browsers[0].browserName, 'safari')
    assert.equal(config.maxDiffPixelRatio, 0.05)
    // The addon does not own this file. A key it has no opinion about must
    // survive a round trip, or pressing Save in the panel would quietly delete
    // something a human put there.
    assert.equal(config.someTeamSetting, 'keep me')
  } finally {
    process.chdir(originalCwd)
    fs.rmSync(scratch, { recursive: true, force: true })
  }
})

test('cancelling an in-flight run reports it as cancelled, not failed', async () => {
  const channel = await wired()

  setRunner(({ signal }) => new Promise((resolve, reject) => {
    signal.addEventListener('abort', () => reject(new Error('aborted')))
  }))

  const run = channel.send(TB_EVENTS.RUN, {})
  await channel.send(TB_EVENTS.CANCEL, {})
  await run

  assert.deepEqual(channel.last(TB_EVENTS.RUN_FINISHED), { ok: false, cancelled: true })
  assert.equal(isRunning(), false)
})

test('credentials never cross the channel', async () => {
  const channel = await wired()
  useTestCredentials('super-secret-key', 'super-secret-value')

  setRunner(async () => ({ ok: true }))

  await channel.send(TB_EVENTS.GET_CREDENTIALS, {})
  await channel.send(TB_EVENTS.GET_STATUS, {})
  await channel.send(TB_EVENTS.GET_CONFIG, {})
  await channel.send(TB_EVENTS.RUN, {})

  const serialised = JSON.stringify(channel.emitted)
  assert.ok(!serialised.includes('super-secret-key'), 'the key must never be emitted')
  assert.ok(!serialised.includes('super-secret-value'), 'the secret must never be emitted')

  // The manager is told only whether credentials exist and where from.
  const status = channel.last(TB_EVENTS.CREDENTIALS_STATUS)
  assert.equal(status.configured, true)
  assert.ok(!('key' in status) && !('secret' in status))
})

test('project config falls back to sane defaults', async () => {
  const channel = await wired()
  await channel.send(TB_EVENTS.GET_CONFIG, {})

  const { config } = channel.last(TB_EVENTS.CONFIG_LOADED)
  assert.ok(Array.isArray(config.browsers) && config.browsers.length >= 1)
  assert.ok(config.maxDiffPixelRatio >= 0 && config.maxDiffPixelRatio <= 1)
})

test('documented TestingBot capabilities pass through to the browser entry', () => {
  const { normaliseConfig } = require('../src/server/projectConfig.cjs')

  // All of these are documented tb:options and all of them matter for visual
  // testing: timeZone and geoCountryCode change how dates and currency render,
  // build groups sessions in CI, screenResolution changes layout.
  const { config, removed } = normaliseConfig({
    browsers: [{
      browserName: 'chrome',
      timeZone: 'Europe/Brussels',
      geoCountryCode: 'BE',
      build: 'ci-42',
      name: 'storybook run',
      screenResolution: '1920x1080',
      recordLogs: true,
    }],
  })

  const browser = config.browsers[0]
  assert.equal(browser.timeZone, 'Europe/Brussels')
  assert.equal(browser.geoCountryCode, 'BE')
  assert.equal(browser.build, 'ci-42')
  assert.equal(browser.screenResolution, '1920x1080')
  assert.equal(browser.recordLogs, true)
  assert.deepEqual(removed, [], 'nothing legitimate should be stripped')
})

test('config cannot override the capabilities the addon owns', () => {
  const { normaliseConfig } = require('../src/server/projectConfig.cjs')

  // Overriding these would either point the run at another account or bind it
  // to a different tunnel, so they are removed and reported rather than obeyed.
  const { config, removed } = normaliseConfig({
    browsers: [{
      browserName: 'chrome',
      key: 'someone-elses-key',
      secret: 'someone-elses-secret',
      tunnelIdentifier: 'someone-elses-tunnel',
      localHttpPorts: [1234],
    }],
  })

  const browser = config.browsers[0]
  for (const reserved of ['key', 'secret', 'tunnelIdentifier', 'localHttpPorts']) {
    assert.ok(!(reserved in browser), `${reserved} must not survive config`)
    assert.ok(removed.includes(reserved), `${reserved} must be reported as removed`)
  }
})

test('addon options from main.js override the config file', () => {
  const { mergeOptions } = require('../src/server/projectConfig.cjs')

  const fileConfig = { browsers: [{ browserName: 'chrome' }], maxDiffPixelRatio: 0.001 }

  // Storybook merges its own keys into the same options object, so only
  // config-shaped keys should be taken from it.
  const merged = mergeOptions(fileConfig, { maxDiffPixelRatio: 0.1, port: 6006, configDir: '/x' })

  assert.equal(merged.maxDiffPixelRatio, 0.1, 'main.js wins over the file')
  assert.ok(!('port' in merged), "Storybook's own options must not leak into config")
  assert.ok(!('configDir' in merged))
})

test('a malformed main.js override does not discard working file config', () => {
  const { mergeOptions } = require('../src/server/projectConfig.cjs')

  const fileConfig = {
    browsers: [{ browserName: 'chrome', timeZone: 'Europe/Brussels', build: 'from-file' }],
    maxDiffPixelRatio: 0.001,
  }

  // Strings instead of objects: nothing usable. Falling back to defaults here
  // would cost the user both their file config and their override, silently.
  const merged = mergeOptions(fileConfig, { browsers: ['not-an-object'] })

  assert.equal(merged.browsers[0].timeZone, 'Europe/Brussels', 'file config must survive')
  assert.equal(merged.browsers[0].build, 'from-file')
})

/** TB-257: the picker runs a selection without rewriting the committed config. */

test('a selection from the picker overrides the config for that run only', async () => {
  const channel = await wired()
  let seen = null

  setRunner(async ({ config, scope, storyId }) => {
    seen = { browsers: config.browsers, scope, storyId }
    return { ok: true }
  })

  await channel.send(TB_EVENTS.RUN, {
    scope: 'component',
    storyId: 'components-button--primary',
    browsers: [
      { browserName: 'edge', browserVersion: 'latest-1', platform: 'WIN11' },
      { browserName: 'chrome', browserVersion: '150', platform: 'WIN10' },
    ],
  })

  assert.deepEqual(seen.browsers, [
    { browserName: 'edge', browserVersion: 'latest-1', platform: 'WIN11' },
    { browserName: 'chrome', browserVersion: '150', platform: 'WIN10' },
  ])
  assert.equal(seen.scope, 'component')
  assert.equal(seen.storyId, 'components-button--primary')
})

test('a selection cannot smuggle credentials or a tunnel identifier into the run', async () => {
  const channel = await wired()
  let seen = null

  setRunner(async ({ config }) => {
    seen = config.browsers
    return { ok: true }
  })

  await channel.send(TB_EVENTS.RUN, {
    scope: 'all',
    browsers: [
      {
        browserName: 'chrome',
        browserVersion: 'latest',
        platform: 'WIN10',
        // A forged event trying to bill another account and reach another
        // machine's tunnel.
        key: 'someone-elses-key',
        secret: 'someone-elses-secret',
        tunnelIdentifier: 'not-ours',
        localHttpPorts: [22],
      },
    ],
  })

  assert.deepEqual(seen, [{ browserName: 'chrome', browserVersion: 'latest', platform: 'WIN10' }])
})

test('no selection in the payload leaves the committed config alone', async () => {
  const channel = await wired({ ...STORYBOOK_OPTIONS, browsers: [{ browserName: 'edge', browserVersion: 'latest', platform: 'WIN11' }] })
  let seen = null

  setRunner(async ({ config }) => {
    seen = config.browsers
    return { ok: true }
  })

  await channel.send(TB_EVENTS.RUN, { scope: 'all' })

  assert.deepEqual(seen, [{ browserName: 'edge', browserVersion: 'latest', platform: 'WIN11' }])
})

test('an empty browser list is not treated as a selection, so it cannot silently run nothing', async () => {
  const channel = await wired()
  let seen = null

  setRunner(async ({ config }) => {
    seen = config.browsers
    return { ok: true }
  })

  await channel.send(TB_EVENTS.RUN, { scope: 'all', browsers: [] })

  assert.ok(seen.length > 0)
})
