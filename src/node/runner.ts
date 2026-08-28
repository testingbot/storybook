import { chromium, firefox, webkit } from 'playwright-core'
import type { Browser, BrowserType, Page } from 'playwright-core'

import { getAccountLimits, resolveConcurrency } from './account.js'
import { baselineDir, baselinePath, readBaseline, resultPath, writeImage } from './baselines.js'
import { deviceDriverFor } from './device-url.js'
import {
  buildSnapshotArguments,
  buildSnapshotOptions,
  buildSnapshotScript,
  isValidVisualName,
  mapSnapshotResponse,
  visualMode,
  visualNameFor,
} from './hosted-visual.js'
import { compareImages } from './image-diff.js'
import { writeLastRun } from './run-store.js'
import { fetchStoryIndex, selectStories } from './story-index.js'
import { getSessionId, setSessionName, setSessionStatus, visualSnapshot } from './session.js'
import { browserTypeFor, buildCapabilities, buildWsEndpoint, toTargets } from './targets.js'
import { TunnelManager } from './tunnel-manager.js'
import { buildDeviceCapabilities, WebDriverSession } from './webdriver.js'
import type {
  Credentials,
  ProjectConfig,
  RunProgressEvent,
  RunResult,
  RunTarget,
  StoryEntry,
  StoryOutcome,
  StoryResult,
  TunnelCapability,
  TunnelProvider,
  Viewport,
} from './types.js'

/**
 * The grid runner.
 *
 * The mechanism is lifted from the proven spec in the example repo
 * (tests/storybook.spec.mjs), not reinvented: read /index.json, open
 * iframe.html?id=<story> per story, wait for #storybook-root, wait for fonts,
 * screenshot with animations disabled.
 *
 * What is added here is everything a one-off spec did not have to care about:
 * one session per browser config rather than one per test, a concurrency cap
 * taken from the account, baselines kept per target, and cancellation that
 * actually closes grid sessions instead of leaving them to time out and bill.
 */

const CONNECT_TIMEOUT_MS = 180_000
const GOTO_TIMEOUT_MS = 60_000
const ROOT_SELECTOR = '#storybook-root'
const SETTLE_QUIET_MS = 500
const SETTLE_TIMEOUT_MS = 15_000
/** Real devices are slow enough that polling faster than this only wastes commands. */
const DEVICE_POLL_MS = 400
/** Mirrors DEFAULT_CONFIG in src/server/projectConfig.cjs. */
const DEFAULT_MAX_DIFF_PIXEL_RATIO = 0.001
const DEFAULT_VIEWPORT: Viewport = { width: 1280, height: 720 }
const BROWSER_TYPES: Record<string, BrowserType> = { chromium, firefox, webkit }

export class RunError extends Error {
  code: string

  constructor (message: string, code: string) {
    super(message)
    this.name = 'RunError'
    this.code = code
  }
}

/**
 * What a run covers. `story` is the one story open in the manager, `component`
 * is every story in the same component, `all` is the whole index.
 *
 * `component` exists because it is the unit a developer actually works in: you
 * change Button.css and you want the six Button stories, not one of them and
 * not four hundred.
 */
export type RunScope = 'story' | 'component' | 'all'

export type RunnerArgs = {
  credentials: Credentials
  config: ProjectConfig
  devServerUrl: string
  /**
   * Where device targets should point. Null means no device-reachable URL was
   * found, and device targets are skipped rather than run against a URL that
   * cannot resolve. See device-url.ts.
   */
  deviceUrl?: string | null
  scope?: RunScope
  storyId?: string | null
  signal: AbortSignal
  onProgress?: (event: RunProgressEvent) => void
  projectRoot?: string
  /** Injected by tests so they never touch the network. */
  tunnelManager?: TunnelProvider
}

