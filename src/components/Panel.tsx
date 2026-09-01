import React, { useEffect, useState } from 'react'
import { useStorybookState } from 'storybook/manager-api'

import type { TargetSpec } from '../node/types.js'
import { BrowserPicker } from './BrowserPicker.js'
import { DevicePicker } from './DevicePicker.js'
import { Results } from './Results.js'
import { RunControls } from './RunControls.js'
import { panel, subtle } from './styles.js'
import { useTestingBot } from './useTestingBot.js'
import type { RunScope } from './useTestingBot.js'

/**
 * The addon panel: credentials, what to run it on, what to run, and what came
 * back.
 *
 * All of the channel work lives in useTestingBot so the toolbar button can
 * trigger the same run without a second subscription.
 */

const SESSION_URL = 'https://testingbot.com/members/tests/'

export const Panel = () => {
  const { storyId } = useStorybookState()
  const tb = useTestingBot()
  const [scope, setScope] = useState<RunScope>('story')
  const [selection, setSelection] = useState<TargetSpec[] | null>(null)
  const [devices, setDevices] = useState<TargetSpec[] | null>(null)

  /**
   * The picker starts from the committed config, once. Re-seeding on every
   * config event would throw away a selection the moment Storybook reloaded
   * .testingbot.json, which it does whenever the file is touched.
   */
  useEffect(() => {
    if (selection === null && tb.config) setSelection(tb.config.browsers ?? [])
    if (devices === null && tb.config) setDevices(tb.config.devices ?? [])
  }, [tb.config, selection, devices])

  const browsers = selection ?? []
  const deviceSelection = devices ?? []
  const widths = Array.isArray(tb.config?.widths) ? tb.config.widths : []
  const targetCount = browsers.length + deviceSelection.length
  const canRun = Boolean(tb.credentials?.configured) && targetCount > 0

  const blockedReason = !tb.credentials?.configured
    ? 'No TestingBot credentials found. Set TB_KEY and TB_SECRET, or add a ~/.testingbot file.'
    : targetCount === 0
      ? 'Select at least one browser or device.'
      : null

  return (
    <div style={panel}>
      <h2 style={{ margin: '0 0 4px', fontSize: 15 }}>TestingBot</h2>
      <p style={{ margin: '0 0 12px', fontSize: 13, opacity: 0.8 }}>
        Cross browser and real device testing for your stories.
      </p>

      <p style={{ margin: 0, fontSize: 13 }}>
        <strong>Credentials:</strong>{' '}
        {tb.credentials === null
          ? 'checking...'
          : tb.credentials.configured
            ? `found in ${tb.credentials.source}`
            : 'not configured'}
      </p>

      {tb.config && (
        <p style={{ margin: '4px 0 0', fontSize: 13 }}>
          <strong>Tolerance:</strong> {tb.config.maxDiffPixelRatio} of the story&apos;s pixels
        </p>
      )}

      {/*
        * Shown before the run, not discovered from the bill afterwards. Widths
        * multiply everything: three of them on five browsers is fifteen times
        * the stories, and the number is worth reading while it can still be
        * changed.
        */}
      {widths.length > 0 && (
        <p style={{ margin: '4px 0 0', fontSize: 13 }}>
          <strong>Widths:</strong> {widths.join(', ')} pixels. Every story is captured{' '}
          {widths.length === 1 ? 'once' : `${widths.length} times`} per browser, so this run costs{' '}
          {widths.length}x.
          {deviceSelection.length > 0 && ' Real devices use their own screen and are not affected.'}
        </p>
      )}

      {tb.configError && (
        <p style={{ ...subtle, color: 'var(--sb-color-negative, #d0021b)' }}>{tb.configError}</p>
      )}

      <BrowserPicker
        catalogue={tb.catalogue}
        catalogueError={tb.catalogueError}
        selection={browsers}
        onChange={setSelection}
        disabled={tb.running}
      />

      <DevicePicker
        catalogue={tb.catalogue}
        reachability={tb.deviceTarget}
        selection={deviceSelection}
        onChange={setDevices}
        disabled={tb.running}
      />

      <RunControls
        scope={scope}
        onScopeChange={setScope}
        onRun={() => tb.start({ scope, storyId, browsers, devices: deviceSelection })}
        onCancel={tb.cancel}
        run={tb.run}
        canRun={canRun}
        blockedReason={blockedReason}
      />

      <Results
        result={tb.results}
        finishedAt={tb.finishedAt}
        approvalError={tb.approvalError}
        requestImage={tb.requestImage}
        approve={tb.approve}
        approveAll={tb.approveAll}
        sessionUrl={(sessionId) => `${SESSION_URL}${sessionId}`}
      />

      <p style={{ ...subtle, margin: '20px 0 0', opacity: 0.6 }}>
        Baselines live in .testingbot/baselines and belong in git. Per-run screenshots go to
        .testingbot/results and do not.
      </p>
    </div>
  )
}
