import { STATUS_TYPE_ID, TB_EVENTS } from './constants.js'
import { withNonce } from './nonce.js'
import type { RunResult, StoryOutcome, StoryResult } from './node/types.js'

/**
 * The Testing widget's logic, with no Storybook imports in it. TB-258.
 *
 * Split out from test-provider.tsx so it can be tested in Node. Importing the
 * manager bundle here would drag in storybook/manager-api and React, neither of
 * which runs outside a browser, and the mapping below is exactly the part worth
 * testing: a provider that reports the wrong state is worse than no provider,
 * because the widget would say a run succeeded when the tunnel never came up.
 */

const STATUS_BY_OUTCOME: Record<StoryOutcome, 'status-value:success' | 'status-value:warning' | 'status-value:error'> = {
  // A first baseline is not a pass. Nothing was compared, and calling it green
  // would hide the one run where a wrong screenshot gets frozen in as truth.
  new: 'status-value:warning',
  passed: 'status-value:success',
  diff: 'status-value:error',
  failed: 'status-value:error',
}

/** Worst wins. A story that passed on Chrome and differs on Safari has differed. */
const SEVERITY: Record<StoryOutcome, number> = { passed: 0, new: 1, diff: 2, failed: 3 }

function describe (results: StoryResult[]): string {
  return results
    .map((result) => {
      if (result.outcome === 'diff' && typeof result.diffPixelRatio === 'number') {
        return `${result.target}: ${(result.diffPixelRatio * 100).toFixed(3)}% of pixels differ`
      }
      if (result.outcome === 'failed') return `${result.target}: ${result.message ?? 'failed'}`
      if (result.outcome === 'new') return `${result.target}: new baseline`
      return `${result.target}: matches baseline`
    })
    .join('\n')
}

/**
 * One status per story, folded from every target that ran it.
 *
 * The status store is keyed by story and type id, so there is room for exactly
 * one entry per story no matter how many browsers were used. Reporting only the
 * last target to finish would make the sidebar depend on scheduling order.
 */
export function toStatuses (results: StoryResult[]) {
  const byStory = new Map<string, StoryResult[]>()

  for (const result of results) {
    const existing = byStory.get(result.storyId)
    if (existing) existing.push(result)
    else byStory.set(result.storyId, [result])
  }

  return [...byStory.entries()].map(([storyId, forStory]) => {
    const worst = forStory.reduce((a, b) => (SEVERITY[b.outcome] > SEVERITY[a.outcome] ? b : a))

    return {
      typeId: STATUS_TYPE_ID,
      storyId,
      value: STATUS_BY_OUTCOME[worst.outcome],
      title: 'TestingBot',
      description: describe(forStory),
      // Storybook offers the status in the sidebar's right-click menu, which is
      // the only way to get from a red icon to the comparison without hunting
      // for the story in the panel.
      sidebarContextMenu: true,
    }
  })
}

/**
 * Only the parts of Storybook's channel and stores this file touches.
 *
 * The listener is deliberately as loose as Storybook's own Listener type. A
 * tighter signature is not assignable from the real Channel under
 * strictFunctionTypes, and a cast at the call site would hide a genuine
 * mismatch if the channel API ever changes.
 */
export type TestProviderChannel = {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  on (event: string, listener: (...args: any[]) => void): void
  emit (event: string, payload?: unknown): void
}

export type StatusStoreLike = {
  set (statuses: ReturnType<typeof toStatuses>): void
  unset (storyIds?: string[]): void
}

export type TestProviderStoreLike = {
  setState (state: 'test-provider-state:running' | 'test-provider-state:succeeded' | 'test-provider-state:crashed' | 'test-provider-state:pending'): void
  onRunAll (listener: () => void): () => void
  onClearAll (listener: () => void): () => void
}

/**
 * The channel wiring, kept out of React so that it survives the widget being
 * unmounted. Exported for the tests, which drive it with a fake channel.
 */
export function connectTestProvider (
  channel: TestProviderChannel,
  statusStore: StatusStoreLike,
  providerStore: TestProviderStoreLike,
): void {
  const seen: StoryResult[] = []

  const publish = () => statusStore.set(toStatuses(seen))

  channel.on(TB_EVENTS.RUN_STARTED, () => {
    seen.length = 0
    // Clearing rather than marking every story pending: we do not know which
    // stories this run covers until the runner says so, and painting the whole
    // sidebar pending for a single-story run would be a lie about scope.
    statusStore.unset()
    providerStore.setState('test-provider-state:running')
  })

  channel.on(TB_EVENTS.RUN_PROGRESS, (event: { phase: string; result?: StoryResult }) => {
    if (event.phase !== 'story' || !event.result) return
    seen.push(event.result)
    publish()
  })

  channel.on(TB_EVENTS.RUN_FINISHED, (result: RunResult) => {
    // Succeeded means the run completed, including a run that found
    // differences. Those are reported per story, not as a crash of the whole
    // provider, which is what the Storybook docs ask for.
    providerStore.setState('test-provider-state:succeeded')
    if (result?.stories) {
      seen.length = 0
      seen.push(...result.stories)
      publish()
    }
  })

  channel.on(TB_EVENTS.RUN_ERROR, () => {
    // The run itself did not happen. No credentials, no tunnel, no Storybook.
    providerStore.setState('test-provider-state:crashed')
  })

  channel.on(TB_EVENTS.RESULTS_LOADED, ({ result }: { result: RunResult | null }) => {
    // Results from a previous session, restored on load, so a reload does not
    // wipe the sidebar. Not a state change: nothing ran just now.
    if (!result?.stories?.length) return
    seen.length = 0
    seen.push(...result.stories)
    publish()
  })

  providerStore.onRunAll(() => {
    channel.emit(TB_EVENTS.RUN, withNonce({ scope: 'all' }))
  })

  providerStore.onClearAll(() => {
    seen.length = 0
    statusStore.unset()
  })

  channel.emit(TB_EVENTS.GET_RESULTS, withNonce({}))
}

