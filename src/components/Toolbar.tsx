import React, { useEffect, useState } from 'react'
import { addons, useStorybookApi, useStorybookState } from 'storybook/manager-api'

import { PANEL_ID, TB_EVENTS } from '../constants.js'
import { withNonce } from '../nonce.js'

/**
 * Toolbar button: run the story that is open, without going to the panel first.
 *
 * It deliberately does not carry a browser selection. The panel's picker is a
 * session-scoped override; the toolbar is the "just run it" affordance, so it
 * runs against whatever .testingbot.json says, which is the thing that is
 * actually committed and reviewed.
 *
 * It keeps its own two-line subscription rather than sharing the panel's hook.
 * The toolbar renders whether or not the panel is mounted, so it cannot depend
 * on the panel's state, and duplicating a run trigger would mean two runs per
 * click.
 */

export const Toolbar = () => {
  const api = useStorybookApi()
  const { storyId } = useStorybookState()
  const [running, setRunning] = useState(false)

  useEffect(() => {
    const channel = addons.getChannel()
    const onStarted = () => setRunning(true)
    const onStopped = () => setRunning(false)

    channel.on(TB_EVENTS.RUN_STARTED, onStarted)
    channel.on(TB_EVENTS.RUN_FINISHED, onStopped)
    channel.on(TB_EVENTS.RUN_ERROR, onStopped)

    return () => {
      channel.off(TB_EVENTS.RUN_STARTED, onStarted)
      channel.off(TB_EVENTS.RUN_FINISHED, onStopped)
      channel.off(TB_EVENTS.RUN_ERROR, onStopped)
    }
  }, [])

  const run = () => {
    if (running || !storyId) return

    // Opened before the run starts, because progress and any error land there
    // and a button that appears to do nothing is worse than no button.
    api.setSelectedPanel(PANEL_ID)
    api.togglePanel(true)

    addons.getChannel().emit(TB_EVENTS.RUN, withNonce({ scope: 'story', storyId }))
  }

  return (
    <button
      type="button"
      onClick={run}
      disabled={running || !storyId}
      title="Run this story on TestingBot"
      style={{
        background: 'none',
        border: 'none',
        cursor: running ? 'default' : 'pointer',
        fontSize: 12,
        padding: '0 10px',
        height: 40,
        opacity: running ? 0.6 : 1,
      }}
    >
      {running ? 'Running on TestingBot...' : 'TestingBot'}
    </button>
  )
}
