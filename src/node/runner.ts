import { _android, chromium, firefox, webkit } from 'playwright-core'
import type { BrowserType, Page } from 'playwright-core'

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
import { applyShard, resolveShard } from './shard.js'
import { fetchStoryIndex, selectStories } from './story-index.js'
import {
  EXTRACT_ASYNC_SCRIPT,
  EXTRACT_EXPRESSION,
  PARAMETER_KEY,
  partitionSkipped,
  storyUrl,
  toParameterMap,
} from './story-parameters.js'
import type { ShardRequest, ShardSpec } from './shard.js'
import type { ParameterMap, StoryParameters } from './story-parameters.js'
import { getSessionId, setSessionName, setSessionStatus, visualSnapshot } from './session.js'
import {
  browserTypeFor,
  buildAndroidCapabilities,
  buildCapabilities,
  buildWsEndpoint,
  DEFAULT_VIEWPORT,
  resolveWidths,
  toTargets,
  variantsFor,
} from './targets.js'
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
/**
 * Storybook renders a docs page into its own element and leaves #storybook-root
 * empty, so a docs capture aimed at the story root would wait fifteen seconds
 * and then screenshot nothing. Confirmed against a Storybook 10.5 build:
 * iframe.html carries both elements, and the preview's own docsRoot() returns
 * this one.
 */
const DOCS_SELECTOR = '#storybook-docs'
const SETTLE_QUIET_MS = 500
const SETTLE_TIMEOUT_MS = 15_000
/**
 * How long a story's own waitForSelector may take. Shorter than GOTO_TIMEOUT_MS
 * on purpose: the page has already loaded by then, so this is waiting on the
 * component rather than on the network, and thirty seconds of that per story
 * across five targets is a bill rather than a wait. Overridable per story with
 * the waitTimeout parameter.
 */
