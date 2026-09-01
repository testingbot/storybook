import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { addons } from 'storybook/manager-api'

import { TB_EVENTS } from '../constants.js'
import { withNonce } from '../nonce.js'
import type { Catalogue } from '../node/catalogue.js'
import type { DeviceReachabilityView } from './DevicePicker.js'
import type {
  ProjectConfig,
  RunProgressEvent,
  RunResult,
  StoryResult,
  TargetSpec,
} from '../node/types.js'

/**
 * All of the panel's channel wiring, in one place.
 *
 * The panel, the toolbar button and the results view all need the same
 * conversation with Node, and duplicating the subscription in three components
 * would mean three sets of listeners, three run triggers per click, and three
 * chances to forget the nonce. Everything mutating goes through withNonce here
 * so no caller has to remember.
 */

export type CredentialStatus = {
  configured: boolean
  source: string | null
  overriddenByEnvironment: boolean
}

export type RunScope = 'story' | 'component' | 'all'

/** Live progress, rebuilt from the runner's event stream as it arrives. */
export type LiveProgress = {
  message: string | null
  totalStories: number
  targets: Record<string, { label: string; done: number; total: number; finished: boolean }>
  /** Configured targets the runner refused to start, and why. See TB-260. */
  skipped: { target: string; label: string; reason: string }[]
  /** Things worth saying that are not a target and not a story result. See RunProgressEvent. */
  notices: string[]
  stories: StoryResult[]
}

export type RunPhase =
  | { phase: 'idle' }
  | { phase: 'running'; live: LiveProgress }
  | { phase: 'error'; code: string; message: string }
  | { phase: 'done'; cancelled: boolean; result: RunResult | null }

const EMPTY_PROGRESS: LiveProgress = {
  message: null,
  totalStories: 0,
  targets: {},
  skipped: [],
  notices: [],
  stories: [],
}

function applyProgress (live: LiveProgress, event: RunProgressEvent): LiveProgress {
  switch (event.phase) {
    case 'tunnel':
      return { ...live, message: event.message }
    case 'stories':
      return { ...live, message: null, totalStories: event.total }
    case 'target-started':
      return {
        ...live,
        targets: {
          ...live.targets,
          [event.target]: { label: event.label, done: 0, total: event.total, finished: false },
        },
      }
    case 'story': {
      const existing = live.targets[event.result.target]

      return {
        ...live,
        stories: [...live.stories, event.result],
        targets: existing
          ? {
              ...live.targets,
              [event.result.target]: { ...existing, done: event.index, total: event.total },
            }
          : live.targets,
      }
    }
    case 'notice':
      // Deduplicated by the runner already, so this cannot grow without bound.
      return { ...live, notices: [...live.notices, event.message] }
    case 'target-skipped':
      return {
        ...live,
        skipped: [...live.skipped, { target: event.target, label: event.label, reason: event.reason }],
      }
    case 'target-finished': {
      const existing = live.targets[event.target]

      return existing
        ? { ...live, targets: { ...live.targets, [event.target]: { ...existing, finished: true } } }
        : live
    }
    default:
      return live
  }
}

