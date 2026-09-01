/** Shared types for the Node half of the addon. */

export type Credentials = {
  key: string
  secret: string
  source: string
}

export type LocalPortCapability = {
  localHttpPorts?: number[]
  localHttpsPorts?: number[]
}

export type TunnelCapability = LocalPortCapability & {
  tunnelIdentifier: string
}

/** Only produced once a tunnel is actually up, so these are never null. */
export type TunnelInfo = {
  tunnelIdentifier: string
  devServerUrl: string
  capability: TunnelCapability
}

export type TunnelState = 'idle' | 'starting' | 'ready' | 'closing' | 'closed' | 'error'

export type TunnelProgress = {
  phase: 'starting' | 'launching' | 'ready'
  tunnelIdentifier: string
}

export type TunnelErrorCode =
  | 'JAVA_MISSING'
  | 'JAVA_TOO_OLD'
  | 'AUTH_REJECTED'
  | 'PLAN_EXHAUSTED'
  | 'CONCURRENCY_EXHAUSTED'
  | 'TUNNEL_TIMEOUT'
  | 'DOWNLOAD_FAILED'
  | 'TUNNEL_FAILED'

export type Logger = {
  info?: (message: string) => void
  warn?: (message: string) => void
  error?: (message: string) => void
}

export type StoryEntry = {
  id: string
  title: string
  name: string
  /**
   * What Storybook's index calls this entry. A docs page renders into a
   * different element, under a different viewMode, so the two cannot be treated
   * as one thing past this point. See TB-357.
   */
  type: 'story' | 'docs'
  /**
   * The index tags, kept for one reason: telling a generated autodocs page from
   * a hand written MDX one, which are separate settings because they are
   * separate decisions. Story entries inherit the `autodocs` tag from their
   * meta, so the tag only means what it says on a docs entry.
   */
  tags: string[]
}

/** A browser or device entry from the config, plus whatever extra tb:options the user set. */
export type TargetSpec = Record<string, unknown>

export type RunTarget = {
  /** Stable, filesystem-safe identity used as the baseline folder name. */
  key: string
  /** Human label for the UI. */
  label: string
  kind: 'browser' | 'device'
  spec: TargetSpec
}

export type Viewport = { width: number; height: number }

export type ProjectConfig = {
  browsers: TargetSpec[]
  devices: TargetSpec[]
  include: string[]
  exclude: string[]
  maxDiffPixelRatio: number
  viewport?: Viewport
  /**
   * Capture every story once per width, on desktop targets only. Absent means
   * one capture at `viewport`, which is what keeps existing baseline keys
   * intact. See variantsFor in targets.ts.
   */
  widths?: number[]
  /** Capture the whole page instead of the story element. See runner.ts. */
  fullPage?: boolean
  /**
   * Also capture hand written MDX docs pages. Off by default: a docs page is a
   * grid session like any other, and most of what it shows is already covered
   * story by story. TB-357.
   */
  captureDocs?: boolean
  /**
   * Also capture the docs pages Storybook generates from `tags: ['autodocs']`.
   * Separate from captureDocs because it is a separate decision: autodocs are
   * one page per component and arrive without anyone writing them.
   */
  captureAutodocs?: boolean
  /**
   * Who does the comparing. "local" compares against a PNG in the repository,
   * "hosted" delegates to TestingBot's visual service. See hosted-visual.ts.
   */
  visual?: 'local' | 'hosted'
  /** Options passed through to the hosted service. Ignored when visual is "local". */
  hostedVisual?: Record<string, unknown>
  [key: string]: unknown
}

export type StoryOutcome = 'new' | 'passed' | 'diff' | 'failed'

export type StoryResult = {
  storyId: string
  target: string
  outcome: StoryOutcome
  diffPixelRatio?: number
  /**
   * Hosted mode only, and deliberately not diffPixelRatio. hub returns a count
   * of differing pixels, not a fraction, and gives no dimensions to divide by,
   * so the two are not interchangeable and must not share a field.
   */
  pixelDifference?: number
  /** Hosted mode only: the TestingBot page for this comparison. */
  url?: string
  baselinePath?: string
  actualPath?: string
  diffPath?: string
  message?: string
}

export type RunProgressEvent =
  | { phase: 'tunnel'; message: string }
  | { phase: 'stories'; total: number }
  | { phase: 'target-started'; target: string; label: string; total: number }
  | { phase: 'story'; index: number; total: number; result: StoryResult }
  | { phase: 'target-finished'; target: string; label: string }
  | { phase: 'target-skipped'; target: string; label: string; reason: string }
  /**
   * Something the developer should know that is not a target and not a story
   * result: a story that asked to be skipped, or a parameter that was ignored.
   * Emitted at most once per distinct message per run, because every target
   * reads the same parameters and would otherwise say the same thing five
   * times.
   */
  | { phase: 'notice'; message: string }

export type RunResult = {
  ok: boolean
  cancelled?: boolean
  totals: Record<StoryOutcome, number>
  stories: StoryResult[]
  targets: { key: string; label: string; sessionId: string | null }[]
  /**
   * Targets that were configured but never run, with the reason. Real devices
   * land here when the Storybook is not reachable from a device (TB-260).
   * Reporting them is not optional: a run that quietly covered fewer targets
   * than asked would show green for browsers nobody tested.
   */
  skipped?: { key: string; label: string; reason: string }[]
  baselineDir: string
}

/**
 * What the runner needs from a tunnel, which is less than TunnelManager does.
 *
 * The CLI has a second implementation: in CI the tunnel is usually already
 * running, started by testingbot/testingbot-tunnel-action, and starting a
 * second one would consume a parallel session the customer has paid for and
 * would fail once the account limit is reached.
 */
export interface TunnelProvider {
  ensureStarted (
    devServerUrl: string,
    options?: { onProgress?: (progress: TunnelProgress) => void; alsoProxy?: string[] },
  ): Promise<TunnelInfo>
  stop (): Promise<void>
}
