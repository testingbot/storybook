import React, { useMemo, useState } from 'react'

import type { BrowserGroup, Catalogue } from '../node/catalogue.js'
import type { TargetSpec } from '../node/types.js'
import { label, row, select, smallButton, subtle } from './styles.js'

/**
 * The browser matrix picker.
 *
 * Two selects and an Add button rather than a grid of every combination: the
 * live catalogue has 57 browser and platform groups with up to 16 versions
 * each, which is around 900 checkboxes. The cascading shape also makes the
 * blocked case explainable, because the reason can sit next to the thing it is
 * about.
 *
 * The selection starts from .testingbot.json so the panel opens showing what
 * the project already committed to, and changes here are not written back.
 * Running with a different browser for one afternoon should not quietly rewrite
 * a file that is under review in a pull request.
 */

export type Selection = TargetSpec[]

export function selectionKey (spec: TargetSpec): string {
  return `${spec.browserName}|${spec.browserVersion}|${spec.platform}`
}

function describe (spec: TargetSpec): string {
  return `${spec.browserName} ${spec.browserVersion} on ${spec.platform}`
}

export const BrowserPicker = ({
  catalogue,
  catalogueError,
  selection,
  onChange,
  disabled,
}: {
  catalogue: Catalogue | null
  catalogueError: string | null
  selection: Selection
  onChange: (next: Selection) => void
  disabled: boolean
}) => {
  const groups = catalogue?.browsers ?? []
  const [groupIndex, setGroupIndex] = useState(0)
  const [version, setVersion] = useState('latest')

  const group: BrowserGroup | undefined = groups[groupIndex]

  const selected = useMemo(() => new Set(selection.map(selectionKey)), [selection])

  const add = () => {
    if (!group) return

    const spec: TargetSpec = {
      browserName: group.browserName,
      browserVersion: version,
      platform: group.platform,
    }

    if (selected.has(selectionKey(spec))) return

    onChange([...selection, spec])
  }

  const remove = (spec: TargetSpec) => {
    onChange(selection.filter((entry) => selectionKey(entry) !== selectionKey(spec)))
  }

  return (
    <section style={{ margin: '16px 0 0' }}>
      <h3 style={label}>Browsers</h3>

      {selection.length === 0 ? (
        <p style={subtle}>
          No browsers selected. Pick at least one below, or add them to .testingbot.json.
        </p>
      ) : (
        <ul style={{ listStyle: 'none', margin: '0 0 8px', padding: 0 }}>
          {selection.map((spec) => (
            <li key={selectionKey(spec)} style={{ ...row, padding: '2px 0' }}>
              <span style={{ fontSize: 13 }}>{describe(spec)}</span>
              <button
                type="button"
                style={smallButton}
                onClick={() => remove(spec)}
                disabled={disabled}
                aria-label={`Remove ${describe(spec)}`}
              >
                Remove
              </button>
            </li>
          ))}
        </ul>
      )}

      {catalogueError && <p style={{ ...subtle, color: 'var(--sb-color-warning, #a15c07)' }}>{catalogueError}</p>}

      {groups.length > 0 && (
        <>
          <div style={row}>
            <select
              style={{ ...select, flex: 1 }}
              value={groupIndex}
              onChange={(event) => {
                setGroupIndex(Number(event.target.value))
                setVersion('latest')
              }}
              disabled={disabled}
              aria-label="Browser and platform"
            >
              {groups.map((entry, index) => (
                <option key={entry.label} value={index}>
                  {entry.label}
                </option>
              ))}
            </select>

            <select
              style={select}
              value={version}
              onChange={(event) => setVersion(event.target.value)}
              disabled={disabled}
              aria-label="Version"
            >
              {(group?.versions ?? []).map((entry) => (
                <option key={entry} value={entry}>
                  {entry}
                </option>
              ))}
            </select>

            <button type="button" style={smallButton} onClick={add} disabled={disabled || !group}>
              Add
            </button>
          </div>

          {group?.blocked && <p style={{ ...subtle, color: 'var(--sb-color-warning, #a15c07)' }}>{group.blocked}</p>}
        </>
      )}
    </section>
  )
}
