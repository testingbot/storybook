import { chromium, firefox } from 'playwright-core'
import { resolveCredentials } from '../dist/index.js'

const c = resolveCredentials()

async function attempt (label, type, ws) {
  const started = Date.now()
  try {
    const browser = await type.connect(ws, { timeout: 90_000 })
    const page = await browser.newPage()
    await page.goto('https://testingbot.com', { timeout: 60_000 })
    console.log(`${label}: OK in ${((Date.now() - started) / 1000).toFixed(1)}s, title=${await page.title()}`)
    await browser.close()
  } catch (e) {
    console.log(`${label}: FAIL after ${((Date.now() - started) / 1000).toFixed(1)}s: ${e.message.split('\n')[0]}`)
  }
}

const capsWs = (caps) =>
  `wss://cloud.testingbot.com/playwright?capabilities=${encodeURIComponent(JSON.stringify(caps))}`

const queryWs = (browserName) =>
  `wss://cloud.testingbot.com/playwright?key=${c.key}&secret=${c.secret}&browserName=${browserName}&browserVersion=latest`

await attempt('chrome via capabilities', chromium, capsWs({
  browserName: 'chrome', browserVersion: 'latest',
  'tb:options': { key: c.key, secret: c.secret, platform: 'WIN10', name: 'probe chrome caps' },
}))

await attempt('firefox via query string', firefox, queryWs('firefox'))

await attempt('firefox via capabilities, no platform', firefox, capsWs({
  browserName: 'firefox', browserVersion: 'latest',
  'tb:options': { key: c.key, secret: c.secret, name: 'probe ff no platform' },
}))