const SELECTOR_TIMEOUT_MS = 15_000
/** Real devices are slow enough that polling faster than this only wastes commands. */
const DEVICE_POLL_MS = 400
/** Mirrors DEFAULT_CONFIG in src/server/projectConfig.cjs. */
const DEFAULT_MAX_DIFF_PIXEL_RATIO = 0.001
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
  /**
   * Take only this slice of the stories, so a large Storybook can be split
   * across CI machines. Null runs everything. See shard.ts. TB-356.
   */
  shard?: ShardRequest | null
  /**
   * Say up front that this run is not the whole project, even when it is not
   * sharded. A sharded run is partial whether this is set or not.
   */
  partial?: boolean
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
  shard: shardRequest = null,
  partial = false,
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
  const selected = selectStories(scoped, {
    // selectStories already narrowed to a single story if it needed to; passing
    // storyId again here would undo the component scope.
    storyId: null,
    include: config.include ?? [],
    exclude: config.exclude ?? [],
    captureDocs: config.captureDocs === true,
    captureAutodocs: config.captureAutodocs === true,
  })

  if (selected.length === 0) {
    throw new RunError(
      describeEmptySelection(allStories, scope, storyId),
      'NO_STORIES',
    )
  }

  // The shard is taken after everything else has had its say, so that
  // "one quarter of the run" means one quarter of what this project actually
  // captures rather than one quarter of the raw index. An out of range index
  // throws here: it means the CI matrix and the flags disagree, and the
  // stories nobody claimed would otherwise go uncaptured in silence.
  let shard: ShardSpec | null = null

  try {
    shard = shardRequest ? resolveShard(shardRequest, selected.length) : null
  } catch (error) {
    throw new RunError((error as Error).message, 'BAD_SHARD')
  }

  const stories = shard ? applyShard(selected, shard) : selected

  // Reported before anything is booted, because it is the number the developer
  // is about to watch tick up and it is not the project's story count.
  onProgress({ phase: 'stories', total: stories.length })

  for (const entry of skipped) {
    onProgress({ phase: 'target-skipped', target: entry.key, label: entry.label, reason: entry.reason })
  }

  const tunnel = tunnelManager ?? new TunnelManager({ credentials })
  const results: StoryResult[] = []
  const sessions: RunResult['targets'] = []

  // Every target reads the same story parameters, so every target finds the
  // same things to say about them. Said once.
  const announced = new Set<string>()
  const notify = (message: string): void => {
    if (announced.has(message)) return

    announced.add(message)
    onProgress({ phase: 'notice', message })
  }

  // Said rather than left to be inferred from a device folder that has no width
  // in its name. A developer who asked for 375 and 1280 and got one set of
  // iPhone baselines should be told which of the two it is, and it is neither.
  const widths = resolveWidths(config)

  if (widths && targets.some((target) => target.kind === 'device')) {
    notify(
      `"widths" applies to desktop browsers only. Real devices were captured at their own screen size, ` +
      `not at ${widths.join(' and ')} pixels.`,
    )
  }

  // A shard can be empty, when the CI matrix has more machines in it than the
  // project has stories. That is a matrix that is wider than it needs to be,
  // not a failure, and it is not worth a tunnel or a grid session either: the
  // run below is skipped whole and the result says it covered nothing.
  if (stories.length === 0) {
    notify('This shard has no stories in it. There are more shards than there are stories to spread over them.')
  } else {
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
          notify,
        }

        /**
         * One target that cannot start is not a reason to throw away the ones
         * that did. A device that is out of stock, or a browser the grid refuses,
         * used to abort the pool and discard every result already collected: a
         * five-target run lost four working targets to the fifth. It is recorded
         * as skipped instead, which already makes the run report red.
         */
        let outcome: TargetRunOutcome

        try {
          outcome = target.kind === 'device' && deviceDriverFor(target.spec) === 'webdriver'
            ? await runDeviceTarget(args)
            : await runTarget(args)
        } catch (error) {
          if (signal.aborted) throw error

          const reason = (error as Error).message
          skipped.push({ key: target.key, label: target.label, reason })
          onProgress({ phase: 'target-skipped', target: target.key, label: target.label, reason })

          return
        }

        results.push(...outcome.results)

        // One entry per variant, all pointing at the one session that produced
        // them. The panel lists what was captured, and a width is a thing that
        // was captured even though it was not a thing that was booted.
        for (const variant of outcome.reported) {
          sessions.push({ key: variant.key, label: variant.label, sessionId: outcome.sessionId })
        }
      })
    } finally {
      // Always, including on cancellation. A tunnel left running holds one of the
      // account's slots and the next run fails with CONCURRENCY_EXHAUSTED.
      await tunnel.stop().catch(() => {})
    }
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
    // A sharded run is partial whether or not anyone said so: it ran a quarter
    // of the stories and knows nothing about the other three quarters. "ok"
    // above still means "everything this run covered matched", because that is
    // what the exit code has to be or every shard job would fail by design.
    ...(partial || shard ? { partial: true } : {}),
    ...(shard
      ? { shard: { index: shard.index, count: shard.count, selected: stories.length, total: selected.length } }
      : {}),
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

  const published = allStories.filter((story) => story.type === 'story').length
  const docs = allStories.length - published

  // Naming the docs pages matters here. Without it, a Storybook that is nothing
  // but MDX reports "Storybook published 0" and sends the developer looking for
  // a broken index rather than for a setting that is off.
  const aside = docs > 0
    ? ` ${docs} docs page${docs === 1 ? '' : 's'} were not run: see "captureDocs" and "captureAutodocs".`
    : ''

  return `No stories matched. Storybook published ${published}; check "include" and "exclude".${aside}`
}

/** Where this entry renders. The index says which, so nothing has to guess. */
function rootSelectorFor (story: StoryEntry): string {
  return story.type === 'docs' ? DOCS_SELECTOR : ROOT_SELECTOR
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
  /** Reports something once per run, however many targets discover it. */
  notify: (message: string) => void
}

/**
 * `reported` is the variants this target actually announced, which is not
 * always one. A target run at three widths reports as three lines in the panel
 * and three baseline folders while holding a single grid session, so the run
 * result lists three entries sharing one session id.
 */
