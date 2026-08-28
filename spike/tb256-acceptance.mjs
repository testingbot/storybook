/**
 * TB-256 acceptance criteria, run against the real grid.
 *
 *   node spike/tb256-acceptance.mjs baseline   first run, creates baselines
 *   node spike/tb256-acceptance.mjs repeat     re-run with no change
 *   node spike/tb256-acceptance.mjs change     deliberate CSS change
 *   node spike/tb256-acceptance.mjs cancel     cancel mid-run
 *
 * The example project has exactly 15 stories, and the config below uses two
 * browsers, which is the criterion as written.
 */
import { spawn } from 'node:child_process'
import { setTimeout as sleep } from 'node:timers/promises'
import fs from 'node:fs'
import net from 'node:net'
import path from 'node:path'

import { runOnGrid, resolveCredentials } from '../dist/index.js'

const STORYBOOK_DIR = '/Users/jochen/test/storybook-testingbot-example'
const CSS_FILE = path.join(STORYBOOK_DIR, 'src/components/styles.css')
const PROJECT_ROOT = process.env.TB256_ROOT || '/private/tmp/claude-501/tb256-acceptance'

const CONFIG = {
  browsers: [
    { browserName: 'chrome', browserVersion: 'latest', platform: 'WIN10' },
    // Edge rather than Firefox: Firefox and WebKit sessions start on the grid
    // but never complete the Playwright connect handshake, while the same
    // Firefox works through WebDriver. See spike/firefox-isolate.mjs.
    { browserName: 'edge', browserVersion: 'latest', platform: 'WIN10' },
  ],
  devices: [],
  include: [],
  exclude: [],
  maxDiffPixelRatio: Number(process.env.TB256_TOLERANCE ?? 0.001),
}

const phase = process.argv[2] || 'baseline'

function randomPort () {
  return 7000 + Math.floor(Math.random() * 1500)
}

async function waitForPort (port, timeoutMs = 120_000) {
  const deadline = Date.now() + timeoutMs

  while (Date.now() < deadline) {
    const open = await new Promise((resolve) => {
      const socket = net.connect({ port, host: '127.0.0.1' })
      socket.once('connect', () => { socket.destroy(); resolve(true) })
      socket.once('error', () => { socket.destroy(); resolve(false) })
    })

    if (open) return true
    await sleep(1000)
  }

  return false
}

async function withStorybook (fn) {
  const port = randomPort()
  const devServerUrl = `http://localhost:${port}`

  console.log(`[tb256] starting Storybook on ${devServerUrl}`)

  const storybook = spawn('npx', ['storybook', 'dev', '-p', String(port), '--no-open', '--quiet'], {
    cwd: STORYBOOK_DIR,
    env: { ...process.env },
  })

  try {
    if (!await waitForPort(port)) throw new Error('Storybook never came up')
    return await fn(devServerUrl)
  } finally {
    storybook.kill('SIGINT')
  }
}

function summarise (result) {
  console.log(`[tb256] totals ${JSON.stringify(result.totals)} ok=${result.ok} cancelled=${result.cancelled}`)

  for (const target of result.targets) {
    console.log(`[tb256]   ${target.label} session=${target.sessionId}`)
  }

  for (const story of result.stories.filter((s) => s.outcome !== 'passed')) {
    const ratio = story.diffPixelRatio === undefined ? '' : ` ratio=${story.diffPixelRatio.toFixed(5)}`
    console.log(`[tb256]   ${story.outcome} ${story.target} ${story.storyId}${ratio} ${story.message || ''}`)
  }
}

async function run (signal) {
  const credentials = resolveCredentials()

  if (!credentials) throw new Error('No TestingBot credentials found')

  return withStorybook((devServerUrl) => runOnGrid({
    credentials,
    config: CONFIG,
    devServerUrl,
    signal,
    projectRoot: PROJECT_ROOT,
    onProgress: (event) => {
      if (event.phase === 'story') {
        console.log(`[tb256] ${event.index}/${event.total} ${event.result.target} ${event.result.storyId} ${event.result.outcome}`)
      } else {
        console.log(`[tb256] ${event.phase} ${JSON.stringify(event)}`)
      }
    },
  }))
}

