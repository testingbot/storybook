import React, { useState } from 'react'

import type { StoryResult } from '../node/types.js'
import { row, smallButton, subtle } from './styles.js'

/**
 * Baseline, current and diff for one story on one browser.
 *
 * Three modes, because no single one answers every question:
 *
 *  - Side by side is how you see what the change actually looks like.
 *  - Overlay with a slider is how you see whether something moved by two
 *    pixels, which side by side cannot show you at all.
 *  - Diff is how you find where to look on a large component.
 *
 * A checkerboard sits behind every image. Stories are often transparent, and on
 * a plain background a dark story on a dark theme, or a white story on a white
 * one, is invisible. TB-259 asks for diffs that are legible in both themes, and
 * this is what makes that true regardless of the story's own colours.
 */

type Mode = 'side-by-side' | 'overlay' | 'diff'

const CHECKERBOARD = {
  backgroundImage:
    'linear-gradient(45deg, rgba(128,128,128,0.25) 25%, transparent 25%), ' +
    'linear-gradient(-45deg, rgba(128,128,128,0.25) 25%, transparent 25%), ' +
    'linear-gradient(45deg, transparent 75%, rgba(128,128,128,0.25) 75%), ' +
    'linear-gradient(-45deg, transparent 75%, rgba(128,128,128,0.25) 75%)',
  backgroundSize: '12px 12px',
  backgroundPosition: '0 0, 0 6px, 6px -6px, -6px 0px',
}

const frame: React.CSSProperties = {
  ...CHECKERBOARD,
  border: '1px solid var(--sb-color-border, rgba(128,128,128,0.35))',
  borderRadius: 3,
  overflow: 'hidden',
  minHeight: 40,
}

const image: React.CSSProperties = { display: 'block', maxWidth: '100%' }

export const ImageCompare = ({
  story,
  requestImage,
}: {
  story: StoryResult
  requestImage: (storyId: string, target: string, kind: string) => string | null | undefined
}) => {
  const [mode, setMode] = useState<Mode>(story.diffPath ? 'diff' : 'side-by-side')
  const [split, setSplit] = useState(50)

  const baseline = requestImage(story.storyId, story.target, 'baseline')
  const actual = requestImage(story.storyId, story.target, 'actual')
  const diff = story.outcome === 'diff' ? requestImage(story.storyId, story.target, 'diff') : null

  const modes: { id: Mode; title: string; available: boolean }[] = [
    { id: 'side-by-side', title: 'Side by side', available: true },
    { id: 'overlay', title: 'Overlay', available: Boolean(baseline && actual) },
    { id: 'diff', title: 'Diff', available: Boolean(diff) },
  ]

  return (
    <div style={{ margin: '8px 0 0' }}>
      <div style={{ ...row, margin: '0 0 8px' }}>
        {modes
          .filter((entry) => entry.available)
          .map((entry) => (
            <button
              key={entry.id}
              type="button"
              style={{
                ...smallButton,
                fontWeight: mode === entry.id ? 600 : 400,
                textDecoration: mode === entry.id ? 'underline' : 'none',
              }}
              onClick={() => setMode(entry.id)}
            >
              {entry.title}
            </button>
          ))}
      </div>

      {mode === 'side-by-side' && (
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
          <Pane title="Baseline" src={baseline} missing="No baseline yet." />
          <Pane title="This run" src={actual} missing="No screenshot from this run." />
        </div>
      )}

      {mode === 'overlay' && baseline && actual && (
        <div>
          {/*
            The current screenshot is clipped from the left, revealing the
            baseline underneath. Both are absolutely positioned in the same box
            so they line up pixel for pixel; a flex layout would offset them by
            whatever the container padding happened to be.
          */}
          <div style={{ ...frame, position: 'relative' }}>
            <img src={baseline} alt="Baseline" style={image} />
            <div
              style={{
                position: 'absolute',
                inset: 0,
                overflow: 'hidden',
                clipPath: `inset(0 0 0 ${split}%)`,
              }}
            >
              <img src={actual} alt="This run" style={image} />
            </div>
            <div
              style={{
                position: 'absolute',
                top: 0,
                bottom: 0,
                left: `${split}%`,
                width: 1,
                background: 'var(--sb-color-secondary, #029cfd)',
              }}
            />
          </div>
          <input
            type="range"
            min={0}
            max={100}
            value={split}
            onChange={(event) => setSplit(Number(event.target.value))}
            style={{ width: '100%', margin: '6px 0 0' }}
            aria-label="Overlay position, baseline on the left and this run on the right"
          />
          <p style={subtle}>Baseline on the left of the line, this run on the right.</p>
        </div>
      )}

      {mode === 'diff' && <Pane title="Differences" src={diff} missing="No diff for this story." />}
    </div>
  )
}

const Pane = ({
  title,
  src,
  missing,
}: {
  title: string
  src: string | null | undefined
  missing: string
}) => (
  <div>
    <p style={{ ...subtle, margin: '0 0 4px' }}>{title}</p>
    <div style={frame}>
      {src === undefined && <p style={{ ...subtle, padding: 8 }}>Loading...</p>}
      {src === null && <p style={{ ...subtle, padding: 8 }}>{missing}</p>}
      {src && <img src={src} alt={title} style={image} />}
    </div>
  </div>
)