export async function runOnGrid ({
  credentials,
  config,
  devServerUrl,
  deviceUrl = null,
  scope = 'all',
  storyId = null,
  signal,
  onProgress = () => {},
  projectRoot = process.cwd(),
  tunnelManager,
}: RunnerArgs): Promise<RunResult> {
  const configured = toTargets(config)

  // Targets that cannot be run are separated before anything else, because a
  // target that cannot work is a wasted grid session, not a failing test.
  // The reason is reported rather than the target quietly dropped: a run that
  // covered fewer targets than asked would show green for a browser nobody
  // tested.
  const skipped = configured.flatMap((target) => {
    if (!deviceUrl && target.kind === 'device') {
      return [{
        key: target.key,
        label: target.label,
        reason: 'No URL a real device could open. See the device section of the TestingBot panel.',
      }]
    }

    return []
  })

  const skippedKeys = new Set(skipped.map((entry) => entry.key))
  const targets = configured.filter((target) => !skippedKeys.has(target.key))

  if (configured.length === 0) {
    throw new RunError(
      'No browsers or devices configured. Add at least one entry to .testingbot.json.',
      'NO_TARGETS',
    )
  }

  if (targets.length === 0) {
    throw new RunError(
      'Every configured target is a real device, and this Storybook is not reachable from one. ' +
        'Real devices cannot resolve "localhost". Start Storybook without --host, or set "deviceUrl" ' +
        'in .testingbot.json to a Storybook a device can open.',
      'NO_DEVICE_URL',
    )
  }

  const allStories = await fetchStoryIndex(devServerUrl, { signal })
  const scoped = applyScope(allStories, scope, storyId)
  const stories = selectStories(scoped, {
    // selectStories already narrowed to a single story if it needed to; passing
    // storyId again here would undo the component scope.
    storyId: null,
    include: config.include ?? [],
    exclude: config.exclude ?? [],
  })

  if (stories.length === 0) {
    throw new RunError(
      describeEmptySelection(allStories, scope, storyId),
      'NO_STORIES',
    )
  }

  onProgress({ phase: 'stories', total: stories.length })

  for (const entry of skipped) {
    onProgress({ phase: 'target-skipped', target: entry.key, label: entry.label, reason: entry.reason })
  }

  const tunnel = tunnelManager ?? new TunnelManager({ credentials })
  const results: StoryResult[] = []
  const sessions: RunResult['targets'] = []

  try {
    onProgress({ phase: 'tunnel', message: 'Starting the TestingBot tunnel' })

    // The device URL usually shares the dev server's port, but a configured
    // one need not, and a tunnel is asked for its ports exactly once.
    const tunnelInfo = await tunnel.ensureStarted(devServerUrl, {
      alsoProxy: deviceUrl ? [deviceUrl] : [],
    })

    throwIfAborted(signal)

    const limits = await getAccountLimits(credentials)
    const concurrency = resolveConcurrency(limits, targets.length)
    const build = `storybook-${new Date().toISOString().replace(/[:.]/g, '-')}`

    await pool(targets, concurrency, async (target) => {
      const args = {
        target,
        stories,
        credentials,
        tunnel: tunnelInfo.capability,
        build,
        config,
        // Devices open the device URL; everything else opens the local one.
        // Passing the local URL to a device is the exact failure TB-260 is
        // about, so the choice is made here rather than inside the drivers.
        devServerUrl: target.kind === 'device' ? (deviceUrl as string) : devServerUrl,
        projectRoot,
        signal,
        onProgress,
      }

      const outcome = target.kind === 'device' && deviceDriverFor(target.spec) === 'webdriver'
        ? await runDeviceTarget(args)
        : await runTarget(args)

      results.push(...outcome.results)
      sessions.push({ key: target.key, label: target.label, sessionId: outcome.sessionId })
    })
  } finally {
    // Always, including on cancellation. A tunnel left running holds one of the
    // account's slots and the next run fails with CONCURRENCY_EXHAUSTED.
    await tunnel.stop().catch(() => {})
  }

  const totals: Record<StoryOutcome, number> = { new: 0, passed: 0, diff: 0, failed: 0 }

  for (const result of results) {
    totals[result.outcome] += 1
  }

  const result: RunResult = {
    // A cancelled run is not a passing run. It made no statement about the
    // stories it never reached, so reporting green would be a lie the panel
    // would then show as a tick. A run that skipped a configured target is the
    // same kind of lie for the same reason.
    ok: !signal.aborted && skipped.length === 0 && totals.diff === 0 && totals.failed === 0,
    cancelled: signal.aborted,
    totals,
    stories: results,
    targets: sessions,
    ...(skipped.length ? { skipped } : {}),
    baselineDir: baselineDir(projectRoot),
  }

  // Persisted so the results view survives a manager reload. A failure to write
  // it must not fail the run: the developer still got their answer, and the
  // screenshots are on disk either way.
  try {
    writeLastRun(projectRoot, result)
  } catch {
    // Ignored deliberately. See above.
  }

  return result
}

