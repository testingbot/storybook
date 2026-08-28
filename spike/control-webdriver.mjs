/**
 * Isolates whether the tunnel-bound network failure is specific to the
 * Playwright entry point (wss://cloud.testingbot.com/playwright) or affects any
 * session with a tunnel bound.
 *
 * Same tunnel, same account, same capability - but a W3C WebDriver session
 * against hub.testingbot.com instead.
 */
import { setTimeout as sleep } from 'node:timers/promises'
import { chromium } from 'playwright-core'

import { TunnelManager } from '../dist/index.js'
import { resolveCredentials } from '../dist/index.js'

const credentials = resolveCredentials()
const auth = Buffer.from(`${credentials.key}:${credentials.secret}`).toString('base64')
const HUB = 'https://hub.testingbot.com/wd/hub'
const ROUNDS = Number(process.env.SPIKE_ROUNDS || 3)
const devServerUrl = 'http://localhost:7411'

async function wd(method, path, body) {
  const r = await fetch(`${HUB}${path}`, {
    method,
    headers: { Authorization: `Basic ${auth}`, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  })
  return { status: r.status, json: await r.json().catch(() => ({})) }
}

async function webdriverProbe(capability, label) {
  const created = await wd('POST', '/session', {
    capabilities: {
      alwaysMatch: {
        browserName: 'chrome',
        browserVersion: 'latest',
        platformName: 'WIN10',
        'tb:options': { key: credentials.key, secret: credentials.secret, name: label, ...capability },
      },
    },
  })

  const sessionId = created.json?.value?.sessionId
  if (!sessionId) return `session create failed (${created.status})`

  try {
    await wd('POST', `/session/${sessionId}/url`, { url: 'https://testingbot.com/' })
    await sleep(3000)
    const pub = await wd('GET', `/session/${sessionId}/url`)
    const publicUrl = pub.json?.value || ''

    await wd('POST', `/session/${sessionId}/url`, { url: `${devServerUrl}/index.json` })
    await sleep(3000)
    const src = await wd('GET', `/session/${sessionId}/source`)
    const source = String(src.json?.value || '')
    const tunnelOk = /entries|stories|storybook/i.test(source) ? 'REACHED' : 'NOT REACHED'

    return `public=${publicUrl.includes('testingbot.com') ? 'OK' : 'FAILED(' + publicUrl + ')'} tunnelledLocalhost=${tunnelOk}`
  } finally {
    await wd('DELETE', `/session/${sessionId}`).catch(() => {})
  }
}

const tunnel = new TunnelManager({ credentials })
try {
  const info = await tunnel.ensureStarted(devServerUrl)
  console.log(`[wd] tunnel ${info.tunnelIdentifier}, capability ${JSON.stringify(info.capability)}\n`)

  for (let i = 1; i <= ROUNDS; i += 1) {
    console.log(`[wd] webdriver round ${i}: ${await webdriverProbe(info.capability, `TB-253 wd control ${i}`)}`)

    // Interleave a Playwright session against the same tunnel for comparison.
    const caps = {
      browserName: 'chrome', browserVersion: 'latest',
      'tb:options': { key: credentials.key, secret: credentials.secret, platform: 'WIN10', name: `TB-253 pw compare ${i}`, ...info.capability },
    }
    const ws = `wss://cloud.testingbot.com/playwright?capabilities=${encodeURIComponent(JSON.stringify(caps))}`
    let browser, verdict = 'n/a'
    try {
      browser = await chromium.connect(ws, { timeout: 180_000 })
      const page = await browser.newPage()
      try {
        const r = await page.goto('https://testingbot.com/', { waitUntil: 'domcontentloaded', timeout: 20_000 })
        verdict = `public=HTTP ${r?.status()}`
      } catch (e) { verdict = /ERR_TIMED_OUT/.test(e.message) ? 'public=TIMEOUT' : 'public=ERR' }
    } catch { verdict = 'connect failed' }
    finally { if (browser) await browser.close().catch(() => {}) }
    console.log(`[wd] playwright round ${i}: ${verdict}\n`)
  }
} finally {
  await tunnel.stop().catch(() => {})
}