type TargetRunOutcome = {
  results: StoryResult[]
  sessionId: string | null
  reported: { key: string; label: string }[]
}

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
  notify,
}: TargetRunArgs): Promise<TargetRunOutcome> {
  throwIfAborted(signal)

  const android = target.kind === 'device' && deviceDriverFor(target.spec) === 'playwright'
  const capabilities = android
    ? buildAndroidCapabilities(target, { credentials, tunnel, build })
    : buildCapabilities(target, { credentials, tunnel, build })
  const variants = variantsFor(target, config)
  const results: StoryResult[] = []

  let connection: GridConnection | null = null
  let sessionId: string | null = null

  /**
   * Cancellation has to reach into the open connection, not just stop the loop.
   * Playwright will happily sit in page.goto for a minute, and until the socket
   * closes the grid keeps the VM and keeps charging for it.
   */
  const onAbort = (): void => {
    connection?.close().catch(() => {})
  }

  signal.addEventListener('abort', onAbort, { once: true })

  try {
    connection = android
      ? await connectAndroid(capabilities)
      : await connectBrowser(capabilities, target, variants[0]?.viewport ?? null)

    const page = connection.page

    sessionId = await getSessionId(page)
    await setSessionName(page, `Storybook: ${target.label}`)

    const parameters = await readStoryParameters(
      () => page.evaluate(EXTRACT_EXPRESSION),
      devServerUrl,
      (url) => page.goto(url, { waitUntil: 'domcontentloaded', timeout: GOTO_TIMEOUT_MS }).then(() => {}),
      notify,
    )

    const { run, skipped: skippedStories } = partitionSkipped(stories, parameters)

    for (const story of skippedStories) {
      notify(`${story.id} was skipped by its own "${PARAMETER_KEY}.skip" parameter.`)
    }

    for (const variant of variants) {
      if (signal.aborted) break

      // Only when there is more than one, because the context was already
      // created at the first variant's size and a resize that changes nothing
      // is still a round trip to the grid.
      if (variants.length > 1 && variant.viewport) {
        await page.setViewportSize(variant.viewport)
      }

      onProgress({ phase: 'target-started', target: variant.key, label: variant.label, total: run.length })

      for (const [index, story] of run.entries()) {
        if (signal.aborted) break

        const result = await captureStory({
          page,
          story,
          parameters: parameters[story.id],
          targetKey: variant.key,
          config,
          devServerUrl,
          projectRoot,
          signal,
          notify,
        })

        // Null means the cancel landed while this story was in flight. It is
        // not a failure and must not be counted as one, or every cancelled run
        // would report red.
        if (!result) break

        results.push(result)
        onProgress({ phase: 'story', index: index + 1, total: run.length, result })
      }

      onProgress({ phase: 'target-finished', target: variant.key, label: variant.label })
    }

    const passed = results.every((result) => result.outcome === 'passed' || result.outcome === 'new')

    await setSessionStatus(page, passed, passed ? 'All stories matched' : 'Visual differences found')
  } catch (error) {
    if (signal.aborted) {
      return { results, sessionId, reported: variants }
    }

    throw new RunError(
      `${target.label}: ${(error as Error).message.split('\n')[0]}`,
      'GRID_SESSION_FAILED',
    )
  } finally {
    signal.removeEventListener('abort', onAbort)
    await connection?.close().catch(() => {})
  }

  return { results, sessionId, reported: variants }
}

/** One open grid session, however it was opened. */
type GridConnection = { page: Page; close: () => Promise<void> }

/**
 * A grid browser. The context is sized to the first variant's viewport, because
 * on desktop the viewport is the addon's to choose and an unpinned one would
 * make every baseline depend on whatever the grid VM happened to be running.
 * Later variants resize the page rather than opening a second session.
 */
async function connectBrowser (
  capabilities: Record<string, unknown>,
  target: RunTarget,
  viewport: Viewport | null,
): Promise<GridConnection> {
  const browserType = BROWSER_TYPES[browserTypeFor(target.spec)] as BrowserType
  const browser = await browserType.connect(buildWsEndpoint(capabilities), { timeout: CONNECT_TIMEOUT_MS })

  const context = await browser.newContext({
    viewport: viewport ?? DEFAULT_VIEWPORT,
    // Screenshots must not include a scrollbar that appears only on some
    // platforms, and reduced motion removes one more source of run-to-run
    // difference on top of Playwright's own animation freezing.
    reducedMotion: 'reduce',
  })

  return { page: await context.newPage(), close: () => browser.close() }
}

/**
 * A real Android device, which Playwright reaches through _android rather than
 * chromium. Connecting with the chromium client instead fails with "Malformed
 * endpoint. Did you use BrowserType.launchServer method?", because the server
 * hands back a device where the client expected a pre-launched browser.
 *
 * The device's own browser is launched and its first page used as it comes. No
 * viewport is set: the screen is the point of running on real hardware, and
 * overriding it would produce a desktop-shaped page on a phone.
 */
