/**
 * Same audit as teardown-audit, but with a real grid session bound to the
 * tunnel before it is torn down. This is what the addon actually does after a
 * run, and it is the only difference between the clean teardown audit and the
 * reliability run that produced a null-identifier zombie.
 */
import { execSync } from 'node:child_process'
import { setTimeout as sleep } from 'node:timers/promises'
import { chromium } from 'playwright-core'

import { TunnelManager } from '../dist/index.js'
import { resolveCredentials } from '../dist/index.js'

const credentials = resolveCredentials()
const auth = Buffer.from(`${credentials.key}:${credentials.secret}`).toString('base64')
const CYCLES = Number(process.env.SPIKE_CYCLES || 3)
const devServerUrl = 'http://localhost:7411'

const localTunnels = () => {
  try { return Number(execSync('ps -eo command | grep -c "[t]estingbot-tunnel.jar"').toString().trim()) }
  catch { return 0 }
}
const serverTunnels = async () => {
  const r = await fetch('https://api.testingbot.com/v1/tunnel/list', { headers: { Authorization: `Basic ${auth}` } })
  const list = await r.json()
  return Array.isArray(list) ? list.map((t) => `id=${t.id} identifier=${t.identifier} state=${t.state}`) : [String(list)]
}

console.log(`baseline: local=${localTunnels()} server=${JSON.stringify(await serverTunnels())}\n`)

for (let i = 1; i <= CYCLES; i += 1) {
  const tunnel = new TunnelManager({ credentials })
  const info = await tunnel.ensureStarted(devServerUrl)
  console.log(`cycle ${i}: tunnel ${info.tunnelIdentifier}`)

  const caps = {
    browserName: 'chrome', browserVersion: 'latest',
    'tb:options': { key: credentials.key, secret: credentials.secret, platform: 'WIN10', name: `TB-253 teardown+session ${i}`, ...info.capability },
  }
  const ws = `wss://cloud.testingbot.com/playwright?capabilities=${encodeURIComponent(JSON.stringify(caps))}`

  let browser
  let reach = 'n/a'
  try {
    browser = await chromium.connect(ws, { timeout: 180_000 })
    const page = await browser.newPage()
    try {
      const r = await page.goto('https://testingbot.com/', { waitUntil: 'domcontentloaded', timeout: 20_000 })
      reach = `HTTP ${r?.status()}`
    } catch (e) { reach = /ERR_TIMED_OUT/.test(e.message) ? 'TIMEOUT' : 'ERR' }
  } catch (e) { reach = `connect failed` }
  finally { if (browser) await browser.close().catch(() => {}) }

  console.log(`  session reachability: ${reach}`)
  console.log(`  before stop : local=${localTunnels()} server=${JSON.stringify(await serverTunnels())}`)

  await tunnel.stop()
  await sleep(5000)
  console.log(`  after stop  : local=${localTunnels()} server=${JSON.stringify(await serverTunnels())}\n`)
}

console.log(`final: local=${localTunnels()} server=${JSON.stringify(await serverTunnels())}`)
