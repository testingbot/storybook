import type { Page } from 'playwright-core'

/**
 * TestingBot's custom commands, as seen from Playwright.
 *
 * The grid intercepts an evaluate whose argument string starts with
 * `testingbot_executor:` and answers it itself, so the expression never reaches
 * the page. Handled in ws-hub/src/custom_command.ts; the actions used here are
 * getSessionDetails, setSessionName and setSessionStatus.
 *
 * Every call is best effort. Losing a session ID or a status label is a
 * cosmetic loss in the TestingBot dashboard; failing a screenshot run over it
 * would not be.
 */

async function execute (page: Page, action: string, args: Record<string, unknown> = {}): Promise<unknown> {
  const command = `testingbot_executor: ${JSON.stringify({ action, arguments: args })}`

  try {
    return await page.evaluate(() => {}, command)
  } catch {
    return null
  }
}

export async function getSessionId (page: Page): Promise<string | null> {
  const details = (await execute(page, 'getSessionDetails')) as { sessionId?: unknown } | null

  return typeof details?.sessionId === 'string' ? details.sessionId : null
}

export async function setSessionName (page: Page, name: string): Promise<void> {
  await execute(page, 'setSessionName', { name })
}

export async function setSessionStatus (page: Page, passed: boolean, reason?: string): Promise<void> {
  await execute(page, 'setSessionStatus', reason === undefined ? { passed } : { passed, reason })
}

/**
 * The one custom command whose return value is the result.
 *
 * Deliberately not routed through `execute` above. That helper swallows
 * failures because losing a session label is cosmetic; swallowing a visual
 * failure would turn it into `null`, and a caller reading `match` off null gets
 * a pass. ws-hub draws the same line for the same reason
 * (custom_command.ts, the note above the visual cases).
 */
export async function visualSnapshot (
  page: Page,
  args: Record<string, unknown>,
): Promise<unknown> {
  const command = `testingbot_executor: ${JSON.stringify({ action: 'visual.snapshot', arguments: args })}`

  return await page.evaluate(() => {}, command)
}