async function connectAndroid (capabilities: Record<string, unknown>): Promise<GridConnection> {
  const device = await _android.connect(buildWsEndpoint(capabilities), { timeout: CONNECT_TIMEOUT_MS })
  const context = await device.launchBrowser()
  const page = context.pages()[0] ?? await context.newPage()

  return {
    page,
    close: async () => {
      await context.close()
      await device.close()
    },
  }
}

/**
 * Asks the page for every story's parameters, once per target.
 *
 * The preview has to be loaded for the store to exist, so this navigates to the
 * bare iframe first. A Storybook that does not answer is not a failure: the run
 * proceeds with no per-story parameters, which is exactly how it behaved before
 * TB-353, and says so once rather than per target.
 */
async function readStoryParameters (
  evaluate: () => Promise<unknown>,
  devServerUrl: string,
  goto: (url: string) => Promise<void>,
  notify: (message: string) => void,
): Promise<ParameterMap> {
  try {
    await goto(`${devServerUrl.replace(/\/$/, '')}/iframe.html`)

    const raw = await evaluate()

    if (raw === null || raw === undefined) {
      notify('Storybook did not expose a story store, so no per-story parameters were read.')

      return {}
    }

    const { params, warnings } = toParameterMap(raw)

    for (const warning of warnings) notify(warning)

    return params
  } catch (error) {
    notify(`Story parameters could not be read: ${(error as Error).message.split('\n')[0]}`)

    return {}
  }
}

async function captureStory ({
  page,
  story,
  parameters,
  targetKey,
  config,
  devServerUrl,
  projectRoot,
  signal,
  notify,
}: {
  page: Page
  story: StoryEntry
  parameters: StoryParameters | undefined
  /** The variant's key, not the target's. They differ once widths are in play. */
  targetKey: string
  config: ProjectConfig
  devServerUrl: string
  projectRoot: string
  signal: AbortSignal
  notify: (message: string) => void
}): Promise<StoryResult | null> {
  const base: Pick<StoryResult, 'storyId' | 'target'> = { storyId: story.id, target: targetKey }
  const root = rootSelectorFor(story)
  const { url, rejected } = storyUrl(devServerUrl, story, parameters)

  for (const key of rejected) {
    notify(`${story.id}: "${key}" cannot travel in a URL, so the story rendered with its default.`)
  }

  let actual: Buffer

  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: GOTO_TIMEOUT_MS })
    await page.waitForSelector(root, { timeout: GOTO_TIMEOUT_MS })

    // The story's own precondition, before the generic settle wait: a component
    // that fetches has nothing to settle until its data arrives.
    if (parameters?.waitForSelector) {
      await page.waitForSelector(parameters.waitForSelector, {
        timeout: parameters.waitTimeout ?? SELECTOR_TIMEOUT_MS,
      })
    }

    // Fonts change metrics, so a screenshot taken before they load is a
    // different image every time depending on cache warmth.
    await page.evaluate(() => document.fonts.ready)
    await waitForStableStory(page, root)

    const renderError = await storyRenderError(page)

    if (renderError !== null) {
      return { ...base, outcome: 'failed', message: renderError }
    }

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
        buildSnapshotArguments(name, buildSnapshotOptions(config, root)),
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
      : await page.locator(root).screenshot({ animations: 'disabled', type: 'png' })
  } catch (error) {
    // Cancelling closes the browser under the running command, so the error
    // here describes the teardown rather than the story.
    if (signal.aborted) return null

    // One story failing to render is not a reason to abandon the other
    // fourteen, so this is reported and the loop continues.
    return { ...base, outcome: 'failed', message: (error as Error).message.split('\n')[0] }
  }

  return recordStory({ actual, story, targetKey, config, projectRoot })
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
  targetKey,
  config,
  projectRoot,
}: {
  actual: Buffer
  story: StoryEntry
  targetKey: string
  config: ProjectConfig
  projectRoot: string
}): StoryResult {
  const base: Pick<StoryResult, 'storyId' | 'target'> = { storyId: story.id, target: targetKey }
  const baselineFile = baselinePath(projectRoot, targetKey, story.id)
  const actualFile = resultPath(projectRoot, targetKey, story.id, 'actual')

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

  const diffFile = resultPath(projectRoot, targetKey, story.id, 'diff')

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
async function waitForStableStory (page: Page, selector: string): Promise<void> {
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
      { selector, quietMs: SETTLE_QUIET_MS },
      { timeout: SETTLE_TIMEOUT_MS, polling: 100 },
    )
  } catch {
    // Cap reached. Fall through and screenshot what is on screen.
  }
}

