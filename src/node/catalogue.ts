import type { TargetSpec } from './types.js'

/**
 * The browser and device catalogue.
 *
 * TB-257 asks for a picker sourced from the live TestingBot list rather than a
 * hardcoded array, because a hardcoded array is wrong the week after it is
 * written. `https://api.testingbot.com/v1/browsers` is the source; it needs no
 * credentials and returns roughly 5,300 entries covering Selenium, Appium and
 * Playwright.
 *
 * There is no Playwright-specific list: `?type=playwright` answers
 * `{"error":"type does not have a valid value"}`. So the filtering happens
 * here, and it has to, because the Selenium list contains browsers Playwright
 * cannot drive at all. Offering Internet Explorer in a Playwright picker would
 * sell the user a session that can never connect but is still billed.
 *
 * It takes two endpoints to describe the mobile side honestly, and getting that
 * wrong cost a real debugging session (TB-310). Of the 325 entries in
 * `/v1/browsers` that carry a `deviceName`, 265 are iOS *simulators*, keyed by
 * the macOS version hosting them rather than by iOS; 42 are Android
 * *emulators*, at `platform: "ANDROID"`; and 18 are physical Android, which the
 * list marks explicitly as `platform: "REAL_ANDROID"`. Physical iOS is not in
 * that list at all. It only appears in `https://api.testingbot.com/v1/devices`,
 * which is the fleet inventory and carries an `available` flag per device.
 *
 * Treating every `deviceName` entry as real hardware, which is what this used
 * to do, means asking for a physical iPhone 15 on iOS 17.0 because a simulator
 * of that name exists. Nothing refuses the request; it simply never starts, and
 * five minutes later the client times out (TB-312). So real devices come from
 * `/v1/devices`, simulators and emulators come from `/v1/browsers`, and each
 * group says which it is.
 */

const CATALOGUE_URL = 'https://api.testingbot.com/v1/browsers'
const DEVICES_URL = 'https://api.testingbot.com/v1/devices'
const CATALOGUE_TIMEOUT_MS = 20_000

/** The `platform` value `/v1/browsers` uses for physical Android hardware. */
const REAL_ANDROID = 'REAL_ANDROID'

/**
 * How many concrete versions to keep per browser and platform.
 *
 * The raw list has over 1,800 Firefox entries. A dropdown with every Firefox
 * back to 4.0 is not a feature, and the aliases below cover the cases anyone
 * actually pins to. Older versions remain usable by writing them into
 * .testingbot.json by hand; this cap is a UI concern, not a restriction.
 */
const VERSIONS_PER_PLATFORM = 12

/**
 * Version aliases TestingBot resolves server-side, documented at
 * support/web_automate/playwright/options.html.erb:224. Offering these matters
 * more than the concrete versions: a config pinned to `latest` keeps testing
 * what users are on, and one pinned to `131` silently stops being relevant.
 */
export const VERSION_ALIASES = ['latest', 'latest-1', 'latest-2', 'latest-3']

/**
 * TestingBot's Selenium names are not Playwright's browser names, and the
 * mismatch is silent rather than loud: `browserName: "googlechrome"` starts a
 * session that never completes the handshake. Anything not in this map cannot
 * be driven over the Playwright endpoint and is dropped.
 */
const PLAYWRIGHT_BROWSER_NAMES: Record<string, string> = {
  googlechrome: 'chrome',
  chrome: 'chrome',
  microsoftedge: 'edge',
  firefox: 'firefox',
  safari: 'safari',
}

/**
 * Firefox and WebKit sessions start on the grid, bill, and never complete the
 * Playwright handshake (TB-272). They stay in the catalogue because they are
 * real capabilities of the account and hiding them would be its own kind of
 * lie, but they carry the reason with them so the panel can say why rather than
 * letting someone spend three minutes watching a connect time out.
 */
const BLOCKED_BROWSERS: Record<string, string> = {
  firefox:
    'Firefox sessions start on the grid but the Playwright handshake never completes (TB-272). ' +
    'Use chrome or edge until this is fixed.',
  safari:
    'WebKit sessions start on the grid but the Playwright handshake never completes (TB-272). ' +
    'Use chrome or edge until this is fixed.',
}