/**
 * Narrows the index to what the chosen scope covers.
 *
 * Component membership is the story's `title`, which is what Storybook groups
 * by in the sidebar, so "run this component" means the same thing here as it
 * looks like it means there.
 */
export function applyScope (stories: StoryEntry[], scope: RunScope, storyId: string | null): StoryEntry[] {
  if (scope === 'all' || !storyId) return stories

  const current = stories.find((story) => story.id === storyId)

  if (!current) return []
  if (scope === 'story') return [current]

  return stories.filter((story) => story.title === current.title)
}

function describeEmptySelection (
  allStories: StoryEntry[],
  scope: RunScope,
  storyId: string | null,
): string {
  if (scope !== 'all' && storyId) {
    const known = allStories.some((story) => story.id === storyId)

    if (!known) return `Story "${storyId}" is not in the Storybook index.`

    return `Every story in this component is excluded by "include" or "exclude" in the config.`
  }

  return `No stories matched. Storybook published ${allStories.length}; check "include" and "exclude".`
}

/** What both drivers need. Identical on purpose: the caller picks the driver. */
type TargetRunArgs = {
  target: RunTarget
  stories: StoryEntry[]
  credentials: Credentials
  tunnel: TunnelCapability
  build: string
  config: ProjectConfig
  devServerUrl: string
  projectRoot: string
  signal: AbortSignal
  onProgress: (event: RunProgressEvent) => void
}

type TargetRunOutcome = { results: StoryResult[]; sessionId: string | null }

async function runTarget ({
  target,
  stories,
  credentials,
  tunnel,
  build,
  config,
  devServerUrl,
  projectRoot,
  signal,
  onProgress,
}: TargetRunArgs): Promise<TargetRunOutcome> {
  throwIfAborted(signal)

  const capabilities = buildCapabilities(target, { credentials, tunnel, build })
  const results: StoryResult[] = []

  let browser: Browser | null = null
  let sessionId: string | null = null

  /**
   * Cancellation has to reach into the open connection, not just stop the loop.
   * Playwright will happily sit in page.goto for a minute, and until the socket
   * closes the grid keeps the VM and keeps charging for it.
   */
  const onAbort = (): void => {
    browser?.close().catch(() => {})
  }

  signal.addEventListener('abort', onAbort, { once: true })

  try {
    const browserType = BROWSER_TYPES[browserTypeFor(target.spec)] as BrowserType

    browser = await browserType.connect(buildWsEndpoint(capabilities), { timeout: CONNECT_TIMEOUT_MS })

    const context = await browser.newContext({
      viewport: config.viewport ?? DEFAULT_VIEWPORT,
      // Screenshots must not include a scrollbar that appears only on some
      // platforms, and reduced motion removes one more source of run-to-run
      // difference on top of Playwright's own animation freezing.
      reducedMotion: 'reduce',
    })

    const page = await context.newPage()

    sessionId = await getSessionId(page)
    await setSessionName(page, `Storybook: ${target.label}`)

    onProgress({ phase: 'target-started', target: target.key, label: target.label, total: stories.length })

    for (const [index, story] of stories.entries()) {
      if (signal.aborted) break

      const result = await captureStory({
        page,
        story,
        target,
        config,
        devServerUrl,
        projectRoot,
        signal,
      })

      // Null means the cancel landed while this story was in flight. It is not
      // a failure and must not be counted as one, or every cancelled run would
      // report red.
      if (!result) break

      results.push(result)
      onProgress({ phase: 'story', index: index + 1, total: stories.length, result })
    }

    const passed = results.every((result) => result.outcome === 'passed' || result.outcome === 'new')

    await setSessionStatus(page, passed, passed ? 'All stories matched' : 'Visual differences found')
    onProgress({ phase: 'target-finished', target: target.key, label: target.label })
  } catch (error) {
    if (signal.aborted) {
      return { results, sessionId }
    }

    throw new RunError(
      `${target.label}: ${(error as Error).message.split('\n')[0]}`,
      'GRID_SESSION_FAILED',
    )
  } finally {
    signal.removeEventListener('abort', onAbort)
    await browser?.close().catch(() => {})
  }

  return { results, sessionId }
}