/**
 * Storybook catches a story that throws and swaps in its own error screen. The
 * story element stays in the document and is empty, so nothing above notices:
 * the selector is found and an empty element settles immediately. The failure
 * then surfaces as "locator.screenshot: Timeout exceeded", which sends whoever
 * reads it looking at the addon rather than at the story. Read the error out.
 */
async function storyRenderError (page: Page): Promise<string | null> {
  return page.evaluate(() => {
    if (!document.body.classList.contains('sb-show-errordisplay')) return null

    const message = document.querySelector('#error-message')?.textContent?.trim()

    return message ? `The story failed to render: ${message}` : 'The story failed to render.'
  })
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
  notify,
}: TargetRunArgs): Promise<TargetRunOutcome> {
  throwIfAborted(signal)

  const capabilities = buildDeviceCapabilities(target.spec, {
    label: `Storybook: ${target.label}`,
    build,
    credentials,
    tunnel,
  })

  const results: StoryResult[] = []
  // A device always reports as itself. It has the screen it has, so widths do
  // not apply and the key stays the one every existing device baseline uses.
  const reported = [{ key: target.key, label: target.label }]

  let session: WebDriverSession | null = null

  // Same reasoning as the Playwright path: cancelling has to close the session,
  // not just stop the loop, or the device stays allocated and billed.
  const onAbort = (): void => {
    session?.close().catch(() => {})
  }

  signal.addEventListener('abort', onAbort, { once: true })

  try {
    session = await WebDriverSession.create(capabilities)

    // The same read as the Playwright path, over the async execute endpoint,
    // which is the only one that can wait for the store to resolve.
    const opened = session
    const parameters = await readStoryParameters(
      async () => {
        const answer = await opened.executeAsync(EXTRACT_ASYNC_SCRIPT) as
          { value?: unknown; error?: string } | null

        if (answer?.error) throw new Error(answer.error)

        return answer?.value ?? null
      },
      devServerUrl,
      (url) => opened.navigate(url),
      notify,
    )

    const { run, skipped: skippedStories } = partitionSkipped(stories, parameters)

    for (const story of skippedStories) {
      notify(`${story.id} was skipped by its own "${PARAMETER_KEY}.skip" parameter.`)
    }

    onProgress({ phase: 'target-started', target: target.key, label: target.label, total: run.length })

    for (const [index, story] of run.entries()) {
      if (signal.aborted) break

      const result = await captureStoryOnDevice({
        session,
        story,
        parameters: parameters[story.id],
        targetKey: target.key,
        config,
        devServerUrl,
        projectRoot,
        signal,
        notify,
      })

      if (!result) break

      results.push(result)
      onProgress({ phase: 'story', index: index + 1, total: run.length, result })
    }

    const passed = results.every((result) => result.outcome === 'passed' || result.outcome === 'new')

    await session.annotate('setSessionStatus', {
      passed,
      reason: passed ? 'All stories matched' : 'Visual differences found',
    })
    onProgress({ phase: 'target-finished', target: target.key, label: target.label })
  } catch (error) {
    if (signal.aborted) {
      return { results, sessionId: session?.sessionId ?? null, reported }
    }

    throw new RunError(
      `${target.label}: ${(error as Error).message.split('\n')[0]}`,
      'DEVICE_SESSION_FAILED',
    )
  } finally {
    signal.removeEventListener('abort', onAbort)
    await session?.close().catch(() => {})
  }

  return { results, sessionId: session?.sessionId ?? null, reported }
}

async function captureStoryOnDevice ({
  session,
  story,
  parameters,
  targetKey,
  config,
  devServerUrl,
  projectRoot,
  signal,
  notify,
}: {
  session: WebDriverSession
  story: StoryEntry
  parameters: StoryParameters | undefined
  targetKey: string
  config: ProjectConfig
  devServerUrl: string
  projectRoot: string
  signal: AbortSignal
  notify: (message: string) => void
}): Promise<StoryResult | null> {
  const base: Pick<StoryResult, 'storyId' | 'target'> = { storyId: story.id, target: targetKey }
  const root = rootSelectorFor(story)
  const { url, rejected } = storyUrl(devServerUrl, story, parameters)

  for (const key of rejected) {
    notify(`${story.id}: "${key}" cannot travel in a URL, so the story rendered with its default.`)
  }

  let actual: Buffer

  try {
    await session.navigate(url)
    await freezeAnimationsOnDevice(session)

    if (parameters?.waitForSelector) {
      await waitForSelectorOnDevice(
        session,
        parameters.waitForSelector,
        parameters.waitTimeout ?? SELECTOR_TIMEOUT_MS,
        signal,
      )
    }

    await waitForStableStoryOnDevice(session, root, signal)

    const renderError = await storyRenderErrorOnDevice(session)

    if (renderError !== null) {
      return { ...base, outcome: 'failed', message: renderError }
    }

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
        buildSnapshotScript(name, buildSnapshotOptions(config, root)),
      )

      return mapSnapshotResponse(response, base)
    }

    const element = config.fullPage === true ? null : await session.findElement(root)

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

  return recordStory({ actual, story, targetKey, config, projectRoot })
}

