/**
 * Is the Firefox failure specific to the Playwright endpoint?
 *
 * Same question TB-253 answered for the tunnel: run the identical browser
 * through WebDriver, which uses a different entry point into the same grid.
 */
import { firefox } from 'playwright-core'
import { resolveCredentials } from '../dist/index.js'

const c = resolveCredentials()

async function viaPlaywright () {
  const caps = {
    browserName: 'firefox', browserVersion: 'latest',
    'tb:options': { key: c.key, secret: c.secret, platform: 'WIN10', name: 'TB-256 firefox playwright 240s' },
  }
  const ws = `wss://cloud.testingbot.com/playwright?capabilities=${encodeURIComponent(JSON.stringify(caps))}`
  const started = Date.now()

  try {
    const browser = await firefox.connect(ws, { timeout: 240_000 })
    const page = await browser.newPage()
    await page.goto('https://testingbot.com', { timeout: 60_000 })
    console.log(`playwright firefox: OK in ${((Date.now() - started) / 1000).toFixed(1)}s`)
    await browser.close()
  } catch (e) {
    console.log(`playwright firefox: FAIL after ${((Date.now() - started) / 1000).toFixed(1)}s: ${e.message.split('\n')[0]}`)
  }
}

async function viaWebDriver () {
  const started = Date.now()
  const body = {
    capabilities: {
      alwaysMatch: {
        browserName: 'firefox',
        browserVersion: 'latest',
        platformName: 'WIN10',
        'tb:options': { key: c.key, secret: c.secret, name: 'TB-256 firefox webdriver' },
      },
    },
  }

  try {
    const response = await fetch('https://hub.testingbot.com/wd/hub/session', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(240_000),
    })
    const json = await response.json()
    const sessionId = json?.value?.sessionId

    if (!sessionId) {
      console.log(`webdriver firefox: FAIL ${JSON.stringify(json).slice(0, 300)}`)
      return
    }

    await fetch(`https://hub.testingbot.com/wd/hub/session/${sessionId}/url`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: 'https://testingbot.com' }),
    })
    const title = await (await fetch(`https://hub.testingbot.com/wd/hub/session/${sessionId}/title`)).json()

    console.log(`webdriver firefox: OK in ${((Date.now() - started) / 1000).toFixed(1)}s, session=${sessionId}, title=${JSON.stringify(title.value)}`)

    await fetch(`https://hub.testingbot.com/wd/hub/session/${sessionId}`, { method: 'DELETE' })
  } catch (e) {
    console.log(`webdriver firefox: FAIL after ${((Date.now() - started) / 1000).toFixed(1)}s: ${e.message}`)
  }
}

await viaPlaywright()
await viaWebDriver()