async function captureStory ({
  page,
  story,
  target,
  config,
  devServerUrl,
  projectRoot,
  signal,
}: {
  page: Page
  story: StoryEntry
  target: RunTarget
  config: ProjectConfig
  devServerUrl: string
  projectRoot: string
  signal: AbortSignal
}): Promise<StoryResult | null> {
  const base: Pick<StoryResult, 'storyId' | 'target'> = { storyId: story.id, target: target.key }
  const storyUrl = `${devServerUrl.replace(/\/$/, '')}/iframe.html?id=${encodeURIComponent(story.id)}&viewMode=story`

  let actual: Buffer

  try {
    await page.goto(storyUrl, { waitUntil: 'domcontentloaded', timeout: GOTO_TIMEOUT_MS })
    await page.waitForSelector(ROOT_SELECTOR, { timeout: GOTO_TIMEOUT_MS })
    // Fonts change metrics, so a screenshot taken before they load is a
    // different image every time depending on cache warmth.
    await page.evaluate(() => document.fonts.ready)
    await waitForStableStory(page)

    /**
     * Hosted mode never takes a screenshot here, on either driver. hub
     * captures and compares on its own side, so this returns before the
     * download, the local baseline and the diff. See hosted-visual.ts.
     */
    if (visualMode(config) === 'hosted') {
      const name = visualNameFor(story.id)

      if (!isValidVisualName(name)) {
        return {
          ...base,
          outcome: 'failed',
          message:
            `Story id "${story.id}" cannot be used as a hosted visual name. ` +
            'TestingBot allows letters, digits, dot, underscore and hyphen, up to 128 characters.',
        }
      }

      const response = await visualSnapshot(
        page,
        buildSnapshotArguments(name, buildSnapshotOptions(config, ROOT_SELECTOR)),
      )

      return mapSnapshotResponse(response, base)
    }

    /**
     * The story element, not the page.
     *
     * This is a deliberate departure from the reference spec's fullPage. A
     * tolerance is a fraction of the image, and a full page is mostly empty
     * space around the component: at 1280x720 the default 2% is 18,432 pixels,
     * which is larger than most components. Measured on this project, a CSS
     * change that visibly altered every button scored 0.0012 to 0.0108 full
     * page and passed. Cropping to the component makes the denominator the
     * thing under test, so the same change scores in the tens of percent.
     *
     * Stories that render into a portal outside #storybook-root can opt back
     * out with "fullPage": true in the config.
     */
    actual = config.fullPage === true
      ? await page.screenshot({ animations: 'disabled', fullPage: true, type: 'png' })
      : await page.locator(ROOT_SELECTOR).screenshot({ animations: 'disabled', type: 'png' })
  } catch (error) {
    // Cancelling closes the browser under the running command, so the error
    // here describes the teardown rather than the story.
    if (signal.aborted) return null

    // One story failing to render is not a reason to abandon the other
    // fourteen, so this is reported and the loop continues.
    return { ...base, outcome: 'failed', message: (error as Error).message.split('\n')[0] }
  }

  return recordStory({ actual, story, target, config, projectRoot })
}