const PLATFORM_LABELS: Record<string, string> = {
  WIN11: 'Windows 11',
  WIN10: 'Windows 10',
  WIN8_1: 'Windows 8.1',
  WIN8: 'Windows 8',
  VISTA: 'Windows 7',
  LINUX: 'Linux',
  TAHOE: 'macOS Tahoe',
  SEQUOIA: 'macOS Sequoia',
  SONOMA: 'macOS Sonoma',
  VENTURA: 'macOS Ventura',
  MONTEREY: 'macOS Monterey',
  BIGSUR: 'macOS Big Sur',
  CATALINA: 'macOS Catalina',
  MOJAVE: 'macOS Mojave',
  'HIGH-SIERRA': 'macOS High Sierra',
  CAPITAN: 'macOS El Capitan',
  GOLDENGATE: 'macOS Golden Gate',
}

export type BrowserGroup = {
  browserName: string
  platform: string
  label: string
  /** Aliases first, then concrete versions newest first. */
  versions: string[]
  /** Null when the combination works. A string is the reason it does not. */
  blocked: string | null
}

export type DeviceGroup = {
  deviceName: string
  platformName: string
  label: string
  /** Newest first. */
  platformVersions: string[]
  /**
   * Physical hardware, as opposed to a simulator or emulator. The two are
   * separate groups even for the same device name, because they are separate
   * things to book and they do not render identically.
   */
  realDevice: boolean
}

export type Catalogue = {
  browsers: BrowserGroup[]
  devices: DeviceGroup[]
  fetchedAt: string
}

export class CatalogueError extends Error {
  code: string

  constructor (message: string, code = 'CATALOGUE_FAILED') {
    super(message)
    this.name = 'CatalogueError'
    this.code = code
  }
}

type RawEntry = {
  name?: string
  platform?: string
  version?: string
  deviceName?: string
  platformName?: string
}

/** An entry from `/v1/devices`, which uses snake_case where `/v1/browsers` does not. */
type RawDevice = {
  name?: string
  platform_name?: string
  version?: string
  available?: boolean
}

/**
 * Descending version sort that understands `131` beats `99` and `14.10` beats
 * `14.2`. A plain string sort gets both of those backwards, which would put a
 * decade-old browser at the top of the list.
 */
function compareVersionsDescending (a: string, b: string): number {
  const left = a.split('.').map((part) => Number.parseInt(part, 10) || 0)
  const right = b.split('.').map((part) => Number.parseInt(part, 10) || 0)

  for (let i = 0; i < Math.max(left.length, right.length); i += 1) {
    const diff = (right[i] ?? 0) - (left[i] ?? 0)

    if (diff !== 0) return diff
  }

  return 0
}

function platformLabel (platform: string): string {
  return PLATFORM_LABELS[platform] ?? platform
}

function browserLabel (browserName: string): string {
  if (browserName === 'edge') return 'Edge'
  if (browserName === 'safari') return 'Safari'

  return browserName.charAt(0).toUpperCase() + browserName.slice(1)
}

