import type { Credentials, ProjectConfig, RunTarget, TargetSpec, TunnelCapability } from './types.js'

/**
 * Turns config entries into run targets, and targets into the capabilities a
 * grid session needs.
 *
 * The target key matters more than it looks: it is the baseline folder name, so
 * it has to be stable across runs and distinct per rendering environment.
 * Chrome on Windows and Safari on macOS never produce identical pixels, so one
 * shared baseline set would mean permanent false diffs. Anything that changes
 * what the page looks like belongs in the key.
 */

const PIXEL_AFFECTING_KEYS = ['timeZone', 'geoCountryCode', 'screenResolution'] as const

function sanitise (value: unknown): string {
  return String(value ?? '')
    .trim()
    .replace(/[^a-zA-Z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .toLowerCase()
}

function keyParts (spec: TargetSpec, base: string[]): string[] {
  const extras = PIXEL_AFFECTING_KEYS
    .filter((name) => spec[name] !== undefined && spec[name] !== null && spec[name] !== '')
    .map((name) => `${name}-${sanitise(spec[name])}`)

  return [...base, ...extras].filter(Boolean)
}

/** What a non-physical device of this platform is called. */
function simulatedLabel (spec: TargetSpec): string {
  return String(spec.platformName ?? '').toLowerCase() === 'ios' ? 'simulator' : 'emulator'
}

export function toTargets (config: ProjectConfig): RunTarget[] {
  const browsers = (config.browsers ?? []).map((spec): RunTarget => {
    const base = [spec.browserName, spec.browserVersion, spec.platform].map(sanitise)

    return {
      key: keyParts(spec, base).join('_'),
      label: [spec.browserName, spec.browserVersion, 'on', spec.platform].filter(Boolean).join(' '),
      kind: 'browser',
      spec,
    }
  })

  const devices = (config.devices ?? []).map((spec): RunTarget => {
    // A simulator and the physical phone of the same name are two different
    // rendering environments, so by the rule above they are two different keys
    // and two different baseline sets. Only the simulator is marked, which
    // keeps the keys of everything written before simulators existed intact.
    const simulated = spec.realDevice === false
    const base = [
      spec.deviceName,
      spec.platformName,
      spec.platformVersion,
      ...(simulated ? [simulatedLabel(spec)] : []),
    ].map(sanitise)

    return {
      key: keyParts(spec, base).join('_'),
      label: [
        spec.deviceName,
        spec.platformName,
        spec.platformVersion,
        ...(simulated ? [`(${simulatedLabel(spec)})`] : []),
      ].filter(Boolean).join(' '),
      kind: 'device',
      spec,
    }
  })

  return [...browsers, ...devices]
}

/**
 * Builds the capabilities object for one target.
 *
 * The shape is not flat, and getting it wrong is silent: only browserName and
 * browserVersion sit at the top level, and everything else TestingBot cares
 * about lives under `tb:options`. A tunnelIdentifier placed at the top level is
 * ignored, the session starts anyway, and every page.goto times out looking
 * like a broken tunnel. Verified in the TB-253 spike and matching
 * testingbot.config.mjs in the example repo.
 *
 * Credentials and the tunnel capability go in last and unconditionally. The
 * config layer already refuses to set them (RESERVED_CAPABILITIES in
 * projectConfig.cjs), so this is belt and braces rather than the only guard,
 * but it means no config file can ever point a run at another account.
 */
export function buildCapabilities (
  target: RunTarget,
  {
    credentials,
    tunnel,
    build,
  }: { credentials: Credentials; tunnel: TunnelCapability; build: string },
): Record<string, unknown> {
  const { browserName, browserVersion, 'tb:options': userOptions, ...rest } = target.spec

  return {
    ...(browserName === undefined ? {} : { browserName }),
    ...(browserVersion === undefined ? {} : { browserVersion }),
    'tb:options': {
      name: target.label,
      build,
      ...rest,
      ...(isPlainObject(userOptions) ? userOptions : {}),
      ...tunnel,
      key: credentials.key,
      secret: credentials.secret,
    },
  }
}

/**
 * Android over Playwright is a different endpoint with a different contract.
 *
 * The desktop shape does not carry here. TestingBot's Playwright docs put every
 * capability at the top level for _android.connect, and the Android version
 * goes in browserVersion rather than platformVersion
 * (web/app/views/support/web_automate/playwright/mobile.html.erb). Sending the
 * desktop shape does connect, which is what makes this worth a comment:
 * deviceName inside tb:options is not read, so the session silently lands on
 * whatever the endpoint defaults to instead of the device that was asked for.
 * Measured against the grid: the nested shape returned sdk_gphone64_x86_64, the
 * flat one returned the Pixel 8 that was requested.
 */
export function buildAndroidCapabilities (
  target: RunTarget,
  {
    credentials,
    tunnel,
    build,
  }: { credentials: Credentials; tunnel: TunnelCapability; build: string },
): Record<string, unknown> {
  const { 'tb:options': userOptions, platformVersion, browserVersion, ...rest } = target.spec
  const version = browserVersion ?? platformVersion

  return {
    browserName: 'chrome',
    // The config's `devices` list means real hardware, which is also what
    // toDeviceSpec writes when the catalogue fills it in. A spec that says
    // otherwise still wins, because `rest` is spread after this.
    realDevice: true,
    ...rest,
    ...(version === undefined ? {} : { browserVersion: version }),
    ...(isPlainObject(userOptions) ? userOptions : {}),
    name: target.label,
    build,
    ...tunnel,
    key: credentials.key,
    secret: credentials.secret,
  }
}

function isPlainObject (value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Which playwright-core client speaks to which grid browser.
 *
 * This is not cosmetic. Playwright's connect handshake is per browser type, so
 * chromium.connect against a Firefox session does not fall back or error
 * clearly: it hangs until the connect timeout expires, which reads as a dead
 * grid. Matches the documented entry points, pw.firefox.connect and
 * pw.webkit.connect (web/app/views/support/web_automate/playwright/browsers.html.erb).
 */
export function browserTypeFor (spec: TargetSpec): 'chromium' | 'firefox' | 'webkit' {
  const name = String(spec.browserName ?? 'chrome').toLowerCase()

  if (name === 'firefox') return 'firefox'
  if (name === 'webkit' || name === 'safari') return 'webkit'

  return 'chromium'
}

export function buildWsEndpoint (capabilities: Record<string, unknown>): string {
  return `wss://cloud.testingbot.com/playwright?capabilities=${encodeURIComponent(JSON.stringify(capabilities))}`
}