/**
 * Turns one screenshot into one result: write it, compare it to the baseline,
 * and write the diff.
 *
 * Shared by both drivers, and it has to be. A device screenshot compared by
 * slightly different code from a browser screenshot would drift, and the first
 * symptom would be a tolerance that means one thing on desktop and another on
 * a phone.
 */
function recordStory ({
  actual,
  story,
  target,
  config,
  projectRoot,
}: {
  actual: Buffer
  story: StoryEntry
  target: RunTarget
  config: ProjectConfig
  projectRoot: string
}): StoryResult {
  const base: Pick<StoryResult, 'storyId' | 'target'> = { storyId: story.id, target: target.key }
  const baselineFile = baselinePath(projectRoot, target.key, story.id)
  const actualFile = resultPath(projectRoot, target.key, story.id, 'actual')

  writeImage(actualFile, actual)

  const baseline = readBaseline(baselineFile)

  if (!baseline) {
    // First run for this target: the screenshot becomes the baseline. It came
    // from the grid, which is the only place a baseline may come from.
    writeImage(baselineFile, actual)

    return { ...base, outcome: 'new', baselinePath: baselineFile, actualPath: actualFile }
  }

  let comparison

  try {
    comparison = compareImages(baseline, actual, config.maxDiffPixelRatio ?? DEFAULT_MAX_DIFF_PIXEL_RATIO)
  } catch (error) {
    return { ...base, outcome: 'failed', message: `Could not compare images: ${(error as Error).message}` }
  }

  if (comparison.equal) {
    return { ...base, outcome: 'passed', diffPixelRatio: 0, baselinePath: baselineFile, actualPath: actualFile }
  }

  if ('sizeMismatch' in comparison) {
    return {
      ...base,
      outcome: 'diff',
      diffPixelRatio: 1,
      baselinePath: baselineFile,
      actualPath: actualFile,
      message: `Size changed from ${comparison.sizeMismatch.baseline} to ${comparison.sizeMismatch.actual}.`,
    }
  }

  const diffFile = resultPath(projectRoot, target.key, story.id, 'diff')

  writeImage(diffFile, comparison.diff)

  return {
    ...base,
    outcome: 'diff',
    diffPixelRatio: comparison.diffPixelRatio,
    baselinePath: baselineFile,
    actualPath: actualFile,
    diffPath: diffFile,
  }
}

/**
 * Waits until the story stops changing shape.
 *
 * `#storybook-root` existing is not the same as the story being finished. A
 * story with a play function keeps mutating after first paint, and screenshots
 * taken mid-flight are a different image every run. Measured on the example
 * project: signupform--submits-successfully came out 1248x226 on one run and
 * 1248x68 on the next, and badge--neutral alternated between 48 and 71 pixels
 * tall.
 *
 * Watching the DOM settle rather than hooking a Storybook internal keeps this
 * working across Storybook versions, and covers play functions, late fonts and
 * lazily loaded images with one mechanism.
 *
 * A story that never settles, because something animates forever, is
 * screenshotted anyway once the cap is reached. Refusing to produce an image
 * would be worse than producing one that may differ.
 */
async function waitForStableStory (page: Page): Promise<void> {
  try {
    await page.waitForFunction(
      ({ selector, quietMs }) => {
        const element = document.querySelector(selector)

        if (!element) return false

        const rect = element.getBoundingClientRect()
        const signature = `${rect.width}x${rect.height}:${element.innerHTML.length}`
        const state = window as unknown as { __tbSignature?: string; __tbSince?: number }
        const now = performance.now()

        if (state.__tbSignature !== signature) {
          state.__tbSignature = signature
          state.__tbSince = now

          return false
        }

        return now - (state.__tbSince ?? now) >= quietMs
      },
      { selector: ROOT_SELECTOR, quietMs: SETTLE_QUIET_MS },
      { timeout: SETTLE_TIMEOUT_MS, polling: 100 },
    )
  } catch {
    // Cap reached. Fall through and screenshot what is on screen.
  }
}

