import type { CSSProperties } from 'react'

/**
 * Shared inline styles.
 *
 * Inline rather than styled-components on purpose: the manager bundle already
 * externalises React to Storybook's own instance, and pulling in Storybook's
 * theming internals would add a second internal surface to re-verify on every
 * upgrade for something this panel does not need. The CSS variables Storybook
 * publishes are enough, and each has a fallback so the panel is legible even if
 * a future theme stops setting them.
 */

export const panel: CSSProperties = {
  padding: 16,
  fontFamily: 'var(--sb-fontBase, sans-serif)',
  lineHeight: 1.6,
}

export const label: CSSProperties = {
  margin: '0 0 6px',
  fontSize: 12,
  textTransform: 'uppercase',
  letterSpacing: 0.4,
  opacity: 0.7,
}

export const subtle: CSSProperties = {
  margin: '4px 0',
  fontSize: 12,
  opacity: 0.7,
}

export const row: CSSProperties = {
  display: 'flex',
  gap: 8,
  alignItems: 'center',
}

export const select: CSSProperties = {
  fontSize: 13,
  padding: '3px 6px',
  maxWidth: '100%',
}

export const smallButton: CSSProperties = {
  fontSize: 12,
  padding: '3px 8px',
  cursor: 'pointer',
}

export const outcomeColours: Record<string, string> = {
  new: 'var(--sb-color-secondary, #029cfd)',
  passed: 'var(--sb-color-positive, #66bf3c)',
  diff: 'var(--sb-color-warning, #a15c07)',
  failed: 'var(--sb-color-negative, #d0021b)',
}

export const outcomeLabels: Record<string, string> = {
  new: 'New baseline',
  passed: 'Matched',
  diff: 'Changed',
  failed: 'Failed',
}
