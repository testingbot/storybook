'use strict'

const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const { TB_EVENTS } = require('../constants.cjs')
const { readEnv, readEnvRaw, setKey, writeEnvRaw } = require('./env.cjs')

/**
 * Credential resolution and the channel handlers that manage it.
 *
 * The hard rule from TB-255: the key and secret never leave Node. Nothing here
 * emits them, and nothing here logs them. The manager is told only whether a
 * usable pair exists and where it came from, which is all the UI needs to
 * decide between showing a form and showing a run button.
 *
 * Resolution order, most specific first:
 *   1. process.env            (CI, and a developer's shell)
 *   2. the project's .env     (what the UI writes, when consent is given)
 *   3. ~/.testingbot          (the machine-wide file the rest of the toolchain uses)
 *   4. the session cache      (entered in the UI without consent to persist)
 */

const VERIFY_TIMEOUT_MS = 10_000
const API_BASE = 'https://api.testingbot.com/v1'

const NETWORK_ERROR =
  'Could not reach TestingBot to verify the credentials. Check your connection and try again.'
const INVALID_ERROR =
  'TestingBot rejected that key and secret. Check them at https://testingbot.com/members/user/edit'

/**
 * Credentials entered in the UI when the developer declines to write them to
 * .env. Lives only as long as the Storybook process.
 */
const sessionCredentials = { key: '', secret: '' }

function setSessionCredentials (key, secret) {
  sessionCredentials.key = key || ''
  sessionCredentials.secret = secret || ''
}

function clearSessionCredentials () {
  sessionCredentials.key = ''
  sessionCredentials.secret = ''
}

function readHomeFile () {
  try {
    const file = path.join(os.homedir(), '.testingbot')
    if (!fs.existsSync(file)) return null

    const [key, secret] = fs.readFileSync(file, 'utf8').trim().split(':')
    return key && secret ? { key, secret } : null
  } catch {
    return null
  }
}

/**
 * Resolve the credentials Node should use. Returns null when no complete pair
 * is available anywhere.
 *
 * A pair is only ever taken from a single source. Mixing a key from one place
 * with a secret from another produces a confusing 401 rather than a useful
 * error, so partial sources are skipped entirely.
 */
function resolveCredentials (env = process.env) {
  if (env.TB_KEY && env.TB_SECRET) {
    return { key: env.TB_KEY, secret: env.TB_SECRET, source: 'environment' }
  }

  const fromEnvFile = readEnv()
  if (fromEnvFile.TB_KEY && fromEnvFile.TB_SECRET) {
    return { key: fromEnvFile.TB_KEY, secret: fromEnvFile.TB_SECRET, source: '.env' }
  }

  const fromHome = readHomeFile()
  if (fromHome) {
    return { ...fromHome, source: '~/.testingbot' }
  }

  if (sessionCredentials.key && sessionCredentials.secret) {
    return { ...sessionCredentials, source: 'session' }
  }

  return null
}

/** What the manager is allowed to know. Never the values themselves. */
function credentialStatus () {
  const resolved = resolveCredentials()

  return {
    configured: resolved !== null,
    source: resolved ? resolved.source : null,
    // Whether the source can be changed from the UI. Environment variables
    // win over anything the panel writes, so saying so avoids a confusing
    // "I saved new credentials and nothing changed".
    overriddenByEnvironment: Boolean(process.env.TB_KEY && process.env.TB_SECRET),
  }
}

/**
 * Check a pair against TestingBot before trusting or storing it.
 *
 * Distinguishes "wrong credentials" from "could not reach TestingBot" so the UI
 * can tell the developer whether retrying is worth anything.
 */
async function verifyCredentials (key, secret) {
  if (!key || !secret) return { ok: false, reason: 'invalid' }

  try {
    const auth = Buffer.from(`${key}:${secret}`).toString('base64')
    const response = await fetch(`${API_BASE}/user`, {
      headers: { Authorization: `Basic ${auth}` },
      signal: AbortSignal.timeout(VERIFY_TIMEOUT_MS),
    })

    if (response.ok) return { ok: true }
    if (response.status === 401 || response.status === 403) {
      return { ok: false, reason: 'invalid' }
    }
    return { ok: false, reason: 'network' }
  } catch {
    return { ok: false, reason: 'network' }
  }
}

function persistToEnvFile (key, secret) {
  let content = readEnvRaw()
  content = setKey(content, 'TB_KEY', key)
  content = setKey(content, 'TB_SECRET', secret)
  writeEnvRaw(content)
}

function failureFor (reason) {
  const isNetwork = reason === 'network'
  return {
    success: false,
    error: isNetwork ? NETWORK_ERROR : INVALID_ERROR,
    retryable: isNetwork,
  }
}

function registerCredentialHandlers (channel) {
  channel.on(TB_EVENTS.GET_CREDENTIALS, () => {
    channel.emit(TB_EVENTS.CREDENTIALS_STATUS, credentialStatus())
  })

  // Persisting to .env happens only after TestingBot confirms the pair is real,
  // so a forged event cannot write arbitrary content into the project's .env.
  channel.on(TB_EVENTS.SAVE_CREDENTIALS, async ({ key, secret } = {}) => {
    const result = await verifyCredentials(key, secret)

    if (!result.ok) {
      channel.emit(TB_EVENTS.CREDENTIALS_SAVED, failureFor(result.reason))
      return
    }

    try {
      persistToEnvFile(key, secret)
    } catch (error) {
      channel.emit(TB_EVENTS.CREDENTIALS_SAVED, {
        success: false,
        // error.message here is ours (see env.cjs) and contains no secret.
        error: `Could not write to .env: ${error.message}`,
        retryable: false,
      })
      return
    }

    // Seed the session cache too, so handlers already running in this process
    // see the new pair without waiting for a file read.
    setSessionCredentials(key, secret)
    channel.emit(TB_EVENTS.CREDENTIALS_SAVED, { success: true, ...credentialStatus() })
  })

  // Session-only: the developer entered credentials but declined to write them
  // to .env. Still verified first, so a forged event cannot seed the session
  // with values that later privileged handlers would spend money with.
  channel.on(TB_EVENTS.SET_SESSION_CREDENTIALS, async ({ key, secret } = {}) => {
    const result = await verifyCredentials(key, secret)

    if (!result.ok) {
      channel.emit(TB_EVENTS.SESSION_CREDENTIALS_SET, failureFor(result.reason))
      return
    }

    setSessionCredentials(key, secret)
    channel.emit(TB_EVENTS.SESSION_CREDENTIALS_SET, { success: true, ...credentialStatus() })
  })
}

module.exports = {
  resolveCredentials,
  credentialStatus,
  verifyCredentials,
  setSessionCredentials,
  clearSessionCredentials,
  registerCredentialHandlers,
  NETWORK_ERROR,
  INVALID_ERROR,
}
