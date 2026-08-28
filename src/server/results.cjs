'use strict'

const { TB_EVENTS } = require('../constants.cjs')
const { loadRuntime } = require('./esm.cjs')

/**
 * The results view's server side: read the last run, fetch one screenshot,
 * approve one story or many.
 *
 * Everything here addresses images by story id and target key, never by path.
 * The panel is reachable over a websocket, so a handler that accepted a path
 * would be a file read and a file write primitive for anything that got hold of
 * the nonce. Rebuilding the path from identifiers means an approval can only
 * touch a file the runner itself wrote.
 */

const IMAGE_KINDS = new Set(['baseline', 'actual', 'diff'])

function projectRoot () {
  return process.cwd()
}

function registerResultsHandlers (channel) {
  channel.on(TB_EVENTS.GET_RESULTS, async () => {
    try {
      const { readLastRun } = await loadRuntime()
      const stored = readLastRun(projectRoot())

      channel.emit(TB_EVENTS.RESULTS_LOADED, {
        // Null is the honest answer for "no run yet", and the panel shows the
        // empty state rather than an error.
        result: stored ? stored.result : null,
        finishedAt: stored ? stored.finishedAt : null,
        error: null,
      })
    } catch (error) {
      channel.emit(TB_EVENTS.RESULTS_LOADED, {
        result: null,
        finishedAt: null,
        error: `Could not read the last run: ${error.message}`,
      })
    }
  })

  channel.on(TB_EVENTS.GET_IMAGE, async ({ storyId, target, kind } = {}) => {
    if (!storyId || !target || !IMAGE_KINDS.has(kind)) {
      channel.emit(TB_EVENTS.IMAGE_LOADED, {
        storyId: storyId || null,
        target: target || null,
        kind: kind || null,
        dataUrl: null,
        error: 'Asked for an image without a story, a target or a valid kind.',
      })
      return
    }

    try {
      const { readImageDataUrl } = await loadRuntime()
      const dataUrl = readImageDataUrl(projectRoot(), storyId, target, kind)

      channel.emit(TB_EVENTS.IMAGE_LOADED, {
        storyId,
        target,
        kind,
        dataUrl,
        // A missing diff is normal: a new or passing story has none. The panel
        // decides whether absence is worth mentioning.
        error: null,
      })
    } catch (error) {
      channel.emit(TB_EVENTS.IMAGE_LOADED, {
        storyId,
        target,
        kind,
        dataUrl: null,
        error: `Could not read the ${kind} image: ${error.message}`,
      })
    }
  })

  channel.on(TB_EVENTS.APPROVE, async ({ stories, all } = {}) => {
    try {
      const { approveStory, approvableStories, readLastRun, markApproved } = await loadRuntime()
      const stored = readLastRun(projectRoot())

      if (!stored) {
        channel.emit(TB_EVENTS.APPROVED, {
          success: false,
          outcomes: [],
          error: 'There is no run to approve. Run your stories first.',
        })
        return
      }

      /**
       * "Approve everything" is resolved from the stored run rather than from a
       * list the panel sends, so it can only ever cover stories that genuinely
       * differed in the run on disk. A stale panel cannot approve a story that
       * has since started failing.
       */
      const requested = all === true
        ? approvableStories(stored.result).map((story) => ({
            storyId: story.storyId,
            target: story.target,
          }))
        : (Array.isArray(stories) ? stories : []).filter(
            (story) => story && story.storyId && story.target,
          )

      if (requested.length === 0) {
        channel.emit(TB_EVENTS.APPROVED, {
          success: false,
          outcomes: [],
          error: 'Nothing to approve. Only stories with a visual difference can be approved.',
        })
        return
      }

      const outcomes = requested.map((story) =>
        approveStory(projectRoot(), String(story.storyId), String(story.target)),
      )

      // The stored run has to move with the baselines, or the panel keeps
      // showing a diff for a story that was just accepted.
      const result = markApproved(projectRoot(), outcomes)

      channel.emit(TB_EVENTS.APPROVED, {
        success: outcomes.every((outcome) => outcome.approved),
        outcomes,
        result,
        error: null,
      })
    } catch (error) {
      channel.emit(TB_EVENTS.APPROVED, {
        success: false,
        outcomes: [],
        error: `Could not approve: ${error.message}`,
      })
    }
  })
}

module.exports = { registerResultsHandlers, IMAGE_KINDS }
