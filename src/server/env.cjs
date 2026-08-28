'use strict'

const fs = require('node:fs')
const path = require('node:path')

/**
 * Minimal .env reader and writer.
 *
 * Deliberately hand-rolled rather than pulling in dotenv: the addon only needs
 * to read two keys and update them in place without disturbing anything else
 * the project keeps in that file.
 */

function getEnvPath () {
  return path.join(process.cwd(), '.env')
}

/** Parse .env content into a key/value map, ignoring comments and blanks. */
function parseEnv (content) {
  const result = {}

  for (const line of content.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue

    const index = trimmed.indexOf('=')
    if (index === -1) continue

    const key = trimmed.slice(0, index).trim()
    let value = trimmed.slice(index + 1).trim()

    // Tolerate quoted values, which are common in hand-written .env files.
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1)
    }

    result[key] = value
  }

  return result
}

function readEnv () {
  const envPath = getEnvPath()
  return fs.existsSync(envPath) ? parseEnv(fs.readFileSync(envPath, 'utf8')) : {}
}

function readEnvRaw () {
  const envPath = getEnvPath()
  return fs.existsSync(envPath) ? fs.readFileSync(envPath, 'utf8') : ''
}

/**
 * Set or replace one key in .env content, leaving every other line untouched.
 *
 * Rejects newlines in the value: without that check, a value could inject
 * additional assignments into the file.
 */
function setKey (source, key, value) {
  const stringValue = String(value)

  if (/[\r\n]/.test(stringValue)) {
    throw new Error(`Refusing to write ${key} to .env: the value contains a newline`)
  }

  const line = `${key}=${stringValue}`
  const lines = source.split('\n')
  const index = lines.findIndex((existing) => existing.trimStart().startsWith(`${key}=`))

  if (index !== -1) {
    lines[index] = line
    return lines.join('\n')
  }

  return source.trim() ? `${source.trim()}\n${line}\n` : `${line}\n`
}

/**
 * Write .env with owner-only permissions. The file is about to hold a secret,
 * so it should not be world-readable on a shared machine.
 */
function writeEnvRaw (content) {
  const envPath = getEnvPath()
  fs.writeFileSync(envPath, content, { encoding: 'utf8', mode: 0o600 })

  try {
    fs.chmodSync(envPath, 0o600)
  } catch {
    // Best effort: some filesystems (and Windows) do not support this.
  }
}

module.exports = { getEnvPath, parseEnv, readEnv, readEnvRaw, setKey, writeEnvRaw }
