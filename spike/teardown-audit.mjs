/**
 * TB-253 acceptance criterion 2: "Killing Storybook with Ctrl+C leaves no
 * tunnel process and no orphaned session."
 *
 * Audits both halves of that claim after every start/stop cycle: the local
 * process table and TestingBot's own view of the account's tunnels.
 */
import { execSync } from 'node:child_process'
import { setTimeout as sleep } from 'node:timers/promises'

import { TunnelManager } from '../dist/index.js'
import { resolveCredentials } from '../dist/index.js'

const credentials = resolveCredentials()
const auth = Buffer.from(`${credentials.key}:${credentials.secret}`).toString('base64')
const CYCLES = Number(process.env.SPIKE_CYCLES || 3)
const devServerUrl = 'http://localhost:7411'

const localTunnels = () => {
  try {
    return Number(execSync('ps -eo command | grep -c "[t]estingbot-tunnel.jar"').toString().trim())
  } catch { return 0 }
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
  console.log(`cycle ${i}: started ${info.tunnelIdentifier}`)
  console.log(`  after start : local=${localTunnels()} server=${JSON.stringify(await serverTunnels())}`)

  await tunnel.stop()
  console.log(`  stop() returned, manager state=${tunnel.state}`)

  // Give the server a moment to reflect the deregistration.
  await sleep(5000)
  console.log(`  after stop  : local=${localTunnels()} server=${JSON.stringify(await serverTunnels())}\n`)
}

console.log(`final: local=${localTunnels()} server=${JSON.stringify(await serverTunnels())}`)
