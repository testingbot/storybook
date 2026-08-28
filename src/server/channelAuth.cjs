'use strict'

const { randomBytes } = require('node:crypto')
const { CHANNEL_AUTH } = require('../constants.cjs')

/**
 * Per-process nonce guard for the server channel.
 *
 * Without this, any page a developer happens to visit could reach their running
 * Storybook's channel and start grid runs on their account. Runs cost money and
 * plan concurrency, so this is a real exposure rather than a theoretical one.
 * The design is taken from @percy/storybook@10.0.2.
 *
 * The full set of guarded handlers lands in TB-255; this module exists now so
 * preset.cjs can export a meaningful managerHead from the start.
 */

let nonce = null

/** One nonce per Storybook process, created on first use. */
function getOrCreateNonce () {
  if (!nonce) nonce = randomBytes(32).toString('hex')
  return nonce
}

/**
 * Constant-time-ish comparison. The nonce is not a password and an attacker
 * cannot observe our timing across origins, but there is no reason to leak a
 * prefix match either.
 */
function matches (candidate, expected) {
  if (typeof candidate !== 'string' || candidate.length !== expected.length) return false
  let diff = 0
  for (let i = 0; i < candidate.length; i += 1) {
    diff |= candidate.charCodeAt(i) ^ expected.charCodeAt(i)
  }
  return diff === 0
}

/**
 * Wraps a Storybook channel so that listeners registered through it only fire
 * when the event carries the right nonce. Returns an object exposing the same
 * `on`/`emit` surface the handlers need, so registration code reads normally.
 *
 * Events without a valid nonce are dropped and reported on the LOG channel
 * rather than silently ignored, so a genuine wiring mistake is debuggable.
 */
function guardChannel (channel, expectedNonce) {
  return {
    on (eventName, handler) {
      channel.on(eventName, (payload = {}) => {
        const supplied = payload && payload[CHANNEL_AUTH.PAYLOAD_KEY]

        if (!matches(supplied, expectedNonce)) {
          console.warn(
            `[testingbot] Rejected a "${eventName}" event with a missing or invalid nonce. ` +
            'This is expected if another page tried to drive your Storybook.',
          )
          return
        }

        // Handlers never need the nonce itself, so strip it before passing on.
        const { [CHANNEL_AUTH.PAYLOAD_KEY]: _ignored, ...rest } = payload

        // Return the handler's result. Storybook's own channel ignores it, but
        // swallowing it here would mean an async handler's rejection becomes an
        // unhandled promise rejection, and callers could not await completion.
        return handler(rest)
      })
    },

    emit (eventName, payload) {
      channel.emit(eventName, payload)
    },
  }
}

module.exports = { getOrCreateNonce, guardChannel, matches }
