/**
 * TB-253 spike, acceptance criterion 1:
 *   "From a stock `npm run storybook` on a random port, a story renders
 *    correctly in a real cloud Chrome with no manual setup."
 *
 * Starts a real Storybook on a randomly chosen non-default port, brings up a
 * tunnel through TunnelManager, then drives a real cloud Chrome at the story
 * and asserts it actually painted.
 */
import { spawn } from 'node:child_process'
import { setTimeout as sleep } from 'node:timers/promises'
import net from 'node:net'
import { chromium } from 'playwright-core'

import { TunnelManager } from '../dist/index.js'
import { resolveCredentials } from '../dist/index.js'

const STORYBOOK_DIR = '/Users/jochen/test/storybook-testingbot-example'
const STORY_ID = process.env.SPIKE_STORY_ID || 'components-button--primary'

function randomPort() {
  // Deliberately outside the tunnel's default proxied set and away from 6006,
  // to prove the port is derived rather than assumed.
  return 7000 + Math.floor(Math.random() * 1500)
}

async function waitForPort(port, timeoutMs = 120_000) {
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

async function main() {
  const credentials = resolveCredentials()
  if (!credentials) throw new Error('No TestingBot credentials found')

  const port = process.env.SPIKE_PORT ? Number(process.env.SPIKE_PORT) : randomPort()
  const devServerUrl = `http://localhost:${port}`
  console.log(`[spike] starting Storybook on ${devServerUrl}`)

  const storybook = spawn('npx', ['storybook', 'dev', '-p', String(port), '--no-open', '--quiet'], {
    cwd: STORYBOOK_DIR,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env },
  })
  storybook.stdout.on('data', (d) => process.env.SPIKE_VERBOSE && console.log('[sb]', d.toString().trim()))
  storybook.stderr.on('data', (d) => process.env.SPIKE_VERBOSE && console.log('[sb!]', d.toString().trim()))

  const tunnel = new TunnelManager({ credentials })
  let browser

  try {
    if (!(await waitForPort(port))) throw new Error(`Storybook never listened on ${port}`)
    console.log('[spike] Storybook is up')

    const t0 = Date.now()
    const info = await tunnel.ensureStarted(devServerUrl, {
      onProgress: (p) => console.log(`[spike] tunnel: ${p.phase}`),
    })
    console.log(`[spike] tunnel ready in ${((Date.now() - t0) / 1000).toFixed(1)}s`)
    console.log('[spike] capability:', JSON.stringify(info.capability))

    const capabilities = {
      browserName: 'chrome',
      browserVersion: 'latest',
      'tb:options': {
        key: credentials.key,
        secret: credentials.secret,
        platform: 'WIN10',
        name: 'TB-253 spike: tunnel lifecycle',
        ...info.capability,
      },
    }

    const wsEndpoint = `wss://cloud.testingbot.com/playwright?capabilities=${encodeURIComponent(JSON.stringify(capabilities))}`
    console.log('[spike] connecting to cloud Chrome')
    browser = await chromium.connect(wsEndpoint, { timeout: 180_000 })

    const page = await browser.newPage()
    const storyUrl = `${devServerUrl}/iframe.html?id=${STORY_ID}&viewMode=story`
    console.log(`[spike] cloud browser opening ${storyUrl}`)

    // Diagnostic: is the intermittent ERR_TIMED_OUT permanent for the session,
    // or a warm-up race between session start and the VM opening the
    // localHttpPorts listener? Retry and record which attempt succeeds.
    let response = null
    for (let attempt = 1; attempt <= 6; attempt += 1) {
      const started = Date.now()
      try {
        response = await page.goto(storyUrl, { waitUntil: 'domcontentloaded', timeout: 20_000 })
        console.log(`[spike] goto attempt ${attempt}: HTTP ${response?.status()} after ${((Date.now() - started) / 1000).toFixed(1)}s`)
        break
      } catch (error) {
        console.log(`[spike] goto attempt ${attempt}: ${error.message.split('\n')[0]} after ${((Date.now() - started) / 1000).toFixed(1)}s`)
        if (attempt === 6) throw error
        await sleep(5000)
      }
    }

    await page.waitForSelector('#storybook-root', { timeout: 30_000 })
    await page.evaluate(() => document.fonts.ready)

    const box = await page.locator('#storybook-root').boundingBox()
    const html = await page.locator('#storybook-root').innerHTML()
    const buttonCount = await page.locator('#storybook-root button').count()
    const buttonText = buttonCount ? await page.locator('#storybook-root button').first().innerText() : ''

    console.log(`[spike] box=${JSON.stringify(box)}`)
    console.log(`[spike] buttons=${buttonCount} firstButtonText=${JSON.stringify(buttonText)}`)
    console.log(`[spike] innerHTML=${JSON.stringify(html.slice(0, 400))}`)

    const shot = await page.screenshot({ animations: 'disabled', fullPage: true })
    console.log(`[spike] screenshot bytes=${shot.length}`)

    if (!box || box.width < 1 || box.height < 1) {
      throw new Error('Story container had no layout box in the cloud browser')
    }
    if (buttonCount < 1) {
      throw new Error('Story markup never mounted in the cloud browser')
    }

    console.log('\n[spike] RESULT: PASS - story rendered in real cloud Chrome via tunnel')
  } finally {
    if (browser) await browser.close().catch(() => {})
    await tunnel.stop().catch((e) => console.log('[spike] stop error', e.message))
    console.log(`[spike] tunnel state after stop: ${tunnel.state}`)
    storybook.kill('SIGINT')
  }
}

main().catch((error) => {
  console.error(`\n[spike] RESULT: FAIL - ${error.code || ''} ${error.message}`)
  process.exitCode = 1
})
