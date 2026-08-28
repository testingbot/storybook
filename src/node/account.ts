import type { Credentials } from './types.js'

/**
 * Account limits, read from the REST API before a run starts.
 *
 * The point is to fail with a sentence a developer can act on. Exceeding the
 * parallel limit on the grid surfaces as sessions that queue or connections
 * that are refused with nothing useful attached, which is exactly the opaque
 * failure the ticket calls out.
 *
 * Verified against the live API: GET /v1/user returns max_concurrent,
 * max_concurrent_mobile, current_vm_concurrency and current_physical_concurrency.
 */

const USER_URL = 'https://api.testingbot.com/v1/user'
const TIMEOUT_MS = 10_000

export type AccountLimits = {
  maxConcurrent: number
  maxConcurrentMobile: number
  currentVm: number
  currentPhysical: number
}

const FALLBACK: AccountLimits = {
  maxConcurrent: 1,
  maxConcurrentMobile: 1,
  currentVm: 0,
  currentPhysical: 0,
}

function toCount (value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : fallback
}

export async function getAccountLimits (credentials: Credentials): Promise<AccountLimits> {
  const auth = Buffer.from(`${credentials.key}:${credentials.secret}`).toString('base64')

  try {
    const response = await fetch(USER_URL, {
      headers: { Authorization: `Basic ${auth}` },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    })

    if (!response.ok) return FALLBACK

    const body = (await response.json()) as Record<string, unknown>

    return {
      maxConcurrent: toCount(body.max_concurrent, FALLBACK.maxConcurrent),
      maxConcurrentMobile: toCount(body.max_concurrent_mobile, FALLBACK.maxConcurrentMobile),
      currentVm: toCount(body.current_vm_concurrency, 0),
      currentPhysical: toCount(body.current_physical_concurrency, 0),
    }
  } catch {
    // A slow or unreachable API must not stop a run. Falling back to one
    // session at a time is always allowed, only slower.
    return FALLBACK
  }
}

/**
 * How many sessions to open at once.
 *
 * Sessions already running elsewhere count against the same limit, so they are
 * subtracted. The floor is 1: refusing to run because the account is busy would
 * be worse than running slowly.
 */
export function resolveConcurrency (limits: AccountLimits, targetCount: number): number {
  const free = limits.maxConcurrent - limits.currentVm

  return Math.max(1, Math.min(targetCount, free))
}
