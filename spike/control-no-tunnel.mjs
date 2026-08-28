/**
 * Control: is the intermittent total-network-loss tied to having a tunnel bound?
 *
 * Runs N sessions WITHOUT any tunnelIdentifier and navigates to a public URL.
 * A clean sweep here means the grid itself is fine and the tunnel proxy binding
 * is the flaky component.
 */
import { chromium } from 'playwright-core'
import { resolveCredentials } from '../dist/index.js'

const credentials = resolveCredentials()
const SESSIONS = Number(process.env.SPIKE_SESSIONS || 5)
const results = []

for (let i = 1; i <= SESSIONS; i += 1) {
  const caps = {
    browserName: 'chrome',
    browserVersion: 'latest',
    'tb:options': {
      key: credentials.key,
      secret: credentials.secret,
      platform: 'WIN10',
      name: `TB-253 control (no tunnel) ${i}`,
    },
  }
  const ws = `wss://cloud.testingbot.com/playwright?capabilities=${encodeURIComponent(JSON.stringify(caps))}`
  let browser
  const t0 = Date.now()
  try {
    browser = await chromium.connect(ws, { timeout: 180_000 })
    const page = await browser.newPage()
    const r = await page.goto('https://testingbot.com/', { waitUntil: 'domcontentloaded', timeout: 25_000 })
    results.push(`HTTP ${r?.status()}`)
    console.log(`[ctl] session ${i}: HTTP ${r?.status()} in ${((Date.now() - t0) / 1000).toFixed(1)}s`)
  } catch (e) {
    const reason = /ERR_TIMED_OUT/.test(e.message) ? 'ERR_TIMED_OUT' : e.message.split('\n')[0]
    results.push(reason)
    console.log(`[ctl] session ${i}: FAIL ${reason} in ${((Date.now() - t0) / 1000).toFixed(1)}s`)
  } finally {
    if (browser) await browser.close().catch(() => {})
  }
}

const ok = results.filter((r) => r.startsWith('HTTP 2')).length
console.log(`\n[ctl] SUMMARY (no tunnel): ${ok}/${results.length} reached the public internet -> ${JSON.stringify(results)}`)