/**
 * A story's own precondition, ported to WebDriver.
 *
 * Unlike the settle wait this one is allowed to give up loudly. The developer
 * named a selector that is supposed to appear, so if it never does the story is
 * not in the state they asked to screenshot, and a picture of the wrong state
 * is worse than a reported failure.
 */
async function waitForSelectorOnDevice (
  session: WebDriverSession,
  selector: string,
  timeoutMs: number,
  signal: AbortSignal,
): Promise<void> {
  const deadline = Date.now() + timeoutMs

  while (Date.now() < deadline) {
    if (signal.aborted) return
    if (await session.findElement(selector)) return

    await sleep(DEVICE_POLL_MS)
  }

  throw new Error(`Timed out waiting for "${selector}", which this story's waitForSelector parameter asked for.`)
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
async function waitForStableStoryOnDevice (
  session: WebDriverSession,
  selector: string,
  signal: AbortSignal,
): Promise<void> {
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
      if (await session.execute(script, [selector, SETTLE_QUIET_MS]) === true) return
    } catch {
      // A script that cannot run at all means the page is not ready yet, or the
      // story never renders. Either way the deadline below is the answer.
    }

    await sleep(DEVICE_POLL_MS)
  }

  // Cap reached, same as the Playwright path: screenshot what is on screen
  // rather than refuse to produce an image.
}

/**
 * The WebDriver half of Playwright's `animations: 'disabled'`.
 *
 * Without it the two drivers do not take comparable screenshots, and a story
 * that animates can never be stable on a device. Measured on this project:
 * motion-animated--spinner came back 1.7% different between two runs on an
 * iPhone that was otherwise 11 for 11, because the spinner was caught at a
 * different angle each time.
 *
 * Running every animation out in one millisecond lands on the end of the first
 * iteration, which for a loop is where it started. That is the same frame
 * Playwright settles on, and more importantly it is the same frame every run.
 */
async function freezeAnimationsOnDevice (session: WebDriverSession): Promise<void> {
  const script = `
    var style = document.createElement('style');
    style.textContent = '*, *::before, *::after {' +
      'animation-delay: -1ms !important;' +
      'animation-duration: 1ms !important;' +
      'animation-iteration-count: 1 !important;' +
      'transition-duration: 0s !important;' +
      'transition-delay: 0s !important;' +
    '}';
    document.head.appendChild(style);
    return true;
  `

  try {
    await session.execute(script, [])
  } catch {
    // A story with no animation loses nothing, and one with an animation is
    // better screenshotted moving than not screenshotted at all.
  }
}

/**
 * storyRenderError, ported to WebDriver for the same reason as the settle wait.
 */
async function storyRenderErrorOnDevice (session: WebDriverSession): Promise<string | null> {
  const script = `
    if (document.body.className.indexOf('sb-show-errordisplay') === -1) return null;
    var element = document.getElementById('error-message');
    var message = element && element.textContent ? element.textContent.trim() : '';
    return message ? 'The story failed to render: ' + message : 'The story failed to render.';
  `

  try {
    const result = await session.execute(script, [])

    return typeof result === 'string' ? result : null
  } catch {
    // A probe that cannot run at all says nothing about the story. Let the
    // screenshot below report whatever is actually wrong.
    return null
  }
}

/**
 * The timer is deliberately not unref'd. An unref'd sleep is invisible to the
 * event loop, so a run whose only pending work was a device poll would let Node
 * exit in the middle of it and the CLI would return without a word. Waiting up
 * to one poll interval after a cancel is the cheaper of the two.
 */
function sleep (ms: number): Promise<void> {
  return new Promise((resolve) => { setTimeout(resolve, ms) })
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