/** Splits the two API lists into the shapes the picker needs. */
export function toCatalogue (
  raw: unknown,
  rawDevices: unknown = [],
  fetchedAt = new Date().toISOString(),
): Catalogue {
  if (!Array.isArray(raw)) {
    throw new CatalogueError(`${CATALOGUE_URL} did not return a list.`)
  }

  // Keyed by identity, valued by the parts plus the versions seen, because
  // device names contain spaces ("Galaxy Tab S9") and splitting a composite
  // key back apart would truncate them. The device key carries `realDevice`
  // too, so a simulated iPhone 15 and a physical one stay separate entries.
  const browserVersions = new Map<string, { browserName: string; platform: string; versions: Set<string> }>()
  const deviceVersions = new Map<
    string,
    { deviceName: string; platformName: string; realDevice: boolean; versions: Set<string> }
  >()

  const addDevice = (
    deviceName: string,
    platformName: string,
    version: string,
    realDevice: boolean,
  ): void => {
    if (!deviceName || !platformName || !version) return

    const key = `${deviceName}::${platformName}::${realDevice}`
    const group = deviceVersions.get(key)
      ?? { deviceName, platformName, realDevice, versions: new Set<string>() }

    group.versions.add(version)
    deviceVersions.set(key, group)
  }

  for (const item of raw as RawEntry[]) {
    if (!item || typeof item !== 'object') continue

    const version = String(item.version ?? '').trim()

    if (!version) continue

    if (item.deviceName && item.platformName) {
      // Device entries report the platform version in `version`: an Android
      // Pixel 9 entry reads version "16.0", platformName "Android".
      //
      // REAL_ANDROID is the only physical hardware in this list. Everything
      // else here is a simulator or an emulator, including every iOS entry,
      // whose `platform` names the macOS host rather than a device platform.
      addDevice(
        String(item.deviceName),
        String(item.platformName),
        version,
        String(item.platform ?? '').trim().toUpperCase() === REAL_ANDROID,
      )
      continue
    }

    const browserName = PLAYWRIGHT_BROWSER_NAMES[String(item.name ?? '').toLowerCase()]
    const platform = String(item.platform ?? '').trim()

    if (!browserName || !platform) continue

    const key = `${browserName}::${platform}`
    const group = browserVersions.get(key) ?? { browserName, platform, versions: new Set<string>() }

    group.versions.add(version)
    browserVersions.set(key, group)
  }

  // The fleet inventory, which is the only place physical iOS appears. An
  // entry that is not `available` is hardware we do not have right now, and
  // offering it buys the user a five minute wait and no session (TB-312).
  for (const item of (Array.isArray(rawDevices) ? rawDevices : []) as RawDevice[]) {
    if (!item || typeof item !== 'object' || item.available !== true) continue

    addDevice(
      String(item.name ?? '').trim(),
      String(item.platform_name ?? '').trim(),
      String(item.version ?? '').trim(),
      true,
    )
  }

  const browsers: BrowserGroup[] = [...browserVersions.values()]
    .map(({ browserName, platform, versions }) => ({
      browserName,
      platform,
      label: `${browserLabel(browserName)} on ${platformLabel(platform)}`,
      versions: [
        ...VERSION_ALIASES,
        ...[...versions].sort(compareVersionsDescending).slice(0, VERSIONS_PER_PLATFORM),
      ],
      blocked: BLOCKED_BROWSERS[browserName] ?? null,
    }))
    .sort((a, b) => a.label.localeCompare(b.label))

  const devices: DeviceGroup[] = [...deviceVersions.values()]
    .map(({ deviceName, platformName, realDevice, versions }) => ({
      deviceName,
      platformName,
      realDevice,
      label: realDevice
        ? `${deviceName} (${platformName})`
        : `${deviceName} (${platformName} ${platformName.toLowerCase() === 'ios' ? 'simulator' : 'emulator'})`,
      platformVersions: [...versions].sort(compareVersionsDescending),
    }))
    // Physical hardware first: it is what most people came for, and it is the
    // shorter list.
    .sort((a, b) => Number(b.realDevice) - Number(a.realDevice) || a.label.localeCompare(b.label))

  if (browsers.length === 0) {
    throw new CatalogueError(
      `${CATALOGUE_URL} returned ${raw.length} entries but none that Playwright can drive.`,
    )
  }

  return { browsers, devices, fetchedAt }
}

async function fetchList (url: string, signal?: AbortSignal): Promise<unknown> {
  let response: Response

  try {
    response = await fetch(url, {
      signal: signal
        ? AbortSignal.any([signal, AbortSignal.timeout(CATALOGUE_TIMEOUT_MS)])
        : AbortSignal.timeout(CATALOGUE_TIMEOUT_MS),
    })
  } catch (error) {
    throw new CatalogueError(
      `Could not reach ${url} (${(error as Error).message}).`,
      'CATALOGUE_UNREACHABLE',
    )
  }

  if (!response.ok) {
    throw new CatalogueError(`${url} returned HTTP ${response.status}.`, 'CATALOGUE_UNREACHABLE')
  }

  return response.json()
}

export async function fetchCatalogue ({ signal }: { signal?: AbortSignal } = {}): Promise<Catalogue> {
  const [browsers, devices] = await Promise.all([
    fetchList(CATALOGUE_URL, signal),
    fetchList(DEVICES_URL, signal),
  ])

  return toCatalogue(browsers, devices)
}

/** Turns a picker selection back into the config entry shape targets.ts reads. */
export function toBrowserSpec (
  browserName: string,
  browserVersion: string,
  platform: string,
): TargetSpec {
  return { browserName, browserVersion, platform }
}

export function toDeviceSpec (
  deviceName: string,
  platformName: string,
  platformVersion: string,
  realDevice = true,
): TargetSpec {
  // iOS devices run Mobile Safari and are driven over WebDriver; Android
  // devices run Chrome and are driven by Playwright. Storing the browser here
  // rather than deriving it in two places keeps the config file explicit about
  // what it asked for.
  const browserName = platformName.toLowerCase() === 'ios' ? 'safari' : 'chrome'

  // Written out even when true, because the difference between a simulator and
  // the phone in someone's hand is the whole reason to use this addon and the
  // config file should not leave it implicit.
  return { deviceName, platformName, platformVersion, browserName, realDevice }
}
