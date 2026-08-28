import React, { useMemo, useState } from 'react'

import type { RunResult, StoryOutcome, StoryResult } from '../node/types.js'
import { ImageCompare } from './ImageCompare.js'
import { label, outcomeColours, outcomeLabels, row, smallButton, subtle } from './styles.js'

/**
 * The review loop.
 *
 * TB-259's acceptance criterion is that a one-pixel intentional change can be
 * reviewed and approved in under thirty seconds, so the changed stories are
 * listed first and expanded by default, and approve is a single click with no
 * confirmation step. Approval is reversible in the only way that matters: the
 * old baseline is in git, so the developer's undo is `git checkout`.
 *
 * Matched stories are collapsed behind a toggle. On a real project they are
 * almost all of the list, and a review screen where the interesting rows are
 * below two hundred boring ones is not a review screen.
 */

const OUTCOME_ORDER: StoryOutcome[] = ['diff', 'failed', 'new', 'passed']

export const Results = ({
  result,
  finishedAt,
  approvalError,
  requestImage,
  approve,
  approveAll,
  sessionUrl,
}: {
  result: RunResult | null
  finishedAt: string | null
  approvalError: string | null
  requestImage: (storyId: string, target: string, kind: string) => string | null | undefined
  approve: (stories: { storyId: string; target: string }[]) => void
  approveAll: () => void
  sessionUrl: (sessionId: string) => string
}) => {
  const [showMatched, setShowMatched] = useState(false)
  const [expanded, setExpanded] = useState<Record<string, boolean>>({})

  const sorted = useMemo(() => {
    if (!result) return []

    return [...result.stories].sort((a, b) => {
      const byOutcome = OUTCOME_ORDER.indexOf(a.outcome) - OUTCOME_ORDER.indexOf(b.outcome)

      return byOutcome !== 0 ? byOutcome : a.storyId.localeCompare(b.storyId)
    })
  }, [result])

  if (!result) {
    return (
      <section style={{ margin: '20px 0 0' }}>
        <h3 style={label}>Results</h3>
        <p style={subtle}>
          Nothing has been run yet. The first run has no baselines to compare against, so every
          story is recorded as new and its grid screenshot becomes the baseline.
        </p>
      </section>
    )
  }

  const changed = sorted.filter((story) => story.outcome === 'diff')
  const visible = showMatched ? sorted : sorted.filter((story) => story.outcome !== 'passed')

  return (
    <section style={{ margin: '20px 0 0' }}>
      <h3 style={label}>Results</h3>

      <p style={{ margin: '0 0 8px', fontSize: 13 }}>
        {result.totals.new} new, {result.totals.passed} matched, {result.totals.diff} changed,{' '}
        {result.totals.failed} failed
        {finishedAt ? ` (${new Date(finishedAt).toLocaleString()})` : ''}
      </p>

      {(result.skipped ?? []).length > 0 && (
        <ul style={{ listStyle: 'none', margin: '0 0 8px', padding: 0 }}>
          {(result.skipped ?? []).map((entry) => (
            <li key={entry.key} style={{ ...subtle, color: 'var(--sb-color-warning, #a15c07)' }}>
              Skipped {entry.label}: {entry.reason}
            </li>
          ))}
        </ul>
      )}

      {result.targets.length > 0 && (
        <p style={subtle}>
          Sessions:{' '}
          {result.targets.map((target, index) => (
            <React.Fragment key={target.key}>
              {index > 0 && ', '}
              {target.sessionId ? (
                <a href={sessionUrl(target.sessionId)} target="_blank" rel="noreferrer">
                  {target.label}
                </a>
              ) : (
                target.label
              )}
            </React.Fragment>
          ))}
        </p>
      )}

      {changed.length > 0 && (
        <div style={{ ...row, margin: '8px 0' }}>
          <button type="button" style={smallButton} onClick={approveAll}>
            Approve all {changed.length} changed
          </button>
          <span style={subtle}>Promotes this run&apos;s screenshots to baselines.</span>
        </div>
      )}

      {approvalError && (
        <p style={{ ...subtle, color: 'var(--sb-color-negative, #d0021b)' }}>{approvalError}</p>
      )}

      {result.totals.passed > 0 && (
        <button
          type="button"
          style={{ ...smallButton, margin: '4px 0 8px' }}
          onClick={() => setShowMatched((current) => !current)}
        >
          {showMatched ? 'Hide' : 'Show'} {result.totals.passed} matched
        </button>
      )}

      <ul style={{ listStyle: 'none', margin: 0, padding: 0 }}>
        {visible.map((story) => {
          const key = `${story.target}::${story.storyId}`
          // Changed stories are the reason the developer is here, so they open
          // without a click. Everything else stays folded.
          const open = expanded[key] ?? story.outcome === 'diff'

          return (
            <li
              key={key}
              style={{
                borderTop: '1px solid var(--sb-color-border, rgba(128,128,128,0.25))',
                padding: '8px 0',
              }}
            >
              <div style={row}>
                <button
                  type="button"
                  style={{ ...smallButton, flex: 1, textAlign: 'left' }}
                  onClick={() => setExpanded((current) => ({ ...current, [key]: !open }))}
                  aria-expanded={open}
                >
                  {open ? '-' : '+'} {story.storyId}
                </button>

                <span style={{ fontSize: 12, color: outcomeColours[story.outcome] }}>
                  {outcomeLabels[story.outcome]}
                  {story.outcome === 'diff' && story.diffPixelRatio !== undefined
                    ? ` ${formatRatio(story.diffPixelRatio)}`
                    : ''}
                  {/* Hosted results carry a count of differing pixels rather than
                      a ratio, because the grid does not return the dimensions to
                      divide by. Shown as a count so it is not mistaken for one. */}
                  {story.pixelDifference !== undefined
                    ? ` ${story.pixelDifference.toLocaleString()} px`
                    : ''}
                </span>
              </div>

              <p style={{ ...subtle, margin: '2px 0 0' }}>{story.target}</p>

              {story.message && (
                <p
                  style={{
                    ...subtle,
                    color:
                      story.outcome === 'failed'
                        ? 'var(--sb-color-negative, #d0021b)'
                        : undefined,
                  }}
                >
                  {story.message}
                </p>
              )}

              {/* Hosted comparisons keep their images on TestingBot, so there is
                  nothing local to show. The link is the whole review surface. */}
              {story.url && (
                <p style={{ ...subtle, margin: '2px 0 0' }}>
                  <a href={story.url} target="_blank" rel="noreferrer">
                    View this comparison on TestingBot
                  </a>
                </p>
              )}

              {open && story.outcome !== 'failed' && !story.url && (
                <>
                  <ImageCompare story={story} requestImage={requestImage} />
                  {story.outcome === 'diff' && (
                    <button
                      type="button"
                      style={{ ...smallButton, margin: '8px 0 0' }}
                      onClick={() => approve([{ storyId: story.storyId, target: story.target }])}
                    >
                      Approve this change
                    </button>
                  )}
                </>
              )}
            </li>
          )
        })}
      </ul>
    </section>
  )
}

/**
 * The default tolerance is 0.001, so a percentage with no decimals would render
 * most real differences as "0%". Two decimals keeps a 0.12% change readable
 * without turning the row into a number.
 */
function formatRatio (ratio: number): string {
  return `${(ratio * 100).toFixed(2)}%`
}

export type { StoryResult }
