import React, { useMemo, useState } from 'react'

import type { Catalogue, DeviceGroup } from '../node/catalogue.js'
import type { TargetSpec } from '../node/types.js'
import { label, row, select, smallButton, subtle } from './styles.js'

/**
 * The real device picker.
 *
 * Same cascading shape as BrowserPicker, with one thing it does not have: a
 * gate. TB-260 requires that device options are hidden or clearly disabled when
 * the current Storybook is unreachable from a device, with an explanation, and
 * that is the `reachability` prop. Real devices cannot resolve the literal
 * hostname "localhost", which is exactly what Storybook serves on, so this is
 * the common case rather than the edge case.
 *
 * When it is reachable, the URL devices will use is shown. It is not the URL in
 * the address bar and a developer who is debugging a device run needs to know
 * which one they are looking at.
 */

export type DeviceReachabilityView = {
  reachable: boolean
  url: string | null
  reason?: string
}

export function deviceKey (spec: TargetSpec): string {
  // The simulator and the physical phone are separately selectable, so they
  // cannot share a key or adding one would look like a duplicate of the other.
  return `${spec.deviceName}|${spec.platformName}|${spec.platformVersion}|${spec.realDevice !== false}`
}

function describe (spec: TargetSpec): string {
  const kind = String(spec.platformName ?? '').toLowerCase() === 'ios' ? 'simulator' : 'emulator'
  const suffix = spec.realDevice === false ? ` ${kind}` : ''

  return `${spec.deviceName} (${spec.platformName} ${spec.platformVersion}${suffix})`
}

export const DevicePicker = ({
  catalogue,
  reachability,
  selection,
  onChange,
  disabled,
}: {
  catalogue: Catalogue | null
  reachability: DeviceReachabilityView | null
  selection: TargetSpec[]
  onChange: (next: TargetSpec[]) => void
  disabled: boolean
}) => {
  const groups = catalogue?.devices ?? []
  const [groupIndex, setGroupIndex] = useState(0)
  const [version, setVersion] = useState('')

  const group: DeviceGroup | undefined = groups[groupIndex]
  const selected = useMemo(() => new Set(selection.map(deviceKey)), [selection])

  const reachable = reachability?.reachable === true
  const locked = disabled || !reachable

  const add = () => {
    if (!group) return

    const platformVersion = version || group.platformVersions[0] || ''

    const spec: TargetSpec = {
      deviceName: group.deviceName,
      platformName: group.platformName,
      platformVersion,
      // iOS runs Mobile Safari over WebDriver, Android runs Chrome over
      // Playwright. Recorded here so the config file says what it means.
      browserName: group.platformName.toLowerCase() === 'ios' ? 'safari' : 'chrome',
      // Not always true. The catalogue lists simulators and emulators next to
      // physical hardware, and asking for a simulator as though it were a real
      // device is a request nothing on the grid will ever answer (TB-310).
      realDevice: group.realDevice,
    }

    if (selected.has(deviceKey(spec))) return

    onChange([...selection, spec])
  }

  const remove = (spec: TargetSpec) => {
    onChange(selection.filter((entry) => deviceKey(entry) !== deviceKey(spec)))
  }

  return (
    <section style={{ margin: '16px 0 0' }}>
      <h3 style={label}>Real devices</h3>

      {reachability === null ? (
        <p style={subtle}>Checking whether a device can reach this Storybook...</p>
      ) : reachable ? (
        <p style={subtle}>
          Devices will open <code>{reachability.url}</code>.
        </p>
      ) : (
        <p style={{ ...subtle, color: 'var(--sb-color-warning, #a15c07)' }}>{reachability.reason}</p>
      )}

      {selection.length > 0 && (
        <ul style={{ listStyle: 'none', margin: '0 0 8px', padding: 0 }}>
          {selection.map((spec) => (
            <li key={deviceKey(spec)} style={{ ...row, padding: '2px 0' }}>
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

      {groups.length > 0 && (
        <div style={row}>
          <select
            style={{ ...select, flex: 1 }}
            value={groupIndex}
            onChange={(event) => {
              setGroupIndex(Number(event.target.value))
              setVersion('')
            }}
            disabled={locked}
            aria-label="Device"
          >
            {groups.map((entry, index) => (
              <option key={entry.label} value={index}>
                {entry.label}
              </option>
            ))}
          </select>

          <select
            style={select}
            value={version || group?.platformVersions[0] || ''}
            onChange={(event) => setVersion(event.target.value)}
            disabled={locked}
            aria-label="Platform version"
          >
            {(group?.platformVersions ?? []).map((entry) => (
              <option key={entry} value={entry}>
                {entry}
              </option>
            ))}
          </select>

          <button type="button" style={smallButton} onClick={add} disabled={locked || !group}>
            Add
          </button>
        </div>
      )}

      <p style={{ ...subtle, opacity: 0.7 }}>
        iPhones run Mobile Safari over a WebDriver session, because Playwright has no iOS device
        backend. Android devices run Chrome through Playwright, the same as desktop.
      </p>

      <p style={{ ...subtle, opacity: 0.7 }}>
        Entries marked simulator or emulator are not physical hardware. They start faster and are
        worth using while iterating, but they render on a desktop GPU and will not catch what a real
        phone catches.
      </p>
    </section>
  )
}
