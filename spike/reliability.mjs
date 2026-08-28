/**
 * Quantifies tunnel reliability and looks for a signal that predicts a bad one.
 *
 * Each iteration: start a fresh tunnel, ask the TestingBot API what it thinks of
 * that tunnel, then run one cloud session and see whether it can reach anything
 * at all. Records both so we can test for correlation.
 */
import { spawn } from 'node:child_process'
import { setTimeout as sleep } from 'node:timers/promises'
import net from 'node:net'
import { chromium } from 'playwright-core'

import { TunnelManager } from '../dist/index.js'
import { resolveCredentials } from '../dist/index.js'

const STORYBOOK_DIR = '/Users/jochen/test/storybook-testingbot-example'
const ITERATIONS = Number(process.env.SPIKE_ITERATIONS || 5)
const PORT = Number(process.env.SPIKE_PORT || 7411)
const credentials = resolveCredentials()
const auth = Buffer.from(`${credentials.key}:${credentials.secret}`).toString('base64')
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

async function tunnelList() {
  try {
    const r = await fetch('https://api.testingbot.com/v1/tunnel/list', { headers: { Authorization: `Basic ${auth}` } })
    return await r.json()
  } catch (e) { return `error ${e.message}` }
}

const storybook = spawn('npx', ['storybook', 'dev', '-p', String(PORT), '--no-open', '--quiet'], {
  cwd: STORYBOOK_DIR, stdio: 'ignore', env: { ...process.env },
})

const rows = []
try {
  if (!(await waitForPort(PORT))) throw new Error('Storybook never started')
  console.log(`[rel] Storybook up on ${devServerUrl}\n`)

  for (let i = 1; i <= ITERATIONS; i += 1) {
    const tunnel = new TunnelManager({ credentials })
    let apiState = 'n/a'
    let outcome = 'n/a'
    let publicOutcome = 'n/a'

    try {
      const info = await tunnel.ensureStarted(devServerUrl)
      const list = await tunnelList()
      apiState = Array.isArray(list)
        ? list.map((t) => `${t.tunnel_identifier || t.identifier || '?'}:${t.state || t.status || '?'}`).join(',') || 'empty'
        : String(apiState)

      const caps = {
        browserName: 'chrome', browserVersion: 'latest',
        'tb:options': { key: credentials.key, secret: credentials.secret, platform: 'WIN10', name: `TB-253 reliability ${i}`, ...info.capability },
      }
      const ws = `wss://cloud.testingbot.com/playwright?capabilities=${encodeURIComponent(JSON.stringify(caps))}`

      let browser
      try {
        browser = await chromium.connect(ws, { timeout: 180_000 })
        const page = await browser.newPage()
        try {
          const r = await page.goto('https://testingbot.com/', { waitUntil: 'domcontentloaded', timeout: 20_000 })
          publicOutcome = `HTTP ${r?.status()}`
        } catch (e) { publicOutcome = /ERR_TIMED_OUT/.test(e.message) ? 'TIMEOUT' : 'ERR' }
        try {
          const r = await page.goto(`${devServerUrl}/index.json`, { waitUntil: 'domcontentloaded', timeout: 20_000 })
          outcome = `HTTP ${r?.status()}`
        } catch (e) { outcome = /ERR_TIMED_OUT/.test(e.message) ? 'TIMEOUT' : 'ERR' }
      } finally { if (browser) await browser.close().catch(() => {}) }
    } catch (e) {
      outcome = `tunnel error ${e.code || e.message}`
    } finally {
      await tunnel.stop().catch(() => {})
    }

    rows.push({ i, apiState, publicOutcome, storybook: outcome })
    console.log(`[rel] ${i}: api=[${apiState}] public=${publicOutcome} storybook=${outcome}`)
    await sleep(2000)
  }
} finally {
  storybook.kill('SIGINT')
  const ok = rows.filter((r) => String(r.storybook).startsWith('HTTP 2')).length
  console.log(`\n[rel] SUMMARY: ${ok}/${rows.length} tunnels delivered a working session`)
  console.table(rows)
}