function expect (condition, message) {
  console.log(`${condition ? '[tb256] PASS' : '[tb256] FAIL'} ${message}`)
  if (!condition) process.exitCode = 1
}

async function main () {
  if (phase === 'baseline') {
    fs.rmSync(PROJECT_ROOT, { recursive: true, force: true })

    const result = await run(new AbortController().signal)
    summarise(result)

    expect(result.stories.length === 30, `30 screenshots taken, got ${result.stories.length}`)
    expect(result.totals.new === 30, `all 30 are new baselines, got ${result.totals.new}`)
    expect(result.totals.failed === 0, 'no story failed to render')
    expect(result.targets.every((t) => t.sessionId), 'a session id was captured for each browser')
    return
  }

  if (phase === 'repeat') {
    const result = await run(new AbortController().signal)
    summarise(result)

    expect(result.totals.diff === 0, `zero diffs on an unchanged re-run, got ${result.totals.diff}`)
    expect(result.totals.passed === 30, `all 30 matched, got ${result.totals.passed}`)
    expect(result.ok === true, 'the run reports ok')
    return
  }

  if (phase === 'change') {
    const original = fs.readFileSync(CSS_FILE, 'utf8')

    try {
      // One visible change, not a rewrite: this must be caught, and the
      // stories that do not use buttons must stay green.
      fs.writeFileSync(CSS_FILE, `${original}\n.tb-button { border-radius: 18px; letter-spacing: 3px; }\n`)

      const result = await run(new AbortController().signal)
      summarise(result)

      expect(result.totals.diff > 0, `the CSS change was caught, ${result.totals.diff} diffs`)
      expect(result.ok === false, 'the run reports not ok')
      expect(result.totals.passed > 0, 'stories unaffected by the change stayed green')
    } finally {
      fs.writeFileSync(CSS_FILE, original)
    }

    return
  }

  if (phase === 'cancel') {
    const controller = new AbortController()
    const started = Date.now()

    setTimeout(() => {
      console.log('[tb256] cancelling')
      controller.abort()
    }, 45_000)

    const result = await run(controller.signal)
    const elapsed = (Date.now() - started) / 1000

    summarise(result)
    console.log(`[tb256] returned after ${elapsed.toFixed(1)}s`)

    expect(result.cancelled === true, 'the run reports itself cancelled')
    expect(result.stories.length < 30, `it stopped early, took ${result.stories.length} of 30`)
    expect(elapsed < 120, `it returned promptly after the cancel, ${elapsed.toFixed(1)}s`)

    // The criterion is that grid sessions are actually torn down, not merely
    // that the local loop stopped. Ask the API what state they are in.
    const credentials = resolveCredentials()
    const auth = `Basic ${Buffer.from(`${credentials.key}:${credentials.secret}`).toString('base64')}`

    await sleep(15_000)

    for (const target of result.targets) {
      if (!target.sessionId) continue

      const response = await fetch(`https://api.testingbot.com/v1/tests/${target.sessionId}`, {
        headers: { Authorization: auth },
      })
      const test = await response.json()

      console.log(`[tb256]   ${target.label} state=${test.state} duration=${test.duration}`)
      expect(test.state !== 'START', `${target.label} is no longer running`)
    }

    const user = await (await fetch('https://api.testingbot.com/v1/user', { headers: { Authorization: auth } })).json()

    console.log(`[tb256] concurrency after cancel: vm=${user.current_vm_concurrency}/${user.max_concurrent}`)
    expect(user.current_vm_concurrency === 0, 'no grid session is left running')
    return
  }

  throw new Error(`unknown phase ${phase}`)
}

main().catch((error) => {
  console.error(`[tb256] ERROR ${error.code || ''} ${error.message}`)
  process.exitCode = 1
})
