import type { ProjectConfig, StoryResult } from './types.js'

/**
 * Hosted visual comparison. TB-303.
 *
 * In hosted mode the addon does not screenshot or compare anything. It asks the
 * grid to do both, through a `tb:visual.snapshot` execute command that hub
 * intercepts (hub/lib/protocols/webdriver.js, the `/execute` branch) and hands
 * to its own visual service. The story is never transferred here, and no PNG is
 * written to the project.
 *
 * This exists for real devices. A device screenshot depends on the exact handset
 * the grid allocated, so a PNG committed to a repository is a fragile baseline
 * in a way a desktop Chrome one is not. The hosted service keys baselines per
 * test environment and, for iOS and Android, ignores the status and navigation
 * bar regions automatically (hub/lib/visual.js, generateCompareOptions), which
 * is a whole class of false positive the local path would have to solve again.
 *
 * Both drivers, and the difference is only in how the command is addressed.
 * WebDriver sends it as an execute script, `tb:visual.snapshot={...}`, which
 * hub intercepts. Playwright sends the same name and arguments as a
 * `testingbot_executor:` evaluate argument, which ws-hub intercepts and
 * forwards to the same hub endpoint (ws-hub/src/custom_command.ts). Same
 * payload either way, which is why buildSnapshotArguments is shared.
 *
 * The Playwright half took three grid-side fixes to reach. ws-hub used to drop
 * every field of the reply but `sessionId`, so a comparison came back with no
 * verdict at all (TB-304). Then the capture itself failed: hub asks the node
 * for `/wd/hub/session/<id>/screenshot`, and the node's handler opened a second
 * Playwright connection, which cannot see the customer's contexts because
 * Playwright scopes them per connection. It attaches over CDP now, which is
 * browser-global (TB-306). Verified end to end against the live grid on
 * 2026-08-27: an unchanged page compared to 0 pixels, a changed one to 15,560.
 */

export type VisualMode = 'local' | 'hosted'

/** hub/lib/visual.js, isValidVisualName. Names outside this are rejected server side. */
const VALID_VISUAL_NAME = /^[A-Za-z0-9._-]{1,128}$/

export function visualMode (config: ProjectConfig): VisualMode {
  return config.visual === 'hosted' ? 'hosted' : 'local'
}

export function isValidVisualName (name: string): boolean {
  return VALID_VISUAL_NAME.test(name)
}

/**
 * The snapshot name is the story id and nothing else.
 *
 * Deliberately not `<target>/<story>`, which is how the local baseline
 * directories are laid out and is the obvious thing to reach for. hub looks
 * baselines up by (user, name) and *then* selects among them by test
 * environment (visual.js getBaseline and findBaseline). Putting the target in
 * the name would give every target a name of its own holding exactly one
 * baseline, which bypasses that matching and quietly reduces the hosted service
 * to the local model. Nothing would appear broken, it would just be worse.
 */
export function visualNameFor (storyId: string): string {
  return storyId
}

export function buildSnapshotOptions (
  config: ProjectConfig,
  rootSelector: string,
): Record<string, unknown> {
  const options: Record<string, unknown> = config.fullPage === true
    ? { fullPage: true }
    : { selector: rootSelector }

  // Passed through untouched when set. hub's sanitizeOptions allowlists these,
  // so anything else would be dropped server side anyway.
  const passthrough = config.hostedVisual
  if (passthrough && typeof passthrough === 'object' && !Array.isArray(passthrough)) {
    for (const key of ['threshold', 'ignoreRegions', 'ignoreSelectors', 'diffColor', 'antialiasing', 'disableFreeze']) {
      if (key in passthrough) options[key] = (passthrough as Record<string, unknown>)[key]
    }
  }

  return options
}

/**
 * The arguments hub's visual service takes, in one place.
 *
 * Both transports carry this object; only the envelope differs. Building it
 * twice is how the two drivers would quietly drift apart, and a difference in
 * the options here is a difference in what is compared.
 */
export function buildSnapshotArguments (
  name: string,
  options: Record<string, unknown>,
): Record<string, unknown> {
  return { name, options }
}

export function buildSnapshotScript (name: string, options: Record<string, unknown>): string {
  return `tb:visual.snapshot=${JSON.stringify(buildSnapshotArguments(name, options))}`
}

type SnapshotResponse = {
  match?: unknown
  pixelDifference?: unknown
  error?: unknown
  visualId?: unknown
  runId?: unknown
  url?: unknown
}

/**
 * Turn hub's response into a StoryResult.
 *
 * The important case is the one that looks harmless. hub reports a comparison
 * that could not be performed as `{ match: false, error }`
 * (protocols/webdriver.js), which is the same shape as a story that genuinely
 * changed. Branching on `match` alone would send someone to review a difference
 * that does not exist, and would mark a broken compare service as a design
 * regression. `error` is therefore checked first, and always wins.
 */
export function mapSnapshotResponse (
  raw: unknown,
  base: Pick<StoryResult, 'storyId' | 'target'>,
): StoryResult {
  if (typeof raw !== 'object' || raw === null) {
    return { ...base, outcome: 'failed', message: 'The grid returned no visual result.' }
  }

  const response = raw as SnapshotResponse

  if (response.error !== undefined && response.error !== null) {
    return { ...base, outcome: 'failed', message: describeError(response.error) }
  }

  if (typeof response.match !== 'boolean') {
    return { ...base, outcome: 'failed', message: 'The grid returned a visual result with no verdict.' }
  }

  const pixelDifference = typeof response.pixelDifference === 'number'
    ? response.pixelDifference
    : undefined
  const url = typeof response.url === 'string' ? response.url : undefined

  /**
   * A first snapshot has nothing to compare against. hub registers the
   * screenshot as the baseline and short-circuits with `{ pixelDifference: 0,
   * match: true }` and no run (visual.js, the skipCompare path), so the absence
   * of a run id is what distinguishes "recorded a baseline" from "compared and
   * matched". Reporting both as passed would hide the one run where a wrong
   * screenshot becomes the truth, which is the same reason the local path has a
   * separate `new` outcome.
   */
  if (response.match && response.runId === undefined) {
    return { ...base, outcome: 'new', message: 'New baseline recorded on TestingBot.' }
  }

  if (response.match) {
    return { ...base, outcome: 'passed', pixelDifference, url }
  }

  return { ...base, outcome: 'diff', pixelDifference, url }
}

function describeError (error: unknown): string {
  const text = typeof error === 'string' ? error : (error as { message?: string })?.message ?? String(error)

  return `Visual comparison failed on TestingBot: ${text.split('\n')[0]}`
}
