import React from 'react'

import type { LiveProgress, RunPhase, RunScope } from './useTestingBot.js'
import { label, row, smallButton, subtle } from './styles.js'

/**
 * Run scope, the run and cancel buttons, and live progress.
 *
 * Progress streams per story rather than appearing at the end, which TB-257
 * requires and which is not decoration: a full matrix run takes minutes, and a
 * panel that says only "Running..." for four of them is indistinguishable from
 * a panel that has hung.
 */

const SCOPES: { id: RunScope; title: string }[] = [
  { id: 'story', title: 'This story' },
  { id: 'component', title: 'This component' },
  { id: 'all', title: 'Everything' },
]

export const RunControls = ({
  scope,
  onScopeChange,
  onRun,
  onCancel,
  run,
  canRun,
  blockedReason,
}: {
  scope: RunScope
  onScopeChange: (next: RunScope) => void
  onRun: () => void
  onCancel: () => void
  run: RunPhase
  canRun: boolean
  blockedReason: string | null
}) => {
  const running = run.phase === 'running'

  return (
    <section style={{ margin: '16px 0 0' }}>
      <h3 style={label}>Run</h3>

      <div style={row}>
        <select
          value={scope}
          onChange={(event) => onScopeChange(event.target.value as RunScope)}
          disabled={running}
          style={{ fontSize: 13, padding: '3px 6px' }}
          aria-label="What to run"
        >
          {SCOPES.map((entry) => (
            <option key={entry.id} value={entry.id}>
              {entry.title}
            </option>
          ))}
        </select>

        <button type="button" style={smallButton} onClick={onRun} disabled={running || !canRun}>
          Run on TestingBot
        </button>

        <button type="button" style={smallButton} onClick={onCancel} disabled={!running}>
          Cancel
        </button>
      </div>

      {!canRun && blockedReason && (
        <p style={{ ...subtle, color: 'var(--sb-color-warning, #a15c07)' }}>{blockedReason}</p>
      )}

      {running && <Progress live={run.live} />}

      {run.phase === 'error' && (
        <p style={{ ...subtle, color: 'var(--sb-color-negative, #d0021b)' }}>{run.message}</p>
      )}

      {run.phase === 'done' && run.cancelled && (
        <p style={subtle}>
          Cancelled. The stories that were not reached were not tested, so this run says nothing
          about them.
        </p>
      )}
    </section>
  )
}

const Progress = ({ live }: { live: LiveProgress }) => {
  const targets = Object.entries(live.targets)

  /**
   * Skipped targets are always shown, even while the message or the empty
   * state is on screen. A run that quietly covered fewer targets than asked
   * would report green for a device nobody tested.
   */
  const skipped = live.skipped.length > 0 && (
    <ul style={{ listStyle: 'none', margin: '8px 0 0', padding: 0 }}>
      {live.skipped.map((entry) => (
        <li key={entry.target} style={{ ...subtle, color: 'var(--sb-color-warning, #a15c07)' }}>
          Skipped {entry.label}: {entry.reason}
        </li>
      ))}
    </ul>
  )

  /**
   * Notices are quieter than a skipped target: a story that asked to be skipped
   * or a parameter that was ignored is worth reading, but it did not change
   * whether the run can be trusted.
   */
  const notices = live.notices.length > 0 && (
    <ul style={{ listStyle: 'none', margin: '8px 0 0', padding: 0 }}>
      {live.notices.map((notice) => (
        <li key={notice} style={{ ...subtle, opacity: 0.7 }}>{notice}</li>
      ))}
    </ul>
  )

  if (live.message) {
    return (
      <>
        <p style={subtle}>{live.message}...</p>
        {skipped}
        {notices}
      </>
    )
  }

  if (targets.length === 0) {
    return (
      <>
        <p style={subtle}>
          {live.totalStories > 0
            ? `Connecting to the grid for ${live.totalStories} stories...`
            : 'Starting...'}
        </p>
        {skipped}
        {notices}
      </>
    )
  }

  return (
    <>
      <ul style={{ listStyle: 'none', margin: '8px 0 0', padding: 0 }}>
        {targets.map(([key, target]) => (
          <li key={key} style={{ fontSize: 12, opacity: 0.85 }}>
            {target.label}: {target.done} of {target.total}
            {target.finished ? ', done' : ''}
          </li>
        ))}
      </ul>
      {skipped}
      {notices}
    </>
  )
}
