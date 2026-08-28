/**
 * The failure signature changed from ERR_TIMED_OUT to HTTP 502. Capture exactly
 * what the proxy returns, for both a public URL and the tunnelled localhost
 * port, plus the tunnel's own log, so the platform team has something concrete.
 */
import { spawn } from 'node:child_process'
import { setTimeout as sleep } from 'node:timers/promises'
import net from 'node:net'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import { chromium } from 'playwright-core'

import { resolveCredentials } from '../dist/index.js'
import { getLocalPortCapability } from '../dist/index.js'

const require = createRequire(import.meta.url)
const launcher = require('testingbot-tunnel-launcher')

const STORYBOOK_DIR = '/Users/jochen/test/storybook-testingbot-example'
const PORT = 7411
const credentials = resolveCredentials()
const auth = Buffer.from(`${credentials.key}:${credentials.secret}`).toString('base64')
const devServerUrl = `http://localhost:${PORT}`
const identifier = `storybook-502diag-${process.pid}`
const logfile = path.join(os.tmpdir(), `tb-502-${process.pid}.log`)
const label = `TB253-502diag-${Date.now()}`

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

let tunnel
try {
  if (!(await waitForPort(PORT))) throw new Error('Storybook never started')

  // Prove the local server is healthy before blaming anything remote.
  const localCheck = await fetch(`${devServerUrl}/index.json`).then((r) => r.status).catch((e) => e.message)
  console.log(`[502] local fetch of ${devServerUrl}/index.json -> ${localCheck}`)

  const options = { apiKey: credentials.key, apiSecret: credentials.secret, tunnelIdentifier: identifier, logfile, verbose: false }
  await launcher.downloadAsync(options)
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'tb-502-'))
  const prev = process.env.TMPDIR
  let pending
  try { process.env.TMPDIR = scratch; pending = launcher.startTunnelAsync(options) }
  finally { if (prev === undefined) delete process.env.TMPDIR; else process.env.TMPDIR = prev }
  tunnel = await pending
  console.log(`[502] tunnel ${identifier} ready`)

  const capability = { tunnelIdentifier: identifier, ...getLocalPortCapability(devServerUrl) }
  console.log(`[502] capability ${JSON.stringify(capability)}`)

  const caps = {
    browserName: 'chrome', browserVersion: 'latest',
    'tb:options': { key: credentials.key, secret: credentials.secret, platform: 'WIN10', name: label, ...capability },
  }
  const ws = `wss://cloud.testingbot.com/playwright?capabilities=${encodeURIComponent(JSON.stringify(caps))}`

  const browser = await chromium.connect(ws, { timeout: 180_000 })
  const page = await browser.newPage()

  for (const target of ['https://testingbot.com/', `${devServerUrl}/index.json`]) {
    console.log(`\n[502] ---- navigating to ${target} ----`)
    try {
      const r = await page.goto(target, { waitUntil: 'domcontentloaded', timeout: 25_000 })
      console.log(`[502] status  : ${r?.status()} ${r?.statusText()}`)
      console.log(`[502] headers : ${JSON.stringify(r?.headers(), null, 2)}`)
      const body = await page.content()
      console.log(`[502] body    : ${body.replace(/\s+/g, ' ').slice(0, 700)}`)
    } catch (e) {
      console.log(`[502] threw   : ${e.message.split('\n')[0]}`)
    }
  }

  await browser.close().catch(() => {})

  await sleep(8000)
  const tests = await fetch(`https://api.testingbot.com/v1/tests?count=5`, { headers: { Authorization: `Basic ${auth}` } }).then((r) => r.json())
  const mine = (tests?.data || []).find((t) => t.name === label)
  console.log(`\n[502] TestingBot session id: ${mine?.session_id || 'not resolved'}`)
  console.log(`[502] TestingBot test id   : ${mine?.id || 'n/a'}`)
} finally {
  if (tunnel) { try { tunnel.close ? tunnel.close() : tunnel.kill('SIGINT') } catch {} }
  await sleep(3000)
  storybook.kill('SIGINT')
  console.log('\n[502] ---- tunnel log tail ----')
  try { console.log(fs.readFileSync(logfile, 'utf8').split('\n').slice(-30).join('\n')) }
  catch (e) { console.log(`(no log: ${e.message})`) }
}