/**
 * The real iOS path.
 *
 * Playwright has no iOS device backend, so Mobile Safari on a physical iPhone
 * is driven over WebDriver instead. TB-260 is explicit that these are two code
 * paths and must not be conflated, and this is the second one. Everything after
 * the screenshot is byte-identical to the Playwright path, because both end up
 * in recordStory.
 *
 * Real Android does not come through here: Playwright can drive Chrome on a
 * real Android device, so those targets stay on the connect path and reuse all
 * of its behaviour.
 */
async function runDeviceTarget ({
  target,
  stories,
  credentials,
  tunnel,
  build,
  config,
  devServerUrl,
  projectRoot,
  signal,
  onProgress,
}: TargetRunArgs): Promise<TargetRunOutcome> {
  throwIfAborted(signal)

  const capabilities = buildDeviceCapabilities(target.spec, {
    label: `Storybook: ${target.label}`,
    build,
    credentials,
    tunnel,
  })

  const results: StoryResult[] = []

  let session: WebDriverSession | null = null

  // Same reasoning as the Playwright path: cancelling has to close the session,
  // not just stop the loop, or the device stays allocated and billed.
  const onAbort = (): void => {
    session?.close().catch(() => {})
  }

  signal.addEventListener('abort', onAbort, { once: true })

  try {
    session = await WebDriverSession.create(capabilities)

    onProgress({ phase: 'target-started', target: target.key, label: target.label, total: stories.length })

    for (const [index, story] of stories.entries()) {
      if (signal.aborted) break

      const result = await captureStoryOnDevice({
        session,
        story,
        target,
        config,
        devServerUrl,
        projectRoot,
        signal,
      })

      if (!result) break

      results.push(result)
      onProgress({ phase: 'story', index: index + 1, total: stories.length, result })
    }

    const passed = results.every((result) => result.outcome === 'passed' || result.outcome === 'new')

    await session.annotate('setSessionStatus', {
      passed,
      reason: passed ? 'All stories matched' : 'Visual differences found',
    })
    onProgress({ phase: 'target-finished', target: target.key, label: target.label })
  } catch (error) {
    if (signal.aborted) {
      return { results, sessionId: session?.sessionId ?? null }
    }

    throw new RunError(
      `${target.label}: ${(error as Error).message.split('\n')[0]}`,
      'DEVICE_SESSION_FAILED',
    )
  } finally {
    signal.removeEventListener('abort', onAbort)
    await session?.close().catch(() => {})
  }

  return { results, sessionId: session?.sessionId ?? null }
}

