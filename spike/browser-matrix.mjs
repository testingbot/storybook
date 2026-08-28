/**
 * Which browsers the Playwright endpoint actually serves today.
 * TB-256 needs at least two, and firefox did not connect.
 */
import { chromium, firefox, webkit } from 'playwright-core'
import { resolveCredentials } from '../dist/index.js'

const c = resolveCredentials()
const TYPES = { chromium, firefox, webkit }

const CASES = [
  ['chrome', 'latest', 'WIN10', 'chromium'],
  ['edge', 'latest', 'WIN10', 'chromium'],
  ['firefox', 'latest', 'WIN10', 'firefox'],
  ['webkit', 'latest', 'VENTURA', 'webkit'],
  ['chrome', 'latest', 'VENTURA', 'chromium'],
]

for (const [browserName, browserVersion, platform, clientType] of CASES) {
  const caps = {
    browserName, browserVersion,
    'tb:options': { key: c.key, secret: c.secret, platform, name: `TB-256 matrix ${browserName} ${platform}` },
  }
  const ws = `wss://cloud.testingbot.com/playwright?capabilities=${encodeURIComponent(JSON.stringify(caps))}`
  const started = Date.now()
  const label = `${browserName} ${browserVersion} on ${platform} (${clientType})`

  try {
    const browser = await TYPES[clientType].connect(ws, { timeout: 90_000 })
    const page = await browser.newPage()
    await page.goto('https://testingbot.com', { timeout: 60_000 })
    console.log(`${label}: OK in ${((Date.now() - started) / 1000).toFixed(1)}s`)
    await browser.close()
  } catch (e) {
    console.log(`${label}: FAIL after ${((Date.now() - started) / 1000).toFixed(1)}s: ${e.message.split('\n')[0]}`)
  }
}
