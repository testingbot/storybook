/**
 * One Storybook instance plus its own tunnel, run as a separate process so the
 * two-instances test is faithful to what a developer actually does.
 * Prints a single JSON line of results.
 */
import { spawn } from 'node:child_process'
import { setTimeout as sleep } from 'node:timers/promises'
import net from 'node:net'
import { chromium } from 'playwright-core'

import { TunnelManager } from '../dist/index.js'
import { resolveCredentials } from '../dist/index.js'

const PORT = Number(process.argv[2])
const LABEL = process.argv[3]
const STORYBOOK_DIR = '/Users/jochen/test/storybook-testingbot-example'
const credentials = resolveCredentials()
const devServerUrl = `http://localhost:${PORT}`

async function waitForPort(port, timeoutMs = 120_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const open = await new Promise((r) => {
      const s = net.connect({ port, host: '127.0.0.1' })
      s.once('connect', () => { s.destroy(); r(true) })
      s.once('error', () => { s.destroy(); r(false) })
    })
    if (open) return true
    await sleep(1000)
  }
  return false
}

const storybook = spawn('npx', ['storybook', 'dev', '-p', String(PORT), '--no-open', '--quiet'], {
  cwd: STORYBOOK_DIR, stdio: 'ignore', env: { ...process.env },
})

const out = { label: LABEL, port: PORT, tunnelIdentifier: null, storybook: 'n/a', sessionId: null }
const tunnel = new TunnelManager({ credentials, jarPath: process.env.SPIKE_JAR || null, logger: { info() {} } })

try {
  if (!(await waitForPort(PORT))) throw new Error('storybook never started')
  const info = await tunnel.ensureStarted(devServerUrl)
  out.tunnelIdentifier = info.tunnelIdentifier
  out.capability = info.capability

  const caps = {
    browserName: 'chrome', browserVersion: 'latest',
    'tb:options': { key: credentials.key, secret: credentials.secret, platform: 'WIN10', name: LABEL, ...info.capability },
  }
  const ws = `wss://cloud.testingbot.com/playwright?capabilities=${encodeURIComponent(JSON.stringify(caps))}`
  let browser
  try {
    browser = await chromium.connect(ws, { timeout: 180_000 })
    const page = await browser.newPage()
    const r = await page.goto(`${devServerUrl}/iframe.html?id=components-button--primary&viewMode=story`, { waitUntil: 'domcontentloaded', timeout: 25_000 })
    await page.waitForSelector('#storybook-root button', { timeout: 15_000 })
    // Confirm this session reached ITS OWN Storybook, not the sibling's.
    const served = await page.evaluate(() => location.port)
    out.storybook = `HTTP ${r?.status()} rendered, served by port ${served}`
    out.correctInstance = served === String(PORT)
  } catch (e) {
    out.storybook = /ERR_TIMED_OUT/.test(e.message) ? 'ERR_TIMED_OUT' : e.message.split('\n')[0].slice(0, 70)
  } finally { if (browser) await browser.close().catch(() => {}) }
} catch (e) {
  out.storybook = `error ${e.code || ''} ${e.message}`.slice(0, 200)
  out.cause = (e.cause && e.cause.message) ? e.cause.message.slice(0, 200) : null
} finally {
  await tunnel.stop().catch(() => {})
  storybook.kill('SIGINT')
  console.log(`__RESULT__${JSON.stringify(out)}`)
}
