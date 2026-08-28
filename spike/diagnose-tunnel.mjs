/**
 * For a single tunnel, answers three questions per session:
 *   1. Does the cloud session have general internet access?
 *   2. Can it reach the tunnelled localhost port?
 *   3. What does the tunnel's own log say while that happens?
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
const PORT = Number(process.env.SPIKE_PORT || 7000 + Math.floor(Math.random() * 1500))
const SESSIONS = Number(process.env.SPIKE_SESSIONS || 3)

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

const credentials = resolveCredentials()
const devServerUrl = `http://localhost:${PORT}`
const identifier = `storybook-diag-${process.pid}`
const logfile = path.join(os.tmpdir(), `tb-tunnel-${process.pid}.log`)

console.log(`[diag] Storybook ${devServerUrl}; tunnel log ${logfile}`)

const storybook = spawn('npx', ['storybook', 'dev', '-p', String(PORT), '--no-open', '--quiet'], {
  cwd: STORYBOOK_DIR, stdio: 'ignore', env: { ...process.env },
})

let tunnel
try {
  if (!(await waitForPort(PORT))) throw new Error('Storybook never started')
  console.log('[diag] Storybook listening locally')

  const options = {
    apiKey: credentials.key,
    apiSecret: credentials.secret,
    tunnelIdentifier: identifier,
    logfile,
    verbose: false,
  }

  await launcher.downloadAsync(options)
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'tb-diag-'))
  const prev = process.env.TMPDIR
  let pending
  try { process.env.TMPDIR = scratch; pending = launcher.startTunnelAsync(options) }
  finally { if (prev === undefined) delete process.env.TMPDIR; else process.env.TMPDIR = prev }
  tunnel = await pending
  console.log(`[diag] tunnel ${identifier} ready`)

  const capability = { tunnelIdentifier: identifier, ...getLocalPortCapability(devServerUrl) }

  for (let i = 1; i <= SESSIONS; i += 1) {
    const caps = {
      browserName: 'chrome', browserVersion: 'latest',
      'tb:options': { key: credentials.key, secret: credentials.secret, platform: 'WIN10', name: `TB-253 diag ${i}`, ...capability },
    }
    const ws = `wss://cloud.testingbot.com/playwright?capabilities=${encodeURIComponent(JSON.stringify(caps))}`
    let browser
    try {
      browser = await chromium.connect(ws, { timeout: 180_000 })
      const page = await browser.newPage()

      let publicOk = 'n/a'
      try {
        const r = await page.goto('https://testingbot.com/', { waitUntil: 'domcontentloaded', timeout: 25_000 })
        publicOk = `HTTP ${r?.status()}`
      } catch (e) { publicOk = /ERR_TIMED_OUT/.test(e.message) ? 'ERR_TIMED_OUT' : e.message.split('\n')[0] }

      let tunnelOk = 'n/a'
      try {
        const r = await page.goto(`${devServerUrl}/index.json`, { waitUntil: 'domcontentloaded', timeout: 25_000 })
        tunnelOk = `HTTP ${r?.status()}`
      } catch (e) { tunnelOk = /ERR_TIMED_OUT/.test(e.message) ? 'ERR_TIMED_OUT' : e.message.split('\n')[0] }

      console.log(`[diag] session ${i}: publicInternet=${publicOk}  tunnelledLocalhost=${tunnelOk}`)
    } catch (e) {
      console.log(`[diag] session ${i}: connect failed ${e.message.split('\n')[0]}`)
    } finally {
      if (browser) await browser.close().catch(() => {})
    }
  }
} finally {
  if (tunnel) { try { tunnel.close ? tunnel.close() : tunnel.kill('SIGINT') } catch {} }
  await sleep(3000)
  storybook.kill('SIGINT')
  console.log('\n[diag] ---- tunnel log tail ----')
  try { console.log(fs.readFileSync(logfile, 'utf8').split('\n').slice(-40).join('\n')) }
  catch (e) { console.log(`(no log: ${e.message})`) }
}
