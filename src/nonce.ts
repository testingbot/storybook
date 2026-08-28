import { CHANNEL_AUTH } from './constants.js'

/**
 * Reads the per-process nonce that preset.cjs injected into the manager
 * document via managerHead.
 *
 * Every state-mutating event the manager sends must carry this, or the guard in
 * src/server/channelAuth.cjs drops it. Reading it here rather than at module
 * load keeps it out of any serialisable manager state.
 */
export function getNonce (): string | null {
  if (typeof document === 'undefined') return null
  const meta = document.querySelector(`meta[name="${CHANNEL_AUTH.META_NAME}"]`)
  return meta?.getAttribute('content') ?? null
}

/**
 * Adds the nonce to an outgoing channel payload. Use for every event that
 * changes state or spends money; read-only events do not need it.
 */
export function withNonce<T extends object> (payload: T): T & Record<string, unknown> {
  const nonce = getNonce()
  return { ...payload, [CHANNEL_AUTH.PAYLOAD_KEY]: nonce }
}
