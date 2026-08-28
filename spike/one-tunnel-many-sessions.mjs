/**
 * Isolates the variable behind the intermittent ERR_TIMED_OUT.
 *
 * Holds a single tunnel up for the whole run and opens N sequential cloud
 * browser sessions against it. If every session reaches Storybook, the
 * flakiness tracks tunnel churn (a fresh tunnel per run). If sessions still
 * fail at roughly the same rate, it is per-session variance on the grid.
 */
import { spawn } from 'node:child_process'
import { setTimeout as sleep } from 'node:timers/promises'
import net from 'node:net'
import { chromium } from 'playwright-core'

import { TunnelManager } from '../dist/index.js'
import { resolveCredentials } from '../dist/index.js'

const STORYBOOK_DIR = '/Users/jochen/test/storybook-testingbot-example'
const SESSIONS = Number(process.env.SPIKE_SESSIONS || 5)
const PORT = Number(process.env.SPIKE_PORT || 7000 + Math.floor(Math.random() * 1500))

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

const credentials = resolveCredentials()
const devServerUrl = `http://localhost:${PORT}`
const storyUrl = `${devServerUrl}/iframe.html?id=components-button--primary&viewMode=story`

console.log(`[exp] Storybook on ${devServerUrl}, ${SESSIONS} sequential sessions, one tunnel`)

const storybook = spawn('npx', ['storybook', 'dev', '-p', String(PORT), '--no-open', '--quiet'], {
  cwd: STORYBOOK_DIR, stdio: 'ignore', env: { ...process.env },
})

const tunnel = new TunnelManager({ credentials })
const results = []

try {
  if (!(await waitForPort(PORT))) throw new Error('Storybook never started')
  const info = await tunnel.ensureStarted(devServerUrl)
  console.log(`[exp] tunnel ${info.tunnelIdentifier} ready; capability ${JSON.stringify(info.capability)}`)

  const warmupMs = Number(process.env.SPIKE_WARMUP_MS || 0)
  if (warmupMs) {
    console.log(`[exp] waiting ${warmupMs / 1000}s after tunnel ready before first session`)
    await sleep(warmupMs)
  }

  for (let i = 1; i <= SESSIONS; i += 1) {
    const capabilities = {
      browserName: 'chrome',
      browserVersion: 'latest',
      'tb:options': {
        key: credentials.key,
        secret: credentials.secret,
        platform: 'WIN10',
        name: `TB-253 one-tunnel session ${i}`,
        ...info.capability,
      },
    }
    const ws = `wss://cloud.testingbot.com/playwright?capabilities=${encodeURIComponent(JSON.stringify(capabilities))}`

    let browser
    const started = Date.now()
    try {
      browser = await chromium.connect(ws, { timeout: 180_000 })
      const page = await browser.newPage()
      const response = await page.goto(storyUrl, { waitUntil: 'domcontentloaded', timeout: 25_000 })
      const ok = response?.status() === 200
      results.push(ok ? 'PASS' : `HTTP ${response?.status()}`)
      console.log(`[exp] session ${i}: ${ok ? 'PASS' : 'HTTP ' + response?.status()} in ${((Date.now() - started) / 1000).toFixed(1)}s`)
    } catch (error) {
      const reason = /ERR_TIMED_OUT/.test(error.message) ? 'ERR_TIMED_OUT' : error.message.split('\n')[0]
      results.push(reason)
      console.log(`[exp] session ${i}: FAIL ${reason} in ${((Date.now() - started) / 1000).toFixed(1)}s`)
    } finally {
      if (browser) await browser.close().catch(() => {})
    }
  }
} finally {
  await tunnel.stop().catch(() => {})
  storybook.kill('SIGINT')
  const passes = results.filter((r) => r === 'PASS').length
  console.log(`\n[exp] SUMMARY: ${passes}/${results.length} sessions reached Storybook -> ${JSON.stringify(results)}`)
}