async function captureStoryOnDevice ({
  session,
  story,
  target,
  config,
  devServerUrl,
  projectRoot,
  signal,
}: {
  session: WebDriverSession
  story: StoryEntry
  target: RunTarget
  config: ProjectConfig
  devServerUrl: string
  projectRoot: string
  signal: AbortSignal
}): Promise<StoryResult | null> {
  const base: Pick<StoryResult, 'storyId' | 'target'> = { storyId: story.id, target: target.key }
  const storyUrl = `${devServerUrl.replace(/\/$/, '')}/iframe.html?id=${encodeURIComponent(story.id)}&viewMode=story`

  let actual: Buffer

  try {
    await session.navigate(storyUrl)
    await waitForStableStoryOnDevice(session, signal)

    /**
     * Crop to the story element, for the same reason the Playwright path does:
     * a tolerance is a fraction of the image, and on a phone the empty space
     * around a component is an even larger share of the screen than on desktop,
     * so a full-screen denominator would swallow almost any real change.
     *
     * If the element screenshot is refused, fall back to the whole screen. That
     * fallback is stable per platform, so baseline and actual stay comparable;
     * what it costs is sensitivity, not correctness.
     */
    /**
     * Hosted mode never takes a screenshot here. hub captures and compares on
     * its own side, so returning early skips the download, the local baseline
     * and the diff entirely. See hosted-visual.ts.
     */
    if (visualMode(config) === 'hosted') {
      const name = visualNameFor(story.id)

      if (!isValidVisualName(name)) {
        return {
          ...base,
          outcome: 'failed',
          message:
            `Story id "${story.id}" cannot be used as a hosted visual name. ` +
            'TestingBot allows letters, digits, dot, underscore and hyphen, up to 128 characters.',
        }
      }

      const response = await session.execute(
        buildSnapshotScript(name, buildSnapshotOptions(config, ROOT_SELECTOR)),
      )

      return mapSnapshotResponse(response, base)
    }

    const element = config.fullPage === true ? null : await session.findElement(ROOT_SELECTOR)

    try {
      actual = await session.screenshot(element)
    } catch (error) {
      if (!element) throw error

      actual = await session.screenshot(null)
    }
  } catch (error) {
    if (signal.aborted) return null

    return { ...base, outcome: 'failed', message: (error as Error).message.split('\n')[0] }
  }

  return recordStory({ actual, story, target, config, projectRoot })
}

/**
 * The settle wait, ported to WebDriver.
 *
 * Same rule as waitForStableStory: wait until the story's size and markup
 * length stop changing. It has to be polled from here rather than expressed as
 * one waiting script, because `execute/sync` has no equivalent of Playwright's
 * waitForFunction and a script that blocks the page would hit the driver's own
 * script timeout instead of ours.
 *
 * The per-poll state lives on `window`, so a navigation resets it, which is
 * exactly what should happen between stories.
 */
async function waitForStableStoryOnDevice (session: WebDriverSession, signal: AbortSignal): Promise<void> {
  const script = `
    var selector = arguments[0], quietMs = arguments[1];
    var element = document.querySelector(selector);
    if (!element) return false;
    var rect = element.getBoundingClientRect();
    var signature = rect.width + 'x' + rect.height + ':' + element.innerHTML.length;
    var now = Date.now();
    if (window.__tbSignature !== signature) {
      window.__tbSignature = signature;
      window.__tbSince = now;
      return false;
    }
    return now - (window.__tbSince || now) >= quietMs;
  `

  const deadline = Date.now() + SETTLE_TIMEOUT_MS

  while (Date.now() < deadline) {
    if (signal.aborted) return

    try {
      if (await session.execute(script, [ROOT_SELECTOR, SETTLE_QUIET_MS]) === true) return
    } catch {
      // A script that cannot run at all means the page is not ready yet, or the
      // story never renders. Either way the deadline below is the answer.
    }

    await sleep(DEVICE_POLL_MS)
  }

  // Cap reached, same as the Playwright path: screenshot what is on screen
  // rather than refuse to produce an image.
}

function sleep (ms: number): Promise<void> {
  return new Promise((resolve) => { setTimeout(resolve, ms).unref?.() })
}

function throwIfAborted (signal: AbortSignal): void {
  if (signal.aborted) {
    throw new RunError('Run cancelled.', 'CANCELLED')
  }
}

/**
 * Runs `worker` over `items` with at most `size` in flight.
 *
 * Small enough to keep rather than take a dependency for, and the semantics
 * matter: the first rejection propagates, but only after the workers already
 * running have settled, so a failure on one browser cannot leave another
 * browser's session open.
 */
async function pool<T> (items: T[], size: number, worker: (item: T) => Promise<void>): Promise<void> {
  const queue = [...items]
  const errors: unknown[] = []

  const lanes = Array.from({ length: Math.min(size, queue.length) }, async () => {
    for (;;) {
      const item = queue.shift()

      if (item === undefined) return

      try {
        await worker(item)
      } catch (error) {
        errors.push(error)
        return
      }
    }
  })

  await Promise.all(lanes)

  if (errors.length > 0) throw errors[0]
}