export function useTestingBot () {
  const [credentials, setCredentials] = useState<CredentialStatus | null>(null)
  const [config, setConfig] = useState<ProjectConfig | null>(null)
  const [configError, setConfigError] = useState<string | null>(null)
  const [catalogue, setCatalogue] = useState<Catalogue | null>(null)
  const [catalogueError, setCatalogueError] = useState<string | null>(null)
  const [deviceTarget, setDeviceTarget] = useState<DeviceReachabilityView | null>(null)
  const [run, setRun] = useState<RunPhase>({ phase: 'idle' })
  const [results, setResults] = useState<RunResult | null>(null)
  const [finishedAt, setFinishedAt] = useState<string | null>(null)
  const [approvalError, setApprovalError] = useState<string | null>(null)

  /**
   * Images are cached by story, target and kind. Without this, every click
   * between "baseline" and "current" would re-send tens of kilobytes over the
   * channel for a picture the manager already has.
   */
  const [images, setImages] = useState<Record<string, string | null>>({})
  const pending = useRef(new Set<string>())

  useEffect(() => {
    const channel = addons.getChannel()

    const onCredentials = (payload: CredentialStatus) => setCredentials(payload)

    const onConfig = ({ config: loaded, error }: { config: ProjectConfig; error: string | null }) => {
      setConfig(loaded)
      setConfigError(error ?? null)
    }

    const onCatalogue = ({ catalogue: loaded, error }: { catalogue: Catalogue | null; error: string | null }) => {
      setCatalogue(loaded)
      setCatalogueError(error ?? null)
    }

    const onDeviceTarget = (payload: DeviceReachabilityView) => setDeviceTarget(payload)

    const onStarted = () => setRun({ phase: 'running', live: EMPTY_PROGRESS })

    const onProgress = (event: RunProgressEvent) =>
      setRun((current) =>
        current.phase === 'running'
          ? { phase: 'running', live: applyProgress(current.live, event) }
          : current,
      )

    const onFinished = (result: RunResult) => {
      setRun({ phase: 'done', cancelled: Boolean(result?.cancelled), result: result ?? null })
      setResults(result ?? null)
      setFinishedAt(new Date().toISOString())
      // Every image on screen now describes the previous run.
      setImages({})
    }

    const onError = (payload: { code: string; message: string }) =>
      setRun({ phase: 'error', code: payload.code, message: payload.message })

    const onResults = ({
      result,
      finishedAt: at,
    }: {
      result: RunResult | null
      finishedAt: string | null
    }) => {
      setResults(result)
      setFinishedAt(at)
    }

    const onImage = ({
      storyId,
      target,
      kind,
      dataUrl,
    }: {
      storyId: string
      target: string
      kind: string
      dataUrl: string | null
    }) => {
      const key = imageKey(storyId, target, kind)

      pending.current.delete(key)
      setImages((current) => ({ ...current, [key]: dataUrl }))
    }

    const onApproved = ({ result, error }: { result: RunResult | null; error: string | null }) => {
      setApprovalError(error ?? null)

      if (result) setResults(result)
      // Approved stories have a new baseline and no diff, so the cached
      // pictures of both are now wrong.
      setImages({})
    }

    channel.on(TB_EVENTS.CREDENTIALS_STATUS, onCredentials)
    channel.on(TB_EVENTS.CONFIG_LOADED, onConfig)
    channel.on(TB_EVENTS.CATALOGUE_LOADED, onCatalogue)
    channel.on(TB_EVENTS.DEVICE_TARGET_LOADED, onDeviceTarget)
    channel.on(TB_EVENTS.RUN_STARTED, onStarted)
    channel.on(TB_EVENTS.RUN_PROGRESS, onProgress)
    channel.on(TB_EVENTS.RUN_FINISHED, onFinished)
    channel.on(TB_EVENTS.RUN_ERROR, onError)
    channel.on(TB_EVENTS.RESULTS_LOADED, onResults)
    channel.on(TB_EVENTS.IMAGE_LOADED, onImage)
    channel.on(TB_EVENTS.APPROVED, onApproved)

    channel.emit(TB_EVENTS.GET_CREDENTIALS, withNonce({}))
    channel.emit(TB_EVENTS.GET_CONFIG, withNonce({}))
    channel.emit(TB_EVENTS.GET_CATALOGUE, withNonce({}))
    channel.emit(TB_EVENTS.GET_DEVICE_TARGET, withNonce({}))
    channel.emit(TB_EVENTS.GET_RESULTS, withNonce({}))

    return () => {
      channel.off(TB_EVENTS.CREDENTIALS_STATUS, onCredentials)
      channel.off(TB_EVENTS.CONFIG_LOADED, onConfig)
      channel.off(TB_EVENTS.CATALOGUE_LOADED, onCatalogue)
      channel.off(TB_EVENTS.DEVICE_TARGET_LOADED, onDeviceTarget)
      channel.off(TB_EVENTS.RUN_STARTED, onStarted)
      channel.off(TB_EVENTS.RUN_PROGRESS, onProgress)
      channel.off(TB_EVENTS.RUN_FINISHED, onFinished)
      channel.off(TB_EVENTS.RUN_ERROR, onError)
      channel.off(TB_EVENTS.RESULTS_LOADED, onResults)
      channel.off(TB_EVENTS.IMAGE_LOADED, onImage)
      channel.off(TB_EVENTS.APPROVED, onApproved)
    }
  }, [])

  const start = useCallback(
    (options: {
      scope: RunScope
      storyId?: string | null
      browsers?: TargetSpec[]
      devices?: TargetSpec[]
    }) => {
      setApprovalError(null)
      addons.getChannel().emit(TB_EVENTS.RUN, withNonce(options))
    },
    [],
  )

  const cancel = useCallback(() => {
    addons.getChannel().emit(TB_EVENTS.CANCEL, withNonce({}))
  }, [])

  /**
   * Asks for an image once and only once. Returns undefined while it is in
   * flight and null when the file does not exist, which the caller has to
   * distinguish: "loading" and "there is no diff for a passing story" look the
   * same otherwise.
   */
  const requestImage = useCallback(
    (storyId: string, target: string, kind: string): string | null | undefined => {
      const key = imageKey(storyId, target, kind)

      if (key in images) return images[key]

      if (!pending.current.has(key)) {
        pending.current.add(key)
        addons.getChannel().emit(TB_EVENTS.GET_IMAGE, withNonce({ storyId, target, kind }))
      }

      return undefined
    },
    [images],
  )

  const approve = useCallback((stories: { storyId: string; target: string }[]) => {
    setApprovalError(null)
    addons.getChannel().emit(TB_EVENTS.APPROVE, withNonce({ stories }))
  }, [])

  const approveAll = useCallback(() => {
    setApprovalError(null)
    addons.getChannel().emit(TB_EVENTS.APPROVE, withNonce({ all: true }))
  }, [])

  const running = run.phase === 'running'

  return useMemo(
    () => ({
      credentials,
      config,
      configError,
      catalogue,
      catalogueError,
      deviceTarget,
      run,
      running,
      results,
      finishedAt,
      approvalError,
      start,
      cancel,
      requestImage,
      approve,
      approveAll,
    }),
    [
      credentials,
      config,
      configError,
      catalogue,
      catalogueError,
      deviceTarget,
      run,
      running,
      results,
      finishedAt,
      approvalError,
      start,
      cancel,
      requestImage,
      approve,
      approveAll,
    ],
  )
}

function imageKey (storyId: string, target: string, kind: string): string {
  return `${target}::${storyId}::${kind}`
}
