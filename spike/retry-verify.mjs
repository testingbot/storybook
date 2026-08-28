/**
 * Re-runs the TB-253 measurement after the platform-side changes.
 *
 * Each iteration: fresh tunnel, one Playwright session against a real Storybook,
 * probing both the public internet and the tunnelled localhost port. Every
 * session carries a unique name so its TestingBot session id can be recovered
 * from /v1/tests afterwards and quoted in the bug report.
 */
import { spawn } from 'node:child_process'
import { setTimeout as sleep } from 'node:timers/promises'
import net from 'node:net'
import { createRequire } from 'node:module'
import { chromium } from 'playwright-core'

const require = createRequire(import.meta.url)

import { TunnelManager } from '../dist/index.js'
import { resolveCredentials } from '../dist/index.js'

const STORYBOOK_DIR = '/Users/jochen/test/storybook-testingbot-example'
const ITERATIONS = Number(process.env.SPIKE_ITERATIONS || 6)
const PORT = Number(process.env.SPIKE_PORT || 7411)
const RUN_TAG = `TB253-retry-${Date.now()}`

const credentials = resolveCredentials()
const auth = Buffer.from(`${credentials.key}:${credentials.secret}`).toString('base64')
const devServerUrl = `http://localhost:${PORT}`
const storyUrl = `${devServerUrl}/iframe.html?id=components-button--primary&viewMode=story`

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

const api = async (path) => {
  const r = await fetch(`https://api.testingbot.com/v1${path}`, { headers: { Authorization: `Basic ${auth}` } })
  return r.json()
}

const storybook = spawn('npx', ['storybook', 'dev', '-p', String(PORT), '--no-open', '--quiet'], {
  cwd: STORYBOOK_DIR, stdio: 'ignore', env: { ...process.env },
})

const rows = []

try {
  if (!(await waitForPort(PORT))) throw new Error('Storybook never started')
  console.log(`[retry] Storybook up on ${devServerUrl}`)
  console.log(`[retry] run tag ${RUN_TAG}`)
  console.log(`[retry] launcher ${require('testingbot-tunnel-launcher/package.json').version}, jar ${process.env.SPIKE_JAR || 'downloaded'}\n`)

  for (let i = 1; i <= ITERATIONS; i += 1) {
    const label = `${RUN_TAG} #${i}`
    const tunnel = new TunnelManager({ credentials, jarPath: process.env.SPIKE_JAR || null })
    const row = { i, label, tunnelIdentifier: null, serverTunnelId: null, public: 'n/a', storybook: 'n/a', sessionId: null }

    try {
      const info = await tunnel.ensureStarted(devServerUrl)
      row.tunnelIdentifier = info.tunnelIdentifier

      const list = await api('/tunnel/list')
      const mine = Array.isArray(list) ? list.find((t) => t.identifier === info.tunnelIdentifier) : null
      row.serverTunnelId = mine ? mine.id : 'not-listed'

      const caps = {
        browserName: 'chrome',
        browserVersion: 'latest',
        'tb:options': {
          key: credentials.key, secret: credentials.secret,
          platform: 'WIN10', name: label, ...info.capability,
        },
      }
      const ws = `wss://cloud.testingbot.com/playwright?capabilities=${encodeURIComponent(JSON.stringify(caps))}`

      let browser
      try {
        browser = await chromium.connect(ws, { timeout: 180_000 })
        const page = await browser.newPage()

        try {
          const r = await page.goto('https://testingbot.com/', { waitUntil: 'domcontentloaded', timeout: 20_000 })
          row.public = `HTTP ${r?.status()}`
        } catch (e) { row.public = /ERR_TIMED_OUT/.test(e.message) ? 'ERR_TIMED_OUT' : e.message.split('\n')[0].slice(0, 60) }

        try {
          const r = await page.goto(storyUrl, { waitUntil: 'domcontentloaded', timeout: 20_000 })
          await page.waitForSelector('#storybook-root button', { timeout: 15_000 })
          row.storybook = `HTTP ${r?.status()} rendered`
        } catch (e) { row.storybook = /ERR_TIMED_OUT/.test(e.message) ? 'ERR_TIMED_OUT' : e.message.split('\n')[0].slice(0, 60) }
      } catch (e) {
        row.storybook = `connect failed: ${e.message.split('\n')[0].slice(0, 60)}`
      } finally {
        if (browser) await browser.close().catch(() => {})
      }
    } catch (e) {
      row.storybook = `tunnel error ${e.code || e.message}`
    } finally {
      await tunnel.stop().catch(() => {})
    }

    rows.push(row)
    console.log(`[retry] ${i}: tunnel=${row.tunnelIdentifier} (id ${row.serverTunnelId}) public=${row.public} storybook=${row.storybook}`)
    await sleep(2000)
  }

  // Recover the TestingBot session ids for this run.
  console.log('\n[retry] resolving session ids from /v1/tests ...')
  await sleep(8000)
  const tests = await api(`/tests?count=${ITERATIONS * 3}`)
  const data = tests?.data || []
  for (const row of rows) {
    const match = data.find((t) => t.name === row.label)
    if (match) {
      row.sessionId = match.session_id
      row.testId = match.id
      row.browserDisplay = match.browser_display_name
      row.tbSuccess = match.success
    }
  }
} finally {
  storybook.kill('SIGINT')

  const ok = rows.filter((r) => String(r.storybook).includes('rendered')).length
  console.log(`\n[retry] ================ RESULT ================`)
  console.log(`[retry] ${ok}/${rows.length} sessions rendered the story through the tunnel`)
  console.log(`[retry] (previous measurement on 2026-08-25 was 13/34 = 38%)\n`)

  for (const r of rows) {
    console.log(`#${r.i}  ${String(r.storybook).includes('rendered') ? 'PASS' : 'FAIL'}`)
    console.log(`    name           : ${r.label}`)
    console.log(`    tunnel         : ${r.tunnelIdentifier} (server tunnel id ${r.serverTunnelId})`)
    console.log(`    public internet: ${r.public}`)
    console.log(`    storybook      : ${r.storybook}`)
    console.log(`    session id     : ${r.sessionId || 'not resolved'}`)
    console.log(`    test id        : ${r.testId || 'n/a'}   browser: ${r.browserDisplay || 'n/a'}`)
  }

  console.log(`\n[retry] local tunnel processes left: ${(await import('node:child_process')).execSync('ps -eo command | grep -c "[t]estingbot-tunnel.jar" || true').toString().trim()}`)
  console.log(`[retry] server tunnels left: ${JSON.stringify(await api('/tunnel/list'))}`)
}
