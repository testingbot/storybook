import type { TunnelErrorCode } from './types.js'

/**
 * Maps the low-level failures of testingbot-tunnel-launcher onto messages that
 * name the problem and the fix.
 *
 * TB-253 requires this explicitly: the failure mode we are designing against is
 * a developer seeing net::ERR_TIMED_OUT and concluding the product is broken,
 * when the real cause is a missing Java, a rejected key or an exhausted plan.
 */

export class TunnelError extends Error {
  readonly code: TunnelErrorCode

  constructor (code: TunnelErrorCode, message: string, { cause }: { cause?: unknown } = {}) {
    super(message)
    this.name = 'TunnelError'
    this.code = code
    if (cause) this.cause = cause
  }
}

type Rule = {
  code: TunnelErrorCode
  match: (text: string) => boolean
  message: string
}

const RULES: Rule[] = [
  {
    code: 'JAVA_MISSING',
    match: (text) => /spawn java ENOENT|Java might not be installed|Java is not installed/i.test(text),
    message:
      'Java was not found on PATH. TestingBot Tunnel is a Java program and needs Java 11 or newer. ' +
      'Install a JDK (macOS: brew install openjdk) and restart Storybook.',
  },
  {
    code: 'JAVA_TOO_OLD',
    match: (text) => /Java \d+ is installed, but Java \d+ or higher is required/i.test(text),
    message:
      'The installed Java is too old for TestingBot Tunnel, which needs Java 11 or newer. ' +
      'Upgrade Java and restart Storybook.',
  },
  {
    code: 'AUTH_REJECTED',
    match: (text) => /Invalid credentials|401 Unauthorized/i.test(text),
    message:
      'TestingBot rejected the key/secret. Check TB_KEY and TB_SECRET, or the ~/.testingbot file. ' +
      'Your credentials are listed at https://testingbot.com/members/user/edit',
  },
  {
    code: 'PLAN_EXHAUSTED',
    match: (text) => /minutes left/i.test(text),
    message:
      'This TestingBot account has no testing minutes left, so the tunnel was refused. ' +
      'Upgrade the plan at https://testingbot.com/pricing or wait for the quota to reset.',
  },
  {
    code: 'CONCURRENCY_EXHAUSTED',
    match: (text) => /already have \d+ tunnels? active|tunnels active/i.test(text),
    message:
      'This TestingBot account already has the maximum number of tunnels running, so a new one was refused. ' +
      'Close another tunnel, or check for a leaked one at https://testingbot.com/members/tunnels',
  },
  {
    code: 'TUNNEL_TIMEOUT',
    match: (text) => /failed to launch in \d+ seconds/i.test(text),
    message:
      'The tunnel did not become ready in time. This is usually a firewall or proxy blocking the ' +
      'outbound connection to TestingBot, or another tunnel already holding this identifier.',
  },
  {
    code: 'DOWNLOAD_FAILED',
    match: (text) => /Could not download the tunnel/i.test(text),
    message:
      'The tunnel binary could not be downloaded from TestingBot. Check network access to ' +
      'testingbot.com and any corporate proxy.',
  },
]

export function toTunnelError (error: unknown): TunnelError {
  if (error instanceof TunnelError) return error

  const candidate = error as { message?: string; stack?: string; code?: string } | undefined
  const text = [candidate?.message, candidate?.stack, candidate?.code].filter(Boolean).join(' ')
  const rule = RULES.find((candidate) => candidate.match(text))

  if (rule) {
    return new TunnelError(rule.code, rule.message, { cause: error })
  }

  return new TunnelError(
    'TUNNEL_FAILED',
    `TestingBot Tunnel could not be started: ${candidate?.message || String(error)}`,
    { cause: error },
  )
}
